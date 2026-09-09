import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startDaemon } from '../dist/daemon.js';
import { EXIT, requestOps } from '../dist/ops-client.js';
import { APP_VERSION, identityProof, OPS_TOKEN_FILE, RUNTIME_FILE } from '../dist/runtime-state.js';
import { connect, createSession, deadline, fixture, mutation, projectRoot } from './helpers.mjs';

const cliPath = join(projectRoot, 'dist/cli.js');
const acpEntry = join(projectRoot, 'tests/cli-acp-entry.mjs');
const signalEntry = join(projectRoot, 'tests/cli-signal-entry.mjs');
const bundledUi = existsSync(join(projectRoot, 'dist', 'web', 'index.html'));
const rel = (path) => relative(projectRoot, path);

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function invoke(f, args, options = {}) {
  const child = spawn(process.execPath, [options.entry ?? cliPath, ...args], {
    cwd: options.cwd ?? projectRoot,
    env: { ...process.env, WORKNARU_TOKEN: options.token ?? f.token, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = deadline(once(child, 'exit').then(([code, signal]) => ({ code, signal, stdout, stderr })), options.timeout ?? 15_000);
  f.cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done.catch(() => {});
  });
  return done;
}

async function startCli(f, extra = [], options = {}) {
  const entry = options.entry ?? signalEntry;
  const args = entry === acpEntry
    ? [entry, '--data-dir', rel(f.data), '--workspace', f.workspace, '--port', '0', ...extra]
    : [entry, 'daemon', 'start', '--data-dir', options.absolutePaths ? f.data : rel(f.data), '--workspace', options.absolutePaths ? f.workspace : rel(f.workspace), '--port', '0', ...extra];
  const child = spawn(process.execPath, args, {
    cwd: options.cwd ?? projectRoot,
    env: { ...process.env, WORKNARU_TOKEN: f.token, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = once(child, 'exit');
  f.cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null && child.connected) child.send('interrupt', () => {});
    try { await deadline(exit, 30_000); }
    catch (error) { child.kill('SIGKILL'); await exit; throw error; }
  });
  const ready = await deadline(new Promise((resolve, reject) => {
    const onData = () => {
      if (!stdout.includes('\n')) return;
      try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`CLI exited before ready: ${stderr}\n${stdout}`)));
  }));
  assert.equal(ready.type, 'daemon.ready');
  assert.equal(stdout.includes(f.token), false);
  assert.equal(stderr.includes(f.token), false);
  return { ...ready, child, stdout: () => stdout + stderr, exit };
}

function rawHttp(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1', port, path, method,
      headers: { Host: `127.0.0.1:${port}`, ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

function listenHttp(handler) {
  const server = createHttpServer(handler);
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  return {
    server, sockets,
    async start() {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      return server.address().port;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('help and version do not create data or send credentials', async (t) => {
  const f = fixture(t);
  const missing = join('.worknaru-test', `cli-absent-${randomUUID()}`);
  const help = await invoke(f, ['--help', '--data-dir', missing]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /daemon start/);
  const version = await invoke(f, ['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^worknaru /);
  assert.equal(existsSync(join(projectRoot, missing)), false);
});

test('status and stop do not create a missing data directory', async (t) => {
  const f = fixture(t);
  const missing = join('.worknaru-test', `cli-absent-${randomUUID()}`);
  const status = await invoke(f, ['daemon', 'status', '--data-dir', missing]);
  const stop = await invoke(f, ['daemon', 'stop', '--data-dir', missing]);
  assert.equal(status.code, EXIT.notRunning);
  assert.equal(stop.code, EXIT.notRunning);
  assert.match(status.stderr, /NOT_RUNNING|DATA_NOT_FOUND/);
  assert.equal(existsSync(join(projectRoot, missing)), false);
});

test('relative data-dir is resolved from the checkout root regardless of cwd', async (t) => {
  const f = fixture(t);
  const started = await startCli(f, [], { cwd: f.workspace });
  const status = await invoke(f, ['daemon', 'status', '--data-dir', rel(f.data), '--json'], { cwd: f.root });
  assert.equal(status.code, 0);
  const body = JSON.parse(status.stdout);
  assert.equal(body.instanceId, started.daemonInstanceId);
  assert.equal(body.webUi, false);
  assert.equal(body.aiExecution, false);
  const stopped = await invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data)], { cwd: dirname(f.root) });
  assert.equal(stopped.code, 0);
  assert.equal(JSON.parse(stopped.stdout).stopped, true);
  await deadline(started.exit);
});

test('a second start loses the data-dir lock and a used port is left running', async (t) => {
  const f = fixture(t);
  const first = await startCli(f);
  const second = await invoke(f, ['daemon', 'start', '--data-dir', rel(f.data), '--workspace', rel(f.workspace)]);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /DATA_IN_USE/);
  const occupied = createNetServer();
  occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  f.cleanups.push(() => new Promise((resolve) => occupied.close(resolve)));
  const port = occupied.address().port;
  const g = fixture(t);
  const conflict = await invoke(g, ['daemon', 'start', '--data-dir', rel(g.data), '--workspace', rel(g.workspace), '--port', String(port)]);
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /PORT_IN_USE/);
  assert.equal(occupied.listening, true);
  assert.equal((await invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data)])).code, 0);
});

