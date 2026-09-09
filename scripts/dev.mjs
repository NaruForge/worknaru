import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));

// Both servers belong to this invocation. No PID files or process-name searches.
export async function startDevServers({ daemonOptions, webPort = 15173, hub, onStopped = () => {} }) {
  const [{ startDaemon }, { createServer }] = await Promise.all([import('../dist/daemon.js'), import('vite')]);
  const origin = `http://127.0.0.1:${webPort}`;
  if (hub && (!/^[a-f0-9]{16}$/.test(hub.Id) || hub.BasePath !== `/p/${hub.Id}/` || hub.TailnetOrigin !== 'https://bsw-home.tailec99c3.ts.net:9191')) throw new Error('올바른 Hub 경로가 필요합니다.');
  const base = hub?.BasePath ?? '/';
  const route = `${base}__worknaru_dev`;
  const relayPath = `${base}__worknaru_ws`;
  const allowedOrigins = new Set([origin, ...(hub ? [hub.TailnetOrigin, 'http://127.0.0.1:9191'] : [])]);
  const daemon = await startDaemon({ ...daemonOptions, projectRoot: root, origins: [origin] });
  const httpServer = createHttpServer();
  httpServer.headersTimeout = 5_000;
  httpServer.requestTimeout = 10_000;
  httpServer.maxConnections = 64;
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
      await onStopped(confirmed);
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
      base,
      // The launcher owns signals and HTTP lifetime; Vite must not exit the process.
      // Disable speculative transforms so immediate shutdown before opening a tab
      // does not wait on dependency requests that no browser will finish.
      server: { host: '127.0.0.1', port: webPort, strictPort: true, open: false,
        middlewareMode: true, ws: { server: httpServer }, preTransformRequests: false },
      plugins: [{
        name: 'worknaru-dev-lifecycle',
        transformIndexHtml: () => [
          { tag: 'meta', attrs: { name: 'worknaru-dev-endpoint', content: hub ? relayPath : daemon.url }, injectTo: 'head' },
          { tag: 'meta', attrs: { name: 'worknaru-dev-base', content: base }, injectTo: 'head' },
          { tag: 'meta', attrs: { name: 'worknaru-dev-instance', content: daemon.daemonInstanceId }, injectTo: 'head' },
        ],
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith(route)) { next(); return; }
            const supplied = Buffer.from(req.headers.authorization ?? '');
            if (req.headers.host !== `127.0.0.1:${webPort}` ||
                (req.headers.origin !== undefined && !allowedOrigins.has(req.headers.origin)) ||
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
    if (hub) httpServer.on('upgrade', (request, socket, head) => {
      if (request.url !== relayPath) {
        // Vite owns only its base-path HMR socket; do not retain unknown upgrades.
        const pathname = request.url?.split('?')[0];
        if (pathname === base && ['vite-hmr', 'vite-ping'].includes(request.headers['sec-websocket-protocol'])) return;
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
      }
      if (daemonClosing || request.headers.host !== `127.0.0.1:${webPort}` ||
          !allowedOrigins.has(request.headers.origin) || request.headers.upgrade?.toLowerCase() !== 'websocket') {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
      }
      // Only this Daemon is reachable. Its original hello/token authentication
      // and protocol limits remain in force; no arbitrary forwarding target.
      const upstream = connectTcp({ host: '127.0.0.1', port: Number(new URL(daemon.url).port) });
      sockets.add(upstream);
      upstream.once('close', () => { sockets.delete(upstream); socket.destroy(); });
      socket.once('close', () => upstream.destroy());
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      upstream.once('connect', () => {
        const headers = [`GET /ws HTTP/1.1`, `Host: ${new URL(daemon.url).host}`, 'Connection: Upgrade', 'Upgrade: websocket', `Origin: ${origin}`];
        for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']) {
          if (typeof request.headers[name] === 'string') headers.push(`${name}: ${request.headers[name]}`);
        }
        upstream.write(`${headers.join('\r\n')}\r\n\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
    });
    httpServer.on('request', web.middlewares);
    httpServer.listen(webPort, '127.0.0.1');
    await once(httpServer, 'listening');
    const response = await fetch(`${origin}${base}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('UI 준비 확인에 실패했습니다.');
    await response.arrayBuffer();
    return { origin, localUrl: `${origin}${base}`, daemon, close };
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
    'codex-path': { type: 'string' }, hub: { type: 'boolean' }, 'no-open': { type: 'boolean' }, 'no-clipboard': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('npm run dev -- [--hub] [--web-port 15173] [--daemon-port 4310] [--workspace .] [--data-dir .worknaru-dev] [--codex-path <codex.exe>] [--no-open] [--no-clipboard]\n--hub: 기존 Tailnet Preview Hub에 20분 연결\n종료: UI의 개발 서버 종료 버튼 또는 Ctrl+C'); return;
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
  const hubCommand = async (mode, id) => JSON.parse(await command('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(root, 'scripts/dev-hub.ps1'), '-Mode', mode, '-Port', String(ports[0]), '-DaemonPort', String(ports[1]), ...(id ? ['-Id', id] : [])], { capture: true }));
  await run('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { capture: true });
  const codexPath = resolve(root, values['codex-path'] ?? process.env.WORKNARU_CODEX_PATH ?? await run('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "(Get-Command codex.exe -CommandType Application -ErrorAction Stop).Source"], { capture: true }));
  if (!existsSync(codexPath)) throw new Error('Codex 실행 파일을 찾지 못했습니다. --codex-path로 지정하세요.');
  const hub = values.hub ? await hubCommand('Prepare') : undefined;
  if (hub) console.log(`Hub 연결 준비: 9191 Tailnet 전용 · 백엔드 ${hub.HubRunning ? '실행 중' : '연결 시 시작'} · UI 127.0.0.1:${ports[0]}`);
  process.chdir(root);
  console.log('최신 코드를 빌드합니다…');
  const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
  await run(process.execPath, [compiler]);
  await run(process.execPath, [compiler, '-p', 'tsconfig.web.json']);
  const { build } = await import('vite');
  await build({ configFile: join(root, 'vite.config.ts') });
  abort.signal.throwIfAborted();
  let stopped = false;
  let attachment;
  let attaching;
  servers = await startDevServers({ webPort: ports[0], hub, daemonOptions: {
    token, port: ports[1], dataDirectory: values['data-dir'], workspaceDirectory: resolve(values.workspace), acp: { codexPath },
  }, async onStopped(confirmed) {
    stopped = true;
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (!confirmed) process.exitCode = 1;
    if (attaching) await attaching.catch(() => {});
    if (attachment) await hubCommand('Detach', hub.Id).catch(() => {
      process.exitCode = 1;
      console.error(`Hub 공유 해제를 확인하지 못했습니다. Dashboard에서 Preview ${hub.Id}를 해제하세요.`);
    });
    console.log(confirmed ? '개발 서버가 종료되었습니다. 대화와 설정은 보존했습니다.' : '서버를 닫았으나 AI 프로세스 정리를 확인하지 못했습니다.');
  } });
  try {
    if (abort.signal.aborted) { await servers.close(); return; }
    if (hub) {
      attaching = hubCommand('Attach', hub.Id).then((result) => { attachment = result; return result; });
      await attaching;
      if (stopped) return;
      console.log(`Hub: ${attachment.TailnetUrl}\n종류: attached-dev-server · 만료: ${attachment.ExpiresAt}\n공유만 해제해도 개발 서버는 계속 실행됩니다.`);
      console.log(`20분 연장: & 'C:\\Projects\\TailscaleOps\\scripts\\artifact-preview\\Extend-ArtifactPreview.ps1' -Id ${hub.Id} -Minutes 20\n공유 해제: & 'C:\\Projects\\TailscaleOps\\scripts\\artifact-preview\\Detach-ArtifactDevServer.ps1' -Id ${hub.Id}`);
    }
    if (!values['no-clipboard']) {
      await run('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference = "Stop"; [Console]::In.ReadToEnd() | Set-Clipboard'], { input: token });
      console.log('연결 키를 클립보드에 복사했습니다. 연결 창에 붙여넣으세요.');
    }
    if (stopped) return;
    console.log(`UI: ${servers.localUrl}\nDaemon: ${servers.daemon.url}\n종료: 화면의 개발 서버 종료 버튼`);
    if (!values['no-open']) await run('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = "Stop"; Start-Process '${servers.localUrl}'`]).catch(() => { if (!stopped) console.log(`브라우저에서 ${servers.localUrl}을 여세요.`); });
  } catch (error) { await servers.close(); throw error; }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error.name === 'AbortError') { console.log('개발 실행을 취소했습니다.'); return; }
    console.error(`개발 실행 실패: ${error.message}\n포트 충돌은 --web-port / --daemon-port, Codex 경로는 --codex-path로 변경할 수 있습니다.`);
    process.exitCode = 1;
  });
}
