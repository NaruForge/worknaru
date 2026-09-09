import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, release } from 'node:os';
import { execFileSync } from 'node:child_process';
import { PaseoRuntime } from '../dist/paseo-runtime.js';
import { deadline } from '../dist/owned-process.js';

const selection = Object.freeze({ model: 'gpt-5.6-luna', effort: 'low' });
const live = process.env.WORKNARU_LIVE === '1';
const hash = path => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;

test('private Paseo: guarded first/follow-up responses, cancellation and cleanup', { skip: !live, timeout: 180_000 }, async () => {
  const codexPath = process.env.WORKNARU_CODEX_PATH;
  assert.ok(codexPath, 'WORKNARU_CODEX_PATH is required; no executable or model fallback.');
  const root = process.cwd();
  const directory = join(root, '.worknaru-test', `paseo-live-${randomUUID()}`);
  const workspace = join(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const log = join(directory, 'verification.jsonl');
  const record = value => { appendFileSync(log, `${JSON.stringify(value)}\n`); console.log(JSON.stringify(value)); };
  const personal = [join(homedir(), '.paseo', 'config.json'), join(homedir(), '.paseo', 'server-id'), join(homedir(), '.codex', 'config.toml'), join(homedir(), '.codex', 'auth.json')];
  const before = personal.map(hash);
  record({ environment: { windows: release(), node: process.version,
    paseo: '0.8.0-beta.1', codexPath, codex: execFileSync(codexPath, ['--version'], { encoding: 'utf8', windowsHide: true }).trim() }, directory });
  const runtime = await PaseoRuntime.start({ projectRoot: root, dataDir: join(directory, 'data'), workspace, codexPath, testMode: true });
  let count = 0;
  const events = [];
  const unsubscribe = runtime.subscribe(event => {
    events.push(event);
    appendFileSync(join(directory, 'native-events.jsonl'), `${JSON.stringify(event)}\n`);
  });
  async function turn(agentId, scenario, prompt, cancel = false) {
    const start = events.length;
    const messageId = randomUUID();
    // Check support and effective values before every actual prompt. Runtime repeats this guard at dispatch.
    await runtime.confirmSelection(agentId, selection);
    record({ scenario, messageId, ...selection, call: ++count, result: 'dispatching' });
    const finished = new Promise(resolve => {
      const off = runtime.subscribe(event => {
        if (event.type === 'agent_stream' && event.agentId === agentId &&
          ['turn_completed', 'turn_failed', 'turn_canceled'].includes(event.event.type)) { off(); resolve(event.event); }
      });
    });
    await runtime.send(agentId, prompt, messageId, selection);
    if (cancel) await runtime.cancel(agentId);
    const terminal = await deadline(finished, 60_000, 'No matching native turn completion event.');
    assert.equal(terminal.type, cancel ? 'turn_canceled' : 'turn_completed');
    const started = events.slice(start).find(event => event.type === 'agent_stream' && event.event.type === 'turn_started');
    assert.ok(started?.event.turnId);
    assert.equal(terminal.turnId, started.event.turnId);
    record({ scenario, messageId, ...selection, call: count, result: terminal.type, turnId: terminal.turnId });
    return terminal;
  }
  try {
    const agent = await runtime.create(randomUUID(), '저비용 Paseo 연결 검증', selection);
    await runtime.watch([agent.id]);
    await turn(agent.id, 'first-response', 'Reply exactly WORKNARU_PASEO_OK. Do not use tools.');
    await turn(agent.id, 'follow-up', 'What exact token did you just reply with? Reply only that token. Do not use tools.');
    const history = await runtime.history(agent.id);
    writeFileSync(join(directory, 'native-history.json'), JSON.stringify(history, null, 2));
    await turn(agent.id, 'cancel', 'Use the shell to wait for 30 seconds, then reply DONE. Do not change files.', true);
  } finally {
    unsubscribe();
    await runtime.stop();
    assert.deepEqual(personal.map(hash), before, 'Personal Paseo and Codex configuration/authentication were not modified.');
    assert.throws(() => process.kill(runtime.pid, 0), { code: 'ESRCH' });
    record({ scenario: 'cleanup', calls: count, result: 'owned runtime stopped; personal configuration unchanged' });
  }
});
