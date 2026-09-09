import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebClient } from '../dist/web-client.js';
import { startDevServers } from '../scripts/dev.mjs';
import { startDaemon } from '../dist/daemon.js';
import { fixture, connect, createSession, mutation, projectRoot, deadline } from './helpers.mjs';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function start(f, options = {}) {
  const webPort = options.webPort ?? await freePort();
  const stopped = Promise.withResolvers();
  const server = await startDevServers({ webPort, hub: options.hub, requireKey: options.requireKey ?? true, daemonOptions: {
    dataDirectory: f.data, workspaceDirectory: f.workspace, token: f.token, port: 0, ...options.daemonOptions,
  }, onStopped: stopped.resolve });
  f.cleanups.push(() => server.close());
  const headers = { Authorization: `Bearer ${f.token}`, 'X-WorkNaru-Dev-Instance': server.daemon.daemonInstanceId, Origin: server.origin };
  return { ...server, stopped: stopped.promise, headers, request: (path, overrides = {}) => fetch(`${server.origin}/__worknaru_dev/${path}`, {
    method: path === 'stop' ? 'POST' : 'GET', headers, ...overrides,
  }) };
}

test('dev lifecycle authenticates its instance, preserves data and stops both listeners', async (t) => {
  const f = fixture(t);
  let server = await start(f);
  const html = await (await fetch(server.origin)).text();
  assert.ok(html.includes('worknaru-dev-instance'));
  assert.ok(html.includes(server.daemon.url));
  assert.equal(html.includes(f.token), false);
  const client = await connect(f, server.daemon);
  const session = await createSession(client, server.daemon.workspace.workspaceId);
  await client.call('messages.append', { sessionId: session.sessionId, text: '개발 종료 후 유지' }, mutation(client));
  for (const headers of [
    {}, { ...server.headers, Authorization: 'Bearer invalid' },
    { ...server.headers, Origin: 'https://example.invalid' },
    { ...server.headers, 'X-WorkNaru-Dev-Instance': 'old-instance' },
  ]) { const response = await server.request('stop', { headers }); await response.text(); assert.equal(response.status, 403); }
  const wrongHost = await new Promise((resolve, reject) => {
    const request = httpRequest(`${server.origin}/__worknaru_dev/stop`, { method: 'POST', headers: { ...server.headers, Host: 'localhost' } }, (response) => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject); request.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await server.request('stop', { method: 'GET' })).status, 404);
  assert.deepEqual(await (await server.request('status')).json(), { activeRuns: 0 });
  const oldHeaders = server.headers;
  const epoch = server.daemon.storeEpoch;
  assert.deepEqual(await (await server.request('stop')).json(), { stopped: true });
  assert.equal(await deadline(server.stopped), true);
  await assert.rejects(fetch(server.origin));
  const ports = { webPort: Number(new URL(server.origin).port), daemonOptions: { port: Number(new URL(server.daemon.url).port) } };
  server = await start(f, ports);
  assert.equal(server.daemon.storeEpoch, epoch);
  assert.equal((await server.request('stop', { headers: oldHeaders })).status, 403);
  const nextClient = await connect(f, server.daemon);
  const messages = await nextClient.call('messages.list', { sessionId: session.sessionId });
  assert.equal(messages.result.messages[0].text, '개발 종료 후 유지');
});

