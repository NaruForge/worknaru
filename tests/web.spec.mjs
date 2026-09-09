import { test as base, expect } from '@playwright/test';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { startDevServers } from '../scripts/dev.mjs';
import { fixture, launch, projectRoot, connect, createSession, mutation } from './helpers.mjs';
const origin = `http://127.0.0.1:${process.env.WORKNARU_TEST_WEB_PORT ?? 5173}`;

const test = base.extend({
  records: async ({}, use) => {
    const cleanups = [];
    const f = fixture({ after: (action) => cleanups.push(action) });
    try { await use(f); } finally { for (const action of cleanups.reverse()) await action(); }
  },
  daemon: async ({ records }, use) => {
    const daemon = await launch(records, { entry: join(projectRoot, 'tests/acp-daemon.mjs'), extraArgs: ['--origin', origin] });
    await use(daemon);
  },
});

async function developmentServer(records, acp = false, hub, requireKey = true) {
  const socket = createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const server = await startDevServers({ webPort: port, hub, requireKey, daemonOptions: {
    dataDirectory: records.data, workspaceDirectory: records.workspace, token: records.token, port: 0,
    ...(acp ? { acp: { command: { executable: process.execPath, arguments: [join(projectRoot, 'tests/fake-acp.mjs')], cwd: records.workspace,
      env: { ...process.env, TEST_AGENT_LOG: join(records.root, 'agent.log'), TEMP: records.root, TMP: records.root },
    } } } : {}),
  } });
  records.cleanups.push(() => server.close());
  return server;
}

test('dev UI stops other-tab runs after confirmation and preserves history on restart', async ({ page, records }) => {
  let server = await developmentServer(records, true);
  await page.goto(server.origin);
  await expect(page.getByLabel('Daemon 주소')).toHaveValue(server.daemon.url);
  await page.getByLabel('연결 키', { exact: true }).fill(records.token);
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await newSession(page);
  await send(page, '개발 종료 뒤에도 남을 기록');
  await expect(page.locator('.run-state')).toHaveText('응답 완료');
  const other = await connect(records, server.daemon);
  const session = await createSession(other, server.daemon.workspace.workspaceId, '다른 탭의 대화');
  await other.call('runs.start', { sessionId: session.sessionId, text: 'wait' }, mutation(other));
  await page.setViewportSize({ width: 320, height: 850 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '개발 서버 종료', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '개발 서버 종료' });
  await expect(dialog).toContainText('진행 중인 AI 응답이 1개');
  await page.screenshot({ path: '.worknaru-test/dev-stop-mobile.png' });
  await dialog.getByRole('button', { name: '계속 점검하기' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '연결됨', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '개발 서버 종료', exact: true }).click();
  await expect(dialog).toContainText('진행 중인 AI 응답이 1개');
  await page.screenshot({ path: '.worknaru-test/dev-stop-desktop.png' });
  await dialog.getByRole('button', { name: '응답 중단 후 종료' }).click();
  await expect(page.getByRole('heading', { name: '종료되었습니다.' })).toBeVisible({ timeout: 20_000 });
  expect(await server.close()).toBe(true);
  await page.screenshot({ path: '.worknaru-test/dev-stopped.png' });
  await expect(fetch(server.origin)).rejects.toThrow();
  server = await developmentServer(records);
  await page.goto(server.origin);
  await page.getByLabel('연결 키', { exact: true }).fill(records.token);
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('.conversation-list button').filter({ hasText: '대화 1' }).click();
  await expect(page.getByRole('article', { name: '내 메시지' })).toContainText('개발 종료 뒤에도 남을 기록');
});

test('Hub subpath UI uses same-origin chat, HMR and shutdown', async ({ page, records }) => {
  const hub = { Id: '0123456789abcdef', BasePath: '/p/0123456789abcdef/', TailnetOrigin: 'https://bsw-home.tailec99c3.ts.net:9191' };
  const server = await developmentServer(records, true, hub);
  const sockets = [];
  page.on('websocket', (socket) => sockets.push(socket.url()));
  await page.goto(server.localUrl);
  await expect(page.getByLabel('Daemon 주소')).toHaveValue(`${server.origin.replace('http:', 'ws:')}${hub.BasePath}__worknaru_ws`);
  await page.getByLabel('연결 키', { exact: true }).fill(records.token);
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await newSession(page);
  await send(page, 'Hub 경로의 대화');
  await expect(page.locator('.run-state')).toHaveText('응답 완료');
  await expect(page.getByRole('article', { name: 'AI 메시지' })).toContainText('Hub 경로의 대화');
  expect(sockets.some((url) => url.includes(`${hub.BasePath}?token=`))).toBe(true);
  expect(sockets.some((url) => url.endsWith(`${hub.BasePath}__worknaru_ws`))).toBe(true);
  await page.getByRole('button', { name: '개발 서버 종료', exact: true }).click();
  await expect(page.getByRole('heading', { name: '종료되었습니다.' })).toBeVisible({ timeout: 20_000 });
  expect(await server.close()).toBe(true);
});

