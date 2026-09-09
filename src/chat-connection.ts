import { CHAT_PROTOCOL, ChatError, type ChatMethod, type ChatResult, type CallParams, type ProductEvent, type ServiceInfo, type Reply } from './chat-contract.js';

export type SocketLike = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'onopen' | 'onmessage' | 'onerror' | 'onclose'>;
export class ChatConnection {
  private socket: SocketLike | undefined;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(event: ProductEvent) => void>();
  private connectionListeners = new Set<() => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private connectPromise: Promise<void> | undefined;
  connected = false;
  info: ServiceInfo | null = null;
  constructor(readonly url: string, private createSocket: (url: string) => SocketLike = url => new WebSocket(url), private reconnect = true) {}
  subscribe(listener: (event: ProductEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  connection(listener: () => void) { this.connectionListeners.add(listener); return () => { this.connectionListeners.delete(listener); }; }
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    if (this.stopped) return Promise.reject(new ChatError('CLIENT_CLOSED', '연결이 종료됐습니다.'));
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = this.createSocket(this.url); this.socket = socket;
      const timer = setTimeout(() => { reject(new ChatError('CONNECT_TIMEOUT', '서버 접속 시간이 초과됐습니다.')); socket.close(); }, 8_000);
      socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', version: CHAT_PROTOCOL }));
      socket.onmessage = event => {
        if (this.socket !== socket) return;
        let message: Reply | { type: 'ready'; info: ServiceInfo } | { type: 'event'; event: ProductEvent };
        try { message = JSON.parse(String(event.data)); } catch { socket.close(); return; }
        if (message.type === 'ready' && message.info?.protocol === CHAT_PROTOCOL) {
          clearTimeout(timer); this.connected = true; this.info = message.info; this.connectPromise = undefined;
          for (const listener of this.connectionListeners) listener(); resolve();
        } else if (message.type === 'event' && message.event) {
          for (const listener of this.listeners) listener(message.event);
        } else if (message.type === 'reply' && message.id) {
          const operation = this.pending.get(message.id); if (!operation) return;
          clearTimeout(operation.timer); this.pending.delete(message.id);
          if (message.ok) operation.resolve(message.result);
          else operation.reject(new ChatError(message.error?.code ?? 'REQUEST_FAILED', message.error?.message ?? '요청에 실패했습니다.'));
        }
      };
      socket.onerror = () => {};
      socket.onclose = () => {
        clearTimeout(timer);
        if (this.socket !== socket) return;
        this.connected = false; this.connectPromise = undefined;
        reject(new ChatError('CONNECTION_CLOSED', '서버 연결이 종료됐습니다.'));
        for (const operation of this.pending.values()) { clearTimeout(operation.timer); operation.reject(new ChatError('RESULT_UNKNOWN', '연결이 끊겨 요청 결과를 확인하지 못했습니다. 다시 조회하세요.')); }
        this.pending.clear();
        for (const listener of this.connectionListeners) listener();
        if (!this.stopped && this.reconnect) this.reconnectTimer = setTimeout(() => { void this.connect().catch(() => {}); }, 1_000);
      };
    });
    return this.connectPromise;
  }
  async call<M extends ChatMethod>(method: M, params: CallParams<M>): Promise<ChatResult[M]> {
    if (!this.connected || !this.socket) throw new ChatError('NOT_CONNECTED', '서버에 연결한 뒤 다시 요청하세요.');
    const id = crypto.randomUUID();
    return new Promise<ChatResult[M]>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ChatError('RESULT_UNKNOWN', '요청 결과를 기한 내 확인하지 못했습니다. 자동 재전송하지 않습니다.')); }, 30_000);
      this.pending.set(id, { resolve: value => resolve(value as ChatResult[M]), reject, timer });
      try { this.socket!.send(JSON.stringify({ type: 'call', id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new ChatError('RESULT_UNKNOWN', '전달 결과를 확인하지 못했습니다. 다시 조회하세요.')); }
    });
  }
  close() {
    this.stopped = true; clearTimeout(this.reconnectTimer); this.socket?.close();
  }
}
