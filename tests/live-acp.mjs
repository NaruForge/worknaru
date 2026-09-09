// Explicit integration check: uses the existing Codex login and makes real model requests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startDaemon } from '../dist/daemon.js';
import { connect, createSession, fixture, mutation, projectRoot } from './helpers.mjs';

test('real Codex ACP follow-up resumes context across daemon restart', { skip: !process.env.WORKNARU_CODEX_PATH }, async (t) => {
  const f = fixture(t);
  const options = { projectRoot, dataDirectory: f.data, workspaceDirectory: f.workspace, token: f.token,
    acp: { codexPath: process.env.WORKNARU_CODEX_PATH, requiredSelection: { model: 'gpt-5.6-luna', reasoningEffort: 'low' } },
  };
  let daemon = await startDaemon(options);
  f.cleanups.push(() => daemon.close());
  let client = await connect(f, daemon);
  const session = await createSession(client, daemon.workspace.workspaceId, '실제 ACP 검증');
  const ids = [];
  for (const text of ['Reply with exactly WORKNARU_OK. Do not use any tools or access any files.',
    'Repeat the exact token from your previous reply. Do not use any tools.']) {
    if (ids.length) {
      await daemon.close();
      daemon = await startDaemon(options);
      client = await connect(f, daemon);
    }
    const response = await client.call('runs.start', { sessionId: session.sessionId, text }, mutation(client));
    assert.equal(response.ok, true);
    const runId = response.result.run.runId;
    ids.push(runId);
    await client.call('runs.watch', { runId });
    let run;
    for (let n = 0; n < 650; n++) {
      run = (await client.call('runs.get', { runId })).result;
      if (['completed', 'failed', 'cancelled'].includes(run.state)) break;
      await delay(200);
    }
    assert.equal(run.state, 'completed', JSON.stringify(run));
    assert.equal(run.model, 'gpt-5.6-luna');
    assert.equal(run.reasoningEffort, 'low');
    assert.equal(run.modelConfirmed, 1);
    assert.equal(run.text.trim(), 'WORKNARU_OK');
    assert.ok(client.events.some((event) => event.run.runId === runId && event.run.text.includes('WORKNARU_OK')));
  }
  const messages = (await client.call('messages.list', { sessionId: session.sessionId })).result.messages;
  assert.equal(messages.length, 4);
  await daemon.close();
  daemon = await startDaemon(options);
  client = await connect(f, daemon);
  assert.deepEqual((await client.call('messages.list', { sessionId: session.sessionId })).result.messages, messages);
  for (const runId of ids) assert.equal((await client.call('runs.get', { runId })).result.state, 'completed');
});