test('CLI rejects a different Workspace while legacy startDaemon still reopens the data area', async (t) => {
  const f = fixture(t);
  const started = await startCli(f);
  assert.equal((await invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data)])).code, 0);
  await deadline(started.exit);
  const other = join(f.root, 'other-workspace');
  mkdirSync(other);
  const conflict = await invoke(f, ['daemon', 'start', '--data-dir', rel(f.data), '--workspace', rel(other)]);
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /WORKSPACE_CONFLICT/);
  const legacy = await startDaemon({ projectRoot, dataDirectory: f.data, workspaceDirectory: other, token: f.token });
  f.cleanups.push(() => legacy.close());
  assert.equal(legacy.workspace.path, other);
});

test('stale and forged discovery are not treated as a live instance', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.data, RUNTIME_FILE), JSON.stringify({
    schema: 1, instanceId: randomUUID(), dataDir: f.data, workspace: f.workspace, pid: 1,
    startedAt: new Date().toISOString(), port: 1, protocolMajor: 1, appVersion: APP_VERSION, webUi: false, aiExecution: false,
  }));
  const stale = await invoke(f, ['daemon', 'status', '--data-dir', rel(f.data)]);
  assert.equal(stale.code, EXIT.noResponse);
  writeFileSync(join(f.data, RUNTIME_FILE), '{');
  const broken = await invoke(f, ['daemon', 'status', '--data-dir', rel(f.data)]);
  assert.equal(broken.code, EXIT.targetMismatch);
  assert.match(broken.stderr, /INVALID_DISCOVERY/);
  writeFileSync(join(f.data, RUNTIME_FILE), JSON.stringify({
    schema: 1, instanceId: randomUUID(), dataDir: f.data, workspace: f.workspace, pid: 1,
    startedAt: new Date().toISOString(), port: 9, protocolMajor: 2, appVersion: APP_VERSION, webUi: false, aiExecution: false,
  }));
  const version = await invoke(f, ['daemon', 'status', '--data-dir', rel(f.data)]);
  assert.equal(version.code, EXIT.targetMismatch);
  const target = join(f.data, 'runtime-target.json');
  writeFileSync(target, '{"schema":1}');
  try { writeFileSync(join(f.data, RUNTIME_FILE), ''); } catch { /* replaced below */ }
  const link = join(f.data, `runtime-link-${randomUUID()}`);
  symlinkSync(target, link);
  const linked = join(f.data, RUNTIME_FILE);
  try { writeFileSync(linked, ''); } catch { /* exists */ }
  const g = fixture(t);
  const alias = join(g.data, RUNTIME_FILE);
  symlinkSync(target, alias);
  const symlinkStatus = await invoke(g, ['daemon', 'status', '--data-dir', rel(g.data)]);
  assert.equal(symlinkStatus.code, EXIT.targetMismatch);
  assert.match(symlinkStatus.stderr, /INVALID_DISCOVERY/);
});

