import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Readable, Transform, Writable } from 'node:stream';
import { z } from 'zod';
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { ClientConnection } from '@agentclientprotocol/sdk';
import { AppError, publicError } from './protocol.js';
import { prepareDataDirectory } from './paths.js';
import { isFinal, RecordStore } from './store.js';
import type { Run } from './store.js';
import { launchAgentJob, stopAgentJob, withTimeout } from './agent-process.js';
import type { AgentCommand } from './agent-process.js';
import { inspectCodex } from './codex-info.js';
import type { AiInfo, AiSelection } from './ai-settings.js';
import { FileTools } from './file-tools.js';

type ModelConfiguration = { selection: AiSelection; models: string[]; efforts: string[] };
type Agent = { process: Awaited<ReturnType<typeof launchAgentJob>>; connection: ClientConnection; providerId: string; activeRun?: string; configuration: ModelConfiguration; fileCalls: Set<string> };
export type AcpOptions = { codexPath?: string; command?: AgentCommand; requiredSelection?: AiSelection };

function modelConfiguration(response: unknown): ModelConfiguration {
  const result = z.object({ configOptions: z.array(z.object({ id: z.string() }).passthrough()) }).safeParse(response);
  const option = z.object({ currentValue: z.string(), options: z.array(z.object({ value: z.string() })) });
  const model = option.safeParse(result.success ? result.data.configOptions.find((item) => item.id === 'model') : undefined);
  const effort = option.safeParse(result.success ? result.data.configOptions.find((item) => item.id === 'reasoning_effort') : undefined);
  if (!model.success || !effort.success) throw new AppError('MODEL_UNCONFIRMED', '적용 모델을 확인하지 못해 질문을 보내지 않았습니다.');
  return { selection: { model: model.data.currentValue, reasoningEffort: effort.data.currentValue }, models: model.data.options.map((item) => item.value), efforts: effort.data.options.map((item) => item.value) };
}

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
      developer_instructions: 'Use text for conversation. For user-requested Workspace file work, use ONLY worknaru_files read_text_file and edit_text_file. Read the file, then propose the complete before and after text. The tool waits for the user to approve before applying. Respect rejection and cancellation. Never use native apply_patch, commands, other tools, apps, plugins, or delegation. Do not claim a file was changed unless the file tool reports completed.',
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
  private readonly infoAbort = new AbortController();
  private info?: AiInfo;
  private inspecting?: Promise<AiInfo>;
  private requiredSelection?: AiSelection;
  private readonly fileTools: FileTools;

  constructor(private store: RecordStore, projectRoot: string, directory: string, options: AcpOptions, private changed: (run: Run) => void) {
    this.command = options.command ?? codexCommand(projectRoot, directory, store.workspace.path, options.codexPath);
    this.requiredSelection = options.requiredSelection;
    this.fileTools = new FileTools(store, directory, changed);
  }

  async recover() {
    const probe = this.store.probeJob();
    if (probe) {
      if (!await stopAgentJob(probe, this.command.env)) throw new AppError('PROCESS_CLEANUP_UNKNOWN', 'AI 상태 조회 프로세스 정리를 확인하지 못했습니다.');
      this.store.setProbeJob(null);
    }
    for (const session of this.store.recoverySessions()) {
      const confirmed = await stopAgentJob(session.jobName, this.command.env);
      this.store.recoverSession(session.sessionId, confirmed);
    }
    this.store.recoverUndelivered();
    this.store.recoverFiles();
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
  respondPermission(runId: string, toolId: string) {
    try { this.fileTools.respond(runId, toolId); }
    catch (error) { void this.fail(runId, publicError(error).code); }
  }

  metadata(): Promise<AiInfo> {
    if (this.stopping) return Promise.reject(new AppError('DAEMON_STOPPING', '데몬을 종료하고 있습니다.'));
    if (this.inspecting) return this.inspecting;
    if (this.info && Date.now() - Date.parse(this.info.checkedAt) < 30_000) return Promise.resolve(this.info);
    const operation = inspectCodex(this.command, this.store, this.infoAbort.signal).then((info) => { this.info = info; return info; });
    this.inspecting = operation;
    void operation.finally(() => { this.inspecting = undefined; }).catch(() => {});
    return operation;
  }

  validateSelection = (selection: AiSelection) => {
    if (!this.info) throw new AppError('AI_CATALOG_REQUIRED', 'AI 모델 목록을 먼저 확인하세요.');
    if (!this.info.models.some((model) => model.id === selection.model && model.efforts.includes(selection.reasoningEffort)))
      throw new AppError('MODEL_UNSUPPORTED', '지원하는 모델과 추론 강도를 선택하세요.');
    this.checkRequired(selection);
  };

  private checkRequired(selection: AiSelection) {
    if (this.requiredSelection && (selection.model !== this.requiredSelection.model || selection.reasoningEffort !== this.requiredSelection.reasoningEffort))
      throw new AppError('TEST_MODEL_REQUIRED', '실제 검증에 허용된 모델과 추론 강도만 사용할 수 있습니다.');
  }

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
    const binding = this.store.binding(sessionId);
    const selection = this.store.selection(sessionId);
    this.checkRequired(selection);
    if (binding.unavailable) throw new AppError('SESSION_UNAVAILABLE', 'AI 대화를 다시 연결할 수 없습니다. 새 대화를 시작하세요.');
    const jobName = `Local\\WorkNaru-${randomUUID()}`;
    // Keep the provider identity durable even if startup/resume is interrupted.
    this.store.setAgent(sessionId, jobName, binding.providerSessionId);
    const config = JSON.parse(this.command.env.CODEX_CONFIG ?? '{}') as Record<string, unknown>;
    let agent: Agent | undefined;
    const fileServer = await this.fileTools.bind(sessionId, () => agent?.activeRun);
    const command = { ...this.command, env: { ...this.command.env, CODEX_CONFIG: JSON.stringify({ ...config, model: selection.model, model_reasoning_effort: selection.reasoningEffort,
      // ACP's standard MCP descriptor cannot carry the Codex timeout/approval settings.
      // Keep this configuration local to the conversation; metadata has no file tools.
      mcp_servers: { worknaru_files: { command: fileServer.command, args: fileServer.args, env: Object.fromEntries(fileServer.env.map(({ name, value }) => [name, value])), tool_timeout_sec: 360,
        tools: { read_text_file: { approval_mode: 'approve' }, edit_text_file: { approval_mode: 'approve' } } } },
    }) } };
    const process = await launchAgentJob(jobName, command, signal).catch((error) => { this.fileTools.unbind(sessionId); throw error; });
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
        // session/load may replay history. It is not output from a new Run.
        if (!agent?.activeRun || params.sessionId !== agent.providerId) return;
        const update = params.update;
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          // The dedicated MCP tool owns its durable preview, approval and file result.
          // ACP also emits presentation events; never interpret those as permission.
          if (update.rawInput && typeof update.rawInput === 'object' && 'server' in update.rawInput && update.rawInput.server === 'worknaru_files') { agent.fileCalls.add(update.toolCallId); return; }
          if (agent.fileCalls.has(update.toolCallId) && !update.rawInput) return;
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
      this.fileTools.unbind(sessionId);
      if (agent?.activeRun) { try { this.fileTools.cancel(agent.activeRun); } catch {} }
      this.agents.delete(sessionId);
      try { this.store.disconnectAgent(sessionId); } catch { /* Storage failure already blocks new writes. */ }
    });
    try {
      const initialized = await withTimeout(connection.agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'worknaru', version: '0.0.0' } }), 30_000);
      if (initialized.protocolVersion !== PROTOCOL_VERSION) throw new AppError('ACP_VERSION_MISMATCH', '에이전트 ACP 버전을 사용할 수 없습니다.');
      let providerId = binding.providerSessionId;
      let configuration: ModelConfiguration;
      const params = { cwd: this.store.workspace.path, mcpServers: [] };
      if (providerId) {
        const capabilities = initialized.agentCapabilities;
        const method = capabilities?.sessionCapabilities?.resume ? 'session/resume' : capabilities?.loadSession ? 'session/load' : undefined;
        if (!method) throw new AppError('SESSION_RESUME_UNSUPPORTED', '연결한 에이전트는 기존 대화 재개를 지원하지 않습니다.');
        try {
          const session = await withTimeout(connection.agent.request(method, { ...params, sessionId: providerId }), 30_000, 'SESSION_RESUME_TIMEOUT');
          configuration = modelConfiguration(session);
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError('SESSION_RESUME_FAILED', '기존 AI 대화를 불러오지 못했습니다. 저장된 기록은 유지됩니다.');
        }
      } else {
        const session = await withTimeout(connection.agent.request('session/new', params), 30_000);
        providerId = z.object({ sessionId: z.string() }).parse(session).sessionId;
        configuration = modelConfiguration(session);
      }
      signal.throwIfAborted();
      this.store.setAgent(sessionId, jobName, providerId);
      agent = { process, connection, providerId, configuration, fileCalls: new Set() };
      this.agents.set(sessionId, agent);
      return agent;
    } catch (error) {
      this.fileTools.unbind(sessionId);
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
      const selection = this.store.selection(run.sessionId);
      this.checkRequired(selection);
      if (!agent.configuration.models.includes(selection.model)) throw new AppError('MODEL_UNSUPPORTED', '선택한 모델을 제공자가 지원하지 않습니다.');
      // Re-confirm every prompt, including unchanged selections on an existing connection.
      agent.configuration = modelConfiguration(await withTimeout(agent.connection.agent.request('session/set_config_option', { sessionId: agent.providerId, configId: 'model', value: selection.model }), 30_000));
      if (!agent.configuration.efforts.includes(selection.reasoningEffort)) throw new AppError('MODEL_UNSUPPORTED', '선택한 추론 강도를 제공자가 지원하지 않습니다.');
      agent.configuration = modelConfiguration(await withTimeout(agent.connection.agent.request('session/set_config_option', { sessionId: agent.providerId, configId: 'reasoning_effort', value: selection.reasoningEffort }), 30_000));
      if (agent.configuration.selection.model !== selection.model || agent.configuration.selection.reasoningEffort !== selection.reasoningEffort)
        throw new AppError('MODEL_UNCONFIRMED', '적용 모델을 확인하지 못해 질문을 보내지 않았습니다.');
      run = this.store.run(runId);
      if (run.state !== 'running' || this.stopping) { await this.cancel(runId); return; }
      const text = this.store.claimRun(runId);
      if (text === null) return;
      agent.activeRun = runId;
      agent.fileCalls.clear();
      this.emit(runId);
      const response = await this.promptTimeout(runId, agent.connection.agent.request('session/prompt', {
        sessionId: agent.providerId, prompt: [{ type: 'text', text }],
      }));
      if (this.cancellations.has(runId)) { await this.cancellations.get(runId); return; }
      if (this.fileTools.waiting(runId)) throw new AppError('TOOL_INCOMPLETE', '파일 승인 요청이 끝나기 전에 에이전트 응답이 종료되었습니다.');
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
    this.fileTools.unbind(sessionId);
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
        this.fileTools.cancel(runId);
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
      this.fileTools.cancel(runId);
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
    this.infoAbort.abort();
    await this.inspecting?.catch(() => {});
    const runs = [...this.work.keys()];
    let confirmed = true;
    await Promise.all(runs.map((id) => this.cancel(id).catch(() => { confirmed = false; })));
    await Promise.allSettled([...this.work.values()]);
    for (const [sessionId] of this.agents) {
      if (!await this.stopSession(sessionId).catch(() => false)) confirmed = false;
    }
    // A cancelled Run or a metadata probe may retain an unconfirmed owned Job.
    await this.fileTools.close();
    return confirmed && !this.store.probeJob() && this.store.activeRunCount() === 0;
  }

  private async promptTimeout<T>(runId: string, promise: Promise<T>): Promise<T> {
    let activeMs = 0;
    let last = Date.now();
    let timer: ReturnType<typeof setInterval>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setInterval(() => {
        const now = Date.now();
        if (!this.fileTools.waiting(runId)) activeMs += now - last;
        last = now;
        if (activeMs >= 120_000) reject(new AppError('AGENT_TIMEOUT', 'AI 응답 대기 시간이 지났습니다.'));
      }, 250);
    });
    try { return await Promise.race([promise, deadline]); } finally { clearInterval(timer!); }
  }
}