test('dev UI can stop before connecting; closing a tab does not stop the servers', async ({ page, records, context }) => {
  const server = await developmentServer(records);
  const tab = await context.newPage();
  await tab.goto(server.origin);
  await tab.close();
  expect((await fetch(server.origin)).ok).toBe(true);
  await page.goto(server.origin);
  await page.getByRole('dialog', { name: 'Workspace 연결' }).getByRole('button', { name: '개발 서버 종료' }).click();
  const dialog = page.getByRole('dialog', { name: '개발 서버 종료' });
  await expect(page.getByLabel('종료용 연결 키')).toBeVisible();
  await page.getByLabel('종료용 연결 키').fill('wrong-key');
  await dialog.getByRole('button', { name: '종료 확인' }).click();
  await expect(dialog.getByRole('alert')).toContainText('이번 개발 실행의 연결 키가 필요합니다.');
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByLabel('연결 키', { exact: true }).fill(records.token);
  await page.getByRole('dialog', { name: 'Workspace 연결' }).getByRole('button', { name: '개발 서버 종료' }).click();
  await expect(page.getByRole('heading', { name: '종료되었습니다.' })).toBeVisible();
  expect(await server.close()).toBe(true);
});

for (const hub of [undefined, { Id: '0123456789abcdef', BasePath: '/p/0123456789abcdef/', TailnetOrigin: 'https://bsw-home.tailec99c3.ts.net:9191' }]) {
  test(`key-free ${hub ? 'Hub' : 'local'} UI automatically connects, reloads, chats and stops`, async ({ page, records }) => {
    const server = await developmentServer(records, true, hub, false);
    const sent = [];
    page.on('websocket', (socket) => socket.on('framesent', (frame) => sent.push(String(frame.payload))));
    await page.goto(server.localUrl);
    await expect(page.getByRole('button', { name: '연결됨', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: '연결됨', exact: true }).click();
    await expect(page.getByLabel('연결 키', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Workspace 연결 닫기' }).click();
    await newSession(page);
    await send(page, '키 없이 이어지는 대화');
    await expect(page.locator('.run-state')).toHaveText('응답 완료');
    await page.reload();
    await expect(page.getByRole('button', { name: '연결됨', exact: true })).toBeVisible();
    await expect(page.getByRole('article', { name: '내 메시지' })).toContainText('키 없이 이어지는 대화');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const hellos = sent.filter((frame) => frame.startsWith('{')).map((frame) => JSON.parse(frame)).filter((frame) => frame.type === 'hello');
    expect(hellos.length).toBeGreaterThanOrEqual(2);
    expect(hellos.every((frame) => !('token' in frame))).toBe(true);
    await page.getByRole('button', { name: '개발 서버 종료', exact: true }).click();
    await expect(page.getByRole('heading', { name: '종료되었습니다.' })).toBeVisible({ timeout: 20_000 });
    expect(await server.close()).toBe(true);
  });
}

async function login(page, daemon, records) {
  await page.goto(origin);
  await page.getByLabel('Daemon 주소').fill(daemon.url);
  await page.getByLabel('연결 키', { exact: true }).fill(records.token);
  await page.getByRole('dialog', { name: 'Workspace 연결' }).getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Workspace 연결' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '연결됨', exact: true })).toBeVisible();
}
async function newSession(page) {
  const back = page.getByRole('button', { name: '← 대화 목록', exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '메시지', exact: true })).toBeEnabled();
  await expect(page.locator('.new-chat')).toBeEnabled();
}
async function send(page, text) {
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill(text);
  await page.getByRole('button', { name: '메시지 전송' }).click();
}

test('personal appearance survives reload while preview cancellation preserves the Chat draft', async ({ page, context, records }) => {
  // Appearance and draft persistence require no AI process.
  const daemon = await launch(records, { extraArgs: ['--origin', origin] });
  await login(page, daemon, records);
  await newSession(page);
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('배색을 바꿔도 유지할 초안');
  const accent = () => page.locator('html').evaluate(element => element.style.getPropertyValue('--accent-background'));
  const initial = await accent();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '설정 메뉴' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: '대화 목록' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '대화 목록 열기 또는 접기' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const input = page.getByRole('textbox', { name: 'Main Color HEX' });
  await input.fill('#4361ee');
  await expect.poll(accent).not.toBe(initial);
  await page.getByRole('button', { name: 'Chat으로 돌아가기' }).click();
  await expect.poll(accent).toBe(initial);
  await expect(page.getByRole('textbox', { name: '메시지', exact: true })).toHaveValue('배색을 바꿔도 유지할 초안');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await input.fill('#4361ee');
  await page.getByRole('button', { name: '배색 적용', exact: true }).click();
  await expect(page.getByText('이 브라우저에 배색을 저장했습니다.', { exact: true })).toBeVisible();
  const applied = await accent();
  const other = await context.newPage();
  await other.goto(origin);
  await expect.poll(() => other.locator('html').evaluate(element => element.style.getPropertyValue('--accent-background'))).toBe(applied);
  await page.reload();
  await expect.poll(accent).toBe(applied);
  const storage = await page.evaluate(() => ({ ...localStorage }));
  expect(JSON.parse(storage['worknaru.appearance.v1'])).toEqual({ version: 1, mainColor: '#4361ee' });
  expect(JSON.stringify(storage)).not.toContain(records.token);
  await other.close();
});

test('file approval restores after reload, shows the preview, and another tab sees the single result', async ({ page, context, daemon, records }) => {
  const file = join(records.workspace, 'sample.txt'); writeFileSync(file, '원래 내용\n');
  await login(page, daemon, records); await newSession(page); await send(page, 'edit-file');
  const dialog = page.locator('.file-approval');
  await expect(dialog).toBeVisible(); await dialog.locator('summary').click();
  await expect(dialog.locator('.file-versions section').first()).toContainText('원래 내용');
  await expect(dialog.locator('.file-versions section').last()).toContainText('수정된 내용');
  expect(readFileSync(file, 'utf8')).toBe('원래 내용\n');
  await dialog.locator('summary').click();
  expect(readFileSync(file, 'utf8')).toBe('원래 내용\n');
  await dialog.locator('summary').click(); await expect(dialog).toBeVisible();
  await login(page, daemon, records); await expect(dialog).toBeVisible(); await dialog.locator('summary').click();
  const other = await context.newPage(); await login(other, daemon, records);
  const otherDialog = other.locator('.file-approval'); await expect(otherDialog).toBeVisible(); await otherDialog.locator('summary').click();
  await page.setViewportSize({ width: 320, height: 850 });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: '.worknaru-test/file-approval-mobile.png' });
  await dialog.getByRole('button', { name: '이번 수정 허용' }).click();
  await expect(dialog.getByRole('status', { name: '파일 수정 상태' })).toContainText('파일 수정 완료');
  await expect(otherDialog.getByRole('status', { name: '파일 수정 상태' })).toContainText('파일 수정 완료');
  await expect(otherDialog.getByRole('button', { name: '이번 수정 허용' })).toHaveCount(0);
  expect(readFileSync(file, 'utf8')).toBe('수정된 내용\n');
  await other.screenshot({ path: '.worknaru-test/file-approval-desktop.png' });
  await otherDialog.locator('summary').click();
  await expect(other.locator('.run-state')).toHaveText('응답 완료');
  await send(other, '후속 대화'); await expect(other.locator('.run-state')).toHaveText('응답 완료');
  await login(other, daemon, records);
  await expect(other.locator('.file-history')).toContainText('파일 수정 완료');
});

