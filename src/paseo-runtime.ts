import { DaemonClient, type DaemonEvent, type CreateAgentRequestOptions, type WebSocketLike } from '@getpaseo/client/internal/daemon-client';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { prepareDataDirectory, assertUnlinkedFile, resolveWorkspaceDirectory } from './paths.js';
import { launchOwnedProcess, deadline } from './owned-process.js';
import { CODEX_OPTIONS, TEST_SELECTION, type RuntimeInit } from './paseo-config.js';

export type RuntimeOptions = { projectRoot: string; dataDir: string; workspace: string; codexPath: string; authFile?: string; testMode?: boolean };

export function privateRuntimeEnvironment(init: Pick<RuntimeInit, 'paseoHome' | 'codexHome'>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'SystemDrive', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    const actual = Object.keys(process.env).find(key => key.toLowerCase() === name.toLowerCase());
    if (actual) env[name] = process.env[actual];
  }
  return { ...env, PASEO_HOME: init.paseoHome, CODEX_HOME: init.codexHome, PASEO_NODE_ENV: 'production' };
}

function rejectLinkedTree(directory: string) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry), stat = lstatSync(path);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('Runtime data cannot contain links.');
    if (stat.isDirectory()) rejectLinkedTree(path);
  }
}

function prepareRuntime(options: RuntimeOptions) {
  const directory = prepareDataDirectory(options.projectRoot, options.dataDir);
  const workspace = resolveWorkspaceDirectory(options.projectRoot, options.workspace).path;
  const marker = join(directory, 'worknaru-format.json');
  rejectLinkedTree(directory);
  if (!existsSync(marker)) {
    if (readdirSync(directory).length) throw new Error('Use a new empty data directory for Paseo v1. Legacy data is not opened.');
    writeFileSync(marker, JSON.stringify({ format: 'worknaru-paseo-v1', workspace }), { flag: 'wx', mode: 0o600 });
  } else {
    const value = JSON.parse(readFileSync(marker, 'utf8'));
    if (value.format !== 'worknaru-paseo-v1' || value.workspace !== workspace) throw new Error('This data directory belongs to another format or Workspace.');
  }
  const lockPath = join(directory, 'runtime-owner.json');
  if (existsSync(lockPath)) {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Invalid runtime ownership record.');
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error; }
    if (alive) throw new Error('This data directory already has a runtime owner.');
    // The Windows job watches the original owner handle; stale PIDs are never killed.
    unlinkSync(lockPath);
  }
  closeSync(openSync(lockPath, 'wx', 0o600));
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
  try {
    const paseoHome = prepareDataDirectory(options.projectRoot, join(directory, 'paseo'));
    const codexHome = prepareDataDirectory(options.projectRoot, join(directory, 'codex'));
    assertUnlinkedFile(options.codexPath, 'Specify an existing Codex executable.');
    const authFile = options.authFile ?? join(homedir(), '.codex', 'auth.json');
    if (existsSync(authFile)) {
      assertUnlinkedFile(authFile, 'Codex authentication must be a regular file.');
      copyFileSync(authFile, join(codexHome, 'auth.json'));
    }
    // Authentication is the only copied personal material. Native defaults are explicit.
    writeFileSync(join(codexHome, 'config.toml'), `model = "${TEST_SELECTION.model}"\nmodel_reasoning_effort = "${TEST_SELECTION.effort}"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nweb_search = "disabled"\n[features]\nmulti_agent_v2 = false\n[sandbox_workspace_write]\nnetwork_access = false\n`);
    return { directory, workspace, paseoHome, codexHome, release: () => unlinkSync(lockPath) };
  } catch (error) { unlinkSync(lockPath); throw error; }
}

export class PaseoRuntime {
  private constructor(private client: DaemonClient, private owner: Awaited<ReturnType<typeof launchOwnedProcess>>,
    private data: ReturnType<typeof prepareRuntime>, private testMode: boolean, readonly pid: number,
    private stoppedSignal: Promise<boolean>, private stopLines: () => void) {}
  get directory() { return this.data.directory; }
  get workspace() { return this.data.workspace; }
  get connected() { return this.client.isConnected; }
  get exited() { return this.owner.exited; }

