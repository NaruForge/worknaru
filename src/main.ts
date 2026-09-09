import { parseArgs } from 'node:util';
import { checkoutRoot } from './paths.js';
import { startApplication, resolveCodexExecutable } from './application.js';

const { values } = parseArgs({ options: {
  'data-dir': { type: 'string', default: '.worknaru-dev/paseo-v1' }, workspace: { type: 'string', default: '.' },
  port: { type: 'string', default: '4310' }, origin: { type: 'string', multiple: true },
  'codex-path': { type: 'string' }, 'web-ui': { type: 'boolean', default: false }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('npm start -- [--web-ui] [--port 4310] [--workspace .] [--data-dir .worknaru-dev/paseo-v1] [--codex-path <codex.exe>] [--origin <http://127.0.0.1:port>]\n종료: Ctrl+C (진행 중인 실행도 중단합니다)');
  process.exit(0);
}
const root = checkoutRoot(import.meta.url), port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
let app: Awaited<ReturnType<typeof startApplication>> | undefined;
let stopRequested = false, failed = false, stopping: Promise<void> | undefined;
function stop() {
  stopRequested = true;
  if (!app) return;
  return stopping ??= (async () => {
    try { await app!.close(); } catch (error) { failed = true; console.error((error as Error).message); }
    console.log(JSON.stringify({ type: 'stopped', clean: !failed }));
    process.exit(failed ? 1 : 0);
  })();
}
process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
// A parent-owned process uses IPC; no shutdown method is exposed on the product socket.
process.on('message', message => { if ((message as { type?: string })?.type === 'stop') void stop(); });
process.on('disconnect', () => { void stop(); });
try {
  app = await startApplication({ projectRoot: root, dataDir: values['data-dir']!, workspace: values.workspace!, port,
    codexPath: resolveCodexExecutable(root, values['codex-path']), origins: values.origin, webUi: values['web-ui'],
    testMode: process.env.WORKNARU_TEST_MODEL_POLICY === '1' });
  void app.exited.then(() => { if (!stopRequested) { failed = true; console.error('Private runtime exited.'); void stop(); } });
  if (stopRequested) await stop();
  else console.log(JSON.stringify({ type: 'ready', protocol: 2, url: app.url, workspace: app.workspace, runtimePid: app.runtimePid,
    ...(values['web-ui'] ? { webUrl: `http://127.0.0.1:${app.port}/` } : {}) }));
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