test('tail refresh includes file history when another client completes multiple runs between polls', async ({ page, daemon, records }) => {
  writeFileSync(join(records.workspace, 'sample.txt'), '원래 내용\n');
  let hold = false;
  const queued = [];
  await page.routeWebSocket(daemon.url, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((text) => {
      if (hold && JSON.parse(text).method === 'sessions.get') queued.push(() => server.send(text));
      else server.send(text);
    });
  });
  await login(page, daemon, records); await newSession(page);
  const other = await connect(records, daemon);
  const session = (await other.call('sessions.list', { workspaceId: daemon.workspace.workspaceId })).result.sessions[0];
  hold = true;
  await expect.poll(() => queued.length).toBeGreaterThan(0);
  const first = (await other.call('runs.start', { sessionId: session.sessionId, text: 'edit-file' }, mutation(other))).result.run;
  let pending;
  await expect.poll(async () => { pending = (await other.call('runs.get', { runId: first.runId })).result; return pending.tools[0]?.state; }).toBe('pending');
  expect((await other.call('permissions.respond', { runId: first.runId, toolId: pending.tools[0].toolId, decision: 'allow' }, mutation(other))).ok).toBe(true);
  await expect.poll(async () => (await other.call('runs.get', { runId: first.runId })).result.state).toBe('completed');
  const second = (await other.call('runs.start', { sessionId: session.sessionId, text: '후속 대화' }, mutation(other))).result.run;
  await expect.poll(async () => (await other.call('runs.get', { runId: second.runId })).result.state).toBe('completed');
  hold = false;
  for (const send of queued.splice(0)) send();
  await expect(page.getByRole('article', { name: 'AI 메시지' })).toHaveCount(2);
  const history = page.getByRole('article', { name: 'AI 메시지' }).first().locator('.file-history');
  await expect(history).toContainText('파일 수정 완료');
  await history.locator('summary').click();
  await expect(history.locator('.file-versions section').last()).toContainText('수정된 내용');
});

test('rejection and stop in the inline approval panel preserve the original file', async ({ page, daemon, records }) => {
  const file = join(records.workspace, 'sample.txt'); writeFileSync(file, '원래 내용\n');
  await login(page, daemon, records);
  for (const action of ['거절', '실행 중지']) {
    await newSession(page); await send(page, 'edit-file');
    const dialog = page.locator('.file-approval'); await expect(dialog).toBeVisible(); await dialog.locator('summary').click();
    await dialog.getByRole('button', { name: action, exact: true }).click();
    await expect(dialog.getByRole('status', { name: '파일 수정 상태' })).toContainText(action === '거절' ? '거절됨' : '취소됨');
    await dialog.locator('summary').click();
    await expect(page.locator('.run-state')).toHaveText(action === '거절' ? '응답 완료' : '중지 완료');
    expect(readFileSync(file, 'utf8')).toBe('원래 내용\n');
  }
});

test('lost permission response is queried after reload and never repeats the edit', async ({ page, daemon, records }) => {
  const file = join(records.workspace, 'sample.txt'); writeFileSync(file, '원래 내용\n');
  let drop = true; let permissionCall;
  await page.routeWebSocket(daemon.url, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((text) => { const value = JSON.parse(text); if (value.method === 'permissions.respond') permissionCall = value.callId; server.send(text); });
    server.onMessage((text) => { const value = JSON.parse(text); if (drop && permissionCall && value.type === 'response' && value.callId === permissionCall) { drop = false; socket.close(); server.close(); } else socket.send(text); });
  });
  await login(page, daemon, records); await newSession(page); await send(page, 'edit-file');
  await page.locator('.file-approval summary').click();
  await page.locator('.file-approval').getByRole('button', { name: '이번 수정 허용' }).click();
  await expect(page.getByRole('button', { name: '연결 끊김', exact: true })).toBeVisible();
  await login(page, daemon, records); await expect(page.locator('.run-state')).toHaveText('응답 완료');
  await expect(page.locator('.file-history')).toContainText('파일 수정 완료');
  expect(readFileSync(file, 'utf8')).toBe('수정된 내용\n'); expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  const events = readFileSync(join(records.root, 'agent.log'), 'utf8').trim().split('\n').map(JSON.parse);
  expect(events.filter((event) => event.type === 'file-result')).toHaveLength(1);
});