test('identity mismatch does not send WORKNARU_TOKEN or the ops credential', async (t) => {
  const f = fixture(t);
  const seen = [];
  const fake = listenHttp((request, response) => {
    seen.push({ url: request.url, authorization: request.headers.authorization, origin: request.headers.origin, body: '' });
    request.on('data', (chunk) => { seen.at(-1).body += chunk; });
    if (request.url?.includes('/identify')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        type: 'worknaru.ops.identify', instanceId: randomUUID(), dataDir: f.data, workspace: f.workspace,
        protocolMajor: 1, appVersion: APP_VERSION, webUi: false, aiExecution: false, port: fake.server.address().port,
      }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  f.cleanups.push(() => fake.close());
  const port = await fake.start();
  writeFileSync(join(f.data, RUNTIME_FILE), JSON.stringify({
    schema: 1, instanceId: randomUUID(), dataDir: f.data, workspace: f.workspace, pid: 1,
    startedAt: new Date().toISOString(), port, protocolMajor: 1, appVersion: APP_VERSION, webUi: false, aiExecution: false,
  }));
  writeFileSync(join(f.data, 'ops.token'), 'A'.repeat(43));
  const status = await invoke(f, ['daemon', 'status', '--data-dir', rel(f.data)]);
  assert.equal(status.code, EXIT.targetMismatch);
  assert.equal(seen.some((item) => item.url.includes('/identify')), true);
  assert.equal(seen.some((item) => item.authorization), false);
  assert.equal(JSON.stringify(seen).includes(f.token), false);
});

test('redirects and non-loopback discovery ports are not followed with credentials', async (t) => {
  const f = fixture(t);
  const fake = listenHttp((_request, response) => {
    response.writeHead(302, { Location: 'http://example.invalid/' });
    response.end();
  });
  f.cleanups.push(() => fake.close());
  const port = await fake.start();
  writeFileSync(join(f.data, RUNTIME_FILE), JSON.stringify({
    schema: 1, instanceId: randomUUID(), dataDir: f.data, workspace: f.workspace, pid: 1,
    startedAt: new Date().toISOString(), port, protocolMajor: 1, appVersion: APP_VERSION, webUi: false, aiExecution: false,
  }));
  const redirected = await invoke(f, ['daemon', 'status', '--data-dir', rel(f.data)]);
  assert.equal(redirected.code, EXIT.targetMismatch);
  assert.match(redirected.stderr, /TARGET_MISMATCH/);
});

test('ops control rejects Origin and wrong Host; status uses the live instance', async (t) => {
  const f = fixture(t);
  const started = await startCli(f);
  const port = Number(new URL(started.url).port);
  const origin = await rawHttp(port, { path: '/__worknaru_ops/identify', headers: { Origin: 'http://127.0.0.1:9' } });
  assert.equal(origin.status, 403);
  const host = await rawHttp(port, { path: '/__worknaru_ops/identify', headers: { Host: '127.0.0.1:1' } });
  assert.equal(host.status, 403);
  const identify = await rawHttp(port, { path: '/__worknaru_ops/identify', headers: { 'X-WorkNaru-Challenge': 'a'.repeat(43) } });
  assert.equal(identify.status, 200);
  assert.equal(identify.body.includes(f.token), false);
  const status = JSON.parse((await invoke(f, ['daemon', 'status', '--data-dir', rel(f.data), '--json'])).stdout);
  assert.equal(status.instanceId, started.daemonInstanceId);
  assert.equal(status.activeRuns, 0);
  const client = await connect(f, started);
  const session = await createSession(client, started.workspace.workspaceId);
  await client.call('messages.append', { sessionId: session.sessionId, text: '운영 종료 후에도 남음' }, mutation(client));
  assert.equal((await invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data)])).code, 0);
  await deadline(started.exit);
  const restarted = await startCli(f);
  const again = await connect(f, restarted);
  const list = await again.call('messages.list', { sessionId: session.sessionId });
  assert.equal(list.result.messages[0].text, '운영 종료 후에도 남음');
});

