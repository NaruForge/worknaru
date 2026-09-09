import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startDaemon } from '../dist/daemon.js';
import { ChatStateStore } from '../dist/chat-state.js';
import { WebClient } from '../dist/web-client.js';
import { connect, createSession, fixture, launch, mutation, projectRoot } from './helpers.mjs';

const luna = { model: 'gpt-5.6-luna', reasoningEffort: 'low' };
const sol = { model: 'gpt-5.6-sol', reasoningEffort: 'high' };
function options(f, env = {}, requiredSelection) {
  return { projectRoot, dataDirectory: f.data, workspaceDirectory: f.workspace, token: f.token,
    acp: { requiredSelection, command: { executable: process.execPath, arguments: [join(projectRoot, 'tests/fake-acp.mjs')], cwd: f.workspace,
      env: { ...process.env, ...env, TEST_AGENT_LOG: join(f.root, 'agent.log'), TEMP: f.root, TMP: f.root },
    } },
  };
}
const activity = (f) => readFileSync(join(f.root, 'agent.log'), 'utf8').trim().split('\n').map(JSON.parse);
async function waitRun(client, runId, predicate = (run) => ['completed', 'failed', 'cancelled'].includes(run.state)) {
  for (let i = 0; i < 600; i++) {
    const response = await client.call('runs.get', { runId });
    assert.equal(response.ok, true);
    if (predicate(response.result)) return response.result;
    await delay(30);
  }
  assert.fail('Run did not reach expected state');
}
async function run(client, session, text) {
  const response = await client.call('runs.start', { sessionId: session.sessionId, text }, mutation(client));
  assert.equal(response.ok, true);
  return waitRun(client, response.result.run.runId);
}

test('provider metadata, settings receipts, session overrides and resume use the chosen model without duplicate prompts', async (t) => {
  const f = fixture(t);
  let daemon = await startDaemon(options(f));
  f.cleanups.push(() => daemon.close());
  let client = await connect(f, daemon);
  const info = await client.call('ai.get', {});
  assert.equal(info.ok, true);
  assert.equal(info.result.authentication, 'chatgpt');
  assert.equal(info.result.models.length, 2);
  assert.ok(!JSON.stringify(info).includes('secret-not-for-ui'));
  assert.ok(!JSON.stringify(info).includes('private-not-for-ui'));
  assert.equal(activity(f).filter((item) => ['new', 'prompt'].includes(item.type)).length, 0);
  assert.equal(activity(f).filter((item) => item.type === 'metadata-new').length, 1);
  const first = await createSession(client, daemon.workspace.workspaceId);
  assert.equal(first.model, luna.model);
  const identity = mutation(client);
  const saved = await client.call('settings.update', { selection: sol }, identity);
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.result.settings.selection, sol);
  const second = await createSession(client, daemon.workspace.workspaceId);
  assert.equal(second.model, sol.model);
  assert.equal((await client.call('sessions.get', { sessionId: first.sessionId })).result.model, luna.model);
  assert.equal((await client.call('settings.update', { selection: { ...sol, reasoningEffort: 'medium' } }, mutation(client))).error.code, 'MODEL_UNSUPPORTED');
  assert.equal((await client.call('settings.update', { selection: luna }, identity)).error.code, 'REQUEST_ID_CONFLICT');
  assert.deepEqual((await client.call('requests.get', { workspaceId: first.workspaceId, ...identity })).result.result, saved.result);
  const firstRun = await run(client, first, '원래 맥락');
  assert.equal(firstRun.state, 'completed');
  assert.equal(firstRun.modelConfirmed, 1);
  assert.equal(firstRun.model, luna.model);
  const changed = await client.call('sessions.configure', { sessionId: first.sessionId, selection: sol }, mutation(client));
  assert.equal(changed.ok, true);
  const next = await run(client, first, 'recall-first');
  assert.equal(next.text, '답변 2: 원래 맥락');
  assert.equal(next.model, sol.model);
  assert.equal(next.reasoningEffort, 'high');
  assert.equal(activity(f).filter((item) => item.type === 'new').length, 1);
  const pending = await client.call('runs.start', { sessionId: first.sessionId, text: 'wait' }, mutation(client));
  const blocked = await client.call('sessions.configure', { sessionId: first.sessionId, selection: luna }, mutation(client));
  assert.equal(blocked.error.code, 'SESSION_BUSY');
  await client.call('runs.cancel', { runId: pending.result.run.runId }, mutation(client));
  await waitRun(client, pending.result.run.runId);
  // Complete a second conversation, then resume that same identity after restart.
  const secondRun = await run(client, second, '다시 열 맥락');
  assert.equal(secondRun.state, 'completed');
  await daemon.close();
  daemon = await startDaemon(options(f));
  client = await connect(f, daemon);
  assert.equal((await client.call('ai.get', {})).ok, true);
  assert.equal(activity(f).filter((item) => item.type === 'metadata-new').length, 1);
  assert.equal(activity(f).filter((item) => item.type === 'metadata-resume').length, 1);
  assert.deepEqual((await client.call('settings.get', {})).result.selection, sol);
  assert.deepEqual((await client.call('settings.update', { selection: sol }, identity)).result, saved.result);
  const resumed = await run(client, second, 'recall-first');
  assert.equal(resumed.state, 'completed');
  assert.equal(resumed.text, '답변 2: 다시 열 맥락');
  assert.equal(resumed.model, sol.model);
  assert.equal(resumed.reasoningEffort, 'high');
  const prompts = activity(f).filter((item) => item.type === 'prompt');
  assert.deepEqual(prompts.filter((item) => item.text !== 'wait').map((item) => item.selection), [
    { model: luna.model, effort: 'low' }, ...Array.from({ length: 3 }, () => ({ model: sol.model, effort: 'high' })),
  ]);
});

