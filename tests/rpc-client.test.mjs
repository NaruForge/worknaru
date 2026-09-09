import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket, WebSocketServer } from 'ws';
import { startDaemon } from '../dist/daemon.js';
import { deadline, fixture, launch, projectRoot } from './helpers.mjs';

function caller(f, daemon, request, options = {}) {
  const rpcPath = join(projectRoot, 'dist/rpc-client.js');
  // Deliver SIGINT to the actual CLI handler without Windows' force-kill semantics.
  const entry = options.interruptible
    ? ['--input-type=module', '-e', `process.on('message',()=>process.emit('SIGINT')); await import(${JSON.stringify(pathToFileURL(rpcPath).href)}); process.disconnect();`, '--']
    : [rpcPath];
  const args = [...entry, '--url', daemon.url, '--timeout-ms', String(options.timeout ?? 10_000)];
  if (request !== undefined) {
    if (options.file) {
      const path = join(f.root, `rpc-${randomUUID()}.json`);
      writeFileSync(path, options.raw ?? JSON.stringify(request)); args.push('--request-file', path);
    } else args.push('--request-file', '-');
  }
  if (options.noKey) args.push('--no-key');
  const child = spawn(process.execPath, args, { cwd: projectRoot, windowsHide: true,
    env: { ...process.env, WORKNARU_TOKEN: options.token ?? f.token },
    stdio: options.interruptible ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', () => {});
  child.stdin.end(request !== undefined && !options.file ? options.raw ?? JSON.stringify(request) : undefined);
  const completion = once(child, 'exit').then(([code, signal]) => ({ code, signal, stdout, stderr,
    frames: stdout.trim() ? stdout.trim().split('\n').map((line) => JSON.parse(line)) : [] }));
  f.cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await deadline(completion); });
  return { child, done: () => deadline(completion, 30_000), stdout: () => stdout, stderr: () => stderr };
}
async function rpc(f, daemon, method, params = {}, identity = {}, options = {}) {
  const result = await caller(f, daemon, { method, params, ...identity }, options).done();
  assert.equal(result.code, 0, result.stderr); assert.equal(result.frames.length, 1);
  const frame = result.frames[0]; assert.equal(frame.ok, true, JSON.stringify(frame)); return frame.result;
}
const identity = (daemon) => ({ requestId: randomUUID(), storeEpoch: daemon.storeEpoch });
async function waitFor(read, predicate, message = 'Expected state was not observed') {
  for (let n = 0; n < 160; n++) { const value = await read(); if (predicate(value)) return value; await delay(25); }
  assert.fail(typeof message === 'function' ? message() : message);
}
const readRun = (f, runId) => {
  const db = new DatabaseSync(join(f.data, 'records.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT state FROM runs WHERE id = ?').get(runId); } finally { db.close(); }
};
const agentLog = (f) => existsSync(join(f.root, 'agent.log')) ? readFileSync(join(f.root, 'agent.log'), 'utf8').trim().split('\n').map(JSON.parse) : [];

test('headless RPC uses a separate daemon, persists a zero-client completion, settings and explicit cancellation', async (t) => {
  const f = fixture(t);
  const daemon = await launch(f, { entry: join(projectRoot, 'tests/acp-daemon.mjs') });
  const ready = await caller(f, daemon).done(); assert.equal(ready.code, 0); assert.equal(ready.frames[0].storeEpoch, daemon.storeEpoch);
  const info = await rpc(f, daemon, 'ai.get'); assert.ok(info.models.length);
  const selection = { model: 'gpt-5.6-luna', reasoningEffort: 'low' };
  await rpc(f, daemon, 'settings.update', { selection }, identity(daemon), { file: true });
  assert.deepEqual((await rpc(f, daemon, 'settings.get')).selection, selection);
  const { session } = await rpc(f, daemon, 'sessions.create', { workspaceId: daemon.workspace.workspaceId }, identity(daemon));
  await rpc(f, daemon, 'sessions.configure', { sessionId: session.sessionId, selection }, identity(daemon));
  const { run } = await rpc(f, daemon, 'runs.start', { sessionId: session.sessionId, text: 'gated' }, identity(daemon));
  await waitFor(() => agentLog(f), (events) => events.some((event) => event.type === 'prompt' && event.text === 'gated'));
  // Every caller process has exited. Read SQLite only to observe completion with zero clients.
  assert.equal(readRun(f, run.runId).state, 'running');
  writeFileSync(join(f.root, 'release-output'), 'release');
  await waitFor(() => readRun(f, run.runId), (row) => row.state === 'completed');
  const completed = await rpc(f, daemon, 'runs.get', { runId: run.runId });
  assert.equal(completed.text, '답변 1: gated'); assert.equal(completed.model, selection.model);
  const finalWatch = await caller(f, daemon, { method: 'runs.watch', params: { runId: run.runId } }).done();
  assert.equal(finalWatch.code, 0); assert.equal(finalWatch.frames[0].result.state, 'completed');
  const { run: waiting } = await rpc(f, daemon, 'runs.start', { sessionId: session.sessionId, text: 'wait' }, identity(daemon));
  await waitFor(() => agentLog(f), (events) => events.some((event) => event.type === 'descendant'));
  const watch = caller(f, daemon, { method: 'runs.watch', params: { runId: waiting.runId } }, { interruptible: true });
  await waitFor(() => watch.stdout(), (value) => value.includes('response'), () => watch.stderr());
  watch.child.send('interrupt'); assert.equal((await watch.done()).code, 0);
  assert.equal((await rpc(f, daemon, 'runs.get', { runId: waiting.runId })).state, 'running');
  const cancelWatch = caller(f, daemon, { method: 'runs.watch', params: { runId: waiting.runId } });
  await waitFor(() => cancelWatch.stdout(), (value) => value.includes('response'));
  await rpc(f, daemon, 'runs.cancel', { runId: waiting.runId }, identity(daemon));
  const streamed = await cancelWatch.done(); assert.equal(streamed.code, 0, streamed.stderr);
  assert.equal(streamed.frames.at(-1).type, 'run.changed'); assert.equal(streamed.frames.at(-1).run.state, 'cancelled');
  await daemon.stop();
  const restarted = await launch(f, { entry: join(projectRoot, 'tests/acp-daemon.mjs') });
  assert.deepEqual((await rpc(f, restarted, 'settings.get')).selection, selection);
  assert.equal((await rpc(f, restarted, 'runs.get', { runId: run.runId })).text, completed.text);
});