async function descendants(f) {
  for (let i = 0; i < 400; i++) {
    const file = join(f.root, 'agent.log');
    const events = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const children = events.filter((event) => event.type === 'descendant');
    if (children.length) { assert.ok(children.every((event) => alive(event.pid))); return children; }
    await delay(25);
  }
  assert.fail('The fake ACP descendant was never started');
}

test('default stop refuses a busy run; cancel-active stops a separate CLI and cleans Windows processes', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'sample.txt'), '원래 내용\n');
  const started = await startCli(f, [], { entry: acpEntry });
  const client = await connect(f, started);
  const session = await createSession(client, started.workspace.workspaceId);
  const startedRun = await client.call('runs.start', { sessionId: session.sessionId, text: 'wait' }, mutation(client));
  assert.equal(startedRun.ok, true);
  const children = await descendants(f);
  const busy = await invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data)]);
  assert.equal(busy.code, EXIT.busy);
  assert.match(busy.stderr, /DAEMON_BUSY/);
  const cancelled = await invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data), '--cancel-active'], { timeout: 30_000 });
  assert.equal(cancelled.code, 0, cancelled.stderr);
  const [code] = await deadline(started.exit, 30_000);
  assert.equal(code, 0);
  assert.ok(children.every((event) => !alive(event.pid)));
  const log = existsSync(join(f.root, 'agent.log')) ? readFileSync(join(f.root, 'agent.log'), 'utf8') : '';
  for (const line of log.trim() ? log.trim().split('\n').map((row) => JSON.parse(row)) : []) {
    if (typeof line.pid === 'number') assert.equal(alive(line.pid), false, `pid ${line.pid} still running`);
  }
});

test('pending approval is busy; cancel-active does not apply the file', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'sample.txt'), '원래 내용\n');
  const started = await startCli(f, [], { entry: acpEntry });
  const client = await connect(f, started);
  const session = await createSession(client, started.workspace.workspaceId);
  const run = await client.call('runs.start', { sessionId: session.sessionId, text: 'edit-file' }, mutation(client));
  let pending = false;
  for (let n = 0; n < 400; n++) {
    const current = await client.call('runs.get', { runId: run.result.run.runId });
    if (current.result.tools.some((tool) => tool.state === 'pending')) { pending = true; break; }
    await delay(25);
  }
  assert.equal(pending, true, 'The file approval was never pending');
  const busy = await invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data)]);
  assert.equal(busy.code, EXIT.busy);
  assert.equal(JSON.parse(busy.stderr.trim()).pendingApprovals, 1);
  assert.match(busy.stderr, /pendingApprovals|DAEMON_BUSY/);
  assert.equal((await invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data), '--cancel-active'], { timeout: 30_000 })).code, 0);
  await deadline(started.exit, 30_000);
  assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), '원래 내용\n');
});

test('new work is rejected once stop has begun', async (t) => {
  const f = fixture(t);
  const started = await startCli(f, [], { entry: acpEntry });
  const client = await connect(f, started);
  const session = await createSession(client, started.workspace.workspaceId);
  await client.call('runs.start', { sessionId: session.sessionId, text: 'wait' }, mutation(client));
  const stopping = invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data), '--cancel-active'], { timeout: 30_000 });
  let rejected = false;
  for (let n = 0; n < 80; n++) {
    const response = await client.call('runs.start', { sessionId: session.sessionId, text: 'too-late' }, mutation(client)).catch((error) => ({ ok: false, error }));
    if (!response.ok && response.error?.code === 'DAEMON_STOPPING') { rejected = true; break; }
    await delay(25);
  }
  assert.equal((await stopping).code, 0);
  assert.equal(rejected, true);
});

