import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ChatStateStore } from '../dist/chat-state.js';
import { WebClient } from '../dist/web-client.js';
import { fixture, launch, connect, createSession, mutation, projectRoot, deadline } from './helpers.mjs';

const memory = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
};

test('newest session paging is bounded and stable when new sessions are inserted', async (t) => {
  const f = fixture(t);
  const daemon = await launch(f);
  const client = await connect(f, daemon);
  const sessions = [];
  for (let i = 0; i < 5; i++) sessions.push(await createSession(client, daemon.workspace.workspaceId, `대화 ${i}`));
  const first = (await client.call('sessions.list', { workspaceId: daemon.workspace.workspaceId, order: 'desc', limit: 2 })).result;
  assert.deepEqual(first.sessions.map((session) => session.sessionId), sessions.slice(3).reverse().map((session) => session.sessionId));
  await createSession(client, daemon.workspace.workspaceId, '페이지 조회 중 새 대화');
  const second = (await client.call('sessions.list', { workspaceId: daemon.workspace.workspaceId, order: 'desc', after: first.nextAfter, limit: 2 })).result;
  assert.deepEqual(second.sessions.map((session) => session.sessionId), sessions.slice(1, 3).reverse().map((session) => session.sessionId));
  assert.equal(first.sessions[0].latestRunId, null);
  assert.equal(first.sessions[0].storageAvailable, true);
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

test('platform client validates loopback endpoint, recovers create receipts and does not mutate with unavailable browser journal', async (t) => {
  const f = fixture(t);
  const daemon = await launch(f);
  const client = new WebClient();
  t.after(() => client.close());
  await assert.rejects(client.connect('ws://example.com:4310/ws', f.token), { code: 'INVALID_URL' });
  await client.connect(daemon.url, f.token);
  const journal = memory();
  const requestId = randomUUID();
  const created = await client.call('sessions.create', { workspaceId: daemon.workspace.workspaceId, title: '접수 응답을 잃은 대화' }, { requestId, storeEpoch: client.ready.storeEpoch });
  const key = `worknaru.pending.v1:${daemon.url}:${daemon.workspace.workspaceId}`;
  journal.setItem(key, JSON.stringify({ method: 'sessions.create', requestId, storeEpoch: client.ready.storeEpoch, workspaceId: daemon.workspace.workspaceId }));
  const model = new ChatStateStore(client, journal);
  t.after(() => model.close());
  await model.connect(daemon.url, f.token);
  assert.equal(model.getSnapshot().selected, created.session.sessionId);
  assert.equal(model.getSnapshot().sessions.length, 1);
  assert.equal(journal.getItem(key), null);
  model.close();
  const broken = new ChatStateStore(new WebClient(), { ...memory(), setItem() { throw new Error('Quota exceeded'); } });
  t.after(() => broken.close());
  await broken.connect(daemon.url, f.token);
  await broken.createSession();
  assert.match(broken.getSnapshot().error, /전송하지 않았습니다/);
  assert.equal(broken.getSnapshot().sessions.length, 1);
  const observer = await connect(f, daemon);
  assert.equal((await observer.call('sessions.list', { workspaceId: daemon.workspace.workspaceId })).result.sessions.length, 1);
});

test('missing receipt restores draft while mismatched store epoch remains unresolved', async (t) => {
  const f = fixture(t);
  const daemon = await launch(f);
  const observer = await connect(f, daemon);
  const session = await createSession(observer, daemon.workspace.workspaceId);
  const key = `worknaru.pending.v1:${daemon.url}:${daemon.workspace.workspaceId}`;
  const pending = { method: 'runs.start', sessionId: session.sessionId, text: '보존할 입력', workspaceId: session.workspaceId, ...mutation(observer) };
  const journal = memory();
  journal.setItem(key, JSON.stringify(pending));
  const model = new ChatStateStore(new WebClient(), journal);
  t.after(() => model.close());
  await model.connect(daemon.url, f.token);
  assert.equal(model.getSnapshot().drafts[session.sessionId], pending.text);
  assert.equal(model.getSnapshot().pending, undefined);
  assert.equal((await observer.call('messages.list', { sessionId: session.sessionId })).result.messages.length, 0);
  model.close();
  journal.setItem(key, JSON.stringify({ ...pending, storeEpoch: randomUUID() }));
  await model.connect(daemon.url, f.token);
  assert.ok(model.getSnapshot().pending);
  assert.match(model.getSnapshot().error, /같은 접수 저장소인지/);
  assert.ok(journal.getItem(key));
  await model.createSession();
  assert.equal(model.getSnapshot().sessions.length, 1);
});