test('a lost configuration receipt is recovered from the journal without reverting a later setting or the input draft', async (t) => {
  const f = fixture(t);
  const daemon = await startDaemon(options(f));
  f.cleanups.push(() => daemon.close());
  const client = await connect(f, daemon);
  await client.call('ai.get', {});
  const session = await createSession(client, daemon.workspace.workspaceId);
  const identity = mutation(client);
  await client.call('sessions.configure', { sessionId: session.sessionId, selection: sol }, identity);
  await client.call('sessions.configure', { sessionId: session.sessionId, selection: luna }, mutation(client));
  const journal = new Map();
  const key = `worknaru.pending.v1:${daemon.url}:${session.workspaceId}`;
  journal.set(key, JSON.stringify({ method: 'sessions.configure', sessionId: session.sessionId, selection: sol, workspaceId: session.workspaceId, ...identity }));
  const model = new ChatStateStore(new WebClient(), { getItem: (name) => journal.get(name) ?? null, setItem: (name, value) => journal.set(name, value), removeItem: (name) => journal.delete(name) });
  t.after(() => model.close());
  await model.connect(daemon.url, f.token);
  assert.equal(model.getSnapshot().sessions[0].model, luna.model);
  assert.equal(model.getSnapshot().pending, undefined);
  assert.equal(journal.has(key), false);
  model.setDraft('지워지지 않을 초안');
  await model.refreshAi();
  // The initial refresh may still be in flight.
  for (let i = 0; i < 100 && !model.getSnapshot().aiInfo; i++) await delay(30);
  await model.configure(sol, session.sessionId);
  assert.equal(model.getSnapshot().drafts[session.sessionId], '지워지지 않을 초안');
  assert.equal(model.getSnapshot().sessions[0].model, sol.model);
  assert.equal(activity(f).filter((item) => item.type === 'prompt').length, 0);
});

