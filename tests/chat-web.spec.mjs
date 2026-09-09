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
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '메시지', exact: true })).toHaveValue('');
});

test('failed first creation keeps its draft with that chat and leaves a separate new draft empty', async ({ page }) => {
  fixture.runtime.failCreationResponse = true;
  await open(page); await send(page, '생성 실패 후 보관할 초안');
  const input = page.getByRole('textbox', { name: '메시지', exact: true });
  await expect(page.getByRole('button', { name: '대화 생성 결과 확인', exact: true })).toBeEnabled();
  await expect(input).toHaveValue('생성 실패 후 보관할 초안');
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await expect(input).toHaveValue('');
  await input.fill('아직 보내지 않은 새 초안');
  await page.getByRole('button').filter({ hasText: '생성 실패 후 보관할 초안' }).click();
  await expect(input).toHaveValue('생성 실패 후 보관할 초안');
  await page.getByRole('button', { name: '대화 생성 결과 확인', exact: true }).click();
  await expect(page.getByRole('button', { name: '메시지 보내기', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '메시지 보내기', exact: true }).click();
  await expect(input).toHaveValue('');
  expect(fixture.runtime.sends).toHaveLength(1);
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await expect(input).toHaveValue('아직 보내지 않은 새 초안');
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
  await page.getByRole('button', { name: '어두운 테마', exact: true }).click();
  await page.screenshot({ path: '.worknaru-test/paseo-chat-mobile.png', fullPage: true });
});

test('model catalog recovery retries without reloading or losing a draft', async ({ page }) => {
  test.setTimeout(15_000);
  const catalog = fixture.runtime.catalog.bind(fixture.runtime);
  let failed = true, calls = 0;
  fixture.runtime.catalog = async () => { calls++; if (failed) throw new Error('temporary catalog failure'); return catalog(); };
  await open(page);
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('복구 뒤 보낼 초안');
  failed = false;
  await page.getByRole('button', { name: '상태 확인', exact: true }).click();
  await expect(page.getByRole('button', { name: '메시지 보내기', exact: true })).toBeEnabled();
  expect(calls).toBeGreaterThan(1);
  await expect(page.getByRole('textbox', { name: '메시지', exact: true })).toHaveValue('복구 뒤 보낼 초안');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(fixture.runtime.sends).toHaveLength(0);
});

async function longChat(page) {
  await open(page); await send(page, '읽던 위치 시험');
  await expect(page.locator('.message.assistant')).toHaveCount(1);
  await expect(page.getByText('입력 가능', { exact: true }).last()).toBeVisible();
  const agentId = [...fixture.runtime.agents.keys()][0];
  fixture.runtime.messages.get(agentId).push(...Array.from({ length: 220 }, (_, i) => ({
    id: `long-${i}`, kind: i % 2 ? 'assistant' : 'user', text: `읽기 기록 ${i}\n줄바꿈과 긴 대화의 위치를 확인합니다.`
  })));
  fixture.runtime.emit({ type: 'changed', agentId });
  await expect(page.getByText('읽기 기록 219', { exact: false })).toBeVisible();
  return agentId;
}

test('reading position survives a chat round trip', async ({ page }) => {
  test.setTimeout(15_000);
  await longChat(page);
  const scroll = page.locator('.transcript-scroll');
  await scroll.evaluate(e => { e.scrollTop = 600; e.dispatchEvent(new Event('scroll')); });
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await page.getByRole('button').filter({ hasText: '읽던 위치 시험' }).click();
  await expect.poll(() => scroll.evaluate(e => e.scrollTop)).toBeCloseTo(600, 0);
});

test('older pages preserve the reading anchor', async ({ page }) => {
  test.setTimeout(15_000);
  await longChat(page);
  const scroll = page.locator('.transcript-scroll');
  await scroll.evaluate(e => { e.scrollTop = 0; e.dispatchEvent(new Event('scroll')); });
  const anchor = page.getByText('읽기 기록 20\n줄바꿈과 긴 대화의 위치를 확인합니다.', { exact: true });
  const before = await anchor.boundingBox();
  await page.getByRole('button', { name: '이전 기록 보기', exact: true }).click();
  await expect(page.locator('.message')).toHaveCount(222);
  await expect.poll(async () => Math.abs((await anchor.boundingBox()).y - before.y)).toBeLessThan(2);
});

test('mobile list focus and browser history follow the visible navigation step', async ({ page }) => {
  test.setTimeout(15_000);
  await page.setViewportSize({ width: 390, height: 850 }); await open(page);
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('목록 왕복 초안');
  await page.getByRole('button', { name: '← 대화 목록', exact: true }).click();
  expect(await page.evaluate(() => !!document.activeElement.getClientRects().length)).toBe(true);
  await page.goBack();
  await expect(page.getByRole('textbox', { name: '메시지', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '메시지', exact: true })).toHaveValue('목록 왕복 초안');
  await page.goForward();
  await expect(page.getByRole('button', { name: '새 대화', exact: true })).toBeVisible();
});

test('product Settings save shared defaults, keep existing chats and apply personal appearance', async ({ page, context }) => {
  await open(page); await send(page, '기존 모델을 유지할 대화');
  await expect(page.getByText('입력 가능', { exact: true }).last()).toBeVisible();
  const other = await context.newPage(); await open(other);
  await other.getByRole('button', { name: 'Settings', exact: true }).click();
  await other.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('설정 왕복 초안');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('combobox', { name: '기본 Model', exact: true }).selectOption('fake-model');
  await expect(page.getByRole('combobox', { name: '기본 Reasoning Effort', exact: true })).toHaveValue('medium');
  await expect(other.getByRole('combobox', { name: '기본 Model', exact: true })).toHaveValue('fake-model');
  await page.reload();
  await expect(page.getByRole('combobox', { name: '기본 Model', exact: true })).toHaveValue('fake-model');
  await page.getByRole('button', { name: 'Chat으로 돌아가기', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('gpt-5.6-luna');
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('fake-model');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: '화면', exact: true }).click();
  const color = page.getByRole('textbox', { name: 'Main Color HEX', exact: true });
  await color.fill('#4361ee');
  await page.getByRole('button', { name: '배색 적용', exact: true }).click();
  await other.getByRole('button', { name: '화면', exact: true }).click();
  await expect(other.getByRole('textbox', { name: 'Main Color HEX', exact: true })).toHaveValue('#4361ee');
  await page.screenshot({ path: '.worknaru-test/product-settings-appearance.png', fullPage: true });
  await color.fill('#a43e75');
  await page.setViewportSize({ width: 736, height: 900 });
  await expect(color).toHaveValue('#a43e75');
  await page.getByRole('button', { name: 'Chat으로 돌아가기', exact: true }).click();
  await expect.poll(() => page.locator('html').evaluate(el => el.style.getPropertyValue('--accent-background')))
    .toBe(await other.locator('html').evaluate(el => el.style.getPropertyValue('--accent-background')));
});

test('settings round trips and viewport changes preserve drafts and the reading anchor', async ({ page }) => {
  const agentId = await longChat(page);
  const scroll = page.locator('.transcript-scroll');
  await scroll.evaluate(e => { e.scrollTop = 700; e.dispatchEvent(new Event('scroll')); });
  const input = page.getByRole('textbox', { name: '메시지', exact: true }); await input.fill('작성 중인 후속 질문');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  fixture.runtime.messages.get(agentId).push({ id: 'late-output', kind: 'assistant', text: '설정을 보는 동안 들어온 출력' });
  fixture.runtime.emit({ type: 'changed', agentId });
  await page.getByRole('button', { name: 'Chat으로 돌아가기', exact: true }).click();
  await expect(input).toHaveValue('작성 중인 후속 질문');
  await expect.poll(() => scroll.evaluate(e => e.scrollTop)).toBeCloseTo(700, 0);
  const anchor = await scroll.evaluate(el => [...el.querySelectorAll('[data-message-id]')].find(node => node.getBoundingClientRect().bottom > el.getBoundingClientRect().top)?.getAttribute('data-message-id'));
  for (const width of [859, 860, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => scroll.evaluate(el => [...el.querySelectorAll('[data-message-id]')].find(node => node.getBoundingClientRect().bottom > el.getBoundingClientRect().top)?.getAttribute('data-message-id'))).toBe(anchor);
    await expect(input).toHaveValue('작성 중인 후속 질문');
  }
  await page.getByRole('button', { name: '최근 내용으로 이동 ↓', exact: true }).click();
  await expect(page.getByText('설정을 보는 동안 들어온 출력', { exact: true })).toBeVisible();
});

test('product mobile Settings, list focus and history preserve unsent input', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await open(page);
  const input = page.getByRole('textbox', { name: '메시지', exact: true }); await input.fill('모바일 설정 왕복');
  await page.getByRole('button', { name: '← 대화 목록', exact: true }).click();
  await page.getByRole('button', { name: '← Module 선택', exact: true }).click();
  await page.getByRole('button').filter({ hasText: '화면 · 연결 · AI' }).click();
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByText('인증 상태', { exact: true })).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: '확인 불가' })).toHaveCount(1);
  await page.screenshot({ path: '.worknaru-test/product-settings-mobile.png', fullPage: true });
  await page.goBack();
  await expect(page.getByRole('button', { name: 'AI', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByText('인증 상태', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Chat으로 돌아가기', exact: true }).click();
  await expect(input).toHaveValue('모바일 설정 왕복');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('late model lookup remains usable after navigation and stale history cannot select another store', async ({ page }) => {
  const catalog = fixture.runtime.catalog.bind(fixture.runtime); let release;
  fixture.runtime.catalog = async () => { await new Promise(resolve => { release = resolve; }); return catalog(); };
  try {
    await open(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    release(); fixture.runtime.catalog = catalog;
    await expect(page.getByRole('combobox', { name: '기본 Model', exact: true })).toBeEnabled();
    await page.evaluate(() => history.replaceState({ worknaru: { scope: 'another-store', route: {
      screen: 'chat', view: 'main', section: 'appearance', chatId: '00000000-0000-4000-8000-000000000000'
    } } }, ''));
    const calls = [], get = fixture.service.get.bind(fixture.service);
    fixture.service.get = async id => { calls.push(id); return get(id); };
    await page.reload();
    await expect(page.getByRole('textbox', { name: '메시지', exact: true })).toBeVisible();
    expect(calls).not.toContain('00000000-0000-4000-8000-000000000000');
    await page.getByRole('textbox', { name: '메시지', exact: true }).fill('정상 입력');
    await expect(page.getByRole('button', { name: '메시지 보내기', exact: true })).toBeEnabled();
  } finally { release?.(); }
});

test('collapsed lists keep independent state and restore a long Chat list after Settings', async ({ page }) => {
  for (let i = 0; i < 30; i++) await fixture.service.create(crypto.randomUUID(), `목록 대화 ${i}`, { model: 'gpt-5.6-luna', effort: 'low' });
  await open(page);
  const list = page.locator('.conversation-list');
  await list.evaluate(el => { el.scrollTop = 500; el.dispatchEvent(new Event('scroll')); });
  await page.getByRole('button', { name: '대화 목록 열기 또는 접기', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'AI', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '설정 목록 열기 또는 접기', exact: true }).click();
  await page.getByRole('button', { name: 'Chat으로 돌아가기', exact: true }).click();
  await expect(list).toHaveCount(0);
  await page.getByRole('button', { name: '대화 목록 열기 또는 접기', exact: true }).click();
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(500);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'AI', exact: true })).toHaveCount(0);
});

test('product appearance rejects invalid colors and reports persistence failure without losing the applied preview', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const color = page.getByRole('textbox', { name: 'Main Color HEX', exact: true });
  await color.fill('wrong'); await expect(page.getByRole('button', { name: '배색 적용', exact: true })).toBeDisabled();
  await color.fill('#4361ee');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === 'worknaru.appearance.v1') throw new Error('storage unavailable'); return original.call(this, key, value); };
  });
  await page.getByRole('button', { name: '배색 적용', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '브라우저에 저장하지 못했습니다' })).toBeVisible();
  const applied = await page.locator('html').evaluate(el => el.style.getPropertyValue('--accent-background'));
  await page.getByRole('button', { name: 'Chat으로 돌아가기', exact: true }).click();
  expect(await page.locator('html').evaluate(el => el.style.getPropertyValue('--accent-background'))).toBe(applied);
  expect(await page.evaluate(() => localStorage.getItem('worknaru.appearance.v1'))).toBe(null);
});

