// A separate real process speaking ACP v1, including a descendant for cleanup tests.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const log = (message) => { if (process.env.TEST_AGENT_LOG) appendFileSync(process.env.TEST_AGENT_LOG, JSON.stringify(message) + '\n'); };
log({ type: 'spawn', pid: process.pid });
const sessions = new Map();
const tasks = new Map();
const reply = (id, result) => send({ id, result });
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (method === 'initialize') reply(id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
  if (method === 'session/new') {
    const sessionId = randomUUID();
    sessions.set(sessionId, []);
    reply(id, { sessionId });
  }
  if (method === 'session/prompt') {
    const text = params.prompt[0].text;
    const history = sessions.get(params.sessionId);
    history.push(text);
    log({ type: 'prompt', text, sessionId: params.sessionId });
    if (text === 'crash') { process.exit(42); }
    if (text === 'malformed') { process.stdout.write('x'.repeat(600_000)); return; }
    if (text === 'tool') {
      send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Test tool', kind: 'read', status: 'pending' } } });
      return;
    }
    if (text === 'permission') {
      send({ id: 'permission-1', method: 'session/request_permission', params: {
        sessionId: params.sessionId, toolCall: { toolCallId: 'tool-1', title: 'Test edit', kind: 'edit', status: 'pending' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      } });
      return;
    }
    if (text === 'wait') {
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
      log({ type: 'descendant', pid: descendant.pid });
      tasks.set(params.sessionId, { id });
      return;
    }
    const chunks = text === 'large' ? ['보존된 출력', 'x'.repeat(17_000)] : [`답변 ${history.length}: `, text];
    let index = 0;
    const timer = setInterval(() => {
      if (index < chunks.length) send({ method: 'session/update', params: { sessionId: params.sessionId, update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunks[index++] },
      } } });
      else { clearInterval(timer); tasks.delete(params.sessionId); reply(id, { stopReason: 'end_turn' }); }
    }, 40);
    tasks.set(params.sessionId, { id, timer });
  }
  if (method === 'session/cancel') {
    log({ type: 'cancel' });
    const task = tasks.get(params.sessionId);
    if (task) { clearInterval(task.timer); tasks.delete(params.sessionId); reply(task.id, { stopReason: 'cancelled' }); }
  }
});