test('defaults refresh blocks edits while loading, discards prior connection results and recovers from read failure', async (t) => {
  const f = fixture(t);
  const daemon = await startDaemon(options(f));
  f.cleanups.push(() => daemon.close());
  const remote = await connect(f, daemon);
  await remote.call('ai.get', {});
  const client = new WebClient();
  const model = new ChatStateStore(client, { getItem: () => null, setItem() {}, removeItem() {} });
  t.after(() => model.close());
  await model.connect(daemon.url, f.token);
  for (let i = 0; i < 100 && !model.getSnapshot().aiInfo; i++) await delay(30);
  assert.ok(model.getSnapshot().aiInfo);
  const original = client.call.bind(client);
  const captured = Promise.withResolvers();
  const release = Promise.withResolvers();
  let hold = true;
  let fail = false;
  let writes = 0;
  client.call = async (method, ...args) => {
    if (method === 'settings.update') writes++;
    if (method === 'settings.get' && fail) throw new Error('설정 조회 시험 오류');
    const result = await original(method, ...args);
    if (method === 'settings.get' && hold) { hold = false; captured.resolve(); await release.promise; }
    return result;
  };
  const stale = model.refreshSettings();
  await captured.promise;
  assert.equal(model.getSnapshot().settingsLoading, true);
  await model.configure(sol);
  assert.equal(writes, 0);
  model.close();
  assert.equal((await remote.call('settings.update', { selection: sol }, mutation(remote))).ok, true);
  await model.connect(daemon.url, f.token);
  assert.deepEqual(model.getSnapshot().settings.selection, sol);
  release.resolve();
  await stale;
  assert.deepEqual(model.getSnapshot().settings.selection, sol);
  fail = true;
  await model.refreshSettings();
  assert.equal(model.getSnapshot().settings, undefined);
  assert.match(model.getSnapshot().settingsError, /설정 조회 시험 오류/);
  assert.equal(model.getSnapshot().settingsLoading, false);
  fail = false;
  await model.refreshSettings();
  assert.deepEqual(model.getSnapshot().settings.selection, sol);
  assert.equal(model.getSnapshot().settingsError, undefined);
  assert.equal(activity(f).filter((item) => item.type === 'prompt').length, 0);
});

for (const [mode, code] of [['mismatch', 'MODEL_UNCONFIRMED'], ['missing', 'MODEL_UNCONFIRMED'], ['unsupported', 'MODEL_UNSUPPORTED']]) {
  test(`test model enforcement rejects ${mode} before any prompt`, async (t) => {
    const f = fixture(t);
    const daemon = await startDaemon(options(f, { TEST_AGENT_MODEL: mode }, luna));
    f.cleanups.push(() => daemon.close());
    const client = await connect(f, daemon);
    const session = await createSession(client, daemon.workspace.workspaceId);
    const result = await run(client, session, '절대 전달하면 안 되는 입력');
    assert.equal(result.state, 'failed');
    assert.equal(result.errorCode, code);
    assert.equal(result.delivery, 'not_attempted');
    assert.equal(result.modelConfirmed, 0);
    assert.equal(activity(f).filter((item) => item.type === 'prompt').length, 0);
    assert.equal((await client.call('messages.list', { sessionId: session.sessionId })).result.messages[0].text, '절대 전달하면 안 되는 입력');
  });
}

test('a previously selected expensive model cannot bypass the test policy after restart', async (t) => {
  const f = fixture(t);
  let daemon = await startDaemon(options(f));
  f.cleanups.push(() => daemon.close());
  let client = await connect(f, daemon);
  await client.call('ai.get', {});
  const session = await createSession(client, daemon.workspace.workspaceId);
  await client.call('sessions.configure', { sessionId: session.sessionId, selection: sol }, mutation(client));
  assert.equal((await run(client, session, '비싼 모델을 흉내 낸 가짜 응답')).state, 'completed');
  await daemon.close();
  daemon = await startDaemon(options(f, {}, luna));
  client = await connect(f, daemon);
  const result = await run(client, session, '테스트에서는 차단');
  assert.equal(result.errorCode, 'TEST_MODEL_REQUIRED');
  assert.equal(result.delivery, 'not_attempted');
  assert.equal(activity(f).filter((item) => item.type === 'prompt').length, 1);
});

test('an unchanged UI selection still rechecks provider drift before the next prompt', async (t) => {
  const f = fixture(t);
  const daemon = await startDaemon(options(f, { TEST_AGENT_MODEL: 'drift' }, luna));
  f.cleanups.push(() => daemon.close());
  const client = await connect(f, daemon);
  const session = await createSession(client, daemon.workspace.workspaceId);
  assert.equal((await run(client, session, '첫 저가 모델 응답')).state, 'completed');
  const result = await run(client, session, '변경된 제공자로 보내면 안 됨');
  assert.equal(result.errorCode, 'MODEL_UNCONFIRMED');
  assert.equal(result.delivery, 'not_attempted');
  assert.equal(activity(f).filter((item) => item.type === 'prompt').length, 1);
});

