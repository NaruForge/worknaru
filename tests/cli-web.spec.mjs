import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { connect, deadline, fixture, projectRoot } from './helpers.mjs';

const test = base.extend({
  records: async ({}, use) => {
    const cleanups = [];
    const records = fixture({ after: (action) => cleanups.push(action) });
    try { await use(records); } finally { for (const action of cleanups.reverse()) await action(); }
  },
  daemon: async ({ records }, use) => {
    const child = spawn(process.execPath, [join(projectRoot, 'tests/cli-acp-entry.mjs'),
      '--data-dir', records.data, '--workspace', records.workspace, '--port', '0', '--web-ui'], {
      cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, WORKNARU_TOKEN: records.token },
    });
    const exit = once(child, 'exit');
    let output = ''; let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    records.cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null && child.connected) child.send('interrupt', () => {});
      try { await deadline(exit, 20_000); }
      catch (error) { child.kill('SIGKILL'); await exit; throw error; }
    });
    const ready = await deadline(new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]));
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(errors)));
    }));
    await use(ready);
  },
});

async function connectPage(page, records, daemon) {
  await expect(page.getByLabel('Daemon 주소')).toHaveValue(daemon.url);
  await page.getByLabel('연결 키', { exact: true }).fill(records.token);
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('bundled CLI UI authenticates, chats, reloads and never exposes development shutdown', async ({ page, records, daemon }) => {
  const sockets = [];
  page.on('websocket', (socket) => sockets.push(socket.url()));
  await page.goto(daemon.httpOrigin);
  await expect(page.getByLabel('Daemon 주소')).toHaveValue(daemon.url);
  await expect(page.getByRole('button', { name: '개발 서버 종료', exact: true })).toHaveCount(0);
  await page.getByLabel('연결 키', { exact: true }).fill('x'.repeat(43));
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('인증');
  await connectPage(page, records, daemon);
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '메시지', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('번들 UI 대화');
  await page.getByRole('button', { name: '메시지 전송' }).click();
  await expect(page.locator('.run-state')).toHaveText('응답 완료');
  expect(sockets.every((url) => url === daemon.url)).toBe(true);
  await page.reload();
  await expect(page.getByLabel('연결 키', { exact: true })).toHaveValue('');
  await connectPage(page, records, daemon);
  await page.locator('.conversation-list button').filter({ hasText: '대화 1' }).click();
  await expect(page.getByRole('article', { name: 'AI 메시지' })).toContainText('번들 UI 대화');
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain(records.token);
  await expect(page.getByRole('button', { name: '개발 서버 종료', exact: true })).toHaveCount(0);
});

test('closing the bundled tab leaves a zero-client run alive until the daemon completes it', async ({ page, records, daemon }) => {
  await page.goto(daemon.httpOrigin);
  await connectPage(page, records, daemon);
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '메시지', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('gated');
  await page.getByRole('button', { name: '메시지 전송' }).click();
  await expect.poll(() => {
    try { return readFileSync(join(records.root, 'agent.log'), 'utf8'); } catch { return ''; }
  }).toContain('"text":"gated"');
  await page.close();
  writeFileSync(join(records.root, 'release-output'), 'release');
  // The run is allowed to finish before any replacement client connects.
  await expect.poll(() => {
    const db = new DatabaseSync(join(records.data, 'records.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT state FROM runs ORDER BY created_at DESC LIMIT 1').get()?.state; }
    finally { db.close(); }
  }).toBe('completed');
  const client = await connect(records, daemon);
  const listed = await client.call('sessions.list', { workspaceId: daemon.workspace.workspaceId });
  const session = listed.result.sessions[0];
  const run = await client.call('runs.get', { runId: session.latestRunId });
  expect(run.result.state).toBe('completed');
  expect(run.result.text).toBe('답변 1: gated');
});
