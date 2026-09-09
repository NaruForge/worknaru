import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { ChatConnection } from '../dist/chat-connection.js';
import { chatFixture } from './chat-fixture.mjs';
const selection = { model: 'gpt-5.6-luna', effort: 'low' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const connect = async url => { const client = new ChatConnection(url, url => new WebSocket(url), false); await client.connect(); return client; };

test('UI/headless contract rejects old clients and non-loopback browser origins', async () => {
  const f = await chatFixture();
  try {
    const legacy = new WebSocket(f.server.url);
    legacy.on('error', () => {});
    const closed = new Promise(resolve => legacy.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
    await new Promise(resolve => legacy.once('open', resolve)); legacy.send(JSON.stringify({ type: 'hello', version: 1 }));
    assert.match((await closed).reason, /protocol 2/);
    const foreign = new WebSocket(f.server.url, { origin: 'https://foreign.example' });
    const error = new Promise(resolve => foreign.once('error', resolve));
    assert.match((await error).message, /403/);
    const client = await connect(f.server.url);
    try {
      const info = await client.call('runtime.get', {}); assert.equal(info.protocol, 2);
      assert.deepEqual(Object.keys(info).sort(), ['connected', 'protocol', 'storageAvailable', 'workspace']);
    } finally { client.close(); }
  } finally { await f.close(); }
});

test('closing a client during delivery loses its reply while execution and the common API remain available', async () => {
  const f = await chatFixture(); let release; const clients = [];
  try {
    const first = await connect(f.server.url), second = await connect(f.server.url); clients.push(first, second);
    const id = randomUUID(); await first.call('chats.create', { id, title: 'headless', selection });
    f.runtime.onSend = () => new Promise(resolve => { release = resolve; });
    const result = first.call('messages.send', { chatId: id, messageId: randomUUID(), text: 'stay alive' });
    const lost = assert.rejects(result, { code: 'RESULT_UNKNOWN' });
    while (!release) await tick();
    first.close(); await lost; release();
    const view = await second.call('chats.get', { chatId: id }); assert.equal(view.chat.status, 'running'); assert.equal(f.runtime.sends.length, 1);
    await second.call('messages.cancel', { chatId: id }); await tick();
    assert.equal((await second.call('chats.get', { chatId: id })).chat.status, 'ready');
    const requestPath = join(f.directory, 'request.json');
    writeFileSync(requestPath, JSON.stringify({ method: 'chats.list', params: {} }));
    const rpc = await promisify(execFile)(process.execPath, ['dist/rpc.js', '--url', f.server.url, '--file', requestPath], { windowsHide: true });
    const response = JSON.parse(rpc.stdout); assert.equal(response.result[0].id, id);
  } finally { release?.(); for (const client of clients) client.close(); await f.close(); }
});

test('two websocket clients cannot submit two prompts or race two permission decisions', async () => {
  const f = await chatFixture(), clients = [];
  try {
    const one = await connect(f.server.url), two = await connect(f.server.url); clients.push(one, two);
    const id = randomUUID(); await one.call('chats.create', { id, title: 'competition', selection });
    const sent = await Promise.allSettled([one.call('messages.send', { chatId: id, messageId: randomUUID(), text: '[permission]' }),
      two.call('messages.send', { chatId: id, messageId: randomUUID(), text: '[permission]' })]);
    assert.equal(sent.filter(result => result.status === 'fulfilled').length, 1);
    const view = await two.call('chats.get', { chatId: id });
    const permissionId = view.chat.permissions[0].id;
    const responded = await Promise.allSettled([one.call('permissions.respond', { chatId: id, permissionId, decision: 'allow' }),
      two.call('permissions.respond', { chatId: id, permissionId, decision: 'deny' })]);
    assert.equal(responded.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(f.runtime.permissionCalls.length, 1);
  } finally { for (const client of clients) client.close(); await f.close(); }
});
