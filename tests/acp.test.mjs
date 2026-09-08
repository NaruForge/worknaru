import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { startDaemon } from '../dist/daemon.js';
import { stopAgentJob } from '../dist/agent-process.js';
import { connect, createSession, fixture, launch, mutation, projectRoot } from './helpers.mjs';

function options(f, agentEnv = {}) {
  return { projectRoot, dataDirectory: f.data, workspaceDirectory: f.workspace, token: f.token,
    acp: { command: { executable: process.execPath, arguments: [join(projectRoot, 'tests/fake-acp.mjs')], cwd: f.workspace,
      env: { ...process.env, ...agentEnv, TEST_AGENT_LOG: join(f.root, 'agent.log'), TEMP: f.root, TMP: f.root },
    } },
  };
}
async function start(f, agentEnv = {}) {
  const daemon = await startDaemon(options(f, agentEnv));
  f.cleanups.push(() => daemon.close());
  return daemon;
}
async function waitRun(client, runId, predicate = (run) => ['completed', 'failed', 'cancelled'].includes(run.state)) {
  for (let n = 0; n < 400; n++) {
    const response = await client.call('runs.get', { runId });
    assert.equal(response.ok, true);
    if (predicate(response.result)) return response.result;
    await delay(25);
  }
  assert.fail('Run did not reach expected state');
}
const log = (f) => existsSync(join(f.root, 'agent.log')) ? readFileSync(join(f.root, 'agent.log'), 'utf8').trim().split('\n').map(JSON.parse) : [];