test('RPC watch reports same-revision storage faults from the actual daemon', async (t) => {
  const f = fixture(t);
  const daemon = await launch(f, { entry: join(projectRoot, 'tests/acp-daemon.mjs') });
  const { session } = await rpc(f, daemon, 'sessions.create', { workspaceId: daemon.workspace.workspaceId }, identity(daemon));
  const { run } = await rpc(f, daemon, 'runs.start', { sessionId: session.sessionId, text: 'gated' }, identity(daemon));
  await waitFor(() => agentLog(f), (events) => events.some((event) => event.type === 'prompt' && event.text === 'gated'));
  const watch = caller(f, daemon, { method: 'runs.watch', params: { runId: run.runId } }, { interruptible: true });
  await waitFor(() => watch.stdout(), (value) => value.includes('response'));
  const initial = JSON.parse(watch.stdout().trim()).result;
  assert.equal(initial.storageAvailable, true);
  const db = new DatabaseSync(join(f.data, 'records.sqlite'));
  f.cleanups.push(() => db.close());
  db.exec("CREATE TRIGGER fail_rpc_output BEFORE UPDATE OF text ON messages BEGIN SELECT RAISE(ABORT, 'test output failure'); END");
  writeFileSync(join(f.root, 'release-output'), 'release');
  await waitFor(() => watch.stdout(), (value) => value.includes('"storageAvailable":false'), 'RPC did not report the storage fault');
  watch.child.send('interrupt');
  const result = await watch.done(); assert.equal(result.code, 0, result.stderr);
  const fault = result.frames.find((frame) => frame.type === 'run.changed' && !frame.run.storageAvailable).run;
  assert.equal(fault.revision, initial.revision);
  assert.equal(fault.text, initial.text);
  assert.equal(fault.state, 'running');
});

test('headless file approval remains pending without clients and is allowed or rejected through RPC', async (t) => {
  const f = fixture(t); writeFileSync(join(f.workspace, 'sample.txt'), '원래 내용\n');
  const daemon = await launch(f, { entry: join(projectRoot, 'tests/acp-daemon.mjs') });
  for (const decision of ['reject', 'allow']) {
    const { session } = await rpc(f, daemon, 'sessions.create', { workspaceId: daemon.workspace.workspaceId }, identity(daemon));
    const { run } = await rpc(f, daemon, 'runs.start', { sessionId: session.sessionId, text: 'edit-file' }, identity(daemon));
    const pending = await waitFor(() => rpc(f, daemon, 'runs.get', { runId: run.runId }), (value) => value.tools.some((tool) => tool.state === 'pending'));
    assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), '원래 내용\n');
    // The previous call has disconnected, including the one that observed the approval.
    const restored = await rpc(f, daemon, 'runs.get', { runId: run.runId }); assert.equal(restored.tools[0].state, 'pending');
    await rpc(f, daemon, 'permissions.respond', { runId: run.runId, toolId: pending.tools[0].toolId, decision }, identity(daemon));
    const watched = await caller(f, daemon, { method: 'runs.watch', params: { runId: run.runId } }).done(); assert.equal(watched.code, 0, watched.stderr);
    const done = await rpc(f, daemon, 'runs.get', { runId: run.runId });
    assert.equal(done.tools[0].state, decision === 'allow' ? 'completed' : 'rejected');
    assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), decision === 'allow' ? '수정된 내용\n' : '원래 내용\n');
  }
});