test('Hub subpath relays only its daemon and retains origin and hello authentication', async (t) => {
  const f = fixture(t);
  const hub = { Id: '0123456789abcdef', BasePath: '/p/0123456789abcdef/', TailnetOrigin: 'https://bsw-home.tailec99c3.ts.net:9191' };
  const server = await start(f, { hub });
  const html = await (await fetch(server.localUrl)).text();
  assert.ok(html.includes(`${hub.BasePath}@vite/client`));
  assert.ok(html.includes(`${hub.BasePath}__worknaru_ws`));
  const url = `${server.origin.replace('http:', 'ws:')}${hub.BasePath}__worknaru_ws`;
  const remote = await connect(f, { url }, f.token, { origin: hub.TailnetOrigin });
  assert.equal(remote.ready.daemonInstanceId, server.daemon.daemonInstanceId);
  const session = await createSession(remote, server.daemon.workspace.workspaceId, 'Hub 대화');
  await remote.call('messages.append', { sessionId: session.sessionId, text: '같은 Daemon' }, mutation(remote));
  const local = await connect(f, server.daemon);
  assert.equal((await local.call('messages.list', { sessionId: session.sessionId })).result.messages[0].text, '같은 Daemon');
  const wrong = await connect(f, { url }, 'x'.repeat(43), { origin: hub.TailnetOrigin });
  assert.equal(wrong.ready.error.code, 'AUTH_FAILED');
  await assert.rejects(connect(f, { url }, f.token, { origin: 'https://untrusted.example' }));
  await assert.rejects(connect(f, { url: `${url}?unexpected=1` }, f.token, { origin: hub.TailnetOrigin }));
  await assert.rejects(new WebClient().connect(url, f.token), /연결 주소/);
  await assert.rejects(new WebClient(url).connect(url.replace(hub.Id, 'aaaaaaaaaaaaaaaa'), f.token), /연결 주소/);
  const response = await fetch(`${server.origin}${hub.BasePath}__worknaru_dev/status`, { headers: { ...server.headers, Origin: hub.TailnetOrigin } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { activeRuns: 0 });
  const stopped = await fetch(`${server.origin}${hub.BasePath}__worknaru_dev/stop`, { method: 'POST', headers: { ...server.headers, Origin: hub.TailnetOrigin } });
  assert.deepEqual(await stopped.json(), { stopped: true });
  assert.equal(await deadline(server.stopped), true);
});

for (const hub of [undefined, { Id: '0123456789abcdef', BasePath: '/p/0123456789abcdef/', TailnetOrigin: 'https://bsw-home.tailec99c3.ts.net:9191' }]) {
  test(`development ${hub ? 'Hub' : 'local'} connects and stops without a key while checking origin, instance and protocol`, async (t) => {
    const f = fixture(t);
    const server = await start(f, { requireKey: false, hub, daemonOptions: { token: undefined } });
    const html = await (await fetch(server.localUrl)).text();
    assert.match(html, /name="worknaru-dev-auth" content="none"/);
    const url = hub ? `${server.origin.replace('http:', 'ws:')}${hub.BasePath}__worknaru_ws` : server.daemon.url;
    const origin = hub?.TailnetOrigin ?? server.origin;
    const client = await connect(f, { url }, null, { origin });
    client.send({ type: 'hello', protocolMajor: 1 });
    const ready = await client.receive();
    assert.equal(ready.type, 'ready');
    const session = await createSession({ ...client, ready }, server.daemon.workspace.workspaceId);
    assert.ok(session.sessionId);
    const version = await connect(f, { url }, null, { origin });
    version.send({ type: 'hello', protocolMajor: 99 });
    assert.equal((await version.receive()).error.code, 'PROTOCOL_MISMATCH');
    await assert.rejects(connect(f, { url }, null, { origin: 'https://untrusted.example' }));
    const route = `${server.localUrl}__worknaru_dev`;
    const headers = { Origin: origin, 'X-WorkNaru-Dev-Instance': ready.daemonInstanceId };
    for (const invalid of [{ ...headers, Origin: 'https://untrusted.example' }, { ...headers, 'X-WorkNaru-Dev-Instance': 'old-instance' }]) {
      assert.equal((await fetch(`${route}/stop`, { method: 'POST', headers: invalid })).status, 403);
    }
    assert.equal((await fetch(`${route}/status`, { headers })).status, 200);
    assert.deepEqual(await (await fetch(`${route}/stop`, { method: 'POST', headers })).json(), { stopped: true });
    assert.equal(await deadline(server.stopped), true);
  });
}

test('unconfirmed cleanup is an error response and never a successful shutdown', async (t) => {
  const f = fixture(t);
  const server = await start(f);
  const originalClose = server.daemon.close;
  server.daemon.close = async () => { await originalClose(); return false; };
  const response = await server.request('stop');
  assert.equal(response.status, 500);
  const result = await response.json();
  assert.equal(result.stopped, undefined);
  assert.match(result.error, /정리를 확인하지 못했습니다/);
  assert.equal(await deadline(server.stopped), false);
});

test('UI port collision closes the newly opened daemon and releases its data lock', async (t) => {
  const f = fixture(t);
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  f.cleanups.push(() => new Promise((resolve) => occupied.close(resolve)));
  await assert.rejects(start(f, { webPort: occupied.address().port }), /EADDRINUSE/);
  const daemon = await startDaemon({ projectRoot, dataDirectory: f.data, workspaceDirectory: f.workspace, token: f.token });
  f.cleanups.push(() => daemon.close());
  assert.equal(occupied.listening, true);
  const client = await connect(f, daemon);
  assert.ok(client.ready);
});

test('shutdown checks all runs, rechecks after status, and cleans an active ACP tree', async (t) => {
  const f = fixture(t);
  const log = join(f.root, 'agent.log');
  const server = await start(f, { daemonOptions: { acp: { command: {
    executable: process.execPath, arguments: [join(projectRoot, 'tests/fake-acp.mjs')], cwd: f.workspace,
    env: { ...process.env, TEST_AGENT_LOG: log, TEMP: f.root, TMP: f.root },
  } } } });
  const client = await connect(f, server.daemon);
  await client.call('ai.get', {});
  assert.deepEqual(await (await server.request('status')).json(), { activeRuns: 0 });
  const session = await createSession(client, server.daemon.workspace.workspaceId);
  const run = await client.call('runs.start', { sessionId: session.sessionId, text: 'wait' }, mutation(client));
  assert.equal(run.ok, true);
  await deadline((async () => {
    while (!readFileSync(log, 'utf8').includes('descendant')) await new Promise((resolve) => setTimeout(resolve, 30));
  })());
  const rejected = await server.request('stop');
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), { activeRuns: 1 });
  assert.equal((await client.call('runs.get', { runId: run.result.run.runId })).result.state, 'running');
  const stopped = await server.request('stop', { headers: { ...server.headers, 'X-WorkNaru-Confirm-Stop': 'yes' } });
  assert.equal(stopped.status, 200);
  await stopped.json();
  assert.equal(await deadline(server.stopped), true);
  const pids = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter((item) => ['spawn', 'descendant'].includes(item.type)).map((item) => item.pid);
  for (const pid of pids) {
    try { assert.throws(() => process.kill(pid, 0), /ESRCH/); }
    catch (error) {
      const current = execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        'Get-Process -Id $env:WORKNARU_TEST_PID -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime | ConvertTo-Json -Compress'],
      { windowsHide: true, encoding: 'utf8', env: { ...process.env, WORKNARU_TEST_PID: String(pid) } });
      error.message += `; expected retired PID ${pid}; current process: ${current.trim() || 'already exited'}`;
      throw error;
    }
  }
  const restarted = await start(f);
  const reader = await connect(f, restarted.daemon);
  assert.equal((await reader.call('runs.get', { runId: run.result.run.runId })).result.state, 'cancelled');
});

test('development server serves UI sources but rejects private workspace data', { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  const marker = join(f.root, 'private-probe.txt');
  writeFileSync(marker, 'PRIVATE_TEST_MARKER');
  const server = spawn(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), '--port', '0', '--strictPort'], {
    cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEMP: f.root, TMP: f.root },
  });
  const exited = once(server, 'exit');
  f.cleanups.push(async () => { if (server.exitCode === null) server.kill(); await deadline(exited); });
  server.stderr.resume();
  const origin = await deadline(new Promise((resolve, reject) => {
    let output = '';
    server.stdout.on('data', (chunk) => { output += chunk; const found = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (found) resolve(found[0]); });
    server.once('error', reject);
    server.once('exit', () => reject(new Error('Development server exited before ready')));
  }));
  for (const path of ['/', '/main.tsx', '/workspace.tsx']) { const response = await fetch(origin + path, { signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 200); await response.text(); }
  const response = await fetch(origin + '/@fs/' + marker.replaceAll('\\', '/'), { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 403);
  assert.equal((await response.text()).includes('PRIVATE_TEST_MARKER'), false);
});