test('approval of another conversation stays current while viewing a different chat', async ({ page, daemon, records }) => {
  const file = join(records.workspace, 'sample.txt'); writeFileSync(file, '원래 내용\n');
  await login(page, daemon, records); await newSession(page); await send(page, 'edit-file');
  const dialog = page.locator('.file-approval'); await expect(dialog).toBeVisible(); await dialog.locator('summary').click();
  await dialog.locator('summary').click(); await newSession(page);
  await expect(page.getByRole('heading', { name: '새 대화 2' })).toBeVisible();
  await dialog.locator('summary').click();
  await dialog.getByRole('button', { name: '이번 수정 허용' }).click();
  await expect(dialog.getByRole('status', { name: '파일 수정 상태' })).toHaveText('파일 수정 완료');
  await dialog.locator('summary').click();
  expect(readFileSync(file, 'utf8')).toBe('수정된 내용\n');
  await expect(page.locator('.file-approval')).toHaveCount(0);
  await page.locator('.conversation-list button').filter({ hasText: '새 대화 1' }).click();
  await expect(page.locator('.file-history')).toContainText('파일 수정 완료');
});
test('actual daemon text flow, drafts, IME, cancellation and responsive modal focus', async ({ page, daemon, records }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, daemon, records);
  await expect(page.getByRole('button', { name: '개발 서버 종료', exact: true })).toHaveCount(0);
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
    const back = page.getByRole('button', { name: '← 대화 목록', exact: true });
    await back.click();
    await expect(page.locator('.stacked-list')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.locator('.conversation-list [aria-current=true]').click();
    await expect(input).toHaveValue('응답 중 작성한 다음 질문');
    expect((await back.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole('button', { name: '어두운 테마' }).click();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  // User-selected A palette: default Main Color, dark canvas.
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(20, 23, 22)');
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

test('page through persisted messages and continue a completed conversation after daemon restart', async ({ page, daemon, records }) => {
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
  const restarted = await launch(records, { entry: join(projectRoot, 'tests/acp-daemon.mjs'), extraArgs: ['--origin', origin] });
  await login(page, restarted, records);
  await expect(page.getByText('이 대화는 기록 보기로 열렸습니다')).toHaveCount(0);
  await send(page, 'recall-first');
  await expect(page.locator('.run-state')).toHaveText('응답 완료');
  await page.getByRole('button', { name: '다음 기록 불러오기' }).click();
  await expect(page.getByRole('article', { name: 'AI 메시지' })).toHaveCount(2);
  await expect(page.getByRole('article', { name: 'AI 메시지' }).last()).toContainText('답변 2: 재시작 뒤 기록');
  const activity = readFileSync(join(records.root, 'agent.log'), 'utf8').trim().split('\n').map(JSON.parse);
  expect(activity.filter((item) => item.type === 'new')).toHaveLength(1);
  expect(activity.filter((item) => item.type === 'prompt')).toHaveLength(2);
});

test('resume failure explains undelivered input and preserves the previous transcript', async ({ page, daemon, records }) => {
  await login(page, daemon, records);
  await newSession(page);
  await send(page, '보존할 이전 답변');
  await expect(page.locator('.run-state')).toHaveText('응답 완료');
  await daemon.stop();
  const restarted = await launch(records, { entry: join(projectRoot, 'tests/acp-daemon.mjs'), extraArgs: ['--origin', origin], env: { TEST_AGENT_RESUME: 'fail' } });
  await login(page, restarted, records);
  await send(page, '전달되지 않을 새 입력');
  await expect(page.locator('.run-state')).toHaveText('응답 실패', { timeout: 20_000 });
  await expect(page.getByText('기존 대화를 이어갈 수 없습니다')).toBeVisible();
  await expect(page.getByRole('article', { name: 'AI 메시지' }).first()).toContainText('답변 1: 보존할 이전 답변');
  await expect(page.getByRole('article', { name: '내 메시지' }).last()).toContainText('전달되지 않을 새 입력');
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('추가 전송 차단');
  await expect(page.getByRole('button', { name: '메시지 전송' })).toBeDisabled();
  const activity = readFileSync(join(records.root, 'agent.log'), 'utf8').trim().split('\n').map(JSON.parse);
  expect(activity.filter((item) => item.type === 'new')).toHaveLength(1);
  expect(activity.filter((item) => item.type === 'prompt')).toHaveLength(1);
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

test('Settings defaults and per-conversation choices remain separate, persist on restart and fit mobile screens', async ({ page, daemon, records }) => {
  await login(page, daemon, records);
  await newSession(page);
  await expect(page.getByLabel('Model', { exact: true })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('설정 중에도 유지할 초안');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: '설정 메뉴', exact: true }).getByRole('button', { name: 'AI', exact: true }).click();
  const settings = page.getByRole('region', { name: '설정', exact: true });
  await expect(settings.getByText('ChatGPT 로그인 정보 확인됨')).toBeVisible();
  await expect(settings).not.toContainText('private-not-for-ui');
  await settings.getByLabel('기본 Model', { exact: true }).selectOption('gpt-5.6-sol');
  await expect(settings.getByLabel('기본 Model', { exact: true })).toHaveValue('gpt-5.6-sol');
  await settings.getByLabel('기본 Reasoning Effort', { exact: true }).selectOption('high');
  await expect(settings.getByLabel('기본 Reasoning Effort', { exact: true })).toHaveValue('high');
  await page.screenshot({ path: '.worknaru-test/settings-desktop.png' });
  await settings.getByRole('button', { name: 'Chat으로 돌아가기' }).click();
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('gpt-5.6-luna');
  await expect(page.getByRole('textbox', { name: '메시지', exact: true })).toHaveValue('설정 중에도 유지할 초안');
  await newSession(page);
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('gpt-5.6-sol');
  await expect(page.getByLabel('Reasoning Effort', { exact: true })).toHaveValue('high');
  await send(page, '설정 뒤에도 같은 맥락');
  await expect(page.locator('.run-state')).toHaveText('응답 완료');
  await expect(page.locator('.model-status')).toContainText('최근 적용: gpt-5.6-sol · high');
  await page.getByLabel('Model', { exact: true }).selectOption('gpt-5.6-luna');
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('gpt-5.6-luna');
  await page.getByLabel('Reasoning Effort', { exact: true }).selectOption('low');
  await expect(page.getByLabel('Reasoning Effort', { exact: true })).toHaveValue('low');
  await expect(page.locator('.model-status')).toContainText('다음 메시지에 적용');
  await send(page, 'recall-first');
  await expect(page.locator('.run-state')).toHaveText('응답 완료');
  await expect(page.getByRole('article', { name: 'AI 메시지' }).last()).toContainText('답변 2: 설정 뒤에도 같은 맥락');
  await expect(page.locator('.model-status')).toContainText('최근 적용: gpt-5.6-luna · low');
  await page.screenshot({ path: '.worknaru-test/chat-model-settings.png' });
  await daemon.stop();
  const restarted = await launch(records, { entry: join(projectRoot, 'tests/acp-daemon.mjs'), extraArgs: ['--origin', origin] });
  await login(page, restarted, records);
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('gpt-5.6-luna');
  await send(page, 'recall-first');
  await expect(page.locator('.run-state')).toHaveText('응답 완료');
  await expect(page.getByRole('article', { name: 'AI 메시지' }).last()).toContainText('답변 3: 설정 뒤에도 같은 맥락');
  await page.setViewportSize({ width: 320, height: 850 });
  await page.getByRole('button', { name: '← 대화 목록', exact: true }).click();
  await page.getByRole('button', { name: '← Module', exact: true }).click();
  await page.getByRole('region', { name: 'Module 선택' }).getByRole('button', { name: /설정/ }).click();
  await page.getByRole('navigation', { name: '설정 메뉴', exact: true }).getByRole('button', { name: 'AI', exact: true }).click();
  await expect(settings.getByLabel('기본 Model', { exact: true })).toHaveValue('gpt-5.6-sol');
  await expect(settings.getByLabel('기본 Reasoning Effort', { exact: true })).toHaveValue('high');
  for (let i = 0; i < 10; i++) await page.keyboard.press('Tab');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('complementary')).toHaveCount(0);
  expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: '.worknaru-test/settings-mobile.png' });
  await page.getByRole('button', { name: '← 설정 메뉴', exact: true }).click();
  await page.getByRole('button', { name: '← Module', exact: true }).click();
  await page.getByRole('region', { name: 'Module 선택' }).getByRole('button', { name: /Chat/ }).click();
  await page.locator('.conversation-list [aria-current=true]').click();
  await send(page, 'wait');
  await expect(page.getByLabel('Model', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Reasoning Effort', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '응답 중지' }).click();
  await expect(page.locator('.run-state')).toHaveText('중지 완료');
});

test('opening Settings and refreshing reads defaults changed by another client', async ({ page, daemon, records }) => {
  await login(page, daemon, records);
  await newSession(page);
  await expect(page.getByLabel('Model', { exact: true })).toBeEnabled({ timeout: 15_000 });
  const other = await connect(records, daemon);
  await other.call('ai.get', {});
  const sol = { model: 'gpt-5.6-sol', reasoningEffort: 'high' };
  const luna = { model: 'gpt-5.6-luna', reasoningEffort: 'low' };
  expect((await other.call('settings.update', { selection: sol }, mutation(other))).ok).toBe(true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: '설정 메뉴', exact: true }).getByRole('button', { name: 'AI', exact: true }).click();
  const settings = page.getByRole('region', { name: '설정', exact: true });
  await expect(settings.getByLabel('기본 Model', { exact: true })).toHaveValue(sol.model);
  await expect(settings.getByLabel('기본 Reasoning Effort', { exact: true })).toHaveValue('high');
  expect((await other.call('settings.update', { selection: luna }, mutation(other))).ok).toBe(true);
  await settings.getByRole('button', { name: '상태 새로고침', exact: true }).click();
  await expect(settings.getByLabel('기본 Model', { exact: true })).toHaveValue(luna.model);
  await expect(settings.getByLabel('기본 Reasoning Effort', { exact: true })).toHaveValue('low');
  await settings.getByRole('button', { name: 'Chat으로 돌아가기' }).click();
  expect((await other.call('settings.update', { selection: sol }, mutation(other))).ok).toBe(true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: '설정 메뉴', exact: true }).getByRole('button', { name: 'AI', exact: true }).click();
  await expect(settings.getByLabel('기본 Model', { exact: true })).toHaveValue(sol.model);
  await settings.getByRole('button', { name: 'Chat으로 돌아가기' }).click();
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue(luna.model);
  await newSession(page);
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue(sol.model);
  await expect(page.getByLabel('Reasoning Effort', { exact: true })).toHaveValue('high');
  const events = readFileSync(join(records.root, 'agent.log'), 'utf8').trim().split('\n').map(JSON.parse);
  expect(events.filter((event) => event.type === 'prompt')).toHaveLength(0);
});

test('a lost setting response is recovered after reload without creating a model turn', async ({ page, daemon, records }) => {
  let drop = true;
  let configureId;
  await page.routeWebSocket(daemon.url, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((text) => { const value = JSON.parse(text); if (value.method === 'settings.update') configureId = value.callId; server.send(text); });
    server.onMessage((text) => {
      const value = JSON.parse(text);
      if (drop && configureId && value.type === 'response' && value.callId === configureId) { drop = false; socket.close(); server.close(); }
      else socket.send(text);
    });
  });
  await login(page, daemon, records);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: '설정 메뉴', exact: true }).getByRole('button', { name: 'AI', exact: true }).click();
  await expect(page.getByLabel('기본 Model', { exact: true })).toBeEnabled({ timeout: 15_000 });
  await page.getByLabel('기본 Model', { exact: true }).selectOption('gpt-5.6-sol');
  await expect(page.getByRole('button', { name: '연결 끊김', exact: true })).toBeVisible();
  await login(page, daemon, records);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: '설정 메뉴', exact: true }).getByRole('button', { name: 'AI', exact: true }).click();
  await expect(page.getByLabel('기본 Model', { exact: true })).toHaveValue('gpt-5.6-sol');
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  const events = readFileSync(join(records.root, 'agent.log'), 'utf8').trim().split('\n').map(JSON.parse);
  expect(events.filter((event) => ['new', 'prompt'].includes(event.type))).toHaveLength(0);
});


