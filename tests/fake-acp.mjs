// A separate real process speaking ACP v1, including a descendant for cleanup tests.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
let metadata = false;
const log = (message) => { if (process.env.TEST_AGENT_LOG) appendFileSync(process.env.TEST_AGENT_LOG, JSON.stringify({ ...message, type: metadata && ['new', 'resume', 'configure'].includes(message.type) ? `metadata-${message.type}` : message.type, metadata }) + '\n'); };
log({ type: 'spawn', pid: process.pid });
const sessions = new Map();
const selections = new Map();
const config = JSON.parse(process.env.CODEX_CONFIG ?? '{}');
const models = [
  { id: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({ reasoningEffort })) },
  { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', defaultReasoningEffort: 'high', supportedReasoningEfforts: ['low', 'high'].map((reasoningEffort) => ({ reasoningEffort })) },
].filter((model) => process.env.TEST_AGENT_MODEL !== 'unsupported' || model.id !== 'gpt-5.6-luna');
const initialSelection = () => ({ model: process.env.TEST_AGENT_MODEL === 'mismatch' ? 'gpt-5.6-sol' : config.model ?? 'gpt-5.6-luna', effort: config.model_reasoning_effort ?? 'low' });
function configuration(sessionId) {
  if (process.env.TEST_AGENT_MODEL === 'missing') return {};
  const selection = selections.get(sessionId);
  const selected = models.find((model) => model.id === selection.model) ?? models[0];
  return { configOptions: [
    { id: 'model', name: 'Model', type: 'select', currentValue: selection.model, options: models.map((model) => ({ value: model.id, name: model.displayName })) },
    { id: 'reasoning_effort', name: 'Reasoning effort', type: 'select', currentValue: selection.effort, options: selected.supportedReasoningEfforts.map(({ reasoningEffort }) => ({ value: reasoningEffort, name: reasoningEffort })) },
  ] };
}
const tasks = new Map();
const reply = (id, result) => send({ id, result });
const sessionFile = (sessionId) => join(dirname(process.env.TEST_AGENT_LOG), `session-${sessionId}.json`);
const resumeMode = process.env.TEST_AGENT_RESUME ?? 'resume';
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (method === 'initialize') {
    metadata = params.clientInfo?.name === 'worknaru-metadata';
    reply(id, { protocolVersion: 1,
    agentCapabilities: resumeMode === 'unsupported' ? {} : resumeMode === 'load' ? { loadSession: true } : { loadSession: true, sessionCapabilities: { resume: {}, close: {} } }, authMethods: [] });
  }
  if (method === 'authentication/status') {
    log({ type: 'authentication-status' });
    if (process.env.TEST_AGENT_INFO === 'wait') return;
    reply(id, { type: process.env.TEST_AGENT_INFO === 'signedOut' ? 'unauthenticated' : 'chat-gpt', email: 'private-not-for-ui@example.invalid', accessToken: 'secret-not-for-ui' });
  }
  if (method === 'session/close') { sessions.delete(params.sessionId); selections.delete(params.sessionId); reply(id, {}); }
  if (method === 'session/new') {
    const sessionId = randomUUID();
    sessions.set(sessionId, []);
    selections.set(sessionId, initialSelection());
    writeFileSync(sessionFile(sessionId), '[]');
    log({ type: 'new', sessionId });
    reply(id, { sessionId, ...configuration(sessionId) });
  }
  if (method === 'session/resume' || method === 'session/load') {
    log({ type: 'resume', method, sessionId: params.sessionId });
    if (resumeMode === 'wait') return;
    try {
      if (resumeMode === 'fail') throw new Error('Synthetic resume failure');
      const history = JSON.parse(readFileSync(sessionFile(params.sessionId), 'utf8'));
      sessions.set(params.sessionId, history);
      selections.set(params.sessionId, initialSelection());
      if (method === 'session/load') {
        for (const [index, text] of history.entries()) {
          for (const [sessionUpdate, content] of [['user_message_chunk', text], ['agent_message_chunk', `답변 ${index + 1}: ${text}`]])
            send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate, content: { type: 'text', text: content } } } });
        }
      }
      reply(id, configuration(params.sessionId));
    } catch { send({ id, error: { code: -32602, message: 'Session history unavailable' } }); }
  }
  if (method === 'session/set_config_option') {
    log({ type: 'configure', ...params });
    const selection = selections.get(params.sessionId);
    if (process.env.TEST_AGENT_MODEL !== 'mismatch' && !(process.env.TEST_AGENT_MODEL === 'drift' && sessions.get(params.sessionId)?.length)) {
      if (params.configId === 'model') selection.model = params.value;
      if (params.configId === 'reasoning_effort') selection.effort = params.value;
    }
    reply(id, configuration(params.sessionId));
  }
  if (method === 'session/prompt') {
    const text = params.prompt[0].text;
    const history = sessions.get(params.sessionId);
    history.push(text);
    log({ type: 'prompt', text, sessionId: params.sessionId, selection: selections.get(params.sessionId) });
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
    const chunks = text === 'large' ? ['보존된 출력', 'x'.repeat(17_000)] : [`답변 ${history.length}: `, text === 'recall-first' ? history[0] : text];
    let index = 0;
    const timer = setInterval(() => {
      if (index < chunks.length) send({ method: 'session/update', params: { sessionId: params.sessionId, update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunks[index++] },
      } } });
      else {
        clearInterval(timer); tasks.delete(params.sessionId); writeFileSync(sessionFile(params.sessionId), JSON.stringify(history));
        if (process.env.TEST_AGENT_MODEL === 'drift') selections.set(params.sessionId, { model: 'gpt-5.6-sol', effort: 'high' });
        reply(id, { stopReason: 'end_turn' });
      }
    }, 40);
    tasks.set(params.sessionId, { id, timer });
  }
  if (method === 'session/cancel') {
    log({ type: 'cancel' });
    const task = tasks.get(params.sessionId);
    if (task) { clearInterval(task.timer); tasks.delete(params.sessionId); reply(task.id, { stopReason: 'cancelled' }); }
  }
});
