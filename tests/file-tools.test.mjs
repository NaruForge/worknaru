import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync, writeFileSync, symlinkSync, linkSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startDaemon } from '../dist/daemon.js';
import { FileTools } from '../dist/file-tools.js';
import { RecordStore } from '../dist/store.js';
import { connect, createSession, fixture, mutation, projectRoot, launch } from './helpers.mjs';

async function start(f) {
  const daemon = await startDaemon({ projectRoot, dataDirectory: f.data, workspaceDirectory: f.workspace, token: f.token,
    acp: { command: { executable: process.execPath, arguments: [join(projectRoot, 'tests/fake-acp.mjs')], cwd: f.workspace,
      env: { ...process.env, TEST_AGENT_LOG: join(f.root, 'agent.log'), TEMP: f.root, TMP: f.root } } } });
  f.cleanups.push(() => daemon.close());
  return daemon;
}
async function waitRun(client, runId, predicate) {
  for (let n = 0; n < 400; n++) { const response = await client.call('runs.get', { runId }); assert.equal(response.ok, true); if (predicate(response.result)) return response.result; await delay(25); }
  assert.fail('File run did not reach expected state');
}
async function proposal(f, daemon, client, text = 'edit-file') {
  const session = await createSession(client, daemon.workspace.workspaceId);
  const started = await client.call('runs.start', { sessionId: session.sessionId, text }, mutation(client));
  assert.equal(started.ok, true);
  return waitRun(client, started.result.run.runId, (run) => run.tools.some((tool) => tool.state === 'pending'));
}

test('real MCP bridge waits for approval, applies once, and resolves conflicting tab responses', async (t) => {
  const f = fixture(t); writeFileSync(join(f.workspace, 'sample.txt'), '원래 내용\n');
  const daemon = await start(f); const a = await connect(f, daemon); const b = await connect(f, daemon);
  const run = await proposal(f, daemon, a);
  assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), '원래 내용\n');
  assert.equal(run.tools[0].before, '원래 내용\n'); assert.equal(run.tools[0].after, '수정된 내용\n');
  const id = mutation(a); const params = { runId: run.runId, toolId: run.tools[0].toolId, decision: 'allow' };
  const [first, duplicate] = await Promise.all([a.call('permissions.respond', params, id), b.call('permissions.respond', params, id)]);
  assert.equal(first.ok, true); assert.deepEqual(first.result, duplicate.result);
  const conflict = await b.call('permissions.respond', { ...params, decision: 'reject' }, mutation(b));
  assert.equal(conflict.error.code, 'PERMISSION_RESOLVED');
  const done = await waitRun(a, run.runId, (value) => value.state === 'completed');
  assert.equal(done.tools[0].state, 'completed'); assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), '수정된 내용\n');
  const receipt = await a.call('requests.get', { workspaceId: daemon.workspace.workspaceId, requestId: id.requestId, storeEpoch: id.storeEpoch });
  assert.deepEqual(receipt.result.result, first.result);
  await daemon.close();
  const restarted = await start(f); const c = await connect(f, restarted);
  assert.equal((await c.call('runs.get', { runId: run.runId })).result.tools[0].state, 'completed');
  assert.equal((await c.call('permissions.respond', params, id)).ok, true);
  assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), '수정된 내용\n');
});

test('reconnect restores pending approval; rejection and cancellation leave the file unchanged', async (t) => {
  const f = fixture(t); writeFileSync(join(f.workspace, 'sample.txt'), '원래 내용\n');
  const daemon = await start(f); const a = await connect(f, daemon);
  const run = await proposal(f, daemon, a); a.ws.close();
  const b = await connect(f, daemon);
  assert.equal((await b.call('runs.watch', { runId: run.runId })).result.tools[0].state, 'pending');
  await b.call('permissions.respond', { runId: run.runId, toolId: run.tools[0].toolId, decision: 'reject' }, mutation(b));
  assert.equal((await waitRun(b, run.runId, (value) => value.state === 'completed')).tools[0].state, 'rejected');
  const other = await proposal(f, daemon, b);
  await b.call('runs.cancel', { runId: other.runId }, mutation(b));
  assert.equal((await waitRun(b, other.runId, (value) => value.state === 'cancelled')).tools[0].state, 'cancelled');
  assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), '원래 내용\n');
});