test('mobile browser navigation preserves running work, drafts and settings menu choices', async ({page, daemon, records}) => {
  await page.setViewportSize({width:390,height:850});
  await login(page,daemon,records);
  await expect(page.locator('.stacked-list')).toBeVisible();
  await newSession(page);await send(page,'wait');
  await expect(page.getByRole('button',{name:'응답 중지'})).toBeEnabled();
  const draft=page.getByRole('textbox',{name:'메시지',exact:true});
  await draft.fill('돌아와서 보낼 초안');
  await page.getByRole('button',{name:'← 대화 목록'}).click();
  await expect(page.locator('.stacked-list')).toBeVisible();
  await expect(page.locator('.conversation-list [aria-current=true]')).toContainText('응답 중');
  await page.goForward();await expect(draft).toHaveValue('돌아와서 보낼 초안');
  await page.goBack();await expect(page.locator('.stacked-list')).toBeVisible();
  await page.getByRole('button',{name:'← Module'}).click();
  await page.getByRole('region',{name:'Module 선택'}).getByRole('button',{name:/설정/}).click();
  await page.getByRole('navigation',{name:'설정 메뉴'}).getByRole('button',{name:'AI',exact:true}).click();
  await expect(page.getByRole('heading',{name:'AI 인증'})).toBeVisible();
  await page.goBack();await expect(page.locator('.stacked-list')).toBeVisible();
  await expect(page.getByRole('navigation',{name:'설정 메뉴'}).getByRole('button',{name:'AI',exact:true})).toHaveAttribute('aria-current','page');
  await page.goBack();await expect(page.getByRole('region',{name:'Module 선택'})).toBeVisible();
  await page.getByRole('region',{name:'Module 선택'}).getByRole('button',{name:/Chat/}).click();
  await page.locator('.conversation-list [aria-current=true]').click();
  await expect(draft).toHaveValue('돌아와서 보낼 초안');
  await expect(page.getByRole('button',{name:'응답 중지'})).toBeEnabled();
  const historyState=await page.evaluate(()=>JSON.stringify(history.state));
  expect(historyState).not.toContain('돌아와서 보낼 초안');expect(historyState).not.toContain(records.token);
  await page.getByRole('button',{name:'응답 중지'}).click();await expect(page.locator('.run-state')).toHaveText('중지 완료');
  await page.reload();await login(page,daemon,records);
  await expect(page.getByRole('button',{name:'← 대화 목록'})).toBeVisible();
  await expect(page.locator('.run-state')).toHaveText('중지 완료');
  await expect(draft).toHaveValue('');
});

