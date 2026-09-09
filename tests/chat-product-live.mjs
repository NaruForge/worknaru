import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { chromium } from '@playwright/test';
import { WebSocket } from 'ws';
import { PaseoRuntime } from '../dist/paseo-runtime.js';
import { PaseoChatRuntime } from '../dist/paseo-chat-runtime.js';
import { ChatStore } from '../dist/chat-store.js';
import { ChatService } from '../dist/chat-service.js';
import { startChatDaemon } from '../dist/chat-daemon.js';
import { ChatConnection } from '../dist/chat-connection.js';
import { deadline } from '../dist/owned-process.js';

const selection = { model: 'gpt-5.6-luna', effort: 'low' };
const digest = path => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
test('real product UI/headless: tools, permission allow/deny, new-history restart and cancellation', { skip: process.env.WORKNARU_LIVE !== '1', timeout: 300_000 }, async () => {
  const codexPath = process.env.WORKNARU_CODEX_PATH; assert.ok(codexPath, 'WORKNARU_CODEX_PATH is required.');
  const root = process.cwd(), directory = join(root, '.worknaru-test', `product-live-${randomUUID()}`);
  const workspace = join(directory, 'workspace'), outside = join(directory, 'outside'), temp = join(directory, 'browser');
  for (const path of [workspace, outside, temp]) mkdirSync(path, { recursive: true });
  const marker = `WORKNARU_SOURCE_${randomUUID().slice(0, 8)}`;
  writeFileSync(join(workspace, 'source.txt'), marker);
  const allowed = join(outside, 'allowed.txt'), denied = join(outside, 'denied.txt');
  writeFileSync(denied, 'UNCHANGED');
  const personal = [join(homedir(), '.paseo', 'config.json'), join(homedir(), '.paseo', 'server-id'), join(homedir(), '.codex', 'config.toml'), join(homedir(), '.codex', 'auth.json')];
  const before = personal.map(digest);
  let native, service, server, client, browser, page;
  let calls = 0, chatId;
  const finished = [];
  const record = value => { appendFileSync(join(directory, 'verification.jsonl'), `${JSON.stringify(value)}\n`); console.log(JSON.stringify(value)); };
  async function start() {
    native = await PaseoRuntime.start({ projectRoot: root, dataDir: join(directory, 'data'), workspace, codexPath, testMode: true });
    native.subscribe(event => appendFileSync(join(directory, 'native-events.jsonl'), `${JSON.stringify(event)}\n`));
    service = new ChatService(new PaseoChatRuntime(native), new ChatStore(native.directory), workspace);
    await service.start(); server = await startChatDaemon(service, { port: 0, webRoot: join(root, 'dist', 'web') });
    client = new ChatConnection(server.url, url => new WebSocket(url), false); await client.connect();
    client.subscribe(event => { if (event.type === 'message.finished') finished.push(event); });
    page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.port}/index.html`);
    await page.getByText('연결됨', { exact: true }).waitFor();
    if (chatId) { await page.getByRole('button').filter({ hasText: 'source.txt' }).click(); await page.getByRole('textbox', { name: '메시지', exact: true }).waitFor(); }
  }
  async function stop() {
    await page?.close(); client?.close(); await server?.close(); await native?.stop(); await server?.drain(); await service?.close();
    page = client = server = native = service = undefined;
  }
  async function preflight(scenario) {
    const models = await client.call('models.list', {});
    assert.ok(models.find(model => model.id === selection.model)?.efforts.some(effort => effort.id === selection.effort));
    assert.equal(await page.getByRole('combobox', { name: 'Model', exact: true }).inputValue(), selection.model);
    assert.equal(await page.getByRole('combobox', { name: 'Reasoning Effort', exact: true }).inputValue(), selection.effort);
    if (chatId) {
      const view = await client.call('chats.get', { chatId }); assert.deepEqual(view.chat.selection, selection); assert.equal(view.chat.status, 'ready');
    }
    record({ scenario, call: ++calls, ...selection, result: 'guarded dispatch', directory });
  }
  async function waitFinish(start, scenario, expected = 'completed') {
    const event = await deadline(new Promise(resolve => {
      const check = () => {
        const value = finished.slice(start).find(event => !chatId || event.chatId === chatId);
        if (value) resolve(value); else setTimeout(check, 25).unref();
      }; check();
    }), 60_000, `No product completion: ${scenario}`);
    assert.equal(event.outcome, expected); chatId = event.chatId;
    record({ scenario, call: calls, ...selection, result: event.outcome, messageId: event.messageId });
    return event;
  }
  async function sendUI(scenario, prompt, action) {
    await preflight(scenario); const start = finished.length;
    await page.getByRole('textbox', { name: '메시지', exact: true }).fill(prompt);
    await page.getByRole('button', { name: '메시지 보내기', exact: true }).click();
    if (action) await action();
    return waitFinish(start, scenario, scenario === 'ui-cancel' ? 'cancelled' : 'completed');
  }
  const originalTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TEMP = process.env.TMP = temp;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    await start();
    await sendUI('workspace-read-tool', 'Read source.txt using a file or shell tool. Reply exactly with its contents. Do not change files.', async () => {
      // This isolated Windows Codex home can request approval even for a read-only shell command.
      const allow = page.getByRole('button', { name: '이번 요청 허용', exact: true });
      const summary = page.locator('.file-approval summary');
      await Promise.race([summary.waitFor({ timeout: 40_000 }), new Promise(resolve => {
        const check = () => { if (finished.length) resolve(); else setTimeout(check, 25).unref(); }; check();
      })]);
      if (await summary.isVisible()) {
        await summary.click();
        assert.match(await page.locator('.file-approval').innerText(), /source\.txt/i);
        await allow.click();
      }
    });
    const firstView = await client.call('chats.get', { chatId });
    assert.ok(firstView.timeline.items.some(item => item.kind === 'tool'));
    assert.ok(firstView.timeline.items.some(item => item.kind === 'assistant' && item.text.includes(marker)));
    await preflight('headless-follow-up');
    const startIndex = finished.length;
    await client.call('messages.send', { chatId, messageId: randomUUID(), text: 'What did source.txt contain? Reply with the same exact contents. Do not use tools.' });
    await waitFinish(startIndex, 'headless-follow-up');
    const command = `Set-Content -LiteralPath '${allowed.replaceAll("'", "''")}' -Value 'ALLOWED'`;
    await sendUI('permission-allow', `Use exec_command to run the PowerShell command below. Set sandbox_permissions to require_escalated and provide a short justification. Wait for the permission response. Do not run other commands, use other tools, or change other files. If denied, do not retry.\n\nCOMMAND (one line):\n${command}\n`, async () => {
      await page.locator('.file-approval summary').waitFor({ timeout: 40_000 }); await page.locator('.file-approval summary').click();
      await page.screenshot({ path: join(directory, 'permission-allow.png'), fullPage: true });
      await page.getByRole('button', { name: '이번 요청 허용', exact: true }).click();
    });
    assert.equal(readFileSync(allowed, 'utf8').trim(), 'ALLOWED');
    const oldPid = native.pid; await page.close(); page = undefined;
    process.kill(oldPid, 0); // Closing the tab leaves the active product runtime alive.
    await stop(); assert.throws(() => process.kill(oldPid, 0), { code: 'ESRCH' });
    await start();
    const restored = await client.call('chats.get', { chatId });
    assert.ok(restored.timeline.items.some(item => item.kind === 'assistant' && item.text.includes(marker)));
    assert.equal(restored.chat.status, 'ready');
    record({ scenario: 'restart-new-history', result: 'restored', chatId });
    const deniedCommand = `Set-Content -LiteralPath '${denied.replaceAll("'", "''")}' -Value 'CHANGED'`;
    await sendUI('permission-deny', `Use exec_command to run the PowerShell command below. Set sandbox_permissions to require_escalated and provide a short justification. Wait for permission. If denied, stop without retrying or using any other tool.\n\nCOMMAND (one line):\n${deniedCommand}\n`, async () => {
      await page.locator('.file-approval summary').waitFor({ timeout: 40_000 }); await page.locator('.file-approval summary').click();
      await page.getByRole('button', { name: '거절', exact: true }).click();
    });
    assert.equal(readFileSync(denied, 'utf8'), 'UNCHANGED');
    await sendUI('ui-cancel', 'Use the shell to wait for 30 seconds and then reply DONE. Do not change any files.', async () => {
      await page.getByRole('button', { name: '실행 취소', exact: true }).click();
    });
    await page.screenshot({ path: join(directory, 'product-chat.png'), fullPage: true });
  } finally {
    await stop(); await browser?.close();
    for (const key of ['TEMP', 'TMP']) { if (originalTemp[key] === undefined) delete process.env[key]; else process.env[key] = originalTemp[key]; }
    assert.deepEqual(personal.map(digest), before);
    record({ scenario: 'cleanup', calls, result: 'stopped; personal configuration unchanged' });
  }
});