test('approval refuses changed files, stale approvals and cross-workspace access', async (t) => {
  const f = fixture(t); writeFileSync(join(f.workspace, 'sample.txt'), '원래 내용\n');
  const daemon = await start(f); const client = await connect(f, daemon);
  const run = await proposal(f, daemon, client);
  writeFileSync(join(f.workspace, 'sample.txt'), '외부 수정');
  await client.call('permissions.respond', { runId: run.runId, toolId: run.tools[0].toolId, decision: 'allow' }, mutation(client));
  const done = await waitRun(client, run.runId, (value) => value.state === 'completed');
  assert.equal(done.tools[0].state, 'failed'); assert.equal(done.tools[0].errorCode, 'FILE_CONFLICT');
  assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), '외부 수정');
  await daemon.close();
  const workspace = join(f.root, 'another'); mkdirSync(workspace);
  const other = await startDaemon({ projectRoot, dataDirectory: f.data, workspaceDirectory: workspace, token: f.token }); f.cleanups.push(() => other.close());
  const scoped = await connect(f, other);
  assert.equal((await scoped.call('runs.get', { runId: run.runId })).error.code, 'NOT_FOUND');
});

test('daemon death never replays a pending file change', async (t) => {
  const f = fixture(t); writeFileSync(join(f.workspace, 'sample.txt'), '원래 내용\n');
  const daemon = await launch(f, { entry: join(projectRoot, 'tests/acp-daemon.mjs') }); const a = await connect(f, daemon);
  const run = await proposal(f, daemon, a); await daemon.stop();
  const restarted = await start(f); const b = await connect(f, restarted);
  const recovered = (await b.call('runs.get', { runId: run.runId })).result;
  assert.equal(recovered.tools[0].state, 'cancelled'); assert.equal(recovered.state, 'failed');
  assert.equal((await b.call('permissions.respond', { runId: run.runId, toolId: run.tools[0].toolId, decision: 'allow' }, mutation(b))).error.code, 'PERMISSION_RESOLVED');
  assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), '원래 내용\n');
});

