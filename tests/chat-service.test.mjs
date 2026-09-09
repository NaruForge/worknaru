import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChatStore } from '../dist/chat-store.js';
import { ChatService } from '../dist/chat-service.js';
import { FakeChatRuntime } from './fake-chat-runtime.mjs';

const selection = { model: 'gpt-5.6-luna', effort: 'low' };
function fixture() {
  const directory = join(process.cwd(), '.worknaru-test', `chat-service-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const runtime = new FakeChatRuntime(), store = new ChatStore(directory), service = new ChatService(runtime, store, directory);
  return { directory, runtime, store, service, async close() { this.runtime.close(); await this.service.close(); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function create(f) { const chat = await f.service.create(randomUUID(), '대화', selection); return { id: chat.id, agentId: f.store.get(chat.id).agentId }; }

test('saved defaults survive restart, apply only to new chats and keep retried creation identity', async () => {
  const f = fixture();
  try {
    const old = await create(f), initial = f.service.settings(), storeId = f.service.info().storeId;
    const defaults = { model: 'fake-model', effort: 'medium' };
    const saved = await f.service.updateSettings(initial.revision, defaults);
    const id = randomUUID();
    f.runtime.failCreationResponse = true;
    await assert.rejects(f.service.create(id, 'defaults'));
    assert.deepEqual(f.store.get(id).creation.selection, defaults);
    await f.service.updateSettings(saved.revision, selection);
    await f.service.create(id, 'defaults');
    assert.deepEqual((await f.service.get(id)).chat.selection, defaults);
    assert.deepEqual((await f.service.get(old.id)).chat.selection, selection);
    await f.service.close();
    f.store = new ChatStore(f.directory); f.service = new ChatService(f.runtime, f.store, f.directory);
    assert.equal(f.service.info().storeId, storeId);
    assert.deepEqual(f.service.settings(), { revision: saved.revision + 1, defaults: selection });
    const fresh = await f.service.create(randomUUID(), 'new defaults');
    assert.deepEqual(fresh.selection, selection);
    assert.deepEqual((await f.service.get(id)).chat.selection, defaults);
  } finally { await f.close(); }
});

test('concurrent default changes reject the stale revision and unsupported defaults do not fall back', async () => {
  const f = fixture();
  try {
    const revision = f.service.settings().revision;
    const attempts = await Promise.allSettled([
      f.service.updateSettings(revision, { model: 'fake-model', effort: 'medium' }),
      f.service.updateSettings(revision, { model: 'gpt-5.6-luna', effort: 'high' }),
    ]);
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'SETTINGS_CONFLICT');
    const current = f.service.settings();
    await assert.rejects(f.service.updateSettings(current.revision, { model: 'missing-model', effort: 'low' }), { code: 'MODEL_UNSUPPORTED' });
    assert.deepEqual(f.service.settings(), current);
    f.runtime.catalog = async () => [];
    const id = randomUUID();
    await assert.rejects(f.service.create(id, 'unsupported saved default'), { code: 'MODEL_UNSUPPORTED' });
    assert.equal(f.runtime.createCalls.length, 0);
    assert.equal(f.store.list().length, 1);
    assert.equal((await f.service.get(id)).chat.status, 'creating');
    await assert.rejects(f.service.recover(id), { code: 'MODEL_UNSUPPORTED' });
    assert.equal(f.runtime.createCalls.length, 0);
  } finally { await f.close(); }
});

test('failed SQLite default writes keep the previous value and revision after restart', async () => {
  const f = fixture();
  try {
    const initial = f.service.settings();
    f.store.db.exec("CREATE TRIGGER fail_settings BEFORE UPDATE ON chat_settings BEGIN SELECT RAISE(ABORT, 'disk failure'); END;");
    await assert.rejects(f.service.updateSettings(initial.revision, { model: 'fake-model', effort: 'medium' }), { code: 'STORAGE_UNAVAILABLE' });
    assert.equal(f.service.info().storageAvailable, false);
    await f.service.close();
    f.store = new ChatStore(f.directory); f.service = new ChatService(f.runtime, f.store, f.directory);
    assert.deepEqual(f.service.settings(), initial);
  } finally { await f.close(); }
});

test('adding settings to an existing Paseo database preserves chats and initializes its identity once', async () => {
  const f = fixture();
  try {
    const existing = await create(f);
    await f.service.close();
    const db = new DatabaseSync(join(f.directory, 'worknaru.sqlite'));
    db.exec('DROP TABLE chat_settings'); db.close(); // Simulate the schema immediately before #42.
    f.store = new ChatStore(f.directory); f.service = new ChatService(f.runtime, f.store, f.directory);
    assert.deepEqual(f.service.settings(), { revision: 0, defaults: selection });
    assert.equal(f.store.get(existing.id).agentId, existing.agentId);
    const identity = f.service.info().storeId;
    await f.service.close();
    f.store = new ChatStore(f.directory); f.service = new ChatService(f.runtime, f.store, f.directory);
    assert.equal(f.service.info().storeId, identity);
    assert.deepEqual((await f.service.get(existing.id)).chat.selection, selection);
  } finally { await f.close(); }
});

test('lost creation response reuses its persisted identity across a product restart', async () => {
  const f = fixture(), id = randomUUID();
  try {
    f.runtime.failCreationResponse = true;
    await assert.rejects(f.service.create(id, '대화', selection));
    assert.equal(f.store.get(id).agentId, null);
    await f.service.close();
    f.store = new ChatStore(f.directory); f.service = new ChatService(f.runtime, f.store, f.directory);
    const recovered = await f.service.recover(id);
    assert.equal(recovered.id, id); assert.equal(f.runtime.agents.size, 1);
    assert.deepEqual(f.runtime.createCalls, [id, id]);
    await assert.rejects(f.service.create(id, '다른 제목', selection), { code: 'CREATION_CONFLICT' });
  } finally { await f.close(); }
});

test('binding write failure does not create another native agent on restart', async () => {
  const f = fixture(), id = randomUUID();
  try {
    f.store.db.exec("CREATE TRIGGER fail_binding BEFORE UPDATE OF agent_id ON chats BEGIN SELECT RAISE(ABORT, 'disk fault'); END;");
    await assert.rejects(f.service.create(id, '대화', selection), { code: 'STORAGE_UNAVAILABLE' });
    f.store.db.exec('DROP TRIGGER fail_binding'); await f.service.close();
    f.store = new ChatStore(f.directory); f.service = new ChatService(f.runtime, f.store, f.directory);
    await f.service.recover(id); assert.equal(f.runtime.agents.size, 1);
  } finally { await f.close(); }
});

test('two callers admit one message; only its matching completion opens the next admission', async () => {
  const f = fixture();
  try {
    const { id, agentId } = await create(f);
    const results = await Promise.allSettled([f.service.send(id, randomUUID(), 'first'), f.service.send(id, randomUUID(), 'second')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(f.runtime.sends.length, 1);
    const executionId = f.runtime.agents.get(agentId).executionId;
    f.runtime.emit({ type: 'execution.finished', agentId, executionId: 'stale', outcome: 'completed', error: null });
    await tick(); assert.ok(f.store.get(id).pendingMessageId);
    f.runtime.finish(agentId, 'completed', executionId); await tick();
    assert.equal(f.store.get(id).pendingMessageId, null);
    await assert.rejects(f.service.send(id, f.runtime.sends[0].messageId, 'first'), { code: 'MESSAGE_ALREADY_SENT' });
    await f.service.send(id, randomUUID(), 'follow-up'); assert.equal(f.runtime.sends.length, 2);
  } finally { await f.close(); }
});

test('cancel stays available while the delivery acknowledgement is pending', async () => {
  const f = fixture();
  let release;
  try {
    const { id, agentId } = await create(f);
    f.runtime.onSend = () => new Promise(resolve => { release = resolve; });
    const sending = f.service.send(id, randomUUID(), 'hold');
    while (!release) await tick();
    const cancelling = f.service.cancel(id);
    await tick(); assert.equal(f.store.get(id).cancelRequested, true);
    release(); await sending; await cancelling; await tick();
    assert.equal(f.runtime.agents.get(agentId).state, 'ready'); assert.equal(f.store.get(id).pendingMessageId, null);
  } finally { release?.(); await f.close(); }
});

test('a delayed cancellation never cancels the next input after its target has completed', async () => {
  const f = fixture();
  let release;
  try {
    const { id, agentId } = await create(f);
    f.runtime.onSend = () => new Promise(resolve => { release = resolve; });
    const sending = f.service.send(id, randomUUID(), 'first');
    while (!release) await tick();
    const cancelling = f.service.cancel(id);
    await tick();
    f.runtime.finish(agentId); await tick();
    assert.equal((await f.service.get(id)).chat.status, 'ready');
    f.runtime.onSend = undefined;
    const nextId = randomUUID();
    await f.service.send(id, nextId, 'next');
    release(); await sending; await cancelling; await tick();
    assert.equal(f.store.get(id).pendingMessageId, nextId);
    assert.equal((await f.service.get(id)).chat.status, 'running');
  } finally { release?.(); await f.close(); }
});

test('lost delivery response and idle after restart do not prove completion or cause resend', async () => {
  const f = fixture();
  try {
    const { id, agentId } = await create(f);
    f.runtime.failSendResponse = true;
    await assert.rejects(f.service.send(id, randomUUID(), 'uncertain'), { code: 'MESSAGE_OUTCOME_UNKNOWN' });
    await tick(); await f.service.close();
    f.runtime.agents.get(agentId).state = 'ready'; f.runtime.agents.get(agentId).executionId = null;
    f.store = new ChatStore(f.directory); f.service = new ChatService(f.runtime, f.store, f.directory);
    const view = await f.service.get(id); assert.equal(view.chat.status, 'unknown'); assert.equal(view.timeline.items.length, 1);
    await assert.rejects(f.service.send(id, randomUUID(), 'retry'), { code: 'CHAT_BUSY' }); assert.equal(f.runtime.sends.length, 1);
  } finally { await f.close(); }
});

test('permission responses compete in the daemon and a lost response is only reconciled by reading', async () => {
  const f = fixture();
  try {
    const { id, agentId } = await create(f);
    await f.service.send(id, randomUUID(), '[permission]');
    const permissionId = f.runtime.agents.get(agentId).permissions[0].id;
    const results = await Promise.allSettled([f.service.permission(id, permissionId, 'allow'), f.service.permission(id, permissionId, 'deny')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(f.runtime.permissionCalls.length, 1);
    await tick();
    await f.service.send(id, randomUUID(), '[permission]');
    const next = f.runtime.agents.get(agentId).permissions[0].id;
    f.runtime.failPermissionResponse = true;
    await assert.rejects(f.service.permission(id, next, 'deny'), { code: 'PERMISSION_OUTCOME_UNKNOWN' });
    await f.service.get(id);
    await assert.rejects(f.service.permission(id, next, 'allow'), { code: 'PERMISSION_RESOLVED' });
    assert.equal(f.runtime.permissionCalls.length, 2);
  } finally { await f.close(); }
});

test('unsupported permission cannot be allowed; denial remains available', async () => {
  const f = fixture();
  try {
    const { id, agentId } = await create(f); await f.service.send(id, randomUUID(), '[unsupported]');
    const permissionId = f.runtime.agents.get(agentId).permissions[0].id;
    await assert.rejects(f.service.permission(id, permissionId, 'allow'), { code: 'PERMISSION_UNSUPPORTED' });
    assert.equal(f.runtime.permissionCalls.length, 0);
    await f.service.permission(id, permissionId, 'deny');
  } finally { await f.close(); }
});

test('partial configuration exposes actual values and blocks input until verified', async () => {
  const f = fixture();
  try {
    const { id } = await create(f);
    f.runtime.failConfiguration = true;
    await assert.rejects(f.service.configure(id, { model: 'fake-model', effort: 'medium' }));
    const partial = await f.service.get(id);
    assert.equal(partial.chat.status, 'configuration-required'); assert.deepEqual(partial.chat.selection, { model: 'fake-model', effort: 'low' });
    await assert.rejects(f.service.send(id, randomUUID(), 'blocked'), { code: 'CONFIGURATION_REQUIRED' });
    await f.service.configure(id, { model: 'fake-model', effort: 'medium' });
    await f.service.send(id, randomUUID(), 'configured'); assert.equal(f.runtime.sends.length, 1);
  } finally { await f.close(); }
});

test('storage failure before admission sends no prompt; reconnect cannot use an old observation', async () => {
  const f = fixture();
  try {
    const { id } = await create(f);
    f.store.db.exec("CREATE TRIGGER fail_admission BEFORE UPDATE OF pending_message_id ON chats BEGIN SELECT RAISE(ABORT, 'disk fault'); END;");
    await assert.rejects(f.service.send(id, randomUUID(), 'not sent'), { code: 'STORAGE_UNAVAILABLE' });
    assert.equal(f.runtime.sends.length, 0); assert.equal(f.service.info().storageAvailable, false);
  } finally { await f.close(); }
  const g = fixture();
  try {
    const { id } = await create(g);
    const original = g.runtime.inspect.bind(g.runtime);
    g.runtime.inspect = async agentId => { const state = await original(agentId); g.runtime.setConnected(false); g.runtime.setConnected(true); return state; };
    await assert.rejects(g.service.send(id, randomUUID(), 'stale observation'), { code: 'RUNTIME_UNAVAILABLE' });
    assert.equal(g.runtime.sends.length, 0);
  } finally { await g.close(); }
});
