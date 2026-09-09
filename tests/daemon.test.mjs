import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect as connectTcp } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { startDaemon } from '../dist/daemon.js';
import { connect, createSession, deadline, fixture, launch, mutation, projectRoot } from './helpers.mjs';

test('committed messages and original receipts survive forced process restart without replay', async (t) => {
  const f = fixture(t);
  let daemon = await launch(f);
  let client = await connect(f, daemon);
  const session = await createSession(client, daemon.workspace.workspaceId);
  const request = mutation(client);
  const params = { sessionId: session.sessionId, text: '재시작 뒤에도 남아야 하는 메시지' };
  const saved = await client.call('messages.append', params, request);
  assert.equal(saved.ok, true);
  assert.equal(saved.result.aiExecution, false);
  const oldEpoch = client.ready.storeEpoch;
  const oldInstance = client.ready.daemonInstanceId;
  await daemon.stop();
  daemon = await launch(f);
  client = await connect(f, daemon);
  assert.equal(client.ready.storeEpoch, oldEpoch);
  assert.notEqual(client.ready.daemonInstanceId, oldInstance);
  const receipt = await client.call('requests.get', { workspaceId: daemon.workspace.workspaceId, requestId: request.requestId, storeEpoch: oldEpoch });
  assert.equal(receipt.result.found, true);
  assert.deepEqual(receipt.result.result, saved.result);
  const replay = await client.call('messages.append', params, request);
  assert.deepEqual(replay.result, saved.result);
  const list = await client.call('messages.list', { sessionId: session.sessionId });
  assert.equal(list.result.messages.length, 1);
  assert.equal(list.result.messages[0].text, params.text);
  assert.equal(daemon.output().includes(f.token), false);
});

test('lost client connection is resolved by receipt; concurrent duplicate requests commit once', async (t) => {
  const f = fixture(t);
  const daemon = await launch(f);
  const first = await connect(f, daemon);
  const second = await connect(f, daemon);
  const session = await createSession(first, daemon.workspace.workspaceId);
  const params = { sessionId: session.sessionId, text: '한 번만 저장' };
  const request = mutation(first);
  const results = await Promise.all([first.call('messages.append', params, request), second.call('messages.append', params, request)]);
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(results[0].result, results[1].result);
  first.ws.terminate();
  const receipt = await second.call('requests.get', { workspaceId: daemon.workspace.workspaceId, requestId: request.requestId, storeEpoch: first.ready.storeEpoch });
  assert.equal(receipt.result.found, true);
  const conflict = await second.call('messages.append', { ...params, text: '다른 내용' }, request);
  assert.equal(conflict.error.code, 'REQUEST_ID_CONFLICT');
  const list = await second.call('messages.list', { sessionId: session.sessionId });
  assert.equal(list.result.messages.length, 1);
});

test('a discarded response can be recovered without knowing its message ID', async (t) => {
  const f = fixture(t);
  const daemon = await launch(f);
  const sender = await connect(f, daemon);
  const observer = await connect(f, daemon);
  const session = await createSession(sender, daemon.workspace.workspaceId);
  const request = mutation(sender);
  // Drop the response at the client before it is parsed or used to acknowledge the input.
  sender.ws.removeAllListeners('message');
  sender.send({ type: 'request', callId: 'lost', method: 'messages.append', params: { sessionId: session.sessionId, text: '응답을 놓친 입력' }, ...request });
  let receipt;
  for (let attempt = 0; attempt < 20; attempt++) {
    receipt = await observer.call('requests.get', { workspaceId: daemon.workspace.workspaceId, requestId: request.requestId, storeEpoch: request.storeEpoch });
    if (receipt.result.found) break;
  }
  sender.ws.terminate();
  assert.equal(receipt.result.found, true);
  const replay = await observer.call('messages.append', { sessionId: session.sessionId, text: '응답을 놓친 입력' }, request);
  assert.deepEqual(replay.result, receipt.result.result);
  assert.equal((await observer.call('messages.list', { sessionId: session.sessionId })).result.messages.length, 1);
});