test('file tool rejects traversal, links, data files, binary, oversized and invalid input', async (t) => {
  const f = fixture(t); const store = new RecordStore(f.data, f.workspace); f.cleanups.push(() => store.close());
  const tools = new FileTools(store, f.data, () => {}); f.cleanups.push(() => tools.close());
  const session = store.handle({ method: 'sessions.create', params: { workspaceId: store.workspace.workspaceId, title: '파일 검사' }, requestId: 's', storeEpoch: store.epoch }).session;
  const run = store.handle({ method: 'runs.start', params: { sessionId: session.sessionId, text: '파일 검사' }, requestId: 'r', storeEpoch: store.epoch }).run;
  const bridge = await tools.bind(session.sessionId, () => run.runId); const env = Object.fromEntries(bridge.env.map(({ name, value }) => [name, value]));
  const call = async (name, args, overrides = {}) => fetch(env.WORKNARU_FILE_ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${env.WORKNARU_FILE_TOKEN}`, ...overrides }, body: JSON.stringify({ name, arguments: args }) });
  writeFileSync(join(f.workspace, 'sample.txt'), 'text'); writeFileSync(join(f.workspace, 'binary.txt'), Buffer.from([0xff, 0x00])); writeFileSync(join(f.workspace, 'large.txt'), 'x'.repeat(8193));
  symlinkSync(join(f.workspace, 'sample.txt'), join(f.workspace, 'link.txt'), 'file');
  linkSync(join(f.workspace, 'sample.txt'), join(f.workspace, 'hard.txt'));
  for (const path of ['../data/records.sqlite', join(f.root, 'data/records.sqlite'), 'sample.txt:stream', '.git/config', 'CON', 'link.txt', 'hard.txt', 'binary.txt', 'large.txt', 'missing.txt']) {
    const response = await (await call('read_text_file', { path })).json(); assert.equal(response.isError, true, path);
  }
  assert.equal((await call('read_text_file', { path: 'sample.txt' }, { Origin: 'http://evil.invalid' })).status, 403);
  assert.equal((await call('read_text_file', { path: 'sample.txt' }, { Authorization: 'Bearer wrong' })).status, 403);
  assert.equal((await (await call('edit_text_file', { path: 'sample.txt', before: 'text', after: '\ud800' })).json()).isError, true);
});

test('v3 migration backs up records and interrupted application remains unknown', (t) => {
  const f = fixture(t); let store = new RecordStore(f.data, f.workspace);
  const epoch = store.epoch;
  const session = store.handle({ method: 'sessions.create', params: { workspaceId: store.workspace.workspaceId, title: '보존' }, requestId: 's', storeEpoch: epoch }).session;
  const run = store.handle({ method: 'runs.start', params: { sessionId: session.sessionId, text: '보존' }, requestId: 'r', storeEpoch: epoch }).run;
  store.close();
  const db = new DatabaseSync(join(f.data, 'records.sqlite')); db.exec('DROP TABLE file_approvals; PRAGMA user_version = 3'); db.close();
  store = new RecordStore(f.data, f.workspace);
  assert.equal(store.epoch, epoch); assert.equal(store.run(run.runId).runId, run.runId);
  assert.ok(readdirSync(f.data).some((name) => name.startsWith('records-v3-')));
  const tool = store.proposeFile(run.runId, 'sample.txt', 'before', 'after', 'identity');
  store.handle({ method: 'permissions.respond', params: { runId: run.runId, toolId: tool.toolId, decision: 'allow' }, requestId: 'p', storeEpoch: epoch });
  assert.ok(store.claimFile(run.runId, tool.toolId)); store.close();
  store = new RecordStore(f.data, f.workspace); f.cleanups.push(() => store.close()); store.recoverFiles();
  assert.equal(store.run(run.runId).tools[0].state, 'unknown'); assert.equal(store.claimFile(run.runId, tool.toolId), undefined);
});

test('failed approval receipt never changes a file; failed result storage stays unknown after restart', async (t) => {
  for (const phase of ['receipt', 'result']) {
    const f = fixture(t); const file = join(f.workspace, 'sample.txt'); writeFileSync(file, '원래 내용\n');
    const daemon = await start(f); const client = await connect(f, daemon); const run = await proposal(f, daemon, client);
    const db = new DatabaseSync(join(f.data, 'records.sqlite'));
    const trigger = phase === 'receipt'
      ? "CREATE TRIGGER fail_file_write BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'test receipt failure'); END"
      : "CREATE TRIGGER fail_file_write BEFORE UPDATE OF state ON file_approvals WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'test result failure'); END";
    db.exec(trigger);
    const response = await client.call('permissions.respond', { runId: run.runId, toolId: run.tools[0].toolId, decision: 'allow' }, mutation(client));
    if (phase === 'receipt') assert.equal(response.error.code, 'STORE_UNAVAILABLE'); else assert.equal(response.ok, true);
    await waitRun(client, run.runId, (value) => !value.storageAvailable);
    assert.equal(readFileSync(file, 'utf8'), phase === 'receipt' ? '원래 내용\n' : '수정된 내용\n');
    assert.notEqual(db.prepare('SELECT state FROM file_approvals').get().state, 'completed');
    db.exec('DROP TRIGGER fail_file_write'); db.close(); await daemon.close();
    const restarted = await start(f); const reader = await connect(f, restarted);
    const recovered = (await reader.call('runs.get', { runId: run.runId })).result.tools[0];
    assert.equal(recovered.state, phase === 'receipt' ? 'cancelled' : 'unknown');
    assert.equal(readFileSync(file, 'utf8'), phase === 'receipt' ? '원래 내용\n' : '수정된 내용\n');
  }
});
