import { randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { AppError, helloSchema, MAX_MESSAGE_BYTES, MAX_TEXT_BYTES, PROTOCOL_MAJOR, publicError, requestSchema } from './protocol.js';
import { prepareDataDirectory } from './paths.js';
import { RecordStore } from './store.js';
import type { Run } from './store.js';
import { AcpRuntime } from './acp.js';
import type { AcpOptions } from './acp.js';
import { APP_VERSION, createOpsToken, identityProof, isOpsPath, opsPath, removeOwnedRuntimeState, writeRuntimeState } from './runtime-state.js';
import { resolveWebRoot, serveWebAsset } from './static-ui.js';

const MAX_CLIENTS = 16;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_BUFFER_BYTES = 512 * 1024;
const METHODS = ['workspaces.get', 'sessions.create', 'sessions.get', 'sessions.list', 'messages.append', 'messages.list', 'requests.get', 'settings.get'];

export type DaemonOptions = {
  projectRoot: string;
  dataDirectory: string;
  workspaceDirectory: string;
  token?: string;
  disableKeyAuth?: boolean;
  port?: number;
  origins?: string[];
  acp?: AcpOptions;
  ops?: boolean;
  exclusiveWorkspace?: boolean;
  webUi?: boolean;
};

export async function startDaemon(options: DaemonOptions) {
  if (!options.disableKeyAuth && !/^[a-zA-Z0-9_-]{43,128}$/.test(options.token ?? '')) {
    throw new AppError('INVALID_AUTH_CONFIG', 'WORKNARU_TOKEN에 32바이트 이상의 무작위 base64url 토큰을 설정하세요.');
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
    throw new AppError('INVALID_PORT', '포트는 0에서 65535 사이의 정수여야 합니다.');
  }
  const origins = [...(options.origins ?? [])];
  for (const value of origins) {
    const origin = new URL(value);
    if (!['http:', 'https:'].includes(origin.protocol) || !['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.origin !== value) {
      throw new AppError('INVALID_ORIGIN', '허용 Origin에는 로컬 개발 화면의 정확한 Origin을 지정하세요.');
    }
  }
  const webRoot = options.webUi ? resolveWebRoot(options.projectRoot) : undefined;
  const directory = prepareDataDirectory(options.projectRoot, options.dataDirectory);
  const store = new RecordStore(directory, options.workspaceDirectory, options.exclusiveWorkspace);
  const subscriptions = new Map<WebSocket, Set<string>>();
  let runtime: AcpRuntime | undefined;
  try {
    runtime = options.acp ? new AcpRuntime(store, options.projectRoot, directory, options.acp, (run: Run) => {
      for (const [socket, watched] of subscriptions) if (watched.has(run.runId)) send(socket, { type: 'run.changed', run });
    }) : undefined;
    if (runtime) await runtime.recover();
    else if (store.recoverySessions().length) {
      // Query-only startup still prevents stale executions from appearing active.
      for (const session of store.recoverySessions()) store.recoverSession(session.sessionId, false);
    }
    if (!runtime) { store.recoverUndelivered(); store.recoverFiles(); }
  } catch (error) { store.close(); throw error; }
  const methods = runtime ? [...METHODS, 'ai.get', 'settings.update', 'sessions.configure', 'runs.start', 'runs.cancel', 'runs.get', 'runs.watch', 'runs.unwatch', 'permissions.respond'] : [...METHODS, 'runs.get', 'runs.watch', 'runs.unwatch'];
  const instanceId = randomUUID();
  const token = Buffer.from(options.disableKeyAuth ? '' : options.token!);
  const opsSecret = options.ops ? Buffer.from(createOpsToken()) : undefined;
  let accepting = false;
  const startedAt = new Date().toISOString();
  const server = createServer((request, response) => {
    try {
      if (!accepting) { response.writeHead(503); response.end(); return; }
      const port = (server.address() as AddressInfo).port;
      const origin = request.headers.origin;
      if (request.headers.host !== `127.0.0.1:${port}`) {
        response.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        response.end('Forbidden');
        return;
      }
      if (stopping) {
        response.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', Connection: 'close' });
        response.end('Stopping');
        return;
      }
      if (handleOps(request, response)) return;
      if (webRoot) {
        if (origin !== undefined && !origins.includes(origin)) {
          response.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
          response.end('Forbidden');
          return;
        }
        serveWebAsset(webRoot, request, response, (html) => injectBundledEndpoint(html, port));
        return;
      }
      response.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      response.end('Not found');
    } catch {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      }
      response.end();
    }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = options.ops ? 180_000 : 5_000;
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

  function json(response: ServerResponse, status: number, body: unknown) {
    const text = JSON.stringify(body);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(text), Connection: 'close',
    });
    response.end(text);
  }

  function identityFields(port: number) {
    return {
      instanceId, dataDir: directory, workspace: store.workspace.path, protocolMajor: PROTOCOL_MAJOR,
      appVersion: APP_VERSION, webUi: Boolean(webRoot), aiExecution: Boolean(runtime), port,
    };
  }

  function handleOps(request: IncomingMessage, response: ServerResponse) {
    if (!options.ops || !opsSecret || !isOpsPath(request.url)) return false;
    const port = (server.address() as AddressInfo).port;
    const path = request.url;
    if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin !== undefined) {
      json(response, 403, { error: { code: 'FORBIDDEN', message: '로컬 운영 제어에서 허용된 요청이 아닙니다.' } });
      return true;
    }
    if (path === opsPath('identify') && request.method === 'GET') {
      const challenge = request.headers['x-worknaru-challenge'];
      if (typeof challenge !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(challenge)) {
        json(response, 400, { error: { code: 'INVALID_REQUEST', message: '실행 확인 challenge가 필요합니다.' } });
        return true;
      }
      const identity = identityFields(port);
      json(response, 200, { type: 'worknaru.ops.identify', ...identity, proof: identityProof(opsSecret.toString(), challenge, identity) });
      return true;
    }
    const expected = Buffer.from(`Bearer ${opsSecret.toString()}`);
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)
      || request.headers['x-worknaru-instance'] !== instanceId) {
      json(response, 401, { error: { code: 'AUTH_FAILED', message: '운영 제어 인증에 실패했습니다.' } });
      expected.fill(0);
      return true;
    }
    expected.fill(0);
    if (path === opsPath('status') && request.method === 'GET') {
      json(response, 200, {
        type: 'worknaru.ops.status', ...identityFields(port),
        activeRuns: store.activeRunCount(), pendingApprovals: store.pendingApprovalCount(),
        pid: process.pid, startedAt,
      });
      return true;
    }
    if (path === opsPath('stop') && request.method === 'POST') {
      if (closing) {
        json(response, 409, { error: { code: 'DAEMON_STOPPING', message: '종료가 이미 진행 중입니다.' } });
        return true;
      }
      const cancelActive = request.headers['x-worknaru-cancel-active'] === 'yes';
      const activeRuns = store.activeRunCount();
      const pendingApprovals = store.pendingApprovalCount();
      if ((activeRuns > 0 || pendingApprovals > 0) && !cancelActive) {
        json(response, 409, { code: 'DAEMON_BUSY', activeRuns, pendingApprovals });
        return true;
      }
      stopping = true;
      void close({ socket: request.socket, response }).catch(() => {});
      return true;
    }
    json(response, 404, { error: { code: 'NOT_FOUND', message: '지원하지 않는 운영 요청입니다.' } });
    return true;
  }

  wss.on('connection', (socket) => {
    let authenticated = false;
    let count = 0;
    let windowStart = Date.now();
    const timeout = setTimeout(() => socket.terminate(), 5_000);
    timeout.unref();
    socket.on('close', () => { clearTimeout(timeout); subscriptions.delete(socket); });
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
        const candidate = Buffer.from(parsed.data.token ?? '');
        if (!options.disableKeyAuth && (candidate.length !== token.length || !timingSafeEqual(candidate, token))) {
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
          capabilities: methods, aiExecution: Boolean(runtime),
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
        const unsupported = typeof envelope.method === 'string' && !methods.includes(envelope.method);
        send(socket, { type: 'response', callId: envelope.callId, ok: false, error: {
          code: unsupported ? 'METHOD_NOT_SUPPORTED' : 'INVALID_REQUEST',
          message: unsupported ? '지원하지 않는 기능입니다.' : '요청 형식이나 입력 한도를 확인하세요.',
        } });
        return;
      }
      try {
        if (stopping) throw new AppError('DAEMON_STOPPING', '데몬을 종료하고 있습니다.');
        if (!methods.includes(parsed.data.method)) throw new AppError('METHOD_NOT_SUPPORTED', '지원하지 않는 기능입니다.');
        if (parsed.data.method === 'ai.get') {
          const callId = parsed.data.callId;
          void runtime!.metadata().then(
            (result) => send(socket, { type: 'response', callId, ok: true, result }),
            (error: unknown) => send(socket, { type: 'response', callId, ok: false, error: publicError(error) }),
          );
          return;
        }
        const result = store.handle(parsed.data, runtime?.validateSelection);
        if (parsed.data.method === 'runs.watch') {
          const watched = subscriptions.get(socket) ?? new Set<string>();
          if (watched.size >= 16 && !watched.has(parsed.data.params.runId)) throw new AppError('SUBSCRIPTION_LIMIT', '실행 구독 한도에 도달했습니다.');
          watched.add(parsed.data.params.runId);
          subscriptions.set(socket, watched);
        }
        if (parsed.data.method === 'runs.unwatch') subscriptions.get(socket)?.delete(parsed.data.params.runId);
        send(socket, { type: 'response', callId: parsed.data.callId, ok: true, result });
        if (parsed.data.method === 'permissions.respond') runtime!.respondPermission(parsed.data.params.runId, parsed.data.params.toolId);
        if (parsed.data.method === 'runs.start') runtime!.start((result as { run: Run }).run.runId);
        if (parsed.data.method === 'runs.cancel') {
          runtime!.emit(parsed.data.params.runId);
          void runtime!.cancel(parsed.data.params.runId).catch(() => {});
        }
      } catch (error) {
        send(socket, { type: 'response', callId: parsed.data.callId, ok: false, error: publicError(error) });
      }
    });
  });

  server.on('upgrade', (request, socket, head) => {
    if (!accepting || stopping) { socket.destroy(); return; }
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
    await runtime?.close();
    store.close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new AppError('PORT_IN_USE', '지정한 포트가 이미 사용 중입니다. 다른 프로세스를 종료하지 않습니다.');
    }
    throw error;
  }
  const port = (server.address() as AddressInfo).port;
  const httpOrigin = `http://127.0.0.1:${port}`;
  if (webRoot && !origins.includes(httpOrigin)) origins.push(httpOrigin);
  if (options.ops && opsSecret) {
    try {
      writeRuntimeState(directory, {
        schema: 1, instanceId, dataDir: directory, workspace: store.workspace.path,
        pid: process.pid, startedAt, port, protocolMajor: PROTOCOL_MAJOR, appVersion: APP_VERSION,
        webUi: Boolean(webRoot), aiExecution: Boolean(runtime),
      }, opsSecret.toString());
    } catch (error) {
      wss.close();
      await runtime?.close();
      store.close();
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of connections) socket.destroy();
      await serverClosed;
      throw error;
    }
  }
  let closing: Promise<boolean> | undefined;
  const finished = Promise.withResolvers<boolean>();
  function close(keep?: { socket: Socket; response: ServerResponse }): Promise<boolean> {
    closing ??= (async () => {
      stopping = true;
      accepting = false;
      let confirmed = false;
      // Stop accepting new TCP/HTTP before any completion body. The keep socket stays
      // open so a separate stop CLI can read the result after owned resources are gone.
      let listenersConfirmed = true;
      const serverClosed = new Promise<void>((resolve) => server.close((error) => { if (error) listenersConfirmed = false; resolve(); }));
      const wssClosed = new Promise<void>((resolve) => wss.close((error) => { if (error) listenersConfirmed = false; resolve(); }));
      try {
        confirmed = runtime ? await runtime.close().catch(() => false) : true;
        for (const socket of wss.clients) socket.terminate();
        for (const socket of connections) {
          if (socket !== keep?.socket) socket.destroy();
        }
        await wssClosed;
        if (options.ops) {
          try { removeOwnedRuntimeState(directory, instanceId); }
          catch { confirmed = false; }
        }
        store.close();
        token.fill(0);
        opsSecret?.fill(0);
        confirmed = confirmed && listenersConfirmed && !server.listening;
        if (keep && !keep.response.writableEnded && !keep.response.destroyed) {
          const payload = confirmed
            ? { stopped: true, instanceId }
            : { code: 'STOP_UNCONFIRMED', error: 'AI 프로세스 정리를 확인하지 못했습니다.' };
          json(keep.response, confirmed ? 200 : 500, payload);
          await Promise.race([once(keep.response, 'finish'), new Promise((resolve) => { setTimeout(resolve, 2_000).unref(); })]).catch(() => {});
        }
        keep?.socket.destroy();
        await serverClosed;
        confirmed = confirmed && listenersConfirmed;
        finished.resolve(confirmed);
        return confirmed;
      } catch (error) {
        finished.resolve(false);
        try { store.close(); } catch { /* already closed */ }
        token.fill(0);
        opsSecret?.fill(0);
        keep?.socket.destroy();
        for (const socket of wss.clients) socket.terminate();
        for (const socket of connections) socket.destroy();
        await Promise.all([serverClosed, wssClosed]);
        return false;
      }
    })();
    return closing;
  }
  accepting = true;
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    httpOrigin,
    workspace: store.workspace,
    storeEpoch: store.epoch,
    daemonInstanceId: instanceId,
    webUi: Boolean(webRoot),
    aiExecution: Boolean(runtime),
    activeRunCount: () => store.activeRunCount(),
    pendingApprovalCount: () => store.pendingApprovalCount(),
    closed: finished.promise,
    close(): Promise<boolean> { return close(); },
  };
}

function injectBundledEndpoint(html: string, port: number) {
  if (html.includes('worknaru-dev-instance') || html.includes('worknaru-daemon-ws')) return html;
  return html.replace('<head>', `<head>\n    <meta name="worknaru-daemon-ws" content="ws://127.0.0.1:${port}/ws" />`);
}
