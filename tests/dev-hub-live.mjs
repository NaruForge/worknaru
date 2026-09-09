// Explicit integration test: attaches one temporary fake-agent server to the
// existing Tailnet Hub, detaches only that ID, and leaves the shared Hub running.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { startDevServers } from '../scripts/dev.mjs';
import { fixture, projectRoot } from './helpers.mjs';

test('real Tailnet Hub carries UI, chat and HMR; detach preserves the upstream', { skip: process.env.WORKNARU_TEST_HUB !== '1', timeout: 120_000 }, async (t) => {
  const f = fixture(t);
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
  const invoke = async (mode, id) => {
    const { stdout } = await promisify(execFile)('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(projectRoot, 'scripts/dev-hub.ps1'), '-Mode', mode, '-Port', String(port), ...(id ? ['-Id', id] : [])], { windowsHide: true, timeout: 60_000 });
    return JSON.parse(stdout);
  };
  const hub = await invoke('Prepare');
  const server = await startDevServers({ webPort: port, hub, daemonOptions: {
    dataDirectory: f.data, workspaceDirectory: f.workspace, token: f.token, port: 0,
    acp: { command: { executable: process.execPath, arguments: [join(projectRoot, 'tests/fake-acp.mjs')], cwd: f.workspace,
      env: { ...process.env, TEST_AGENT_LOG: join(f.root, 'agent.log'), TEMP: f.root, TMP: f.root },
    } },
  } });
  f.cleanups.push(() => server.close());
  const attachment = await invoke('Attach', hub.Id);
  let detached = false;
  f.cleanups.push(async () => { if (!detached) await invoke('Detach', hub.Id); });
  for (const url of [attachment.LocalUrl, attachment.TailnetUrl]) assert.equal((await fetch(url)).status, 200);
  const priorTemp = process.env.TEMP; const priorTmp = process.env.TMP;
  process.env.TEMP = f.root; process.env.TMP = f.root;
  const browser = await chromium.launch({ channel: 'msedge', headless: true, env: { ...process.env, TEMP: f.root, TMP: f.root } });
  f.cleanups.push(async () => { await browser.close(); process.env.TEMP = priorTemp; process.env.TMP = priorTmp; });
  const page = await browser.newPage();
  const received = [];
  page.on('websocket', (ws) => ws.on('framereceived', (frame) => received.push({ url: ws.url(), payload: String(frame.payload) })));
  await page.goto(attachment.TailnetUrl);
  await page.getByRole('button', { name: '연결됨', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('Tailnet 연결 시험');
  await page.getByRole('button', { name: '메시지 전송' }).click();
  await page.locator('.run-state').filter({ hasText: '응답 완료' }).waitFor();
  assert.match(await page.getByRole('article', { name: 'AI 메시지' }).innerText(), /Tailnet 연결 시험/);
  assert.ok(received.some((frame) => frame.url.includes(`${hub.BasePath}?token=`) && frame.payload.includes('connected')));
  assert.ok(received.some((frame) => frame.url.endsWith('__worknaru_ws') && frame.payload.includes('ready')));
  await page.screenshot({ path: join(projectRoot, '.worknaru-test/dev-hub-tailnet.png') });
  await invoke('Detach', hub.Id); detached = true;
  for (const url of [attachment.LocalUrl, attachment.TailnetUrl]) assert.equal((await fetch(url)).status, 404);
  assert.equal((await fetch(server.localUrl)).status, 200);
  await page.goto(server.localUrl);
  await page.getByRole('button', { name: '연결됨', exact: true }).waitFor();
  await page.getByRole('button', { name: '개발 서버 종료', exact: true }).click();
  await page.getByRole('heading', { name: '종료되었습니다.' }).waitFor();
  assert.equal(await server.close(), true);
  console.log(`Verified then detached Preview ${hub.Id}; HTTP 200/404 on local and Tailnet routes; fake chat and HMR passed; no model prompts.`);
});
