import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const route = '/__worknaru_dev';

// Both servers belong to this invocation. No PID files or process-name searches.
export async function startDevServers({ daemonOptions, webPort = 15173, onStopped = () => {} }) {
  const [{ startDaemon }, { createServer }] = await Promise.all([import('../dist/daemon.js'), import('vite')]);
  const origin = `http://127.0.0.1:${webPort}`;
  const daemon = await startDaemon({ ...daemonOptions, projectRoot: root, origins: [origin] });
  const httpServer = createHttpServer();
  const sockets = new Set();
  httpServer.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  let web;
  let closing;
  let daemonClosing;
  let servicesClosing;
  const closeDaemon = () => daemonClosing ??= daemon.close();
  const closeServices = () => servicesClosing ??= (async () => {
    const confirmed = await closeDaemon();
    await web?.close();
    return confirmed;
  })();
  const close = () => closing ??= (async () => {
    let confirmed = false;
    try { confirmed = await closeServices(); }
    finally {
      const httpClosed = new Promise((resolveClose) => httpServer.close(resolveClose));
      for (const socket of sockets) socket.destroy();
      await httpClosed;
      onStopped(confirmed);
    }
    return confirmed;
  })();
  const expected = Buffer.from(`Bearer ${daemonOptions.token}`);
  const reply = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  try {
    web = await createServer({
      configFile: join(root, 'vite.config.ts'),
      // The launcher owns signals and HTTP lifetime; Vite must not exit the process.
      // Disable speculative transforms so immediate shutdown before opening a tab
      // does not wait on dependency requests that no browser will finish.
      server: { host: '127.0.0.1', port: webPort, strictPort: true, open: false,
        middlewareMode: true, ws: { server: httpServer }, preTransformRequests: false },
      plugins: [{
        name: 'worknaru-dev-lifecycle',
        transformIndexHtml: () => [
          { tag: 'meta', attrs: { name: 'worknaru-dev-endpoint', content: daemon.url }, injectTo: 'head' },
          { tag: 'meta', attrs: { name: 'worknaru-dev-instance', content: daemon.daemonInstanceId }, injectTo: 'head' },
        ],
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith(route)) { next(); return; }
            const supplied = Buffer.from(req.headers.authorization ?? '');
            if (req.headers.host !== `127.0.0.1:${webPort}` ||
                (req.headers.origin !== undefined && req.headers.origin !== origin) ||
                req.headers['x-worknaru-dev-instance'] !== daemon.daemonInstanceId ||
                supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
              reply(res, 403, { error: '이번 개발 실행의 연결 키가 필요합니다.' }); return;
            }
            if (daemonClosing) { reply(res, 409, { error: '종료가 이미 진행 중입니다.' }); return; }
            try {
              if (req.url === `${route}/status` && req.method === 'GET') {
                reply(res, 200, { activeRuns: daemon.activeRunCount() }); return;
              }
              if (req.url !== `${route}/stop` || req.method !== 'POST') {
                reply(res, 404, { error: '지원하지 않는 개발 요청입니다.' }); return;
              }
              // Recheck every Run, including other tabs, immediately before closing.
              const activeRuns = daemon.activeRunCount();
              if (activeRuns && req.headers['x-worknaru-confirm-stop'] !== 'yes') {
                reply(res, 409, { activeRuns }); return;
              }
              const done = closeServices(); // Synchronously blocks new Daemon work.
              void done.then((confirmed) => {
                const finish = () => { void close().catch(() => { process.exitCode = 1; }); };
                res.once('finish', finish);
                res.once('close', finish);
                reply(res, confirmed ? 200 : 500, confirmed ? { stopped: true } : { error: 'AI 프로세스 정리를 확인하지 못했습니다. 다시 실행할 때 복구 결과를 확인하세요.' });
                if (res.destroyed) finish();
              }, () => {
                reply(res, 500, { error: '종료 결과를 확인하지 못했습니다. 터미널의 오류를 확인하세요.' });
                void close().catch(() => { process.exitCode = 1; });
              });
            } catch { reply(res, 500, { error: '개발 서버 상태를 확인하지 못했습니다.' }); }
          });
        },
      }],
    });
    httpServer.on('request', web.middlewares);
    httpServer.listen(webPort, '127.0.0.1');
    await once(httpServer, 'listening');
    const response = await fetch(origin, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('UI 준비 확인에 실패했습니다.');
    await response.arrayBuffer();
    return { origin, daemon, close };
  } catch (error) { await close(); throw error; }
}

