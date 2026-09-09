import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PaseoRuntime, type RuntimeOptions } from './paseo-runtime.js';
import { PaseoChatRuntime } from './paseo-chat-runtime.js';
import { ChatStore } from './chat-store.js';
import { ChatService } from './chat-service.js';
import { startChatDaemon } from './chat-daemon.js';
import { resolveWebRoot } from './static-ui.js';

export function resolveCodexExecutable(root: string, supplied?: string) {
  return resolve(root, supplied ?? process.env.WORKNARU_CODEX_PATH ?? execFileSync('pwsh.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '(Get-Command codex.exe -CommandType Application -ErrorAction Stop).Source'],
    { encoding: 'utf8', windowsHide: true }).trim());
}

// The two launchers share this composition point. Product policy and clients only know ChatRuntime.
export async function startApplication(options: RuntimeOptions & { port: number; origins?: string[]; webUi?: boolean }) {
  const webRoot = options.webUi ? resolveWebRoot(options.projectRoot) : undefined;
  const native = await PaseoRuntime.start(options);
  let service: ChatService | undefined;
  let server: Awaited<ReturnType<typeof startChatDaemon>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const errors: unknown[] = [];
    try { await server?.close(); } catch (error) { errors.push(error); }
    try { await native.stop(); } catch (error) { errors.push(error); }
    try { await server?.drain(); } catch (error) { errors.push(error); }
    try { await service?.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Product cleanup could not be fully confirmed.');
  })();
  try {
    service = new ChatService(new PaseoChatRuntime(native), new ChatStore(native.directory), native.workspace);
    await service.start(); server = await startChatDaemon(service, { port: options.port, origins: options.origins, webRoot });
    return { url: server.url, port: server.port, workspace: native.workspace, runtimePid: native.pid, exited: native.exited, close };
  } catch (error) { await close(); throw error; }
}
