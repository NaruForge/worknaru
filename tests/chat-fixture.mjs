import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ChatStore } from '../dist/chat-store.js';
import { ChatService } from '../dist/chat-service.js';
import { startChatDaemon } from '../dist/chat-daemon.js';
import { FakeChatRuntime } from './fake-chat-runtime.mjs';

export async function chatFixture(origins = []) {
  const directory = join(process.cwd(), '.worknaru-test', `chat-fixture-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const runtime = new FakeChatRuntime(); runtime.autoFinish = true;
  const store = new ChatStore(directory), service = new ChatService(runtime, store, directory);
  await service.start();
  const server = await startChatDaemon(service, { port: 0, origins });
  return { directory, runtime, store, service, server,
    async close() { await server.close(); runtime.close(); await server.drain(); await service.close(); } };
}
