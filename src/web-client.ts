// Browser-compatible platform transport. No UI or Node runtime imports.
import { z } from 'zod';
import { aiInfoSchema, aiSettingsSchema } from './ai-settings.js';
import type { AiSelection } from './ai-settings.js';

const id = z.uuid();
const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const runSchema = z.object({
  runId: id, sessionId: id, state: z.enum(['running', 'cancelling', 'completed', 'cancelled', 'failed']),
  delivery: z.enum(['not_attempted', 'attempting']), revision: seq, text: z.string(),
  errorCode: z.string().nullable(), stopReason: z.string().nullable(), createdAt: z.string(), storageAvailable: z.boolean(),
  model: z.string().nullable().default(null), reasoningEffort: z.string().nullable().default(null), modelConfirmed: z.number().int().min(0).max(1).default(0),
});
const sessionSchema = z.object({
  sessionId: id, workspaceId: id, title: z.string(), seq, createdAt: z.string(),
  aiUnavailable: z.number().int().min(0).max(1), latestRunId: id.nullable(),
  latestRunState: z.enum(['running', 'cancelling', 'completed', 'cancelled', 'failed']).nullable(), storageAvailable: z.boolean(),
  model: z.string().nullable().default(null), reasoningEffort: z.string().nullable().default(null),
});
const messageSchema = z.object({
  messageId: id, sessionId: id, seq, text: z.string(), role: z.enum(['user', 'assistant']), runId: id.nullable(), createdAt: z.string(),
});
const workspaceSchema = z.object({ workspaceId: id, path: z.string() });
const runReceipt = z.object({ accepted: z.literal(true), requestId: z.string(), run: runSchema });
const sessionReceipt = z.object({ accepted: z.literal(true), requestId: z.string(), session: sessionSchema });
const settingsReceipt = z.object({ accepted: z.literal(true), requestId: z.string(), settings: aiSettingsSchema });
const readySchema = z.object({
  type: z.literal('ready'), protocolMajor: z.literal(1), daemonInstanceId: id, storeEpoch: id,
  capabilities: z.array(z.string()), aiExecution: z.boolean(),
  limits: z.object({ maxTextBytes: z.number().int().positive().max(16_384) }),
});
const results = {
  'ai.get': aiInfoSchema, 'settings.get': aiSettingsSchema, 'settings.update': settingsReceipt, 'sessions.configure': sessionReceipt,
  'workspaces.get': workspaceSchema,
  'sessions.create': sessionReceipt,
  'sessions.get': sessionSchema,
  'sessions.list': z.object({ sessions: z.array(sessionSchema), nextAfter: seq.nullable() }),
  'messages.list': z.object({ messages: z.array(messageSchema), upTo: seq, nextAfter: seq.nullable() }),
  'runs.start': runReceipt, 'runs.cancel': runReceipt,
  'runs.get': runSchema, 'runs.watch': runSchema, 'runs.unwatch': runSchema,
  'requests.get': z.discriminatedUnion('found', [
    z.object({ storeEpoch: id, found: z.literal(false) }),
    z.object({ storeEpoch: id, found: z.literal(true), result: z.union([runReceipt, sessionReceipt, settingsReceipt]) }),
  ]),
};
type Params = {
  'ai.get': Record<string, never>; 'settings.get': Record<string, never>;
  'settings.update': { selection: AiSelection }; 'sessions.configure': { sessionId: string; selection: AiSelection };
  'workspaces.get': Record<string, never>;
  'sessions.create': { workspaceId: string; title: string };
  'sessions.get': { sessionId: string };
  'sessions.list': { workspaceId: string; after?: number; limit?: number; order?: 'asc' | 'desc' };
  'messages.list': { sessionId: string; after?: number; upTo?: number; limit?: number };
  'runs.start': { sessionId: string; text: string };
  'runs.cancel': { runId: string };
  'runs.get': { runId: string }; 'runs.watch': { runId: string }; 'runs.unwatch': { runId: string };
  'requests.get': { workspaceId: string; requestId: string; storeEpoch: string };
};
export type Run = z.infer<typeof runSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type Ready = z.infer<typeof readySchema>;
export type MutationIdentity = { requestId: string; storeEpoch: string };
export class ClientError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class WebClient {
  private socket?: WebSocket;
  private pending = new Map<string, { schema: z.ZodType; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  ready?: Ready;
  onRun: (run: Run) => void = () => {};
  onDisconnect: (error: ClientError) => void = () => {};
  constructor(private readonly gatewayEndpoint?: string, private readonly keyRequired = true) {}

  async connect(endpoint: string, token: string): Promise<Ready> {
    this.close();
    const url = new URL(endpoint);
    const local = url.protocol === 'ws:' && url.hostname === '127.0.0.1' && Boolean(url.port) && url.pathname === '/ws';
    const gateway = url.href === this.gatewayEndpoint && ['ws:', 'wss:'].includes(url.protocol) && /^\/p\/[a-f0-9]{16}\/__worknaru_ws$/.test(url.pathname);
    if ((!local && !gateway) || url.search || url.hash || url.username || url.password)
      throw new ClientError('INVALID_URL', '로컬 Daemon 주소 또는 이 화면의 개발 서버 연결 주소를 사용하세요.');
    if ((this.keyRequired || token) && !/^[a-zA-Z0-9_-]{43,128}$/.test(token)) throw new ClientError('INVALID_TOKEN', 'Daemon 실행 시 지정한 연결 키를 입력하세요.');
    const socket = new WebSocket(url);
    this.socket = socket;
    return new Promise<Ready>((resolve, reject) => {
      const timeout = setTimeout(() => fail(new ClientError('TIMEOUT', '연결 확인 시간이 지났습니다. Daemon 실행과 허용 Origin을 확인하세요.')), 8_000);
      let ended = false;
      const fail = (error: ClientError) => {
        if (ended) return;
        ended = true;
        clearTimeout(timeout);
        reject(error);
        if (this.socket === socket) {
          this.ready = undefined;
          for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
          this.pending.clear();
          this.onDisconnect(error);
        }
        socket.close();
      };
      socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', protocolMajor: 1, ...(token ? { token } : {}) }));
      socket.onclose = () => fail(new ClientError('DISCONNECTED', '연결이 끊겼습니다. 마지막 확인 기록을 표시합니다.'));
      socket.onmessage = (event) => {
        if (this.socket !== socket || ended) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > 262_144) throw new Error('Invalid frame');
          const data = JSON.parse(event.data);
          if (data.type === 'connection.error') {
            const error = z.object({ code: z.string(), message: z.string() }).parse(data.error);
            fail(new ClientError(error.code, error.message));
          } else if (!this.ready) {
            this.ready = readySchema.parse(data);
            clearTimeout(timeout);
            resolve(this.ready);
          } else if (data.type === 'run.changed') this.onRun(runSchema.parse(data.run));
          else if (data.type === 'response') {
            const request = this.pending.get(data.callId);
            if (!request) return;
            // Validate before removing the waiter so malformed responses reject it too.
            if (data.ok === true) {
              const result = request.schema.parse(data.result);
              clearTimeout(request.timer); this.pending.delete(data.callId); request.resolve(result);
            } else if (data.ok === false) {
              const error = z.object({ code: z.string(), message: z.string() }).parse(data.error);
              clearTimeout(request.timer); this.pending.delete(data.callId); request.reject(new ClientError(error.code, error.message));
            } else throw new Error('Invalid response');
          } else throw new Error('Unknown frame');
        } catch { fail(new ClientError('PROTOCOL_MISMATCH', 'Daemon 응답을 해석할 수 없습니다. 화면과 Daemon 버전을 확인하세요.')); }
      };
      socket.onerror = () => fail(new ClientError('DISCONNECTED', '연결할 수 없습니다. Daemon 주소와 허용 Origin을 확인하세요.'));
    });
  }

  call<K extends keyof Params>(method: K, params: Params[K], identity?: MutationIdentity): Promise<z.infer<(typeof results)[K]>> {
    const socket = this.socket;
    if (!this.ready || socket?.readyState !== WebSocket.OPEN) return Promise.reject(new ClientError('DISCONNECTED', '먼저 Daemon에 연결하세요.'));
    if (!this.ready.capabilities.includes(method)) return Promise.reject(new ClientError('METHOD_NOT_SUPPORTED', '연결한 Daemon에서 지원하지 않는 기능입니다.'));
    const callId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(callId); reject(new ClientError('TIMEOUT', '응답 확인 시간이 지났습니다. 접수 여부를 확인하세요.')); }, method === 'ai.get' ? 60_000 : 10_000);
      this.pending.set(callId, { schema: results[method], resolve, reject, timer });
      try { socket.send(JSON.stringify({ type: 'request', callId, method, params, ...identity })); }
      catch { clearTimeout(timer); this.pending.delete(callId); reject(new ClientError('DISCONNECTED', '전송 결과를 확인할 수 없습니다.')); }
    });
  }

  close() {
    const socket = this.socket;
    this.socket = undefined;
    this.ready = undefined;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new ClientError('DISCONNECTED', '연결이 종료되었습니다.')); }
    this.pending.clear();
    socket?.close();
  }
}