test('idle agent death updates availability and releases all four connection slots', async (t) => {
  const f = fixture(t);
  const daemon = await start(f);
  const client = await connect(f, daemon);
  for (let n = 0; n < 5; n++) {
    const session = await createSession(client, daemon.workspace.workspaceId);
    const started = await client.call('runs.start', { sessionId: session.sessionId, text: '유휴 종료' }, mutation(client));
    assert.equal((await waitRun(client, started.result.run.runId)).state, 'completed');
    const pid = log(f).filter((item) => item.type === 'spawn').at(-1).pid;
    process.kill(pid, 'SIGKILL');
    let unavailable = 0;
    for (let attempt = 0; attempt < 200; attempt++) {
      unavailable = (await client.call('sessions.get', { sessionId: session.sessionId })).result.aiUnavailable;
      if (unavailable) break;
      await delay(25);
    }
    assert.equal(unavailable, 1);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});

test('dangling auth target links are rejected before creating a credential copy', async (t) => {
  const f = fixture(t);
  const source = join(f.root, 'fake-auth');
  mkdirSync(source);
  writeFileSync(join(source, 'auth.json'), '{"fake":"no-real-credentials"}');
  mkdirSync(join(f.data, 'codex'));
  const destination = join(f.workspace, 'unexpected-auth.json');
  symlinkSync(destination, join(f.data, 'codex/auth.json'), 'file');
  await assert.rejects(launch(f, { extraArgs: ['--acp'], env: { CODEX_HOME: source } }), /INVALID_DATA_PATH/);
  assert.equal(existsSync(destination), false);
});

test('daemon death terminates the job even when forwarding to agent stdin is blocked', async (t) => {
  const f = fixture(t);
  const daemon = await launch(f, { entry: join(projectRoot, 'tests/acp-daemon.mjs'), env: { TEST_AGENT_ENTRY: join(projectRoot, 'tests/blocked-acp.mjs') } });
  const client = await connect(f, daemon);
  const session = await createSession(client, daemon.workspace.workspaceId);
  const started = await client.call('runs.start', { sessionId: session.sessionId, text: 'x'.repeat(16000) }, mutation(client));
  await waitRun(client, started.result.run.runId, (run) => run.delivery === 'attempting');
  const db = new DatabaseSync(join(f.data, 'records.sqlite'));
  const jobName = db.prepare('SELECT agent_job AS name FROM sessions WHERE id = ?').get(session.sessionId).name;
  db.close();
  f.cleanups.push(() => stopAgentJob(jobName, process.env));
  const pid = log(f).find((item) => item.type === 'spawn').pid;
  await delay(500);
  await daemon.stop();
  await delay(1500);
  // Assert before explicit cleanup or restart could mask an orphaned process.
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('ACP streams committed output, preserves conversation context, and dispatches duplicate requests once', async (t) => {
  const f = fixture(t);
  const daemon = await start(f);
  const first = await connect(f, daemon);
  const second = await connect(f, daemon);
  const session = await createSession(first, daemon.workspace.workspaceId);
  const request = mutation(first);
  const params = { sessionId: session.sessionId, text: '첫 질문' };
  const [a, b] = await Promise.all([first.call('runs.start', params, request), second.call('runs.start', params, request)]);
  assert.equal(a.ok, true);
  assert.deepEqual(a.result, b.result);
  const runId = a.result.run.runId;
  const watched = await first.call('runs.watch', { runId });
  assert.equal(watched.ok, true);
  assert.equal((await second.call('runs.start', { ...params, text: '동시 실행' }, mutation(second))).error.code, 'SESSION_BUSY');
  assert.equal((await second.call('runs.start', { ...params, text: '변경한 요청' }, request)).error.code, 'REQUEST_ID_CONFLICT');
  const completed = await waitRun(second, runId);
  assert.equal(completed.state, 'completed', JSON.stringify(completed));
  assert.equal(completed.text, '답변 1: 첫 질문');
  assert.ok(first.events.length >= 2);
  assert.ok(first.events.every((event, n, all) => !n || event.run.revision > all[n - 1].run.revision));
  const next = await second.call('runs.start', { sessionId: session.sessionId, text: '후속 질문' }, mutation(second));
  assert.equal((await waitRun(second, next.result.run.runId)).text, '답변 2: 후속 질문');
  assert.equal(log(f).filter((item) => item.type === 'prompt').length, 2);
  assert.deepEqual((await second.call('runs.start', params, request)).result, a.result);
  const messages = await second.call('messages.list', { sessionId: session.sessionId });
  assert.deepEqual(messages.result.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  await daemon.close();
  const restarted = await start(f);
  const reconnected = await connect(f, restarted);
  assert.deepEqual((await reconnected.call('runs.get', { runId })).result, completed);
  assert.deepEqual((await reconnected.call('runs.start', params, request)).result, a.result);
  assert.equal((await reconnected.call('sessions.get', { sessionId: session.sessionId })).result.aiUnavailable, 0);
  const continued = await reconnected.call('runs.start', { sessionId: session.sessionId, text: 'recall-first' }, mutation(reconnected));
  assert.equal((await waitRun(reconnected, continued.result.run.runId)).text, '답변 3: 첫 질문');
  assert.equal(log(f).filter((item) => item.type === 'prompt').length, 3);
  assert.equal(log(f).filter((item) => item.type === 'new').length, 1);
  assert.equal(log(f).find((item) => item.type === 'resume').sessionId, log(f).find((item) => item.type === 'new').sessionId);
  await restarted.close();
  const other = join(f.root, 'other-workspace');
  mkdirSync(other);
  const otherDaemon = await startDaemon({ ...options(f), workspaceDirectory: other });
  f.cleanups.push(() => otherDaemon.close());
  const otherClient = await connect(f, otherDaemon);
  for (const method of ['runs.get', 'runs.watch', 'runs.unwatch']) assert.equal((await otherClient.call(method, { runId })).error.code, 'NOT_FOUND');
  assert.equal((await otherClient.call('runs.cancel', { runId }, mutation(otherClient))).error.code, 'NOT_FOUND');
});

test('cancellation proves cleanup of the owned agent and descendant processes', async (t) => {
  const f = fixture(t);
  const daemon = await start(f);
  const client = await connect(f, daemon);
  const session = await createSession(client, daemon.workspace.workspaceId);
  const started = await client.call('runs.start', { sessionId: session.sessionId, text: 'wait' }, mutation(client));
  const runId = started.result.run.runId;
  for (let n = 0; n < 160 && !log(f).some((item) => item.type === 'descendant'); n++) await delay(25);
  const pids = log(f).filter((item) => ['spawn', 'descendant'].includes(item.type)).map((item) => item.pid);
  assert.equal(pids.length, 2);
  const request = mutation(client);
  const cancelled = await client.call('runs.cancel', { runId }, request);
  assert.equal(cancelled.ok, true);
  assert.equal((await waitRun(client, runId)).state, 'cancelled');
  assert.deepEqual((await client.call('runs.cancel', { runId }, request)).result, cancelled.result);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await daemon.close();
  const restarted = await start(f);
  const reconnected = await connect(f, restarted);
  assert.equal((await reconnected.call('sessions.get', { sessionId: session.sessionId })).result.aiUnavailable, 1);
  assert.equal((await reconnected.call('runs.start', { sessionId: session.sessionId, text: '차단' }, mutation(reconnected))).error.code, 'SESSION_UNAVAILABLE');
});

test('load-only agents replay history without duplicating stored messages or the new answer', async (t) => {
  const f = fixture(t);
  let daemon = await start(f);
  let client = await connect(f, daemon);
  const session = await createSession(client, daemon.workspace.workspaceId);
  const started = await client.call('runs.start', { sessionId: session.sessionId, text: '기억할 첫 질문' }, mutation(client));
  await waitRun(client, started.result.run.runId);
  const saved = (await client.call('messages.list', { sessionId: session.sessionId })).result.messages;
  await daemon.close();
  const readOnly = await startDaemon({ ...options(f), acp: undefined });
  f.cleanups.push(() => readOnly.close());
  const reader = await connect(f, readOnly);
  assert.equal((await reader.call('sessions.get', { sessionId: session.sessionId })).result.aiUnavailable, 1);
  assert.deepEqual((await reader.call('messages.list', { sessionId: session.sessionId })).result.messages, saved);
  await readOnly.close();
  daemon = await start(f, { TEST_AGENT_RESUME: 'load' });
  client = await connect(f, daemon);
  const request = mutation(client);
  const params = { sessionId: session.sessionId, text: 'recall-first' };
  const resumed = await client.call('runs.start', params, request);
  const run = await waitRun(client, resumed.result.run.runId);
  assert.equal(run.state, 'completed');
  assert.equal(run.text, '답변 2: 기억할 첫 질문');
  assert.deepEqual((await client.call('requests.get', { workspaceId: session.workspaceId, ...request })).result.result, resumed.result);
  assert.deepEqual((await client.call('runs.start', params, request)).result, resumed.result);
  const messages = (await client.call('messages.list', { sessionId: session.sessionId })).result.messages;
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.slice(0, 2), saved);
  assert.equal(log(f).filter((item) => item.type === 'new').length, 1);
  assert.deepEqual(log(f).filter((item) => item.type === 'resume').map((item) => item.method), ['session/load']);
  assert.equal(log(f).filter((item) => item.type === 'prompt').length, 2);
});

for (const mode of ['unsupported', 'fail']) test(`resume ${mode} preserves provider identity and history without delivering or creating a replacement`, async (t) => {
  const f = fixture(t);
  let daemon = await start(f);
  let client = await connect(f, daemon);
  const session = await createSession(client, daemon.workspace.workspaceId);
  const first = await client.call('runs.start', { sessionId: session.sessionId, text: '이전 기록' }, mutation(client));
  await waitRun(client, first.result.run.runId);
  const saved = (await client.call('messages.list', { sessionId: session.sessionId })).result.messages;
  const providerId = log(f).find((item) => item.type === 'new').sessionId;
  await daemon.close();
  daemon = await start(f, { TEST_AGENT_RESUME: mode });
  client = await connect(f, daemon);
  const resumed = await client.call('runs.start', { sessionId: session.sessionId, text: '전달하지 않을 입력' }, mutation(client));
  const run = await waitRun(client, resumed.result.run.runId);
  assert.equal(run.state, 'failed');
  assert.equal(run.delivery, 'not_attempted');
  assert.equal(run.errorCode, mode === 'unsupported' ? 'SESSION_RESUME_UNSUPPORTED' : 'SESSION_RESUME_FAILED');
  const messages = (await client.call('messages.list', { sessionId: session.sessionId })).result.messages;
  assert.deepEqual(messages.slice(0, 2), saved);
  assert.equal(messages[2].text, '전달하지 않을 입력');
  assert.equal(messages[3].text, '');
  assert.equal(log(f).filter((item) => item.type === 'new').length, 1);
  assert.equal(log(f).filter((item) => item.type === 'prompt').length, 1);
  assert.equal(log(f).filter((item) => item.type === 'resume').length, mode === 'unsupported' ? 0 : 1);
  const db = new DatabaseSync(join(f.data, 'records.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT provider_session_id FROM sessions WHERE id = ?').get(session.sessionId).provider_session_id, providerId); }
  finally { db.close(); }
  await daemon.close();
  daemon = await start(f);
  client = await connect(f, daemon);
  assert.equal((await client.call('sessions.get', { sessionId: session.sessionId })).result.aiUnavailable, 1);
});

test('cancellation during resume terminates the opening agent without sending the pending prompt', async (t) => {
  const f = fixture(t);
  let daemon = await start(f);
  let client = await connect(f, daemon);
  const session = await createSession(client, daemon.workspace.workspaceId);
  const first = await client.call('runs.start', { sessionId: session.sessionId, text: '정상 완료' }, mutation(client));
  await waitRun(client, first.result.run.runId);
  await daemon.close();
  daemon = await start(f, { TEST_AGENT_RESUME: 'wait' });
  client = await connect(f, daemon);
  const next = await client.call('runs.start', { sessionId: session.sessionId, text: '재개 중 취소할 입력' }, mutation(client));
  for (let n = 0; n < 240 && !log(f).some((item) => item.type === 'resume'); n++) await delay(25);
  assert.ok(log(f).some((item) => item.type === 'resume'));
  const pid = log(f).filter((item) => item.type === 'spawn').at(-1).pid;
  await client.call('runs.cancel', { runId: next.result.run.runId }, mutation(client));
  const cancelled = await waitRun(client, next.result.run.runId);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.delivery, 'not_attempted');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(log(f).filter((item) => item.type === 'prompt').length, 1);
  assert.equal(log(f).filter((item) => item.type === 'new').length, 1);
});

test('cancellation during process startup never delivers the prompt or leaves a late agent', async (t) => {
  const f = fixture(t);
  const daemon = await start(f);
  const client = await connect(f, daemon);
  const session = await createSession(client, daemon.workspace.workspaceId);
  const started = await client.call('runs.start', { sessionId: session.sessionId, text: 'wait' }, mutation(client));
  const runId = started.result.run.runId;
  assert.equal((await client.call('runs.cancel', { runId }, mutation(client))).ok, true);
  assert.equal((await waitRun(client, runId)).state, 'cancelled');
  await delay(500);
  assert.equal(log(f).filter((item) => item.type === 'prompt').length, 0);
});

test('forced daemon death cleans its job and recovers an unknown outcome without replay or unrelated kills', async (t) => {
  const f = fixture(t);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: f.workspace, windowsHide: true, stdio: 'ignore' });
  const unrelatedExit = once(unrelated, 'exit');
  f.cleanups.push(async () => { unrelated.kill(); await unrelatedExit; });
  const daemon = await launch(f, { entry: join(projectRoot, 'tests/acp-daemon.mjs') });
  let client = await connect(f, daemon);
  const session = await createSession(client, daemon.workspace.workspaceId);
  const request = mutation(client);
  const params = { sessionId: session.sessionId, text: 'wait' };
  const started = await client.call('runs.start', params, request);
  const runId = started.result.run.runId;
  for (let n = 0; n < 200 && !log(f).some((item) => item.type === 'descendant'); n++) await delay(25);
  const pids = log(f).filter((item) => ['spawn', 'descendant'].includes(item.type)).map((item) => item.pid);
  assert.equal(pids.length, 2);
  client.ws.terminate();
  assert.equal(process.kill(pids[0], 0), true); // UI disconnect does not cancel.
  await daemon.stop();
  const restarted = await start(f);
  client = await connect(f, restarted);
  const run = (await client.call('runs.get', { runId })).result;
  assert.equal(run.state, 'failed');
  assert.equal(run.errorCode, 'EXECUTION_OUTCOME_UNKNOWN');
  assert.equal((await client.call('sessions.get', { sessionId: session.sessionId })).result.aiUnavailable, 1);
  assert.equal((await client.call('runs.start', params, mutation(client))).error.code, 'SESSION_UNAVAILABLE');
  assert.deepEqual((await client.call('runs.start', params, request)).result, started.result);
  assert.equal(log(f).filter((item) => item.type === 'prompt').length, 1);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(process.kill(unrelated.pid, 0), true);
});