test('requestOps uses a wall-clock deadline and fails closed when the body is cut off', async (t) => {
  const f = fixture(t);
  const dribble = listenHttp((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    const timer = setInterval(() => response.write(' '), 150);
    f.cleanups.push(() => clearInterval(timer));
  });
  f.cleanups.push(() => dribble.close());
  const dribblePort = await dribble.start();
  const began = Date.now();
  await assert.rejects(requestOps(dribblePort, '/__worknaru_ops/identify', { method: 'GET', timeoutMs: 400 }), { code: 'NO_RESPONSE' });
  assert.ok(Date.now() - began < 2_000);
  const cut = listenHttp((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"type":"worknaru.ops.identify"');
    response.destroy();
  });
  f.cleanups.push(() => cut.close());
  const cutPort = await cut.start();
  await assert.rejects(requestOps(cutPort, '/__worknaru_ops/identify', { method: 'GET', timeoutMs: 2_000 }), { code: 'NO_RESPONSE' });
  writeFileSync(join(f.data, RUNTIME_FILE), JSON.stringify({
    schema: 1, instanceId: randomUUID(), dataDir: f.data, workspace: f.workspace, pid: 1,
    startedAt: new Date().toISOString(), port: cutPort, protocolMajor: 1, appVersion: APP_VERSION, webUi: false, aiExecution: false,
  }));
  const status = await invoke(f, ['daemon', 'status', '--data-dir', rel(f.data)]);
  assert.equal(status.code, EXIT.noResponse);
});

test('SIGINT handler on the start process cancels actual work and exits after cleanup', async (t) => {
  const f = fixture(t);
  const started = await startCli(f, [], { entry: acpEntry });
  const client = await connect(f, started);
  const session = await createSession(client, started.workspace.workspaceId);
  assert.equal((await client.call('runs.start', { sessionId: session.sessionId, text: 'wait' }, mutation(client))).ok, true);
  const children = await descendants(f);
  started.child.send('interrupt');
  const [code] = await deadline(started.exit, 20_000);
  assert.equal(code, 0);
  assert.ok(children.every((event) => !alive(event.pid)));
  const status = await invoke(f, ['daemon', 'status', '--data-dir', rel(f.data)]);
  assert.equal(status.code, EXIT.notRunning);
});

test('stop closes the listener before completion; a replacement keeps its own runtime files', async (t) => {
  const f = fixture(t);
  const first = await startCli(f, [], { entry: acpEntry });
  const port = Number(new URL(first.url).port);
  const client = await connect(f, first);
  const session = await createSession(client, first.workspace.workspaceId);
  await client.call('runs.start', { sessionId: session.sessionId, text: 'wait' }, mutation(client));
  const stopping = invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data), '--cancel-active'], { timeout: 30_000 });
  let refused = false;
  for (let n = 0; n < 40; n++) {
    const probe = createNetServer();
    const failed = await new Promise((resolve) => {
      const socket = probe;
      const clientSocket = httpRequest({ host: '127.0.0.1', port, path: '/' }, () => resolve(false));
      clientSocket.on('error', () => resolve(true));
      clientSocket.end();
      socket.close?.();
    });
    if (failed) { refused = true; break; }
    await delay(50);
  }
  assert.equal((await stopping).code, 0);
  assert.equal(refused, true);
  await deadline(first.exit, 30_000);
  const second = await startCli(f);
  const runtime = JSON.parse(readFileSync(join(f.data, RUNTIME_FILE), 'utf8'));
  assert.equal(runtime.instanceId, second.daemonInstanceId);
  assert.notEqual(second.daemonInstanceId, first.daemonInstanceId);
});

