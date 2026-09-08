import { randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { AppError, helloSchema, MAX_MESSAGE_BYTES, MAX_TEXT_BYTES, PROTOCOL_MAJOR, publicError, requestSchema } from './protocol.js';
import { prepareDataDirectory } from './paths.js';
import { RecordStore } from './store.js';

const MAX_CLIENTS = 16;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_BUFFER_BYTES = 512 * 1024;
const METHODS = ['workspaces.get', 'sessions.create', 'sessions.get', 'sessions.list', 'messages.append', 'messages.list', 'requests.get'];

export type DaemonOptions = {
  projectRoot: string;
  dataDirectory: string;
  workspaceDirectory: string;
  token: string;
  port?: number;
  origins?: string[];
};

export async function startDaemon(options: DaemonOptions) {
  if (!/^[a-zA-Z0-9_-]{43,128}$/.test(options.token)) {
    throw new AppError('INVALID_AUTH_CONFIG', 'WORKNARU_TOKEN에 32바이트 이상의 무작위 base64url 토큰을 설정하세요.');
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
    throw new AppError('INVALID_PORT', '포트는 0에서 65535 사이의 정수여야 합니다.');
  }
  const origins = options.origins ?? [];
  for (const value of origins) {
    const origin = new URL(value);
    if (!['http:', 'https:'].includes(origin.protocol) || !['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.origin !== value) {
      throw new AppError('INVALID_ORIGIN', '허용 Origin에는 로컬 개발 화면의 정확한 Origin을 지정하세요.');
    }
  }
  const directory = prepareDataDirectory(options.projectRoot, options.dataDirectory);
  const store = new RecordStore(directory, options.workspaceDirectory);
  const instanceId = randomUUID();
  const token = Buffer.from(options.token);
  const server = createServer((_request, response) => {
    response.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    response.end('Not found');
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.maxConnections = 32;
  const connections = new Set<Socket>();
  let stopping = false;
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

  function send(socket: WebSocket, payload: unknown) {
    const text = JSON.stringify(payload);
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_OUTPUT_BYTES || socket.bufferedAmount + bytes > MAX_BUFFER_BYTES) {
      socket.terminate();
      return;
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(text);
  }

  wss.on('connection', (socket) => {
    let authenticated = false;
    let count = 0;
    let windowStart = Date.now();
    const timeout = setTimeout(() => socket.terminate(), 5_000);
    timeout.unref();
    socket.on('close', () => clearTimeout(timeout));
    socket.on('error', () => { /* Closing a malformed connection does not affect other clients. */ });
    socket.on('message', (raw, binary) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const failConnection = (code: string, message: string) => {
        send(socket, { type: 'connection.error', error: { code, message } });
        socket.close(1008, code);
      };
      if (Date.now() - windowStart >= 1_000) { count = 0; windowStart = Date.now(); }
      if (++count > 120) { failConnection('RATE_LIMITED', '요청 한도를 초과했습니다.'); return; }
      if (binary) { failConnection('INVALID_MESSAGE', '텍스트 JSON 메시지만 지원합니다.'); return; }
      let data: unknown;
      try { data = JSON.parse(raw.toString()); }
      catch { failConnection('INVALID_MESSAGE', '올바른 JSON 메시지가 아닙니다.'); return; }

      if (!authenticated) {
        const parsed = helloSchema.safeParse(data);
        if (!parsed.success) { failConnection('AUTH_REQUIRED', '먼저 인증과 버전을 확인해야 합니다.'); return; }
        const candidate = Buffer.from(parsed.data.token);
        if (candidate.length !== token.length || !timingSafeEqual(candidate, token)) {
          failConnection('AUTH_FAILED', '인증에 실패했습니다.'); return;
        }
        if (parsed.data.protocolMajor !== PROTOCOL_MAJOR) {
          failConnection('PROTOCOL_MISMATCH', '지원하지 않는 전송 계약 버전입니다.'); return;
        }
        authenticated = true;
        clearTimeout(timeout);
        send(socket, {
          type: 'ready', protocolMajor: PROTOCOL_MAJOR, connectionId: randomUUID(),
          daemonInstanceId: instanceId, storeEpoch: store.epoch,
          capabilities: METHODS, aiExecution: false,
          limits: { maxMessageBytes: MAX_MESSAGE_BYTES, maxTextBytes: MAX_TEXT_BYTES, maxResponseBytes: MAX_OUTPUT_BYTES },
        });
        return;
      }

      const parsed = requestSchema.safeParse(data);
      if (!parsed.success) {
        const envelope = data && typeof data === 'object' ? data as Record<string, unknown> : {};
        if (typeof envelope.callId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(envelope.callId)) {
          failConnection('INVALID_REQUEST', '유효한 호출 ID가 필요합니다.'); return;
        }
        const unsupported = typeof envelope.method === 'string' && !METHODS.includes(envelope.method);
        send(socket, { type: 'response', callId: envelope.callId, ok: false, error: {
          code: unsupported ? 'METHOD_NOT_SUPPORTED' : 'INVALID_REQUEST',
          message: unsupported ? '지원하지 않는 기능입니다.' : '요청 형식이나 입력 한도를 확인하세요.',
        } });
        return;
      }
      try {
        const result = store.handle(parsed.data);
        send(socket, { type: 'response', callId: parsed.data.callId, ok: true, result });
      } catch (error) {
        send(socket, { type: 'response', callId: parsed.data.callId, ok: false, error: publicError(error) });
      }
    });
  });

  server.on('upgrade', (request, socket, head) => {
    if (stopping) { socket.destroy(); return; }
    const address = server.address() as AddressInfo;
    const origin = request.headers.origin;
    if (request.url !== '/ws' || request.headers.host !== `127.0.0.1:${address.port}` || (origin !== undefined && !origins.includes(origin))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (wss.clients.size >= MAX_CLIENTS) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
  });

  try {
    server.listen(options.port ?? 0, '127.0.0.1');
    await once(server, 'listening');
  } catch (error) {
    wss.close();
    store.close();
    throw error;
  }
  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    workspace: store.workspace,
    storeEpoch: store.epoch,
    daemonInstanceId: instanceId,
    close(): Promise<void> {
      closing ??= (async () => {
        try {
          stopping = true;
          const serverClosed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
          for (const socket of wss.clients) socket.terminate();
          // Include partial HTTP requests and rejected upgrades, which wss does not own.
          for (const socket of connections) socket.destroy();
          await Promise.all([
            serverClosed,
            new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve())),
          ]);
        } finally {
          store.close();
          token.fill(0);
        }
      })();
      return closing;
    },
  };
}
