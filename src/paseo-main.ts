import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkoutRoot } from './paths.js';
import { PaseoRuntime } from './paseo-runtime.js';
import { PaseoChatRuntime } from './paseo-chat-runtime.js';
import { ChatStore } from './chat-store.js';
import { ChatService } from './chat-service.js';
import { startChatDaemon } from './chat-daemon.js';
import { resolveWebRoot } from './static-ui.js';

const { values } = parseArgs({ options: {
  'data-dir': { type: 'string', default: '.worknaru-dev/paseo-v1' }, workspace: { type: 'string', default: '.' },
  port: { type: 'string', default: '4310' }, origin: { type: 'string', multiple: true },
  'codex-path': { type: 'string' }, 'web-ui': { type: 'boolean', default: false },
} });
const root = checkoutRoot(import.meta.url);
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
const executable = values['codex-path'] ?? process.env.WORKNARU_CODEX_PATH ?? execFileSync('pwsh.exe',
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '(Get-Command codex.exe -ErrorAction Stop).Source'], { encoding: 'utf8', windowsHide: true }).trim();
const webRoot = values['web-ui'] ? resolveWebRoot(root) : undefined;
const native = await PaseoRuntime.start({ projectRoot: root, dataDir: values['data-dir']!, workspace: values.workspace!,
  codexPath: resolve(executable), testMode: process.env.WORKNARU_TEST_MODEL_POLICY === '1' });
const service = new ChatService(new PaseoChatRuntime(native), new ChatStore(native.directory), native.workspace);
let server: Awaited<ReturnType<typeof startChatDaemon>> | undefined;
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  let failed = false;
  try { await server?.close(); } catch { failed = true; }
  try { await native.stop(); } catch (error) { failed = true; console.error((error as Error).message); }
  try { await server?.drain(); await service.close(); } catch { failed = true; }
  console.log(JSON.stringify({ type: 'stopped', clean: !failed }));
  process.exit(failed ? 1 : 0);
}
process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
void native.exited.then(() => { if (!stopping) { console.error('Private runtime exited.'); void stop(); } });
try {
  await service.start();
  server = await startChatDaemon(service, { port, origins: values.origin, webRoot });
  console.log(JSON.stringify({ type: 'ready', protocol: 2, url: server.url, workspace: native.workspace }));
} catch (error) { console.error((error as Error).message); await stop(); }
