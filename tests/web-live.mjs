// Explicit opt-in: one real Codex request through the product browser UI.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { fixture, projectRoot } from './helpers.mjs';
import { startDaemon } from '../dist/daemon.js';

test('browser receives and reloads a real Codex response', { skip: !process.env.WORKNARU_CODEX_PATH, timeout: 150_000 }, async (t) => {
  const f = fixture(t);
  const server = await preview({ preview: { port: 5173, host: '127.0.0.1', strictPort: true } });
  f.cleanups.push(() => new Promise((resolve) => server.httpServer.close(resolve)));
  const daemon = await startDaemon({ projectRoot, dataDirectory: f.data, workspaceDirectory: f.workspace, token: f.token,
    acp: { codexPath: process.env.WORKNARU_CODEX_PATH }, origins: ['http://127.0.0.1:5173'],
  });
  f.cleanups.push(() => daemon.close());
  const browser = await chromium.launch({ channel: 'msedge', headless: true, env: { ...process.env, TEMP: f.root, TMP: f.root } });
  f.cleanups.push(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const login = async () => {
    await page.goto('http://127.0.0.1:5173');
    await page.getByLabel('Daemon 주소').fill(daemon.url);
    await page.getByLabel('연결 키', { exact: true }).fill(f.token);
    await page.getByRole('dialog').getByRole('button', { name: '연결', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  };
  await login();
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('도구를 사용하지 말고 한국어로 짧은 인사 한 문장을 써 주세요.');
  await page.getByRole('button', { name: '메시지 전송' }).click();
  await page.locator('.run-state').filter({ hasText: '응답 완료' }).waitFor({ timeout: 130_000 });
  const output = await page.getByRole('article', { name: 'AI 메시지' }).locator('.message-text').innerText();
  assert.ok(output.trim().length > 0);
  await page.screenshot({ path: '.worknaru-test/chat-live-codex.png' });
  await login();
  await page.getByRole('article', { name: 'AI 메시지' }).waitFor();
  assert.equal(await page.getByRole('article', { name: 'AI 메시지' }).locator('.message-text').innerText(), output);
  assert.deepEqual(errors, []);
});
