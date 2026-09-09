// Explicit opt-in: two Luna/low prompts, editing only a disposable fixture file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { startDaemon } from '../dist/daemon.js';
import { fixture, projectRoot, connect } from './helpers.mjs';

test('real Codex file tool waits for browser approval and respects rejection after restart', { skip: !process.env.WORKNARU_CODEX_PATH, timeout: 360_000 }, async (t) => {
  const f = fixture(t);
  const oldTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TEMP = f.root; process.env.TMP = f.root;
  f.cleanups.push(() => { for (const [name, value] of Object.entries(oldTemp)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const file = join(f.workspace, 'sample.txt'); writeFileSync(file, 'before\n');
  const webPort = Number(process.env.WORKNARU_TEST_WEB_PORT ?? 15173); const origin = `http://127.0.0.1:${webPort}`;
  const server = await preview({ preview: { port: webPort, host: '127.0.0.1', strictPort: true } });
  f.cleanups.push(() => new Promise((done) => server.httpServer.close(done)));
  const options = { projectRoot, dataDirectory: f.data, workspaceDirectory: f.workspace, token: f.token, origins: [origin],
    acp: { codexPath: process.env.WORKNARU_CODEX_PATH, requiredSelection: { model: 'gpt-5.6-luna', reasoningEffort: 'low' } } };
  let daemon = await startDaemon(options); f.cleanups.push(() => daemon.close());
  const browser = await chromium.launch({ channel: 'msedge', headless: true, env: { ...process.env, TEMP: f.root, TMP: f.root } }); f.cleanups.push(() => browser.close());
  const page = await browser.newPage(); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const login = async () => {
    await page.goto(origin); await page.getByLabel('Daemon 주소').fill(daemon.url); await page.getByLabel('연결 키', { exact: true }).fill(f.token);
    await page.getByRole('dialog').getByRole('button', { name: '연결', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' });
  };
  await login(); await page.getByRole('button', { name: '새 대화', exact: true }).click();
  let previousRunId;
  for (const [index, replacement] of ['approved', 'rejected'].entries()) {
    if (index) {
      const port = Number(new URL(daemon.url).port); await daemon.close(); daemon = await startDaemon({ ...options, port }); await login();
      assert.equal(await page.locator('.file-history').count(), 1);
    }
    await page.getByRole('textbox', { name: '메시지', exact: true }).fill(`Use ONLY the worknaru_files MCP read_text_file then edit_text_file tools to replace sample.txt with exactly "${replacement}\\n" (${replacement} followed by one newline). Do not use apply_patch or any other tool. Wait for the tool result. If rejected, do not retry or propose another edit. Reply briefly with the outcome.`);
    await page.getByRole('button', { name: '메시지 전송' }).click();
    const dialog = page.getByRole('dialog', { name: '파일 수정 승인' });
    try { await dialog.waitFor({ timeout: 60_000 }); }
    catch (error) {
      const inspector = await connect(f, daemon);
      const list = (await inspector.call('sessions.list', { workspaceId: daemon.workspace.workspaceId })).result.sessions;
      const latest = list[0]?.latestRunId;
      if (latest) console.error('File live run:', JSON.stringify((await inspector.call('runs.get', { runId: latest })).result));
      console.error('Browser state:', (await page.locator('body').innerText()).slice(-2500));
      await page.screenshot({ path: '.worknaru-test/file-live-failure.png' });
      throw error;
    }
    assert.equal(readFileSync(file, 'utf8'), index ? 'approved\n' : 'before\n');
    assert.equal(await dialog.locator('.file-versions section').nth(1).locator('pre').textContent(), `${replacement}\n`);
    const client = await connect(f, daemon); const sessions = (await client.call('sessions.list', { workspaceId: daemon.workspace.workspaceId })).result.sessions;
    const runId = sessions[0].latestRunId; const run = (await client.call('runs.get', { runId })).result;
    assert.equal(run.model, 'gpt-5.6-luna'); assert.equal(run.reasoningEffort, 'low'); assert.equal(run.modelConfirmed, 1);
    assert.notEqual(runId, previousRunId); previousRunId = runId;
    await page.screenshot({ path: `.worknaru-test/file-approval-live-${index}.png` });
    await dialog.getByRole('button', { name: index ? '거절' : '이번 수정 허용', exact: true }).click();
    await page.locator('.run-state').filter({ hasText: '응답 완료' }).waitFor({ timeout: 130_000 });
    const done = (await client.call('runs.get', { runId })).result;
    assert.equal(done.tools.length, 1); assert.equal(done.tools[0].state, index ? 'rejected' : 'completed');
    assert.equal(readFileSync(file, 'utf8'), 'approved\n');
    await dialog.getByRole('button', { name: '파일 수정 승인 닫기' }).click();
  }
  assert.deepEqual(errors, []);
});