test('agent crash, unsupported permission, oversized output and malformed frames never become success', async (t) => {
  const f = fixture(t);
  const daemon = await start(f);
  const client = await connect(f, daemon);
  for (const [text, expected] of [['crash', 'AGENT_ERROR'], ['permission', 'PERMISSION_UNSUPPORTED'], ['tool', 'TOOLS_UNSUPPORTED'], ['large', 'OUTPUT_LIMIT'], ['malformed', 'AGENT_PROTOCOL_ERROR']]) {
    const session = await createSession(client, daemon.workspace.workspaceId);
    const started = await client.call('runs.start', { sessionId: session.sessionId, text }, mutation(client));
    const run = await waitRun(client, started.result.run.runId);
    assert.equal(run.state, 'failed', JSON.stringify(run));
    assert.equal(run.errorCode, expected);
    if (text === 'large') assert.equal(run.text, '보존된 출력');
    const pid = log(f).filter((item) => item.type === 'spawn').at(-1).pid;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});

test('failed run receipt commits neither a Run nor messages and never launches an agent', async (t) => {
  const f = fixture(t);
  const daemon = await start(f);
  const client = await connect(f, daemon);
  const session = await createSession(client, daemon.workspace.workspaceId);
  const db = new DatabaseSync(join(f.data, 'records.sqlite'));
  f.cleanups.push(() => db.close());
  db.exec("CREATE TRIGGER fail_run_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'test receipt failure'); END");
  const started = await client.call('runs.start', { sessionId: session.sessionId, text: '롤백' }, mutation(client));
  assert.equal(started.error.code, 'STORE_UNAVAILABLE');
  assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
  assert.equal(log(f).length, 0);
});

test('a streaming storage failure preserves the last commit and stops the agent without a false terminal result', async (t) => {
  const f = fixture(t);
  const daemon = await start(f);
  const client = await connect(f, daemon);
  const session = await createSession(client, daemon.workspace.workspaceId);
  const db = new DatabaseSync(join(f.data, 'records.sqlite'));
  f.cleanups.push(() => db.close());
  db.exec("CREATE TRIGGER fail_output BEFORE UPDATE OF text ON messages BEGIN SELECT RAISE(ABORT, 'test output failure'); END");
  const started = await client.call('runs.start', { sessionId: session.sessionId, text: '저장 실패' }, mutation(client));
  const runId = started.result.run.runId;
  const run = await waitRun(client, runId, (run) => !run.storageAvailable);
  assert.equal(run.text, '');
  assert.equal(run.state, 'running');
  const pid = log(f).filter((item) => item.type === 'spawn').at(-1).pid;
  for (let n = 0; n < 200; n++) {
    try { process.kill(pid, 0); } catch { break; }
    await delay(25);
  }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal((await client.call('runs.start', { sessionId: session.sessionId, text: '차단' }, mutation(client))).error.code, 'STORE_UNAVAILABLE');
  db.exec('DROP TRIGGER fail_output');
  await daemon.close();
  const restarted = await start(f);
  const recovered = await connect(f, restarted);
  assert.equal((await recovered.call('runs.get', { runId })).result.state, 'failed');
});

test('v1 migration preserves messages, original receipts and epoch with a readable consistent backup', async (t) => {
  const f = fixture(t);
  const epoch = randomUUID(), workspaceId = randomUUID(), sessionId = randomUUID(), messageId = randomUUID();
  const requestId = randomUUID();
  const oldResult = { accepted: true, requestId, message: { messageId, sessionId, seq: 1, text: '이전 기록', createdAt: '2026-09-08' }, aiExecution: false };
  const db = new DatabaseSync(join(f.data, 'records.sqlite'));
  // Exact v1 columns and constraints from the first persistence implementation.
  db.exec(`
    CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK (id = 1), store_epoch TEXT NOT NULL) STRICT;
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, path_key TEXT NOT NULL UNIQUE, path TEXT NOT NULL) STRICT;
    CREATE TABLE sessions (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL REFERENCES workspaces(id), principal TEXT NOT NULL, module TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE INDEX sessions_scope ON sessions(workspace_id, principal, module, seq);
    CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), text TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE INDEX messages_session ON messages(session_id, seq);
    CREATE TABLE receipts (principal TEXT NOT NULL, module TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY (principal,module,workspace_id,request_id)) STRICT;
    PRAGMA application_id = 1464746322;
    PRAGMA user_version = 1;
  `);
  db.prepare('INSERT INTO metadata VALUES (1, ?)').run(epoch);
  const path = realpathSync(f.workspace);
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run(workspaceId, path.toLowerCase(), path);
  db.prepare('INSERT INTO sessions VALUES (1, ?, ?, ?, ?, ?, ?)').run(sessionId, workspaceId, 'local-owner', 'chat', '이전 대화', '2026-09-08');
  db.prepare('INSERT INTO messages VALUES (1, ?, ?, ?, ?)').run(messageId, sessionId, '이전 기록', '2026-09-08');
  db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?)').run('local-owner', 'chat', workspaceId, requestId,
    JSON.stringify({ method: 'messages.append', params: { sessionId, text: '이전 기록' } }), JSON.stringify(oldResult));
  db.close();
  const daemon = await start(f);
  const client = await connect(f, daemon);
  assert.equal(client.ready.storeEpoch, epoch);
  assert.deepEqual((await client.call('messages.append', { sessionId, text: '이전 기록' }, mutation(client, requestId))).result, oldResult);
  const messages = (await client.call('messages.list', { sessionId })).result.messages;
  assert.equal(messages[0].text, '이전 기록');
  assert.equal(messages[0].role, 'user');
  const backupName = readdirSync(f.data).find((name) => /^records-v1-.*\.sqlite$/.test(name));
  assert.ok(backupName);
  const backup = new DatabaseSync(join(f.data, backupName), { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(backup.prepare('SELECT text FROM messages').get().text, '이전 기록');
  backup.close();
});

test('the development client prints streamed text and the resulting session and run', async (t) => {
  const f = fixture(t);
  const daemon = await start(f);
  const child = spawn(process.execPath, [join(projectRoot, 'dist/chat-client.js'), '--url', daemon.url, '--text', '클라이언트 검증'], {
    cwd: projectRoot, env: { ...process.env, WORKNARU_TOKEN: f.token }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.on('data', (data) => { output += data.toString(); });
  child.stderr.on('data', (data) => { errors += data.toString(); });
  const exit = once(child, 'exit');
  f.cleanups.push(async () => { if (child.exitCode === null) child.kill(); await exit; });
  const [code] = await exit;
  assert.equal(code, 0, errors);
  assert.ok(output.includes('답변 1: 클라이언트 검증'));
  const result = JSON.parse(output.trim().split('\n').at(-1));
  assert.equal(result.state, 'completed');
  assert.ok(result.sessionId && result.runId);
  assert.equal(output.includes(f.token), false);
});