test('RPC rejects missing identities and invalid input, validates capabilities and requires explicit keyless mode', async (t) => {
  const f = fixture(t); const daemon = await launch(f);
  for (const options of [{ raw: '{' }, { raw: '{"method":"sessions.create","params":{}}' },
    { raw: '{"method":"settings.get","params":{},"callId":"override"}' }, { raw: '[]' }]) {
    const result = await caller(f, daemon, {}, options).done(); assert.equal(result.code, 1); assert.match(result.stderr, /INVALID_REQUEST/);
  }
  const unsupported = await caller(f, daemon, { method: 'ai.get', params: {} }).done();
  assert.equal(unsupported.code, 1); assert.match(unsupported.stderr, /METHOD_NOT_SUPPORTED/);
  const badKey = await caller(f, daemon, undefined, { token: 'x'.repeat(43) }).done();
  assert.equal(badKey.code, 1); assert.match(badKey.stderr, /AUTH_FAILED/); assert.ok(!badKey.stderr.includes('x'.repeat(43)));
  const missing = await caller(f, daemon, undefined, { token: '' }).done(); assert.match(missing.stderr, /INVALID_TOKEN/);
  const noFallback = await caller(f, daemon, undefined, { noKey: true }).done(); assert.equal(noFallback.code, 1);
  await daemon.stop();
  const keyless = await startDaemon({ projectRoot, dataDirectory: f.data, workspaceDirectory: f.workspace, disableKeyAuth: true });
  f.cleanups.push(() => keyless.close());
  const explicit = await caller(f, keyless, undefined, { noKey: true, token: '' }).done(); assert.equal(explicit.code, 0, explicit.stderr);
  const refused = await caller(f, keyless, undefined, { token: '' }).done(); assert.equal(refused.code, 1);
});

test('RPC recovers a lost mutation response by receipt without automatic replay', async (t) => {
  const f = fixture(t); const daemon = await launch(f);
  const proxy = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(proxy, 'listening');
  f.cleanups.push(async () => { for (const socket of proxy.clients) socket.terminate(); await new Promise((resolve) => proxy.close(resolve)); });
  let forwarded = 0; let captured;
  proxy.on('connection', (client) => {
    const upstream = new WebSocket(daemon.url); const queued = [];
    upstream.on('error', () => client.terminate());
    upstream.on('open', () => { for (const frame of queued) upstream.send(frame); });
    client.on('message', (raw) => { const message = JSON.parse(raw); if (message.type === 'request') { forwarded++; captured = message; }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(raw.toString()); else queued.push(raw.toString()); });
    upstream.on('message', (raw) => { const message = JSON.parse(raw);
      if (message.type === 'response') { client.terminate(); upstream.terminate(); }
      else client.send(raw.toString()); });
    client.on('close', () => upstream.terminate());
  });
  const request = { method: 'sessions.create', params: { workspaceId: daemon.workspace.workspaceId }, ...identity(daemon) };
  const lost = await caller(f, { url: `ws://127.0.0.1:${proxy.address().port}/ws` }, request).done();
  assert.equal(lost.code, 1); assert.equal(forwarded, 1); assert.equal(captured.requestId, request.requestId);
  assert.match(lost.stderr, /requests.get/); assert.ok(lost.stderr.includes(request.storeEpoch)); assert.ok(!lost.stderr.includes(f.token));
  const found = await rpc(f, daemon, 'requests.get', { workspaceId: daemon.workspace.workspaceId, requestId: request.requestId, storeEpoch: request.storeEpoch });
  assert.equal(found.found, true);
  const sessions = await rpc(f, daemon, 'sessions.list', { workspaceId: daemon.workspace.workspaceId }); assert.equal(sessions.sessions.length, 1);
  assert.equal(found.result.session.sessionId, sessions.sessions[0].sessionId);
});

test('RPC fails malformed/version-mismatched replies and response timeout without retry', async (t) => {
  const f = fixture(t);
  for (const mode of ['version', 'malformed', 'timeout']) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
    f.cleanups.push(async () => { for (const client of server.clients) client.terminate(); await new Promise((resolve) => server.close(resolve)); });
    let requests = 0;
    server.on('connection', (socket) => socket.on('message', (raw) => {
      const frame = JSON.parse(raw);
      if (frame.type === 'hello') socket.send(JSON.stringify({ type: 'ready', protocolMajor: mode === 'version' ? 2 : 1,
        storeEpoch: randomUUID(), daemonInstanceId: randomUUID(), capabilities: ['settings.get'], aiExecution: false, limits: { maxTextBytes: 16384 } }));
      else { requests++; if (mode === 'malformed') socket.send(JSON.stringify({ type: 'response', callId: frame.callId, ok: 'yes' })); }
    }));
    const result = await caller(f, { url: `ws://127.0.0.1:${server.address().port}/ws` }, { method: 'settings.get', params: {} }, { timeout: 300 }).done();
    assert.equal(result.code, 1); assert.match(result.stderr, mode === 'timeout' ? /TIMEOUT/ : /PROTOCOL_MISMATCH/);
    assert.equal(requests, mode === 'version' ? 0 : 1);
  }
});