test('Chat and Settings retain independent sidebar state and mobile list scroll', async ({page, records}) => {
  const daemon=await launch(records,{extraArgs:['--origin',origin]});
  await login(page,daemon,records);
  const other=await connect(records,daemon);
  for(let i=0;i<18;i++) await createSession(other,daemon.workspace.workspaceId,`목록 위치 ${i}`);
  await login(page,daemon,records);
  await page.getByRole('button',{name:'대화 목록 열기 또는 접기'}).click();
  await expect(page.getByRole('complementary')).toHaveCount(0);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await expect(page.getByRole('complementary',{name:'설정 메뉴'})).toBeVisible();
  await page.getByRole('button',{name:'Chat',exact:true}).click();
  await expect(page.getByRole('complementary')).toHaveCount(0);
  await page.setViewportSize({width:390,height:850});
  const list=page.locator('.conversation-list'), selected=list.getByRole('button').nth(10);
  await selected.scrollIntoViewIfNeeded();const scroll=await list.evaluate(el=>el.scrollTop);
  await selected.click();
  await page.getByRole('textbox',{name:'메시지',exact:true}).fill('목록 스크롤과 함께 보존');
  await page.getByRole('button',{name:'← 대화 목록'}).click();
  await expect.poll(()=>list.evaluate(el=>el.scrollTop)).toBe(scroll);
  await expect(selected).toHaveAttribute('aria-current','true');
  await page.getByRole('button',{name:'← Module'}).click();
  await page.getByRole('region',{name:'Module 선택'}).getByRole('button',{name:/설정/}).click();
  await page.getByRole('button',{name:'← Module'}).click();
  await page.getByRole('region',{name:'Module 선택'}).getByRole('button',{name:/Chat/}).click();
  await expect.poll(()=>list.evaluate(el=>el.scrollTop)).toBe(scroll);
  await selected.click();await expect(page.getByRole('textbox',{name:'메시지',exact:true})).toHaveValue('목록 스크롤과 함께 보존');
});


