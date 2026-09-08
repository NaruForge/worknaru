import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Readable, Transform, Writable } from 'node:stream';
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { ClientConnection } from '@agentclientprotocol/sdk';
import { AppError, publicError } from './protocol.js';
import { prepareDataDirectory } from './paths.js';
import { isFinal, RecordStore } from './store.js';
import type { Run } from './store.js';
import { launchAgentJob, stopAgentJob, withTimeout } from './agent-process.js';
import type { AgentCommand } from './agent-process.js';

type Agent = { process: Awaited<ReturnType<typeof launchAgentJob>>; connection: ClientConnection; providerId: string; activeRun?: string };
export type AcpOptions = { codexPath?: string; command?: AgentCommand };

// Only child process configuration; never change the host's environment or CLI home.
function codexCommand(projectRoot: string, directory: string, cwd: string, codexPath?: string): AgentCommand {
  const home = prepareDataDirectory(projectRoot, join(directory, 'codex'));
  const temp = prepareDataDirectory(projectRoot, join(directory, 'tmp'));
  const authSource = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  const authTarget = join(home, 'auth.json');
  try {
    const stat = lstatSync(authTarget);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new AppError('INVALID_DATA_PATH', '에이전트 인증 파일 경로가 올바르지 않습니다.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existsSync(authSource)) copyFileSync(authSource, authTarget);
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, { CODEX_HOME: home, TEMP: temp, TMP: temp, INITIAL_AGENT_MODE: 'read-only',
    // This adapter's "read-only" mode name actually selects its approval preset.
    // Do not treat that name as a filesystem security guarantee.
    CODEX_CONFIG: JSON.stringify({ approval_policy: 'on-request', web_search: 'disabled',
      developer_instructions: 'This is a text conversation. Answer using text only. Do not call tools, access files, execute commands, or delegate work.',
      features: { shell_tool: false, apps: false, plugins: false, multi_agent: false, browser_use: false, computer_use: false, skill_search: false, tool_suggest: false },
      tools: { view_image: false },
    }),
  });
  if (codexPath) env.CODEX_PATH = resolve(codexPath);
  return { executable: process.execPath, arguments: [createRequire(import.meta.url).resolve('@agentclientprotocol/codex-acp')], cwd, env };
}

export class AcpRuntime {
  private readonly agents = new Map<string, Agent>();
  private readonly opening = new Map<string, { promise: Promise<Agent>; abort: AbortController }>();
  private readonly work = new Map<string, Promise<void>>();
  private readonly cancellations = new Map<string, Promise<void>>();
  private stopping = false;
  private readonly command: AgentCommand;

  constructor(private store: RecordStore, projectRoot: string, directory: string, options: AcpOptions, private changed: (run: Run) => void) {
    this.command = options.command ?? codexCommand(projectRoot, directory, store.workspace.path, options.codexPath);
  }

  async recover() {
    for (const session of this.store.recoverySessions()) {
      const confirmed = await stopAgentJob(session.jobName, this.command.env);
      this.store.recoverSession(session.sessionId, confirmed);
    }
    this.store.recoverUndelivered();
  }

  start(runId: string) {
    if (this.stopping || this.work.has(runId)) return;
    const run = this.store.run(runId);
    if (isFinal(run) || run.delivery !== 'not_attempted') return;
    // Register before the first await. Retries never dispatch a second prompt.
    const operation = Promise.resolve().then(() => this.execute(runId));
    this.work.set(runId, operation);
    void operation.finally(() => this.work.delete(runId)).catch(() => {});
  }

  emit(runId: string) { this.changed(this.store.run(runId)); }

  private connect(sessionId: string): Promise<Agent> {
    const existing = this.agents.get(sessionId);
    if (existing && !existing.connection.signal.aborted) return Promise.resolve(existing);
    const pending = this.opening.get(sessionId);
    if (pending) return pending.promise;
    if (this.agents.size + this.opening.size >= 4) return Promise.reject(new AppError('AGENT_CAPACITY', '현재 데몬의 AI 대화 연결 한도에 도달했습니다.'));
    const abort = new AbortController();
    const promise = Promise.resolve().then(() => this.openAgent(sessionId, abort.signal));
    this.opening.set(sessionId, { promise, abort });
    void promise.finally(() => this.opening.delete(sessionId)).catch(() => {});
    return promise;
  }

  private async openAgent(sessionId: string, signal: AbortSignal): Promise<Agent> {
    signal.throwIfAborted();
    if (this.store.binding(sessionId).providerSessionId) throw new AppError('SESSION_UNAVAILABLE', 'AI 대화를 다시 연결할 수 없습니다. 새 대화를 시작하세요.');
    const jobName = `Local\\WorkNaru-${randomUUID()}`;
    this.store.setAgent(sessionId, jobName);
    const process = await launchAgentJob(jobName, this.command, signal);
    let agent: Agent | undefined;
    // Bound incomplete NDJSON frames before the SDK buffers/parses them.
    let frameBytes = 0;
    const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      for (const byte of chunk) {
        if (byte === 10) frameBytes = 0;
        else if (++frameBytes > 512 * 1024) { callback(new AppError('AGENT_PROTOCOL_ERROR', '에이전트 메시지 한도를 초과했습니다.')); return; }
      }
      callback(null, chunk);
    } });
    process.child.stdout.pipe(bounded);
    const connection = client({ name: 'worknaru' })
      .onRequest('session/request_permission', () => {
        if (agent?.activeRun) void this.fail(agent.activeRun, 'PERMISSION_UNSUPPORTED');
        return { outcome: { outcome: 'cancelled' as const } };
      })
      .onNotification('session/update', ({ params }) => {
        if (!agent?.activeRun || params.sessionId !== agent.providerId) return;
        const update = params.update;
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          void this.fail(agent.activeRun, 'TOOLS_UNSUPPORTED'); return;
        }
        if (update.sessionUpdate !== 'agent_message_chunk') return;
        if (update.content.type !== 'text') { void this.fail(agent.activeRun, 'CONTENT_UNSUPPORTED'); return; }
        try {
          const run = this.store.appendOutput(agent.activeRun, update.content.text);
          this.changed(run);
        } catch (error) { void this.fail(agent.activeRun, publicError(error).code); }
      }).connect(ndJsonStream(Writable.toWeb(process.child.stdin), Readable.toWeb(bounded) as unknown as ReadableStream<Uint8Array>));
    void process.exited.then(() => {
      connection.close();
      if (this.agents.get(sessionId)?.process !== process) return;
      this.agents.delete(sessionId);
      try { this.store.disconnectAgent(sessionId); } catch { /* Storage failure already blocks new writes. */ }
    });
    try {
      const initialized = await withTimeout(connection.agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'worknaru', version: '0.0.0' } }), 30_000);
      if (initialized.protocolVersion !== PROTOCOL_VERSION) throw new AppError('ACP_VERSION_MISMATCH', '에이전트 ACP 버전을 사용할 수 없습니다.');
      const session = await withTimeout(connection.agent.request('session/new', { cwd: this.store.workspace.path, mcpServers: [] }), 30_000);
      signal.throwIfAborted();
      this.store.setAgent(sessionId, jobName, session.sessionId);
      agent = { process, connection, providerId: session.sessionId };
      this.agents.set(sessionId, agent);
      return agent;
    } catch (error) {
      connection.close();
      await process.stop();
      throw error;
    }
  }

  private async execute(runId: string) {
    try {
      let run = this.store.run(runId);
      if (run.state === 'cancelling' || this.stopping) { await this.cancel(runId); return; }
      const agent = await this.connect(run.sessionId);
      run = this.store.run(runId);
      if (run.state !== 'running' || this.stopping) { await this.cancel(runId); return; }
      const text = this.store.claimRun(runId);
      if (text === null) return;
      agent.activeRun = runId;
      this.emit(runId);
      const response = await withTimeout(agent.connection.agent.request('session/prompt', {
        sessionId: agent.providerId, prompt: [{ type: 'text', text }],
      }), 120_000);
      if (this.cancellations.has(runId)) { await this.cancellations.get(runId); return; }
      const state = response.stopReason === 'end_turn' ? 'completed' : response.stopReason === 'cancelled' ? 'cancelled' : 'failed';
      this.changed(this.store.finishRun(runId, state, state === 'failed' ? 'AGENT_STOPPED' : null, response.stopReason));
    } catch (error) {
      await this.fail(runId, publicError(error).code === 'UNAVAILABLE' ? 'AGENT_ERROR' : publicError(error).code);
    } finally {
      const run = this.store.run(runId);
      const agent = this.agents.get(run.sessionId);
      if (agent?.activeRun === runId) agent.activeRun = undefined;
    }
  }

  private async stopSession(sessionId: string) {
    let storageError: unknown;
    try { this.store.disconnectAgent(sessionId); } catch (error) { storageError = error; }
    const opening = this.opening.get(sessionId);
    opening?.abort.abort();
    await opening?.promise.catch(() => {});
    const agent = this.agents.get(sessionId);
    let confirmed = true;
    if (agent) {
      agent.connection.close();
      confirmed = await agent.process.stop();
      this.agents.delete(sessionId);
    } else {
      const binding = this.store.binding(sessionId);
      if (binding.jobName) confirmed = await stopAgentJob(binding.jobName, this.command.env);
    }
    if (storageError) throw storageError;
    return confirmed;
  }

  private async fail(runId: string, code: string) {
    if (this.cancellations.has(runId)) return;
    const operation = (async () => {
      try {
        const run = this.store.run(runId);
        if (isFinal(run)) return;
        const confirmed = await this.stopSession(run.sessionId);
        if (confirmed) this.changed(this.store.finishRun(runId, 'failed', code));
        else this.changed(this.store.blockRun(runId));
      } catch { /* Storage failure keeps the last durable state; still terminate the owned job. */
        for (const opening of this.opening.values()) opening.abort.abort();
        for (const agent of this.agents.values()) { agent.connection.close(); await agent.process.stop(); }
      }
    })();
    this.cancellations.set(runId, operation);
    void operation.finally(() => this.cancellations.delete(runId)).catch(() => {});
    await operation;
  }

  cancel(runId: string): Promise<void> {
    const existing = this.cancellations.get(runId);
    if (existing) return existing;
    const operation = (async () => {
      const run = this.store.run(runId);
      if (isFinal(run)) return;
      const agent = this.agents.get(run.sessionId);
      if (agent?.activeRun === runId) {
        await withTimeout(agent.connection.agent.notify('session/cancel', { sessionId: agent.providerId }), 1_000).catch(() => {});
        // Cancellation is followed by tree cleanup; acknowledgement alone is insufficient.
      }
      const confirmed = await this.stopSession(run.sessionId);
      if (confirmed) this.changed(this.store.finishRun(runId, 'cancelled', null, 'client_cancelled'));
      else this.changed(this.store.blockRun(runId));
    })();
    this.cancellations.set(runId, operation);
    void operation.finally(() => this.cancellations.delete(runId)).catch(() => {});
    return operation;
  }

  async close() {
    this.stopping = true;
    const runs = [...this.work.keys()];
    await Promise.all(runs.map((id) => this.cancel(id).catch(() => {})));
    await Promise.allSettled([...this.work.values()]);
    for (const [sessionId] of this.agents) await this.stopSession(sessionId).catch(() => {});
  }
}