test('session creation is idempotent and request keys cannot change methods', async (t) => {
  const f = fixture(t);
  const daemon = await launch(f);
  const client = await connect(f, daemon);
  const request = mutation(client);
  const params = { workspaceId: daemon.workspace.workspaceId, title: '대화' };
  const created = await client.call('sessions.create', params, request);
  const replay = await client.call('sessions.create', { title: '대화', workspaceId: params.workspaceId }, request);
  assert.deepEqual(replay.result, created.result);
  const collision = await client.call('messages.append', { sessionId: created.result.session.sessionId, text: '충돌' }, request);
  assert.equal(collision.error.code, 'REQUEST_ID_CONFLICT');
  assert.equal((await client.call('sessions.list', { workspaceId: params.workspaceId })).result.sessions.length, 1);
});

test('authentication and protocol version precede every business request', async (t) => {
  const f = fixture(t);
  const daemon = await launch(f);
  const wrong = await connect(f, daemon, randomBytes(32).toString('base64url'));
  assert.equal(wrong.ready.error.code, 'AUTH_FAILED');
  const missing = await connect(f, daemon, null);
  missing.send({ type: 'hello', protocolMajor: 1 });
  assert.equal((await missing.receive()).error.code, 'AUTH_FAILED');
  const early = await connect(f, daemon, null);
  early.send({ type: 'request', callId: 'early', method: 'workspaces.get', params: {} });
  assert.equal((await early.receive()).error.code, 'AUTH_REQUIRED');
  const version = await connect(f, daemon, null);
  version.send({ type: 'hello', protocolMajor: 99, token: f.token });
  assert.equal((await version.receive()).error.code, 'PROTOCOL_MISMATCH');
  const client = await connect(f, daemon);
  assert.equal((await client.call('runs.start', {})).error.code, 'METHOD_NOT_SUPPORTED');
  assert.equal(client.ready.aiExecution, false);
});

test('unknown Host, Origin and URL are rejected before WebSocket upgrade', async (t) => {
  const f = fixture(t);
  const daemon = await launch(f);
  for (const [url, headers] of [
    [daemon.url, { Origin: 'https://example.com' }],
    [daemon.url, { Host: 'attacker.invalid' }],
    [`${daemon.url}?token=not-allowed`, {}],
  ]) {
    const status = await deadline(new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      f.cleanups.push(() => ws.terminate());
      ws.on('error', () => {});
      ws.once('open', () => reject(new Error('Unexpected upgrade')));
      ws.once('unexpected-response', (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
    }));
    assert.equal(status, 403);
  }
});

test('a Workspace scope cannot read or mutate a Session from another Workspace', async (t) => {
  const f = fixture(t);
  let daemon = await launch(f);
  let client = await connect(f, daemon);
  const workspaceA = daemon.workspace.workspaceId;
  const session = await createSession(client, workspaceA);
  const request = mutation(client);
  await client.call('messages.append', { sessionId: session.sessionId, text: 'A에서만 조회' }, request);
  await daemon.stop();
  const other = join(f.root, 'other-workspace');
  mkdirSync(other);
  daemon = await launch(f, { workspace: other });
  client = await connect(f, daemon);
  assert.notEqual(daemon.workspace.workspaceId, workspaceA);
  for (const [method, params] of [
    ['sessions.get', { sessionId: session.sessionId }],
    ['messages.list', { sessionId: session.sessionId }],
    ['sessions.list', { workspaceId: workspaceA }],
    ['requests.get', { workspaceId: workspaceA, requestId: request.requestId, storeEpoch: request.storeEpoch }],
  ]) assert.equal((await client.call(method, params)).error.code, 'NOT_FOUND');
  assert.equal((await client.call('messages.append', { sessionId: session.sessionId, text: '침범' }, mutation(client))).error.code, 'NOT_FOUND');
  assert.equal((await client.call('sessions.create', { workspaceId: workspaceA }, mutation(client))).error.code, 'NOT_FOUND');
});