function command(executable, args, { input, capture = false, signal } = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, signal, stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'] });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stdin?.on('error', () => {});
    if (input !== undefined) child.stdin.end(input);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolveCommand(output.trim()) : reject(new Error(`${executable} 실행 실패 (${code})`)));
  });
}

async function main() {
  const { values } = parseArgs({ options: {
    'web-port': { type: 'string', default: '15173' }, 'daemon-port': { type: 'string', default: '4310' },
    'data-dir': { type: 'string', default: '.worknaru-dev' }, workspace: { type: 'string', default: '.' },
    'codex-path': { type: 'string' }, 'no-open': { type: 'boolean' }, 'no-clipboard': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('npm run dev -- [--web-port 15173] [--daemon-port 4310] [--workspace .] [--data-dir .worknaru-dev] [--codex-path <codex.exe>] [--no-open] [--no-clipboard]\n종료: UI의 개발 서버 종료 버튼 또는 Ctrl+C'); return;
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (process.platform !== 'win32' || major !== 24 || minor < 18) throw new Error('Windows와 Node.js 24.18 이상 24.x가 필요합니다.');
  const ports = [values['web-port'], values['daemon-port']].map(Number);
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) || ports[0] === ports[1]) throw new Error('서로 다른 1~65535 포트를 지정하세요.');
  const token = process.env.WORKNARU_TOKEN ?? randomBytes(32).toString('base64url');
  if (!/^[a-zA-Z0-9_-]{43,128}$/.test(token)) throw new Error('WORKNARU_TOKEN에는 32바이트 이상의 무작위 base64url 연결 키를 지정하세요.');
  if (values['no-clipboard'] && !process.env.WORKNARU_TOKEN) throw new Error('--no-clipboard 사용 시 WORKNARU_TOKEN을 먼저 설정하세요.');
  const require = createRequire(import.meta.url);
  try { for (const name of ['typescript', 'vite', '@agentclientprotocol/codex-acp']) require.resolve(name); }
  catch { throw new Error('먼저 npm ci --cache .npm-cache --ignore-scripts를 실행하세요.'); }
  const abort = new AbortController();
  let servers;
  const stop = () => { abort.abort(); void servers?.close().catch(() => { process.exitCode = 1; }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const run = (executable, args, options) => command(executable, args, { ...options, signal: abort.signal });
  await run('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { capture: true });
  const codexPath = resolve(root, values['codex-path'] ?? process.env.WORKNARU_CODEX_PATH ?? await run('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "(Get-Command codex.exe -CommandType Application -ErrorAction Stop).Source"], { capture: true }));
  if (!existsSync(codexPath)) throw new Error('Codex 실행 파일을 찾지 못했습니다. --codex-path로 지정하세요.');
  process.chdir(root);
  console.log('최신 코드를 빌드합니다…');
  const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
  await run(process.execPath, [compiler]);
  await run(process.execPath, [compiler, '-p', 'tsconfig.web.json']);
  const { build } = await import('vite');
  await build({ configFile: join(root, 'vite.config.ts') });
  abort.signal.throwIfAborted();
  let stopped = false;
  servers = await startDevServers({ webPort: ports[0], daemonOptions: {
    token, port: ports[1], dataDirectory: values['data-dir'], workspaceDirectory: resolve(values.workspace), acp: { codexPath },
  }, onStopped(confirmed) {
    stopped = true;
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (!confirmed) process.exitCode = 1;
    console.log(confirmed ? '개발 서버가 종료되었습니다. 대화와 설정은 보존했습니다.' : '서버를 닫았으나 AI 프로세스 정리를 확인하지 못했습니다.');
  } });
  try {
    if (abort.signal.aborted) { await servers.close(); return; }
    if (!values['no-clipboard']) {
      await run('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference = "Stop"; [Console]::In.ReadToEnd() | Set-Clipboard'], { input: token });
      console.log('연결 키를 클립보드에 복사했습니다. 연결 창에 붙여넣으세요.');
    }
    if (stopped) return;
    console.log(`UI: ${servers.origin}\nDaemon: ${servers.daemon.url}\n종료: 화면의 개발 서버 종료 버튼`);
    if (!values['no-open']) await run('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = "Stop"; Start-Process '${servers.origin}'`]).catch(() => { if (!stopped) console.log(`브라우저에서 ${servers.origin}을 여세요.`); });
  } catch (error) { await servers.close(); throw error; }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error.name === 'AbortError') { console.log('개발 실행을 취소했습니다.'); return; }
    console.error(`개발 실행 실패: ${error.message}\n포트 충돌은 --web-port / --daemon-port, Codex 경로는 --codex-path로 변경할 수 있습니다.`);
    process.exitCode = 1;
  });
}
