import { test as base, expect } from '@playwright/test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fixture, launch, projectRoot, connect, createSession, mutation } from './helpers.mjs';

const test = base.extend({
  records: async ({}, use) => {
    const cleanups = [];
    const f = fixture({ after: (action) => cleanups.push(action) });
    try { await use(f); } finally { for (const action of cleanups.reverse()) await action(); }
  },
  daemon: async ({ records }, use) => {
    const daemon = await launch(records, { entry: join(projectRoot, 'tests/acp-daemon.mjs'), extraArgs: ['--origin', 'http://127.0.0.1:5173'] });
    await use(daemon);
  },
});
async function login(page, daemon, records) {
  await page.goto('http://127.0.0.1:5173');
  await page.getByLabel('Daemon 주소').fill(daemon.url);
  await page.getByLabel('연결 키', { exact: true }).fill(records.token);
  await page.getByRole('dialog', { name: 'Workspace 연결' }).getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '연결됨', exact: true })).toBeVisible();
}
async function newSession(page) {
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '메시지', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '새 대화', exact: true })).toBeEnabled();
}
async function send(page, text) {
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill(text);
  await page.getByRole('button', { name: '메시지 전송' }).click();
}
test('actual daemon text flow, drafts, IME, cancellation and responsive modal focus', async ({ page, daemon, records }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, daemon, records);
  await newSession(page);
  const first = await page.locator('.conversation-list [aria-current=true]').innerText();
  await send(page, '고객 인터뷰 질문 세 가지를 정리해 주세요.');
  await expect(page.locator('.run-state')).toHaveText('응답 완료');
  await expect(page.getByRole('article', { name: 'AI 메시지' })).toContainText('답변 1: 고객 인터뷰');
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('첫 대화의 초안');
  await newSession(page);
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('두 번째 초안');
  await page.locator('.conversation-list button').filter({ hasText: first.split('\n')[0] }).last().click();
  await expect(page.getByRole('textbox', { name: '메시지', exact: true })).toHaveValue('첫 대화의 초안');
  const input = page.getByRole('textbox', { name: '메시지', exact: true });
  await input.press('End');
  await input.dispatchEvent('compositionstart');
  await input.press('Enter');
  await input.dispatchEvent('compositionend');
  await expect(input).toHaveValue('첫 대화의 초안\n');
  await input.fill('한'.repeat(5500));
  await expect(page.getByRole('button', { name: '메시지 전송' })).toBeDisabled();
  await send(page, 'wait');
  await expect(page.getByRole('button', { name: '응답 중지' })).toBeEnabled();
  await input.fill('응답 중 작성한 다음 질문');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: '응답 중지' })).toBeEnabled();
  await page.getByRole('button', { name: '응답 중지' }).click();
  await expect(page.locator('.run-state')).toHaveText('중지 완료');
  await expect(input).toHaveValue('응답 중 작성한 다음 질문');
  await page.screenshot({ path: '.worknaru-test/chat-desktop.png' });
  for (const width of [736, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    const toggle = page.getByRole('button', { name: '대화 목록 열기 또는 접기' });
    await toggle.click();
    await expect(page.getByRole('dialog', { name: '대화 목록' })).toBeVisible();
    for (let i = 0; i < 9; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement.closest('dialog'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(toggle).toBeFocused();
    if (width < 600) {
      await page.getByRole('button', { name: '서비스 열기' }).click();
      await expect(page.getByRole('dialog', { name: '서비스', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole('button', { name: '어두운 테마' }).click();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(28, 36, 37)');
  await page.screenshot({ path: '.worknaru-test/chat-mobile-dark.png' });
  expect(errors).toEqual([]);
  const storage = await page.evaluate(() => ({ session: { ...sessionStorage }, local: { ...localStorage }, url: location.href }));
  expect(JSON.stringify(storage)).not.toContain(records.token);
});

test('lost start response survives reload and is queried once without repeating AI input', async ({ page, daemon, records }) => {
  let drop = true;
  let droppedResolve;
  const dropped = new Promise((resolve) => { droppedResolve = resolve; });
  let startId;
  await page.routeWebSocket(daemon.url, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((text) => {
      const value = JSON.parse(text);
      if (value.method === 'runs.start') startId = value.callId;
      server.send(text);
    });
    server.onMessage((text) => {
      const value = JSON.parse(text);
      if (drop && value.type === 'response' && value.callId === startId) {
        drop = false; socket.close(); server.close(); droppedResolve();
      } else socket.send(text);
    });
  });
  await login(page, daemon, records);
  await newSession(page);
  await send(page, '한 번만 실행되어야 합니다');
  await dropped;
  await expect(page.getByRole('button', { name: '연결 끊김', exact: true })).toBeVisible();
  await login(page, daemon, records);
  await expect(page.locator('.run-state')).toHaveText('응답 완료');
  await expect(page.getByRole('article', { name: '내 메시지' })).toHaveCount(1);
  await expect(page.getByRole('article', { name: 'AI 메시지' })).toContainText('답변 1: 한 번만');
  const prompts = readFileSync(join(records.root, 'agent.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((item) => item.type === 'prompt');
  expect(prompts).toHaveLength(1);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
});

test('page through persisted messages; forced daemon restart becomes read-only history', async ({ page, daemon, records }) => {
  const client = await connect(records, daemon);
  const original = await createSession(client, daemon.workspace.workspaceId, '긴 대화');
  for (let i = 0; i < 55; i++) await client.call('messages.append', { sessionId: original.sessionId, text: `저장 기록 ${i}` }, mutation(client));
  await login(page, daemon, records);
  await expect(page.getByRole('article', { name: '내 메시지' })).toHaveCount(50);
  await page.getByRole('button', { name: '다음 기록 불러오기' }).click();
  await expect(page.getByRole('article', { name: '내 메시지' })).toHaveCount(55);
  await send(page, '재시작 뒤 기록');
  await expect(page.locator('.run-state')).toHaveText('응답 완료');
  await daemon.stop();
  await expect(page.getByRole('button', { name: '연결 끊김', exact: true })).toBeVisible();
  const restarted = await launch(records, { entry: join(projectRoot, 'tests/acp-daemon.mjs'), extraArgs: ['--origin', 'http://127.0.0.1:5173'] });
  await login(page, restarted, records);
  await expect(page.getByText('이 대화는 기록 보기로 열렸습니다')).toBeVisible();
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('기존 맥락을 재개하지 않음');
  await expect(page.getByRole('button', { name: '메시지 전송' })).toBeDisabled();
});

test('storage fault and unknown cleanup keep last confirmed text and prevent new execution', async ({ page, daemon, records }) => {
  let fault = '';
  await page.routeWebSocket(daemon.url, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((text) => {
      const message = JSON.parse(text);
      const run = message.type === 'run.changed' ? message.run : message.result?.runId ? message.result : undefined;
      if (run && fault === 'storage') { run.storageAvailable = false; run.text = 'UNCONFIRMED_OUTPUT'; }
      if (run && fault === 'cleanup') { run.errorCode = 'PROCESS_CLEANUP_UNKNOWN'; run.state = 'cancelling'; }
      socket.send(JSON.stringify(message));
    });
  });
  await login(page, daemon, records);
  await newSession(page);
  await send(page, '저장 확인된 응답');
  await expect(page.locator('.run-state')).toHaveText('응답 완료');
  fault = 'storage';
  await expect(page.getByText('저장 상태를 확인할 수 없습니다', { exact: true })).toBeVisible();
  await expect(page.getByText('UNCONFIRMED_OUTPUT')).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'AI 메시지' })).toContainText('답변 1: 저장 확인된 응답');
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('초안 유지');
  await expect(page.getByRole('button', { name: '메시지 전송' })).toBeDisabled();
  await page.screenshot({ path: '.worknaru-test/chat-storage.png' });
  fault = 'cleanup';
  await page.getByRole('button', { name: '상태 확인', exact: true }).click();
  await expect(page.getByText('실행 종료를 확인할 수 없습니다', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '응답 중지' })).toBeDisabled();
  fault = '';
  await page.getByRole('button', { name: '상태 확인', exact: true }).click();
  await expect(page.locator('.run-state')).toHaveText('응답 완료');
  await expect(page.getByRole('button', { name: '메시지 전송' })).toBeEnabled();
});
