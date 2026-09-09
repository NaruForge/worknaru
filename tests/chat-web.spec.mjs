import { test, expect } from '@playwright/test';
import { chatFixture } from './chat-fixture.mjs';

const port = Number(process.env.WORKNARU_TEST_WEB_PORT ?? 15174);
const origin = `http://127.0.0.1:${port}`;
let fixture;
test.beforeEach(async () => { fixture = await chatFixture([origin]); });
test.afterEach(async () => { await fixture.close(); });
const open = async page => { await page.goto(`${origin}/index.html?daemon=${encodeURIComponent(fixture.server.url)}`); await expect(page.getByText('연결됨', { exact: true })).toBeVisible(); };
const send = async (page, text) => { await page.getByRole('textbox', { name: '메시지', exact: true }).fill(text); await page.getByRole('button', { name: '메시지 보내기', exact: true }).click(); };

test('new Chat streams, follows up, changes fake model and restores its new history after reload', async ({ page }) => {
  await open(page); await send(page, '첫 대화');
  await expect(page.getByText('검증 응답: 대화를 이어갈 수 있습니다.', { exact: true })).toBeVisible();
  await expect(page.getByText('입력 가능', { exact: true }).last()).toBeVisible();
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('fake-model');
  await expect(page.getByRole('combobox', { name: 'Reasoning Effort', exact: true })).toHaveValue('medium');
  await send(page, '후속 질문');
  await expect(page.locator('.message.assistant')).toHaveCount(2);
  await expect.poll(() => fixture.runtime.sends.length).toBe(2);
  expect(fixture.runtime.sends[1].selection).toEqual({ model: 'fake-model', effort: 'medium' });
  await page.reload();
  await expect(page.locator('.message.user')).toHaveCount(2);
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('fake-model');
  await page.screenshot({ path: '.worknaru-test/paseo-chat-desktop.png', fullPage: true });
});

test('permission details sit above input; two tabs resolve one request; cancellation stays available', async ({ page, context }) => {
  await open(page); await send(page, '[permission] 도구 확인');
  const other = await context.newPage(); await open(other);
  await other.getByRole('button').filter({ hasText: '[permission] 도구 확인' }).click();
  await page.locator('.file-approval summary').click(); await other.locator('.file-approval summary').click();
  const panel = await page.locator('.file-approval').boundingBox(), compose = await page.locator('form.compose').boundingBox();
  expect(panel.y + panel.height).toBeLessThanOrEqual(compose.y);
  await Promise.all([page.getByRole('button', { name: '이번 요청 허용', exact: true }).click(), other.getByRole('button', { name: '거절', exact: true }).click()]);
  await expect.poll(() => fixture.runtime.permissionCalls.length).toBe(1);
  await expect(page.locator('.file-approval')).toHaveCount(0);
  await send(page, '[hold] 오래 걸리는 작업');
  await expect(page.getByRole('button', { name: '실행 취소', exact: true })).toBeEnabled();
  await other.close();
  expect(fixture.runtime.agents.values().next().value.state).toBe('busy');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(page.locator('.chat-outcome')).toHaveText('실행을 취소했습니다.');
});

test('mobile navigation preserves the draft, supports Korean composition and has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 850 }); await open(page);
  const input = page.getByRole('textbox', { name: '메시지', exact: true }); await input.fill('작성 중인 초안');
  await page.getByRole('button', { name: '← 대화 목록', exact: true }).click();
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await expect(input).toHaveValue('작성 중인 초안');
  await input.dispatchEvent('compositionstart'); await input.press('Enter');
  expect(fixture.runtime.sends).toHaveLength(0);
  await input.dispatchEvent('compositionend'); await input.press('Enter');
  await expect(page.locator('.message.assistant')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '어두운 화면', exact: true }).click();
  await page.screenshot({ path: '.worknaru-test/paseo-chat-mobile.png', fullPage: true });
});