test('navigation history never selects a previous Workspace session after reconnecting elsewhere', async ({page,records}) => {
  const first=await launch(records,{extraArgs:['--origin',origin]});
  const firstClient=await connect(records,first), firstSession=await createSession(firstClient,first.workspace.workspaceId,'첫 Workspace 대화');
  const secondRecords=fixture({after:action=>records.cleanups.push(action)});
  const second=await launch(secondRecords,{extraArgs:['--origin',origin]});
  const secondClient=await connect(secondRecords,second);
  await createSession(secondClient,second.workspace.workspaceId,'다른 Workspace 대화');
  const requested=[];
  await page.routeWebSocket(second.url,socket=>{const server=socket.connectToServer();socket.onMessage(text=>{requested.push(JSON.parse(text));server.send(text);});});
  await page.setViewportSize({width:390,height:850});
  await login(page,first,records);await page.locator('.conversation-list button').filter({hasText:'첫 Workspace 대화'}).click();
  await page.getByRole('textbox',{name:'메시지',exact:true}).fill('이 Workspace의 초안');
  await page.getByRole('button',{name:'연결됨',exact:true}).click();
  await page.getByRole('textbox',{name:'Daemon 주소'}).fill(second.url);
  await page.getByRole('textbox',{name:'연결 키',exact:true}).fill(secondRecords.token);
  await page.getByRole('dialog',{name:'Workspace 연결'}).getByRole('button',{name:'연결',exact:true}).click();
  await expect(page.locator('.stacked-list')).toBeVisible();
  await expect(page.locator('.conversation-list')).toContainText('다른 Workspace 대화');
  await expect(page.locator('.conversation-list')).not.toContainText('첫 Workspace 대화');
  await page.goBack();
  await expect(page.locator('.stacked-list')).toBeVisible();
  await expect(page.locator('.conversation-list')).toContainText('다른 Workspace 대화');
  expect(requested.some(request=>request.method==='sessions.get' && request.params.sessionId===firstSession.sessionId)).toBe(false);
  const snapshot=await page.evaluate(()=>JSON.stringify(history.state));
  expect(snapshot).not.toContain(firstSession.sessionId);expect(snapshot).not.toContain(records.token);expect(snapshot).not.toContain(secondRecords.token);
});