test('signed-out metadata reports no models and creates no provider session', async (t) => {
  const f = fixture(t);
  const daemon = await startDaemon(options(f, { TEST_AGENT_INFO: 'signedOut' }));
  f.cleanups.push(() => daemon.close());
  const client = await connect(f, daemon);
  const info = await client.call('ai.get', {});
  assert.equal(info.ok, true);
  assert.equal(info.result.authentication, 'signedOut');
  assert.deepEqual(info.result.models, []);
  assert.equal(activity(f).filter((item) => ['new', 'metadata-new', 'prompt'].includes(item.type)).length, 0);
});

test('daemon death during metadata discovery cleans the owned process and allows a fresh read', async (t) => {
  const f = fixture(t);
  const daemon = await launch(f, { entry: join(projectRoot, 'tests/acp-daemon.mjs'), env: { TEST_AGENT_INFO: 'wait' } });
  const client = await connect(f, daemon);
  const info = client.call('ai.get', {}).catch(() => undefined);
  let pid;
  for (let i = 0; i < 200; i++) {
    try {
      const events = activity(f);
      if (events.some((item) => item.type === 'authentication-status')) { pid = events.find((item) => item.type === 'spawn').pid; break; }
    } catch { /* Process not started yet. */ }
    await delay(20);
  }
  assert.ok(pid);
  await daemon.stop();
  await info;
  let exited = false;
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { exited = true; break; }
    await delay(30);
  }
  assert.equal(exited, true);
  const restarted = await startDaemon(options(f));
  f.cleanups.push(() => restarted.close());
  const reader = await connect(f, restarted);
  assert.equal((await reader.call('ai.get', {})).ok, true);
  assert.equal((await reader.call('sessions.list', { workspaceId: restarted.workspace.workspaceId })).result.sessions.length, 0);
  assert.equal(activity(f).filter((item) => item.type === 'prompt').length, 0);
});

test('v2 migration backs up records and preserves receipts while requiring an explicit model for legacy sessions', async (t) => {
  const f = fixture(t);
  let daemon = await startDaemon(options(f));
  f.cleanups.push(() => daemon.close());
  let client = await connect(f, daemon);
  const session = await createSession(client, daemon.workspace.workspaceId);
  const identity = mutation(client);
  const append = await client.call('messages.append', { sessionId: session.sessionId, text: 'v2 기록' }, identity);
  await daemon.close();
  const db = new DatabaseSync(join(f.data, 'records.sqlite'));
  db.exec(`DROP TABLE ai_settings;
    ALTER TABLE sessions DROP COLUMN ai_model; ALTER TABLE sessions DROP COLUMN ai_effort;
    ALTER TABLE runs DROP COLUMN ai_model; ALTER TABLE runs DROP COLUMN ai_effort; ALTER TABLE runs DROP COLUMN model_confirmed;
    PRAGMA user_version = 2;`);
  db.close();
  daemon = await startDaemon(options(f));
  client = await connect(f, daemon);
  assert.equal((await client.call('sessions.get', { sessionId: session.sessionId })).result.model, null);
  assert.deepEqual((await client.call('messages.append', { sessionId: session.sessionId, text: 'v2 기록' }, identity)).result, append.result);
  assert.equal((await client.call('runs.start', { sessionId: session.sessionId, text: '기본 모델 사용 금지' }, mutation(client))).error.code, 'AI_SETTINGS_REQUIRED');
  const backupName = readdirSync(f.data).find((name) => name.startsWith('records-v2-'));
  assert.ok(backupName);
  const backup = new DatabaseSync(join(f.data, backupName), { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(backup.prepare('SELECT text FROM messages').get().text, 'v2 기록');
  } finally { backup.close(); }
  await client.call('ai.get', {});
  assert.equal((await client.call('sessions.configure', { sessionId: session.sessionId, selection: luna }, mutation(client))).ok, true);
  assert.equal((await run(client, session, '직접 선택한 모델')).state, 'completed');
});
