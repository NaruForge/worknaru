import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { CHAT_PROTOCOL, CallSchema, ChatParams, ChatError, type ChatMethod, type CallParams, type ChatResult, type Reply } from './chat-contract.js';
import { ChatService } from './chat-service.js';
import { serveWebAsset } from './static-ui.js';

export async function callChat<M extends ChatMethod>(service: ChatService, method: M, raw: unknown): Promise<ChatResult[M]> {
  const params = ChatParams[method].parse(raw) as CallParams<M>;
  // Explicit dispatch keeps the public API bounded. No vendor method forwarding.
  const p = params as Record<string, unknown>;
  let result: unknown;
  switch (method) {
    case 'runtime.get': result = service.info(); break;
    case 'models.list': result = await service.models(); break;
    case 'settings.get': result = service.settings(); break;
    case 'settings.update': result = await service.updateSettings(p.expectedRevision as number, p.defaults as CallParams<'settings.update'>['defaults']); break;
    case 'chats.list': result = await service.list(); break;
    case 'chats.create': result = await service.create(p.id as string, p.title as string, p.selection as CallParams<'chats.create'>['selection']); break;
    case 'chats.recover': result = await service.recover(p.chatId as string); break;
    case 'chats.get': case 'chats.watch': result = await service.get(p.chatId as string); break;
    case 'chats.timeline': result = await service.timeline(p.chatId as string, p.before as string | undefined); break;
    case 'chats.configure': result = await service.configure(p.chatId as string, p.selection as CallParams<'chats.configure'>['selection']); break;
    case 'messages.send': result = await service.send(p.chatId as string, p.messageId as string, p.text as string); break;
    case 'messages.cancel': result = await service.cancel(p.chatId as string); break;
    case 'permissions.respond': result = await service.permission(p.chatId as string, p.permissionId as string, p.decision as 'allow' | 'deny'); break;
  }
  return result as ChatResult[M];
}

export async function startChatDaemon(service: ChatService, options: { port: number; origins?: string[]; webRoot?: string }) {
  const origins = new Set(options.origins ?? []);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname))
      throw new Error('UI origins must be explicit HTTP loopback origins.');
  }
  let port = 0;
  let closing = false;
  const validRequest = (host: string | undefined, origin: string | undefined) =>
    [ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host ?? '') && (!origin || origins.has(origin));
  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    if (!validRequest(request.headers.host, request.headers.origin)) { response.writeHead(403); response.end(); return; }
    if (request.url === '/health') {
      response.writeHead(closing ? 503 : 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(service.info())); return;
    }
    if (options.webRoot) {
      serveWebAsset(options.webRoot, request, response);
    } else { response.writeHead(404); response.end(); }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 160_000 });
  const pending = new Set<Promise<unknown>>();
  server.on('upgrade', (request, socket, head) => {
    if (closing || request.url !== '/ws' || !validRequest(request.headers.host, request.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', socket => {
    let ready = false;
    const helloTimer = setTimeout(() => socket.close(1008, 'Protocol hello required'), 5_000);
    const send = (value: unknown) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 2_000_000) { socket.close(1013, 'Reconnect to refresh state'); return; }
      socket.send(JSON.stringify(value));
    };
    const unsubscribe = service.subscribe(event => { if (ready) send({ type: 'event', event }); });
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(helloTimer); unsubscribe(); });
    socket.on('message', bytes => {
      let message: unknown;
      try { message = JSON.parse(bytes.toString()); }
      catch { socket.close(1008, 'Invalid JSON'); return; }
      if (!ready) {
        const hello = message as { type?: unknown; version?: unknown };
        if (hello?.type !== 'hello' || hello.version !== CHAT_PROTOCOL) { socket.close(1008, 'WorkNaru protocol 2 required'); return; }
        clearTimeout(helloTimer); ready = true; send({ type: 'ready', info: service.info() }); return;
      }
      const parsed = CallSchema.safeParse(message);
      if (!parsed.success) { socket.close(1008, 'Invalid call'); return; }
      const request = parsed.data;
      const task = (async () => {
        let reply: Reply;
        try { reply = { type: 'reply', id: request.id, ok: true, result: await callChat(service, request.method, request.params) }; }
        catch (error) {
          reply = { type: 'reply', id: request.id, ok: false, error: error instanceof ChatError
            ? { code: error.code, message: error.message }
            : { code: 'REQUEST_FAILED', message: '요청을 처리하지 못했습니다. 입력값과 실행 연결을 확인하세요.' } };
        }
        send(reply);
      })();
      pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {});
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No product endpoint.');
  port = address.port;
  origins.add(`http://127.0.0.1:${port}`); origins.add(`http://localhost:${port}`);
  return { port, url: `ws://127.0.0.1:${port}/ws`,
    async close() {
      closing = true;
      for (const socket of sockets.clients) socket.terminate();
      sockets.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
    async drain() { await Promise.allSettled([...pending]); },
  };
}
