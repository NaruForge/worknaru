import test from 'node:test';
import assert from 'node:assert/strict';
import { PaseoChatRuntime } from '../dist/paseo-chat-runtime.js';

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
