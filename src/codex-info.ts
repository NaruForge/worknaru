import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { launchAgentJob, stopAgentJob, withTimeout } from './agent-process.js';
import type { AgentCommand } from './agent-process.js';
import type { RecordStore } from './store.js';
import { AppError } from './protocol.js';
import type { AiInfo } from './ai-settings.js';

const configuration = z.object({ configOptions: z.array(z.object({ id: z.string() }).passthrough()) });
const choices = z.object({ currentValue: z.string(), options: z.array(z.object({ value: z.string(), name: z.string() })).max(100) });
function option(response: unknown, id: string) {
  return choices.parse(configuration.parse(response).configOptions.find((item) => item.id === id));
}

// ACP metadata only. A dedicated provider Session is reused; never send a prompt.
export async function inspectCodex(command: AgentCommand, store: RecordStore, signal: AbortSignal): Promise<AiInfo> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  const previous = store.probeJob();
  if (previous && !await stopAgentJob(previous, command.env)) throw new AppError('PROCESS_CLEANUP_UNKNOWN', '이전 AI 상태 조회의 종료를 확인하지 못했습니다.');
  store.setProbeJob(`Local\\WorkNaru-${randomUUID()}`);
  const process = await launchAgentJob(store.probeJob()!, command, signal);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  const unavailable = () => new AppError('AI_INFO_UNAVAILABLE', 'AI 모델 목록과 인증 상태를 확인하지 못했습니다. 다시 확인하세요.');
  const fail = () => { for (const item of pending.values()) item.reject(unavailable()); pending.clear(); };
  let buffer = '';
  let id = 0;
  process.child.stdout.setEncoding('utf8');
  process.child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 512 * 1024) { fail(); void process.stop(); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        const item = message.id === undefined ? undefined : pending.get(message.id);
        if (item) { pending.delete(message.id!); if (message.error) item.reject(unavailable()); else item.resolve(message.result); }
      } catch { fail(); void process.stop(); }
    }
  });
  void process.exited.then(fail);
  const request = (method: string, params: unknown) => {
    signal.throwIfAborted();
    return withTimeout(new Promise<unknown>((resolve, reject) => {
      const key = ++id;
      pending.set(key, { resolve, reject });
      process.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n');
    }), 15_000, 'AI_INFO_UNAVAILABLE');
  };
  const abort = () => { fail(); void process.stop(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const initialized = z.object({ protocolVersion: z.literal(1), agentCapabilities: z.object({
      loadSession: z.boolean().optional(), sessionCapabilities: z.object({ resume: z.unknown().optional(), close: z.unknown().optional() }).optional(),
    }).optional() }).parse(await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'worknaru-metadata', version: '0.0.0' } }));
    // codex-acp 1.10.0's read-only extension; strip account identifiers and all secrets.
    const account = z.object({ type: z.enum(['unauthenticated', 'api-key', 'chat-gpt', 'gateway']) }).parse(await request('authentication/status', {}));
    if (account.type === 'unauthenticated') return { models: [], authentication: 'signedOut', checkedAt: new Date().toISOString() };
    let sessionId = store.probeSession();
    let response: unknown;
    if (sessionId) {
      const method = initialized.agentCapabilities?.sessionCapabilities?.resume ? 'session/resume' : initialized.agentCapabilities?.loadSession ? 'session/load' : undefined;
      if (!method) throw unavailable();
      try { response = await request(method, { sessionId, cwd: command.cwd, mcpServers: [] }); }
      catch { store.setProbeSession(null); throw unavailable(); }
    } else {
      response = await request('session/new', { cwd: command.cwd, mcpServers: [] });
      sessionId = z.object({ sessionId: z.string() }).parse(response).sessionId;
      store.setProbeSession(sessionId);
    }
    const available = option(response, 'model').options;
    const models: AiInfo['models'] = [];
    for (const model of available) {
      response = await request('session/set_config_option', { sessionId, configId: 'model', value: model.value });
      if (option(response, 'model').currentValue !== model.value) throw unavailable();
      const effort = option(response, 'reasoning_effort');
      const efforts = effort.options.map((item) => item.value);
      if (efforts.length) models.push({ id: model.value, name: model.name, efforts, fallbackEffort: efforts.includes('low') ? 'low' : efforts[0]! });
    }
    if (initialized.agentCapabilities?.sessionCapabilities?.close) await request('session/close', { sessionId });
    return { models, authentication: account.type === 'chat-gpt' ? 'chatgpt' : account.type === 'api-key' ? 'apiKey' : 'other', checkedAt: new Date().toISOString() };
  } catch { throw unavailable(); }
  finally {
    signal.removeEventListener('abort', abort);
    fail();
    if (!await process.stop()) throw new AppError('PROCESS_CLEANUP_UNKNOWN', 'AI 상태 조회 프로세스의 종료를 확인하지 못했습니다.');
    store.setProbeJob(null);
  }
}