test('unknown options, open without UI, and missing web bundle fail before listen', async (t) => {
  const f = fixture(t);
  const unknown = await invoke(f, ['daemon', 'start', '--data-dir', rel(f.data), '--workspace', rel(f.workspace), '--background']);
  assert.equal(unknown.code, EXIT.usage);
  const open = await invoke(f, ['daemon', 'start', '--data-dir', rel(f.data), '--workspace', rel(f.workspace), '--open']);
  assert.equal(open.code, EXIT.usage);
  const both = await invoke(f, ['daemon', 'start', '--data-dir', rel(f.data), '--workspace', rel(f.workspace), '--web-ui', '--open', '--no-open']);
  assert.equal(both.code, EXIT.usage);
  await assert.rejects(startDaemon({
    projectRoot: f.root, dataDirectory: f.data, workspaceDirectory: f.workspace, token: f.token, webUi: true,
  }), { code: 'WEB_UI_UNAVAILABLE' });
  const daemon = await startDaemon({ projectRoot, dataDirectory: f.data, workspaceDirectory: f.workspace, token: f.token });
  f.cleanups.push(() => daemon.close());
});

test('headless CLI still serves the public RPC contract without a web bundle option', async (t) => {
  const f = fixture(t);
  const started = await startCli(f);
  const client = await connect(f, started);
  const session = await createSession(client, started.workspace.workspaceId);
  const saved = await client.call('messages.append', { sessionId: session.sessionId, text: 'headless' }, mutation(client));
  assert.equal(saved.ok, true);
  assert.equal((await rawHttp(Number(new URL(started.url).port), { path: '/' })).status, 404);
  assert.equal((await invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data)])).code, 0);
});

test('bundled UI rejects wrong Host and Origin over raw HTTP', { skip: !bundledUi }, async (t) => {
  const f = fixture(t);
  const started = await startCli(f, ['--web-ui']);
  const port = Number(new URL(started.httpOrigin).port);
  const page = await rawHttp(port, { path: '/' });
  assert.equal(page.status, 200);
  assert.match(page.body, /worknaru-daemon-ws/);
  assert.equal(page.body.includes('worknaru-dev-instance'), false);
  assert.equal(page.body.includes(f.token), false);
  const wrongHost = await rawHttp(port, { path: '/', headers: { Host: '127.0.0.1:1' } });
  assert.equal(wrongHost.status, 403);
  const wrongOrigin = await rawHttp(port, { path: '/', headers: { Origin: 'http://example.invalid' } });
  assert.equal(wrongOrigin.status, 403);
  const traversal = await rawHttp(port, { path: '/../../src/cli.ts' });
  assert.equal(traversal.status, 404);
  assert.equal((await invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data)])).code, 0);
});