test('a settings storage failure still updates connection facts and disables new input', async ({ page }) => {
  await open(page);
  fixture.store.db.exec("CREATE TRIGGER fail_settings BEFORE UPDATE ON chat_settings BEGIN SELECT RAISE(ABORT, 'disk failure'); END;");
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('combobox', { name: '기본 Model', exact: true }).selectOption('fake-model');
  await expect(page.getByRole('combobox', { name: '기본 Model', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.locator('dd').filter({ hasText: /^확인 필요$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Chat으로 돌아가기', exact: true }).click();
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('저장이 복구되기 전에는 전송하지 않음');
  await expect(page.getByRole('button', { name: '메시지 보내기', exact: true })).toBeDisabled();
  expect(fixture.runtime.sends).toHaveLength(0);
});

test('product permission controls stay reachable in a short dark mobile screen and enlarged layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 520 }); await open(page);
  await page.getByRole('button', { name: '어두운 테마', exact: true }).click();
  await send(page, '[permission] 짧은 화면의 승인 확인');
  await page.locator('.file-approval summary').click();
  const allow = page.getByRole('button', { name: '이번 요청 허용', exact: true });
  await allow.scrollIntoViewIfNeeded();
  const bounds = await allow.boundingBox(); expect(bounds.y + bounds.height).toBeLessThanOrEqual(520);
  await page.screenshot({ path: '.worknaru-test/product-chat-short-dark.png', fullPage: true });
  await allow.click(); await expect(page.locator('.file-approval')).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '기본 Model', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
