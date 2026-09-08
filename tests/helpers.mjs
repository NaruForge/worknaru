import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { prepareDataDirectory } from '../dist/paths.js';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const testRoot = prepareDataDirectory(projectRoot, '.worknaru-test');

export function fixture(t) {
  const root = mkdtempSync(join(testRoot, 'records-'));
  const originalRoot = realpathSync(root);
  const data = join(root, 'data');
  const workspace = join(root, 'workspace');
  mkdirSync(data);
  mkdirSync(workspace);
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    const target = realpathSync(root);
    const suffix = relative(realpathSync(testRoot), target);
    assert.ok(suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
    assert.equal(target, originalRoot);
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return { root, data, workspace, token: randomBytes(32).toString('base64url'), cleanups };
}

export async function deadline(promise, ms = 8_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for daemon')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export async function launch(f, overrides = {}) {
  const settings = { ...f, ...overrides };
  const child = spawn(process.execPath, [settings.entry ?? join(projectRoot, 'dist/main.js'), '--data-dir', settings.data, '--workspace', settings.workspace, '--port', '0', ...(settings.extraArgs ?? [])], {
    cwd: projectRoot, env: { ...process.env, ...settings.env, WORKNARU_TOKEN: settings.token },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
  const exit = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await deadline(exit);
  };
  f.cleanups.push(stop);
  const ready = await deadline(new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (!output.includes('\n')) return;
      try { resolve(JSON.parse(output.split('\n')[0])); }
      catch (error) { reject(error); }
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`Daemon exited before ready: ${errors}`)));
  }));
  assert.equal(ready.type, 'daemon.ready');
  return { ...ready, child, stop, output: () => output + errors };
}

export async function connect(f, daemon, token = f.token, options = {}) {
  const ws = new WebSocket(daemon.url, options);
  ws.on('error', () => {});
  const queue = [];
  const events = [];
  const waiters = [];
  ws.on('message', (data) => {
    const value = JSON.parse(data.toString());
    if (value.type === 'run.changed') { events.push(value); return; }
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(value); else queue.push(value);
  });
  ws.on('close', () => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('Connection closed'));
  });
  const receive = () => queue.length
    ? Promise.resolve(queue.shift())
    : deadline(new Promise((resolve, reject) => waiters.push({ resolve, reject })));
  f.cleanups.push(() => { ws.terminate(); });
  await deadline(once(ws, 'open'));
  if (token !== null) ws.send(JSON.stringify({ type: 'hello', protocolMajor: 1, token }));
  const ready = token !== null ? await receive() : undefined;
  const send = (value) => ws.send(JSON.stringify(value));
  const call = async (method, params, mutation = {}) => {
    const callId = randomUUID();
    send({ type: 'request', callId, method, params, ...mutation });
    const response = await receive();
    assert.equal(response.callId, callId);
    return response;
  };
  return { ws, ready, send, receive, call, events };
}

export function mutation(client, requestId = randomUUID()) {
  return { requestId, storeEpoch: client.ready.storeEpoch };
}

export async function createSession(client, workspaceId, title = '검증 대화') {
  const result = await client.call('sessions.create', { workspaceId, title }, mutation(client));
  assert.equal(result.ok, true);
  return result.result.session;
}
