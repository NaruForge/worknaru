import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));

export async function startDevServers({ webPort = 15173, daemonPort = 4310, workspace = '.', dataDir = '.worknaru-dev/paseo-v1', codexPath, testMode = false }) {
  if (webPort === daemonPort && webPort !== 0) throw new Error('UI and Daemon need different ports.');
  const [{ startApplication, resolveCodexExecutable }, { createServer }] = await Promise.all([import('../dist/application.js'), import('vite')]);
  let app, web, closing;
  const close = () => closing ??= (async () => {
    let error;
    try { await web?.close(); } catch (caught) { error = caught; }
    try { await app?.close(); } catch (caught) { error = caught; }
    if (error) throw error;
  })();
  try {
    // Start Vite first so a conflicting UI port never launches a private runtime.
    web = await createServer({ configFile: join(root, 'vite.config.ts'),
      server: { host: '127.0.0.1', port: webPort, strictPort: true, open: false, preTransformRequests: false },
      plugins: [{ name: 'worknaru-local-endpoint',
        transformIndexHtml: () => app ? [{ tag: 'meta', attrs: { name: 'worknaru-daemon', content: app.url }, injectTo: 'head' }] : [],
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            const address = server.httpServer.address();
            const port = typeof address === 'object' && address ? address.port : webPort;
            const origin = `http://127.0.0.1:${port}`;
            if (request.headers.host !== `127.0.0.1:${port}` || (request.headers.origin && request.headers.origin !== origin)) {
              response.writeHead(403); response.end(); return;
            }
            next();
          });
        },
      }],
    });
    await web.listen();
    const actualWebPort = web.httpServer.address().port;
    const localUrl = `http://127.0.0.1:${actualWebPort}/`;
    app = await startApplication({ projectRoot: root, dataDir, workspace, port: daemonPort,
      origins: [new URL(localUrl).origin], codexPath: resolveCodexExecutable(root, codexPath), testMode });
    return { app, localUrl, close };
  } catch (error) { await close(); throw error; }
}

async function command(executable, args) {
  const child = spawn(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Command failed (${code}).`))); });
}
async function main() {
  const { values } = parseArgs({ options: {
    'web-port': { type: 'string', default: '15173' }, 'daemon-port': { type: 'string', default: '4310' },
    workspace: { type: 'string', default: '.' }, 'data-dir': { type: 'string', default: '.worknaru-dev/paseo-v1' },
    'codex-path': { type: 'string' }, 'no-open': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('npm run dev -- [--web-port 15173] [--daemon-port 4310] [--workspace .] [--data-dir .worknaru-dev/paseo-v1] [--codex-path <codex.exe>] [--no-open]\n종료: Ctrl+C (진행 중인 실행도 중단합니다)'); return;
  }
  const ports = [values['web-port'], values['daemon-port']].map(Number);
  if (ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535) || ports[0] === ports[1]) throw new Error('서로 다른 1~65535 포트를 지정하세요.');
  let servers, stopRequested = false, stopping, failed = false;
  const stop = () => {
    stopRequested = true;
    if (!servers) return;
    return stopping ??= (async () => {
      try { await servers.close(); } catch (error) { failed = true; console.error(error.message); }
      console.log(JSON.stringify({ type: 'stopped', clean: !failed })); process.exit(failed ? 1 : 0);
    })();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  process.on('message', message => { if (message?.type === 'stop') void stop(); }); process.on('disconnect', stop);
  if (!process.env.npm_execpath) throw new Error('Use npm run dev to build and launch.');
  console.log('최신 코드를 빌드합니다…');
  await command(process.execPath, [process.env.npm_execpath, 'run', 'build']);
  if (stopRequested) return;
  servers = await startDevServers({ webPort: ports[0], daemonPort: ports[1], workspace: values.workspace,
    dataDir: values['data-dir'], codexPath: values['codex-path'], testMode: process.env.WORKNARU_TEST_MODEL_POLICY === '1' });
  void servers.app.exited.then(() => { if (!stopRequested) { failed = true; console.error('Private runtime exited.'); void stop(); } });
  if (stopRequested) { await stop(); return; }
  console.log(JSON.stringify({ type: 'ready', protocol: 2, webUrl: servers.localUrl, url: servers.app.url, runtimePid: servers.app.runtimePid }));
  console.log('종료: 이 터미널에서 Ctrl+C');
  if (!values['no-open']) {
    // This browser is intentionally visible for the user; no background helper window is opened.
    await command('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Start-Process '${servers.localUrl}'`])
      .catch(() => console.log(`브라우저에서 ${servers.localUrl}을 여세요.`));
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`개발 실행 실패: ${error.message}`); process.exitCode = 1; });
}