test('epoch mismatch and invalid input create no records', async (t) => {
  const f = fixture(t);
  const daemon = await launch(f);
  const client = await connect(f, daemon);
  const session = await createSession(client, daemon.workspace.workspaceId);
  const valid = { sessionId: session.sessionId, text: '입력' };
  assert.equal((await client.call('messages.append', valid, { ...mutation(client), storeEpoch: randomUUID() })).error.code, 'STORE_EPOCH_MISMATCH');
  for (const params of [{ ...valid, text: ' ' }, { ...valid, text: '\ud800' }, { ...valid, text: '한'.repeat(6000) }, { ...valid, moduleId: 'admin' }]) {
    assert.equal((await client.call('messages.append', params, mutation(client))).error.code, 'INVALID_REQUEST');
  }
  assert.equal((await client.call('messages.list', { sessionId: session.sessionId })).result.messages.length, 0);
  const missing = await client.call('requests.get', { workspaceId: daemon.workspace.workspaceId, requestId: randomUUID(), storeEpoch: client.ready.storeEpoch });
  assert.equal(missing.result.found, false);
});

test('message pagination fixes an upper boundary and limits bytes', async (t) => {
  const f = fixture(t);
  const daemon = await launch(f);
  const client = await connect(f, daemon);
  const session = await createSession(client, daemon.workspace.workspaceId);
  for (let n = 0; n < 16; n++) {
    assert.equal((await client.call('messages.append', { sessionId: session.sessionId, text: `${n}:` + 'x'.repeat(16000) }, mutation(client))).ok, true);
  }
  const first = await client.call('messages.list', { sessionId: session.sessionId, limit: 50 });
  assert.ok(first.result.messages.length < 16);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 256 * 1024);
  await client.call('messages.append', { sessionId: session.sessionId, text: '이후에 추가된 메시지' }, mutation(client));
  const second = await client.call('messages.list', { sessionId: session.sessionId, after: first.result.nextAfter, upTo: first.result.upTo, limit: 50 });
  const combined = [...first.result.messages, ...second.result.messages];
  assert.equal(combined.length, 16);
  assert.equal(new Set(combined.map((message) => message.messageId)).size, 16);
  assert.equal(second.result.nextAfter, null);
});

test('an exclusive owner survives connection loss and is released on process death', async (t) => {
  const f = fixture(t);
  const daemon = await launch(f);
  await assert.rejects(launch(f), /DATA_IN_USE/);
  const client = await connect(f, daemon);
  client.ws.terminate();
  await assert.rejects(launch(f), /DATA_IN_USE/);
  await daemon.stop();
  const replacement = await launch(f);
  assert.equal(replacement.storeEpoch, daemon.storeEpoch);
});