test('operation credential is instance-bound and Windows DACL grants only its owner', async (t) => {
  const f = fixture(t);
  const started = await startCli(f);
  const path = join(f.data, OPS_TOKEN_FILE);
  const credential = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(credential.instanceId, started.daemonInstanceId);
  assert.notEqual(credential.token, f.token);
  assert.equal(readFileSync(join(f.data, RUNTIME_FILE), 'utf8').includes(credential.token), false);
  const allowed = execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
$a = Get-Acl -LiteralPath $env:TEST_ACL_FILE
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules = $a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
[bool]($a.AreAccessRulesProtected -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid -and $rules[0].AccessControlType -eq 'Allow')
`], { windowsHide: true, env: { ...process.env, TEST_ACL_FILE: path }, encoding: 'utf8' });
  assert.equal(allowed.trim(), 'True');
  writeFileSync(path, JSON.stringify({ ...credential, instanceId: randomUUID() }));
  assert.equal((await invoke(f, ['daemon', 'status', '--data-dir', rel(f.data)])).code, EXIT.targetMismatch);
  writeFileSync(path, JSON.stringify({ ...credential, token: 'x'.repeat(43) }));
  assert.equal((await invoke(f, ['daemon', 'status', '--data-dir', rel(f.data)])).code, EXIT.authFailed);
  writeFileSync(path, JSON.stringify(credential));
  assert.equal((await invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data)])).code, 0);
});

test('forged matching identity cannot collect credentials; lost or wrong-instance stop replies never succeed', async (t) => {
  const f = fixture(t);
  const token = 'z'.repeat(43);
  const instanceId = randomUUID();
  let mode = 'forged';
  const seen = [];
  const fake = listenHttp((request, response) => {
    seen.push({ path: request.url, auth: request.headers.authorization });
    if (request.url.endsWith('/identify')) {
      const identity = { instanceId, dataDir: f.data, workspace: f.workspace, port: fake.server.address().port,
        protocolMajor: 1, appVersion: APP_VERSION, webUi: false, aiExecution: false };
      response.end(JSON.stringify({ type: 'worknaru.ops.identify', ...identity,
        proof: mode === 'forged' ? 'a'.repeat(43) : identityProof(token, request.headers['x-worknaru-challenge'], identity) }));
    } else if (mode === 'lost') {
      response.writeHead(200, { 'Content-Length': 100 }); response.write('{');
      setTimeout(() => response.destroy(), 20);
    } else response.end(JSON.stringify({ stopped: true, instanceId: randomUUID() }));
  });
  f.cleanups.push(() => fake.close());
  const port = await fake.start();
  writeFileSync(join(f.data, RUNTIME_FILE), JSON.stringify({ schema: 1, instanceId, dataDir: f.data,
    workspace: f.workspace, pid: 1, startedAt: new Date().toISOString(), port,
    protocolMajor: 1, appVersion: APP_VERSION, webUi: false, aiExecution: false }));
  writeFileSync(join(f.data, OPS_TOKEN_FILE), JSON.stringify({ instanceId, token }));
  assert.equal((await invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data)])).code, EXIT.authFailed);
  assert.ok(seen.every((request) => !request.auth));
  mode = 'lost';
  const lost = await invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data)]);
  assert.equal(lost.code, EXIT.noResponse); assert.equal(lost.stdout, '');
  mode = 'wrong';
  const wrong = await invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data)]);
  assert.equal(wrong.code, EXIT.stopUnconfirmed); assert.equal(wrong.stdout, '');
});

test('a real SQLite finish failure makes stop fail while owned ACP processes still terminate', async (t) => {
  const f = fixture(t);
  const started = await startCli(f, [], { entry: acpEntry });
  const client = await connect(f, started);
  const session = await createSession(client, started.workspace.workspaceId);
  const run = await client.call('runs.start', { sessionId: session.sessionId, text: 'wait' }, mutation(client));
  assert.equal(run.ok, true);
  const children = await descendants(f);
  const db = new DatabaseSync(join(f.data, 'records.sqlite'));
  f.cleanups.push(() => db.close());
  db.exec("CREATE TRIGGER block_finish BEFORE UPDATE OF state ON runs BEGIN SELECT RAISE(ABORT, 'test finish failure'); END");
  const stop = await invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data), '--cancel-active'], { timeout: 30_000 });
  assert.equal(stop.code, EXIT.stopUnconfirmed, stop.stderr);
  assert.equal(stop.stdout, '');
  assert.equal((await deadline(started.exit, 30_000))[0], 1);
  assert.ok(children.every((event) => !alive(event.pid)));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE run_id = ?').get(run.result.run.runId).count, 2);
});

test('invalid bundled index/assets and links are rejected without exposing files outside the UI', async (t) => {
  const f = fixture(t);
  const web = join(f.root, 'dist', 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  const options = { projectRoot: f.root, dataDirectory: f.data, workspaceDirectory: f.workspace, token: f.token, webUi: true };
  writeFileSync(join(web, 'index.html'), 'incomplete');
  await assert.rejects(startDaemon(options), { code: 'WEB_UI_UNAVAILABLE' });
  writeFileSync(join(web, 'index.html'), '<head><script type="module" src="/assets/app.js"></script></head><div id="root"></div>');
  await assert.rejects(startDaemon(options), { code: 'WEB_UI_UNAVAILABLE' });
  const privateFile = join(f.root, 'private.js');
  const asset = join(web, 'assets', 'app.js');
  writeFileSync(privateFile, 'private material');
  linkSync(privateFile, asset);
  await assert.rejects(startDaemon(options), { code: 'WEB_UI_UNAVAILABLE' });
  unlinkSync(asset);
  writeFileSync(asset, 'console.log("fixture");');
  const daemon = await startDaemon(options);
  f.cleanups.push(() => daemon.close());
  const port = Number(new URL(daemon.url).port);
  for (const path of ['/../private.js', '/%2e%2e/private.js', '/assets/%5c..%5cprivate.js', '/assets/app.js:stream', '/__worknaru_ops/status', '/%zz']) {
    assert.equal((await rawHttp(port, { path })).status, 404, path);
  }
  unlinkSync(asset); symlinkSync(privateFile, asset);
  assert.equal((await rawHttp(port, { path: '/assets/app.js' })).status, 404);
  assert.equal((await rawHttp(port, { path: '/' })).status, 200);
});

test('browser-open failure reports a warning while the ready daemon stays usable', { skip: !bundledUi }, async (t) => {
  const f = fixture(t);
  const started = await startCli(f, ['--web-ui', '--open'], { entry: acpEntry, env: { TEST_BROWSER_OPEN_FAIL: '1' } });
  for (let n = 0; n < 100 && !started.stdout().includes('BROWSER_OPEN_FAILED'); n++) await delay(10);
  assert.match(started.stdout(), /BROWSER_OPEN_FAILED/);
  assert.equal((await invoke(f, ['daemon', 'status', '--data-dir', rel(f.data)])).code, 0);
  assert.equal((await invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data)])).code, 0);
});

test('simultaneous CLI starts acquire exactly one SQLite owner', async (t) => {
  const f = fixture(t);
  const results = await Promise.allSettled([startCli(f), startCli(f)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const loser = results.find((result) => result.status === 'rejected');
  assert.match(loser.reason.message, /DATA_IN_USE/);
  const winner = results.find((result) => result.status === 'fulfilled').value;
  assert.equal(JSON.parse(readFileSync(join(f.data, RUNTIME_FILE), 'utf8')).instanceId, winner.daemonInstanceId);
  assert.equal((await invoke(f, ['daemon', 'stop', '--data-dir', rel(f.data)])).code, 0);
});

test('CLI runs from a daemon-only checkout without any Web bundle and retains the RPC contract', async (t) => {
  const f = fixture(t);
  const isolated = join(f.root, 'headless');
  mkdirSync(join(isolated, 'dist'), { recursive: true });
  copyFileSync(join(projectRoot, 'package.json'), join(isolated, 'package.json'));
  for (const file of readdirSync(join(projectRoot, 'dist')).filter((file) => file.endsWith('.js'))) {
    copyFileSync(join(projectRoot, 'dist', file), join(isolated, 'dist', file));
  }
  const entry = join(isolated, 'dist', 'cli.js');
  const target = { ...f, data: join(isolated, 'data') };
  const started = await startCli(target, [], { entry, absolutePaths: true });
  assert.equal(existsSync(join(isolated, 'dist', 'web')), false);
  const client = await connect(f, started);
  const session = await createSession(client, started.workspace.workspaceId);
  assert.equal((await client.call('messages.append', { sessionId: session.sessionId, text: 'isolated headless' }, mutation(client))).ok, true);
  assert.equal((await invoke(f, ['daemon', 'stop', '--data-dir', target.data], { entry })).code, 0);
  await deadline(started.exit);
  const missing = await invoke(f, ['daemon', 'start', '--data-dir', target.data, '--workspace', f.workspace, '--web-ui'], { entry });
  assert.equal(missing.code, 1); assert.match(missing.stderr, /WEB_UI_UNAVAILABLE/);
});
