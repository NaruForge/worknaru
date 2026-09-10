import test from 'node:test';
import assert from 'node:assert/strict';
import { PaseoChatRuntime } from '../dist/paseo-chat-runtime.js';

test('message lookup fails on unavailable or incomplete history instead of reporting absence', async () => {
  const page = { epoch: 'epoch', entries: [], hasOlder: false };
  for (const [result, code] of [
    [{ ...page, error: 'unavailable' }, 'HISTORY_UNAVAILABLE'],
    [{ ...page, staleCursor: true }, 'HISTORY_CHANGED'],
    [{ ...page, gap: true }, 'HISTORY_CHANGED'],
    [{ ...page, hasOlder: true }, 'HISTORY_CHANGED'],
    [{ ...page, hasOlder: true, startCursor: { epoch: 'epoch', seq: 0 } }, 'HISTORY_CHANGED'],
    [{ ...page, entries: [{ item: { type: 'user_message', clientMessageId: 'sent' } }] }, 'HISTORY_CHANGED'],
  ]) {
    const runtime = new PaseoChatRuntime({ connection: () => () => {}, history: async () => result });
    await assert.rejects(runtime.locateMessage('agent', 'sent'), { code });
  }
  for (const next of [{ epoch: 'epoch', seq: 10 }, { epoch: 'epoch', seq: 11 }, { epoch: 'other', seq: 9 }]) {
    let reads = 0;
    const runtime = new PaseoChatRuntime({ connection: () => () => {}, history: async () => {
      reads++;
      // The final page makes a broken scan terminate too, so this regression cannot hang.
      return reads > 2 ? page : { ...page, hasOlder: true, startCursor: reads === 1 ? { epoch: 'epoch', seq: 10 } : next };
    } });
    await assert.rejects(runtime.locateMessage('agent', 'sent'), { code: 'HISTORY_CHANGED' });
    assert.equal(reads, 2);
  }
  const rejected = new PaseoChatRuntime({ connection: () => () => {}, history: async () => { throw new Error('connection lost'); } });
  await assert.rejects(rejected.locateMessage('agent', 'sent'), { code: 'HISTORY_UNAVAILABLE' });
  const changed = new PaseoChatRuntime({ connection: () => () => {}, history: async (_id, options) => options.cursor
    ? { ...page, epoch: 'replacement' } : { ...page, hasOlder: true, startCursor: { epoch: 'epoch', seq: 10 } } });
  await assert.rejects(changed.locateMessage('agent', 'sent'), { code: 'HISTORY_CHANGED' });
});

test('message lookup searches older canonical pages and reports absence only after a complete scan', async () => {
  const calls = [];
  const runtime = new PaseoChatRuntime({ connection: () => () => {}, history: async (_id, options) => {
    calls.push(options);
    return options.cursor ? { epoch: 'epoch', hasOlder: false,
      entries: [{ turnId: 'turn', item: { type: 'user_message', clientMessageId: 'sent' } }] }
      : { epoch: 'epoch', entries: [], hasOlder: true, startCursor: { epoch: 'epoch', seq: 10 } };
  } });
  assert.equal(await runtime.locateMessage('agent', 'sent'), 'turn');
  assert.deepEqual(calls[1], { projection: 'canonical', limit: 1000, cursor: { epoch: 'epoch', seq: 10 }, direction: 'before' });
  assert.equal(await runtime.locateMessage('agent', 'new'), null);
  assert.equal(calls.length, 4);
});

test('persisted closed session is loaded by Paseo and its actual snapshot is rechecked', async () => {
  let loaded = false, reads = 0;
  const snapshot = () => ({ id: 'native', status: loaded ? 'idle' : 'closed', persistence: { sessionId: 'saved' },
    pendingPermissions: [], model: 'fake', thinkingOptionId: 'low', effectiveThinkingOptionId: 'low',
    runtimeInfo: { model: 'fake', thinkingOptionId: 'low' } });
  const native = { connection: () => () => {}, inspect: async () => ({ agent: snapshot() }),
    history: async () => { reads++; loaded = true; return {}; } };
  const runtime = new PaseoChatRuntime(native);
  assert.equal((await runtime.inspect('native')).state, 'ready'); assert.equal(reads, 1);
  assert.equal((await runtime.inspect('native')).configurationConfirmed, true); assert.equal(reads, 1);
  loaded = false; native.history = async () => ({ error: 'cannot restore' });
  await assert.rejects(runtime.inspect('native'), { code: 'AGENT_UNAVAILABLE' });
});