test('a failed receipt write rolls back the message and blocks later writes', async (t) => {
  const f = fixture(t);
  let daemon = await launch(f);
  let client = await connect(f, daemon);
  const session = await createSession(client, daemon.workspace.workspaceId);
  await daemon.stop();
  const db = new DatabaseSync(join(f.data, 'records.sqlite'));
  db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
  db.close();
  daemon = await launch(f);
  client = await connect(f, daemon);
  const request = mutation(client);
  const response = await client.call('messages.append', { sessionId: session.sessionId, text: '부분 기록 금지' }, request);
  assert.equal(response.error.code, 'STORE_UNAVAILABLE');
  assert.equal(JSON.stringify(response).includes('test write failure'), false);
  assert.equal((await client.call('sessions.create', { workspaceId: daemon.workspace.workspaceId }, mutation(client))).error.code, 'STORE_UNAVAILABLE');
  assert.equal((await client.call('requests.get', { workspaceId: daemon.workspace.workspaceId, requestId: request.requestId, storeEpoch: request.storeEpoch })).error.code, 'STORE_UNAVAILABLE');
  await daemon.stop();
  const inspect = new DatabaseSync(join(f.data, 'records.sqlite'));
  assert.equal(inspect.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
  assert.equal(inspect.prepare('SELECT count(*) AS n FROM receipts WHERE request_id = ?').get(request.requestId).n, 0);
  inspect.exec('DROP TRIGGER fail_receipt');
  inspect.close();
  daemon = await launch(f);
  client = await connect(f, daemon);
  assert.equal((await client.call('messages.append', { sessionId: session.sessionId, text: '부분 기록 금지' }, request)).ok, true);
});

test('oversized frames close only the offending connection', async (t) => {
  const f = fixture(t);
  const daemon = await launch(f);
  const client = await connect(f, daemon);
  const closed = once(client.ws, 'close');
  client.ws.send('x'.repeat(65537));
  const [code] = await deadline(closed);
  assert.equal(code, 1009);
  const healthy = await connect(f, daemon);
  assert.equal((await healthy.call('workspaces.get', {})).ok, true);
});

test('graceful shutdown releases the store and configured local Origin is accepted', async (t) => {
  const f = fixture(t);
  const options = { projectRoot, dataDirectory: f.data, workspaceDirectory: f.workspace, token: f.token, origins: ['http://127.0.0.1:3000'] };
  const daemon = await startDaemon(options);
  f.cleanups.push(() => daemon.close());
  const client = await connect(f, daemon, f.token, { origin: options.origins[0] });
  assert.equal(client.ready.type, 'ready');
  await daemon.close();
  const next = await startDaemon(options);
  f.cleanups.push(() => next.close());
  assert.equal(next.storeEpoch, daemon.storeEpoch);
});

test('shutdown closes incomplete HTTP requests and releases the data owner lock', async (t) => {
  const f = fixture(t);
  const options = { projectRoot, dataDirectory: f.data, workspaceDirectory: f.workspace, token: f.token };
  const daemon = await startDaemon(options);
  f.cleanups.push(() => daemon.close());
  const socket = connectTcp({ host: '127.0.0.1', port: Number(new URL(daemon.url).port) });
  socket.on('error', () => {});
  f.cleanups.push(() => socket.destroy());
  await deadline(once(socket, 'connect'));
  socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n');
  // Let the server receive the partial headers before initiating shutdown.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const disconnected = new Promise((resolve) => socket.once('close', resolve));
  await deadline(daemon.close(), 1_000);
  await deadline(disconnected, 1_000);
  const replacement = await startDaemon(options);
  f.cleanups.push(() => replacement.close());
  assert.equal(replacement.storeEpoch, daemon.storeEpoch);
});

test('unsupported schema and corrupt database fail startup without replacing the file', async (t) => {
  const f = fixture(t);
  const file = join(f.data, 'records.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE preserve_me (value TEXT); INSERT INTO preserve_me VALUES (\'keep\'); PRAGMA user_version = 999;');
  db.close();
  const original = readFileSync(file);
  await assert.rejects(launch(f), /UNSUPPORTED_STORE/);
  assert.deepEqual(readFileSync(file), original);
  const corruptData = join(f.root, 'corrupt-data');
  mkdirSync(corruptData);
  const corruptFile = join(corruptData, 'records.sqlite');
  writeFileSync(corruptFile, 'not a SQLite database');
  await assert.rejects(launch(f, { data: corruptData }), /STORE_UNAVAILABLE/);
  assert.equal(readFileSync(corruptFile, 'utf8'), 'not a SQLite database');
});

test('development data rejects project root, traversal, directory junctions and linked DB files', async (t) => {
  const f = fixture(t);
  const options = { projectRoot, workspaceDirectory: f.workspace, token: f.token };
  for (const dataDirectory of [projectRoot, '..']) {
    await assert.rejects(startDaemon({ ...options, dataDirectory }), { code: 'INVALID_DATA_PATH' });
  }
  const link = join(f.root, 'linked-directory');
  symlinkSync(f.workspace, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(startDaemon({ ...options, dataDirectory: link }), { code: 'INVALID_DATA_PATH' });
  const fileTarget = join(f.data, 'records.sqlite');
  // A directory in a DB file position is rejected before SQLite opens it.
  mkdirSync(fileTarget);
  await assert.rejects(startDaemon({ ...options, dataDirectory: f.data }), { code: 'INVALID_DATA_PATH' });
  const linkedData = join(f.root, 'linked-db');
  mkdirSync(linkedData);
  const original = join(f.root, 'original.sqlite');
  writeFileSync(original, '');
  linkSync(original, join(linkedData, 'records.sqlite'));
  await assert.rejects(startDaemon({ ...options, dataDirectory: linkedData }), { code: 'INVALID_DATA_PATH' });
});