test('transcript reading position survives Settings and responsive framing changes', async ({page,records}) => {
  const daemon=await launch(records,{extraArgs:['--origin',origin]});
  const client=await connect(records,daemon);
  const session=await createSession(client,daemon.workspace.workspaceId,'읽던 위치');
  await client.call('messages.append',{sessionId:session.sessionId,text:'읽던 위치를 보존하는 긴 기록입니다. '.repeat(160)},mutation(client));
  await login(page,daemon,records);
  const transcript=page.locator('.transcript-scroll');
  await expect(page.getByRole('article',{name:'내 메시지'})).toBeVisible();
  await transcript.evaluate(el=>{el.scrollTop=300;el.dispatchEvent(new Event('scroll'));});
  await page.getByRole('textbox',{name:'메시지',exact:true}).fill('본문 위치와 함께 보존할 초안');
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Chat으로 돌아가기'}).click();
  await expect.poll(()=>transcript.evaluate(el=>el.scrollTop)).toBe(300);
  await page.setViewportSize({width:859,height:900});
  await page.locator('.conversation-list [aria-current=true]').click();
  await expect.poll(()=>transcript.evaluate(el=>el.scrollTop)).toBe(300);
  await page.getByRole('button',{name:'← 대화 목록'}).click();
  await page.locator('.conversation-list [aria-current=true]').click();
  await expect.poll(()=>transcript.evaluate(el=>el.scrollTop)).toBe(300);
  await page.setViewportSize({width:860,height:900});
  await expect.poll(()=>transcript.evaluate(el=>el.scrollTop)).toBe(300);
  await expect(page.getByRole('textbox',{name:'메시지',exact:true})).toHaveValue('본문 위치와 함께 보존할 초안');
  await page.getByRole('button',{name:'최근 내용으로 이동 ↓'}).click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Chat으로 돌아가기'}).click();
  await expect.poll(()=>transcript.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(2);
  await page.setViewportSize({width:390,height:850});
  await expect(transcript).toBeVisible();
  await expect.poll(()=>transcript.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(2);
  await page.setViewportSize({width:1280,height:900});
  await expect.poll(()=>transcript.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(2);
});

test('appearance preview and invalid input survive responsive framing until explicit exit', async ({page,records}) => {
  const daemon=await launch(records,{extraArgs:['--origin',origin]});
  await login(page,daemon,records);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('navigation',{name:'설정 메뉴'}).getByRole('button',{name:'화면',exact:true}).click();
  const hex=page.getByRole('textbox',{name:'Main Color HEX'});
  await hex.fill('#4361ee');
  const preview=await page.evaluate(()=>document.documentElement.style.getPropertyValue('--accent-background'));
  await page.setViewportSize({width:859,height:900});
  await expect(hex).toHaveValue('#4361ee');
  expect(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--accent-background'))).toBe(preview);
  await hex.fill('#43');
  await page.setViewportSize({width:860,height:900});
  await expect(hex).toHaveValue('#43');
  await expect(hex).toHaveAttribute('aria-invalid','true');
  await hex.fill('#4361ee');
  await page.setViewportSize({width:859,height:900});
  await page.getByRole('button',{name:'배색 적용',exact:true}).click();
  await hex.fill('#ff6600');
  await page.getByRole('button',{name:'← 설정 메뉴'}).click();
  await page.getByRole('navigation',{name:'설정 메뉴'}).getByRole('button',{name:'화면',exact:true}).click();
  await expect(hex).toHaveValue('#4361ee');
});

test('history cannot restore an old Workspace while new connection initialization is pending', async ({page,records}) => {
  const first=await launch(records,{extraArgs:['--origin',origin]});
  const firstClient=await connect(records,first);
  const firstSession=await createSession(firstClient,first.workspace.workspaceId,'이전 대화 하나');
  await createSession(firstClient,first.workspace.workspaceId,'이전 대화 둘');
  const otherRecords=fixture({after:action=>records.cleanups.push(action)});
  const second=await launch(otherRecords,{extraArgs:['--origin',origin]});
  const secondClient=await connect(otherRecords,second);
  const secondSession=await createSession(secondClient,second.workspace.workspaceId,'새 Workspace 대화');
  const requested=[];let release;
  await page.routeWebSocket(second.url,socket=>{
    const server=socket.connectToServer();let heldId;
    socket.onMessage(text=>{const request=JSON.parse(text);requested.push(request);if(request.method==='settings.get')heldId=request.callId;server.send(text);});
    server.onMessage(text=>{const response=JSON.parse(text);if(heldId && response.callId===heldId)release=()=>socket.send(text);else socket.send(text);});
  });
  await login(page,first,records);
  await page.locator('.conversation-list button').filter({hasText:'이전 대화 하나'}).click();
  await page.locator('.conversation-list button').filter({hasText:'이전 대화 둘'}).click();
  await page.getByRole('button',{name:'연결됨',exact:true}).click();
  await page.getByRole('textbox',{name:'Daemon 주소'}).fill(second.url);
  await page.getByRole('textbox',{name:'연결 키',exact:true}).fill(otherRecords.token);
  await page.getByRole('dialog',{name:'Workspace 연결'}).getByRole('button',{name:'연결',exact:true}).click();
  await expect.poll(()=>!!release).toBe(true);
  await page.goBack();
  await expect.poll(()=>page.evaluate(()=>history.state.worknaruNavigation.route.view)).toBe('list');
  release();
  await expect(page.getByRole('dialog',{name:'Workspace 연결'})).toHaveCount(0);
  expect(requested.filter(request=>request.method==='sessions.get').every(request=>request.params.sessionId===secondSession.sessionId)).toBe(true);
  await expect(page.locator('.conversation-list [aria-current=true]')).toContainText('새 Workspace 대화');
  await expect(page.locator('.error-banner')).toHaveCount(0);
  expect(await page.evaluate(()=>JSON.stringify(history.state))).not.toContain(firstSession.sessionId);
  await page.goForward();
  await expect(page.locator('.conversation-list [aria-current=true]')).toContainText('새 Workspace 대화');
  expect(await page.evaluate(()=>history.state.worknaruNavigation.route.sessionId)).toBe(secondSession.sessionId);
});

test('offline history still navigates cached conversations in the same Workspace', async ({page,records}) => {
  const daemon=await launch(records,{extraArgs:['--origin',origin]});
  const client=await connect(records,daemon);
  const first=await createSession(client,daemon.workspace.workspaceId,'오프라인 대화 하나');
  const second=await createSession(client,daemon.workspace.workspaceId,'오프라인 대화 둘');
  await client.call('messages.append',{sessionId:first.sessionId,text:'첫 대화의 저장 내용'},mutation(client));
  await client.call('messages.append',{sessionId:second.sessionId,text:'두 번째 대화의 저장 내용'},mutation(client));
  await login(page,daemon,records);
  await page.locator('.conversation-list button').filter({hasText:'오프라인 대화 하나'}).click();
  await expect(page.getByRole('article',{name:'내 메시지'})).toContainText('첫 대화의 저장 내용');
  await page.locator('.conversation-list button').filter({hasText:'오프라인 대화 둘'}).click();
  await expect(page.getByRole('article',{name:'내 메시지'})).toContainText('두 번째 대화의 저장 내용');
  await daemon.stop();
  await expect(page.getByRole('button',{name:'연결 끊김',exact:true})).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('article',{name:'내 메시지'})).toContainText('첫 대화의 저장 내용');
  await page.goForward();
  await expect(page.getByRole('article',{name:'내 메시지'})).toContainText('두 번째 대화의 저장 내용');
});
