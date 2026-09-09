import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isBearerTokenValid } from '@getpaseo/server';
import { privatePaseoConfig } from '../dist/paseo-config.js';
import { PaseoRuntime, privateRuntimeEnvironment } from '../dist/paseo-runtime.js';

const root = process.cwd();
function fixture() {
  const base = join(root, '.worknaru-test', `runtime-test-${randomUUID()}`);
  const workspace = join(base, 'workspace');
  mkdirSync(workspace, { recursive: true });
  return { base, projectRoot: root, workspace, dataDir: join(base, 'data'), codexPath: process.execPath, authFile: join(base, 'no-auth.json') };
}

test('private config disables background features and authenticates only its owner', () => {
  const options = fixture();
  const paseoHome = join(options.base, 'config-test');
  mkdirSync(paseoHome);
  const config = privatePaseoConfig({ paseoHome, codexHome: join(options.base, 'codex'), codexPath: process.execPath, password: 'owner-only-test-secret' });
  assert.equal(isBearerTokenValid({ password: config.auth.password, token: 'owner-only-test-secret' }), true);
  assert.equal(isBearerTokenValid({ password: config.auth.password, token: 'wrong' }), false);
  assert.equal(isBearerTokenValid({ password: config.auth.password, token: null }), false);
  assert.equal(config.listen, '127.0.0.1:0');
  for (const field of ['relayEnabled', 'relayEnabledMutable', 'mcpEnabled', 'mcpInjectIntoAgents', 'browserToolsEnabled', 'pluginsEnabled', 'enableTerminalAgentHooks']) assert.equal(config[field], false, field);
  assert.equal(config.webUi.enabled, false);
  assert.equal(config.configReload, undefined);
  assert.deepEqual(Object.values(config.speech.providers).map(provider => provider.enabled), [false, false, false, false]);
  assert.deepEqual(Object.entries(config.providerOverrides).filter(([, value]) => value.enabled).map(([key]) => key), ['codex']);
  const env = privateRuntimeEnvironment({ paseoHome, codexHome: 'isolated-codex' });
  assert.equal(env.CODEX_HOME, 'isolated-codex');
  assert.equal(env.PASEO_HOME, paseoHome);
  assert.equal(env.TEMP, join(paseoHome, '..', 'tmp'));
  assert.equal(env.TMP, env.TEMP);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_CONFIG, undefined);
});

test('legacy data is rejected before any runtime starts', async () => {
  const options = fixture();
  mkdirSync(options.dataDir);
  writeFileSync(join(options.dataDir, 'records.sqlite'), 'legacy sentinel');
  await assert.rejects(PaseoRuntime.start(options), /new empty data directory/);
  assert.equal(existsSync(join(options.dataDir, 'worknaru-format.json')), false);
});

test('live-test dispatch rejects another model or unconfirmed effective effort before sending', async () => {
  let calls = 0;
  const client = {
    async listProviderModels() { return { models: [{ id: 'gpt-5.6-luna', thinkingOptions: [{ id: 'low' }] }] }; },
    async fetchAgent() { return { agent: { status: 'idle', activeTurn: null, pendingPermissions: [],
      runtimeInfo: { model: 'gpt-5.6-luna', thinkingOptionId: 'high' }, effectiveThinkingOptionId: 'low' } }; },
    async sendMessage() { calls++; },
  };
  const runtime = new PaseoRuntime(client, {}, { workspace: 'fake' }, true, 0, Promise.resolve(true), () => {});
  await assert.rejects(runtime.send('agent', 'not called', randomUUID(), { model: 'gpt-6-astra', effort: 'low' }), /TEST_MODEL_REQUIRED/);
  await assert.rejects(runtime.send('agent', 'not called', randomUUID(), { model: 'gpt-5.6-luna', effort: 'low' }), /MODEL_UNCONFIRMED/);
  assert.equal(calls, 0);
});

test('actual packaged server starts privately, rejects duplicate ownership and stops', { timeout: 90_000 }, async () => {
  const options = fixture();
  // Node is an intentionally unavailable Codex here. No model prompt or personal auth is used.
  const runtime = await PaseoRuntime.start(options);
  try {
    assert.equal(runtime.connected, true);
    assert.equal(existsSync(join(options.dataDir, 'codex', 'auth.json')), false);
    await assert.rejects(PaseoRuntime.start(options), /already has a runtime owner/);
  } finally { await runtime.stop(); }
  assert.equal(existsSync(join(options.dataDir, 'runtime-owner.json')), false);
  assert.throws(() => process.kill(runtime.pid, 0), { code: 'ESRCH' });
});
