import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { startApplication } from '../dist/application.js';
import { ChatConnection } from '../dist/chat-connection.js';
import { deadline } from '../dist/owned-process.js';
import { startDevServers } from '../scripts/dev.mjs';

const root = process.cwd();
const fixture = () => {
  const directory = join(root, '.worknaru-test', `application-${randomUUID()}`);
  const workspace = join(directory, 'workspace'), dataDir = join(directory, 'data');
  mkdirSync(workspace, { recursive: true });
  return { projectRoot: root, directory, workspace, dataDir, codexPath: process.execPath, port: 0, testMode: true };
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function gone(pid) {
  const expires = Date.now() + 10_000;
  while (alive(pid) && Date.now() < expires) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(alive(pid), false, `Owned runtime ${pid} is still alive`);
}
async function launch(options, args = []) {
  const child = spawn(process.execPath, ['dist/main.js', '--data-dir', options.dataDir, '--workspace', options.workspace,
    '--codex-path', options.codexPath, '--port', String(options.port), ...args], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, env: { ...process.env, WORKNARU_TEST_MODEL_POLICY: '1' },
  });
  let output = '', errors = '';
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  child.stderr.on('data', data => { errors += data; });
  const ready = await deadline(new Promise((resolve, reject) => {
    child.stdout.on('data', data => {
      output += data;
      for (const line of output.split('\n')) {
        try { const event = JSON.parse(line); if (event.type === 'ready') resolve(event); } catch {}
      }
    });
    child.once('error', reject);
    void exited.then(code => reject(new Error(`Startup exited ${code}: ${errors}`)));
  }), 50_000, 'Product startup timed out').catch(error => { child.kill(); throw error; });
  return { child, ready, exited, async stop() {
    if (child.connected) child.send({ type: 'stop' });
    assert.equal(await deadline(exited, 40_000, 'Product did not stop'), 0, errors);
    assert.match(output, /"type":"stopped","clean":true/); await gone(ready.runtimePid);
    writeFileSync(join(options.directory, 'process.log'), output + errors);
  } };
}

test('standalone startup serves the new UI and same headless API; disconnect keeps runtime alive; explicit stop releases ownership', { timeout: 90_000 }, async () => {
  const f = fixture();
  const product = await launch(f, ['--web-ui']);
  try {
    const response = await fetch(product.ready.webUrl); assert.equal(response.status, 200);
    const html = await response.text(); assert.match(html, /id="root"/); assert.doesNotMatch(html, /PASEO|password|worknaru-dev-auth/);
    assert.equal((await fetch(`${product.ready.webUrl}src/paseo-runtime.ts`)).status, 404);
    assert.equal((await fetch(product.ready.webUrl, { headers: { Origin: 'https://outside.invalid' } })).status, 403);
    const client = new ChatConnection(product.ready.url, url => new WebSocket(url), false);
    await client.connect(); assert.equal((await client.call('runtime.get', {})).protocol, 2); client.close();
    assert.equal(alive(product.ready.runtimePid), true);
    const result = await promisify(execFile)(process.execPath, ['dist/rpc.js', '--url', product.ready.url], { cwd: root, windowsHide: true });
    assert.equal(JSON.parse(result.stdout).result.connected, true);
  } finally { await product.stop(); }
  assert.equal(existsSync(join(f.dataDir, 'runtime-owner.json')), false);
  const again = await launch(f); await again.stop();
});

test('abrupt owner exit closes its private process tree and new startup reuses only the new data', { timeout: 90_000 }, async () => {
  const f = fixture(); const product = await launch(f);
  product.child.kill('SIGKILL'); await product.exited; await gone(product.ready.runtimePid);
  const again = await launch(f); await again.stop();
});

test('development endpoint is injected without native credentials; closing its UI connection does not stop the product', { timeout: 60_000 }, async () => {
  const f = fixture(); const dev = await startDevServers({ ...f, webPort: 0, daemonPort: 0 });
  try {
    const html = await (await fetch(dev.localUrl)).text(); assert.ok(html.includes(`content="${dev.app.url}"`));
    assert.doesNotMatch(html, /PASEO|password/);
    assert.equal((await fetch(dev.localUrl, { headers: { Origin: 'https://outside.invalid' } })).status, 403);
    const client = new ChatConnection(dev.app.url, url => new WebSocket(url, { origin: new URL(dev.localUrl).origin }), false);
    await client.connect(); assert.equal((await client.call('runtime.get', {})).connected, true); client.close();
    assert.equal(alive(dev.app.runtimePid), true);
  } finally { await dev.close(); }
  await gone(dev.app.runtimePid);
});

test('occupied ports clean up only the attempted application and leave the existing listener untouched', { timeout: 60_000 }, async () => {
  const f = fixture(), occupied = createServer((_, response) => response.end('existing'));
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const port = occupied.address().port;
  try {
    await assert.rejects(startDevServers({ ...f, webPort: port, daemonPort: 0 }));
    assert.equal(existsSync(f.dataDir), false);
    await assert.rejects(startApplication({ ...f, port }));
    assert.equal(existsSync(join(f.dataDir, 'runtime-owner.json')), false);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'existing');
  } finally { await new Promise(resolve => occupied.close(resolve)); }
});

test('retired launcher flags are rejected before opening data', async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ['dist/main.js', '--acp'], { cwd: root, windowsHide: true }));
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/dev.mjs', '--hub'], { cwd: root, windowsHide: true }));
});
