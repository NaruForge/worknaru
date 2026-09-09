// Explicit opt-in: two real Codex requests with a daemon restart between them.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { fixture, projectRoot } from './helpers.mjs';
import { startDaemon } from '../dist/daemon.js';

test('browser resumes real Codex context after daemon restart without duplicating history', { skip: !process.env.WORKNARU_CODEX_PATH, timeout: 300_000 }, async (t) => {
  const f = fixture(t);
  const previousTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TEMP = f.root;
  process.env.TMP = f.root;
  f.cleanups.push(() => { for (const [name, value] of Object.entries(previousTemp)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const webPort = Number(process.env.WORKNARU_TEST_WEB_PORT ?? 5173);
  assert.ok(Number.isInteger(webPort) && webPort > 0 && webPort <= 65535);
  const origin = `http://127.0.0.1:${webPort}`;
  const server = await preview({ preview: { port: webPort, host: '127.0.0.1', strictPort: true } });
  f.cleanups.push(() => new Promise((resolve) => server.httpServer.close(resolve)));
  const options = { projectRoot, dataDirectory: f.data, workspaceDirectory: f.workspace, token: f.token,
    acp: { codexPath: process.env.WORKNARU_CODEX_PATH, requiredSelection: { model: 'gpt-5.6-luna', reasoningEffort: 'low' } }, origins: [origin],
  };
  let daemon = await startDaemon(options);
  f.cleanups.push(() => daemon.close());
  const browser = await chromium.launch({ channel: 'msedge', headless: true, env: { ...process.env, TEMP: f.root, TMP: f.root } });
  f.cleanups.push(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const login = async () => {
    await page.goto(origin);
    await page.getByLabel('Daemon 주소').fill(daemon.url);
    await page.getByLabel('연결 키', { exact: true }).fill(f.token);
    await page.getByRole('dialog').getByRole('button', { name: '연결', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  };
  await login();
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  const marker = `WORKNARU_${randomBytes(12).toString('hex')}`;
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill(`Remember this token for our conversation: ${marker}. Reply with exactly the token. Do not use tools.`);
  await page.getByRole('button', { name: '메시지 전송' }).click();
  await page.locator('.run-state').filter({ hasText: '응답 완료' }).waitFor({ timeout: 130_000 });
  const output = await page.getByRole('article', { name: 'AI 메시지' }).locator('.message-text').innerText();
  assert.equal(output.trim(), marker);
  assert.equal(await page.locator('.model-status').innerText(), '최근 적용: gpt-5.6-luna · low');
  const port = Number(new URL(daemon.url).port);
  await daemon.close();
  daemon = await startDaemon({ ...options, port });
  await login();
  await page.getByRole('article', { name: 'AI 메시지' }).waitFor();
  assert.equal(await page.getByRole('article', { name: 'AI 메시지' }).locator('.message-text').innerText(), output);
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('Repeat the exact token from your previous reply. Do not use tools.');
  await page.getByRole('button', { name: '메시지 전송' }).click();
  await page.getByRole('article', { name: 'AI 메시지' }).nth(1).waitFor({ timeout: 130_000 });
  await page.locator('.run-state').filter({ hasText: '응답 완료' }).waitFor({ timeout: 130_000 });
  assert.equal(await page.getByRole('article', { name: 'AI 메시지' }).count(), 2);
  assert.equal(await page.getByRole('article', { name: '내 메시지' }).count(), 2);
  assert.equal((await page.getByRole('article', { name: 'AI 메시지' }).nth(1).locator('.message-text').innerText()).trim(), marker);
  assert.equal(await page.locator('.model-status').innerText(), '최근 적용: gpt-5.6-luna · low');
  await page.screenshot({ path: '.worknaru-test/chat-resumed-live-codex.png' });
  assert.deepEqual(errors, []);
});