  static async start(options: RuntimeOptions) {
    const data = prepareRuntime(options);
    let owner: Awaited<ReturnType<typeof launchOwnedProcess>> | undefined;
    let client: DaemonClient | undefined;
    try {
      const init: RuntimeInit = { paseoHome: data.paseoHome, codexHome: data.codexHome, codexPath: options.codexPath,
        password: randomBytes(32).toString('base64url') };
      owner = await launchOwnedProcess({ executable: process.execPath,
        args: [fileURLToPath(new URL('./paseo-child.js', import.meta.url))], cwd: data.workspace, env: privateRuntimeEnvironment(init) });
      const lines = createInterface({ input: owner.child.stdout });
      const stoppedSignal = new Promise<boolean>(resolve => lines.on('line', line => {
        if (line === 'WORKNARU_PASEO_STOPPED') resolve(true);
        if (line === 'WORKNARU_PASEO_STOP_FAILED') resolve(false);
      }));
      const ready = new Promise<{ port: number; pid: number }>((resolve, reject) => {
        lines.on('line', line => {
          if (line.startsWith('WORKNARU_PASEO_READY ')) {
            try { resolve(JSON.parse(line.slice('WORKNARU_PASEO_READY '.length))); } catch (error) { reject(error); }
          }
          if (line.startsWith('WORKNARU_PASEO_FAILED ')) reject(new Error(line));
        });
        void owner!.exited.then(() => reject(new Error('Private Paseo exited.')));
      });
      owner.child.stdin.write(`${JSON.stringify(init)}\n`);
      const address = await deadline(ready, 45_000, 'Private Paseo startup timed out.');
      client = new DaemonClient({ url: `ws://127.0.0.1:${address.port}/ws`, password: init.password,
        clientId: 'worknaru', clientType: 'cli', appVersion: 'worknaru-paseo-v1',
        // ws uses narrower listener overloads than the SDK's cross-platform structural type.
        webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers }) as unknown as WebSocketLike,
        reconnect: { enabled: true },
      });
      await deadline(client.connect(), 20_000, 'Private Paseo connection timed out.').catch(error => {
        throw new Error(`${(error as Error).message} ${client?.lastError ?? ''}`);
      });
      return new PaseoRuntime(client, owner, data, options.testMode === true, address.pid, stoppedSignal, () => lines.close());
    } catch (error) { await client?.close(); await owner?.stop(); data.release(); throw error; }
  }
  subscribe(listener: (event: DaemonEvent) => void) { return this.client.subscribe(listener); }
  connection(listener: () => void) { return this.client.subscribeConnectionStatus(listener); }
  async catalog() { return this.client.listProviderModels('codex', { cwd: this.workspace }); }
  async inspect(agentId: string) { return this.client.fetchAgent(agentId); }
  async history(agentId: string, options?: Parameters<DaemonClient['fetchAgentTimeline']>[1]) { return this.client.fetchAgentTimeline(agentId, options); }
  async watch(agentIds: string[]) { await this.client.setAgentTimelineSubscription(agentIds); }
  async create(id: string, title: string, selection: { model: string; effort: string }) {
    await this.checkSelection(selection);
    const config: CreateAgentRequestOptions = { provider: 'codex', cwd: this.workspace, title,
      model: selection.model, thinkingOptionId: selection.effort, providerOptions: CODEX_OPTIONS,
      mcpServers: {}, idempotencyKey: id };
    return this.client.createAgent(config);
  }
  async configure(agentId: string, selection: { model: string; effort: string }) {
    await this.checkSelection(selection);
    await this.client.setAgentModel(agentId, selection.model);
    await this.client.setAgentThinkingOption(agentId, selection.effort);
    await this.confirmSelection(agentId, selection);
  }
  async checkSelection(selection: { model: string; effort: string }) {
    if (this.testMode && (selection.model !== TEST_SELECTION.model || selection.effort !== TEST_SELECTION.effort)) throw new Error('TEST_MODEL_REQUIRED');
    const catalog = await this.catalog();
    const model = catalog.models?.find(model => model.id === selection.model && model.isSelectable !== false);
    if (!model?.thinkingOptions?.some(option => option.id === selection.effort)) throw new Error('MODEL_UNSUPPORTED');
  }
  async confirmSelection(agentId: string, selection: { model: string; effort: string }) {
    await this.checkSelection(selection);
    const state = await this.inspect(agentId);
    if (!state || state.agent.runtimeInfo?.model !== selection.model ||
      state.agent.effectiveThinkingOptionId !== selection.effort) throw new Error('MODEL_UNCONFIRMED');
  }
  async send(agentId: string, text: string, messageId: string, selection: { model: string; effort: string }) {
    await this.confirmSelection(agentId, selection); // Every prompt, including follow-ups and tests, fails closed.
    const state = await this.inspect(agentId);
    if (!state || state.agent.status !== 'idle' || state.agent.activeTurn || state.agent.pendingPermissions.length) throw new Error('CHAT_BUSY');
    // Paseo only offers interrupt/steer. WorkNaru's admission gate prevents an active-turn call.
    await this.client.sendMessage(agentId, text, { messageId });
  }
  async cancel(agentId: string) { await this.client.cancelAgent(agentId); }
  async permission(agentId: string, permissionId: string, behavior: 'allow' | 'deny') {
    return this.client.respondToPermissionAndWait(agentId, permissionId, { behavior });
  }
  private stopping?: Promise<void>;
  stop() {
    return this.stopping ??= (async () => {
      await this.client.close();
      this.owner.child.stdin.write('stop\n');
      // Graceful native shutdown first; the job is the final descendant cleanup fence.
      const graceful = await deadline(this.stoppedSignal, 20_000, 'Paseo stop timed out.').catch(() => false);
      await this.owner.stop();
      this.stopLines(); this.data.release();
      if (!graceful) throw new Error('Paseo graceful shutdown failed; owned processes were terminated.');
    })();
  }
}
