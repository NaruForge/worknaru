import { z } from 'zod';
import { ClientError, WebClient } from './web-client.js';
import type { Message, Ready, Run, Session, Workspace } from './web-client.js';
import { aiSelectionSchema } from './ai-settings.js';
import type { AiInfo, AiSelection, AiSettings } from './ai-settings.js';

const pendingSchema = z.object({
  method: z.enum(['sessions.create', 'runs.start', 'runs.cancel', 'settings.update', 'sessions.configure', 'permissions.respond']),
  requestId: z.uuid(), storeEpoch: z.uuid(), workspaceId: z.uuid(),
  sessionId: z.uuid().optional(), text: z.string().optional(),
  selection: aiSelectionSchema.optional(),
  runId: z.uuid().optional(), toolId: z.uuid().optional(),
});
type Pending = z.infer<typeof pendingSchema>;
type Page = { messages: Message[]; upTo: number; nextAfter: number | null };
export type ChatState = {
  connection: 'offline' | 'connecting' | 'online'; endpoint: string; ready?: Ready; workspace?: Workspace;
  sessions: Session[]; nextSession: number | null; selected?: string;
  pages: Record<string, Page>; runs: Record<string, Run>; drafts: Record<string, string>;
  loading: boolean; busy: boolean; pending?: Pending; error?: string;
  settings?: AiSettings; settingsLoading?: boolean; settingsError?: string; aiInfo?: AiInfo; aiLoading?: boolean; aiError?: string;
};
const final = (run: Run) => ['completed', 'failed', 'cancelled'].includes(run.state);
const errorText = (error: unknown) => error instanceof Error ? error.message : '요청을 확인할 수 없습니다.';

// Chat owns its drafts and navigation. Platform records remain on the daemon.
export class ChatStateStore {
  private state: ChatState = { connection: 'offline', endpoint: '', sessions: [], nextSession: null, pages: {}, runs: {}, drafts: {}, loading: false, busy: false };
  private listeners = new Set<() => void>();
  private generation = 0;
  private selection = 0;
  private poll?: ReturnType<typeof setTimeout>;
  private journalKey = '';
  private watched?: string;
  private lastListRefresh = 0;
  constructor(readonly client: WebClient, private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
    client.onRun = (run) => this.receiveRun(run);
    client.onDisconnect = (error) => {
      clearTimeout(this.poll);
      this.update({ connection: 'offline', busy: false, loading: false, error: error.message });
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(values: Partial<ChatState>) { this.state = { ...this.state, ...values }; for (const listener of this.listeners) listener(); }
  setDraft(text: string) { if (this.state.selected) this.update({ drafts: { ...this.state.drafts, [this.state.selected]: text } }); }
  clearError() { this.update({ error: undefined }); }

  async connect(endpoint: string, token: string) {
    if (this.state.connection === 'connecting') return;
    const generation = ++this.generation;
    ++this.selection;
    clearTimeout(this.poll);
    this.watched = undefined;
    this.update({ connection: 'connecting', busy: false, loading: false, error: undefined, aiInfo: undefined, settings: undefined, settingsLoading: false, settingsError: undefined, aiLoading: false, aiError: undefined });
    try {
      const ready = await this.client.connect(endpoint, token);
      const workspace = await this.client.call('workspaces.get', {});
      if (generation !== this.generation) return;
      const same = endpoint === this.state.endpoint && workspace.workspaceId === this.state.workspace?.workspaceId && ready.storeEpoch === this.state.ready?.storeEpoch;
      this.journalKey = `worknaru.pending.v1:${endpoint}:${workspace.workspaceId}`;
      let pending: Pending | undefined;
      const journal = this.storage.getItem(this.journalKey);
      if (journal) pending = pendingSchema.parse(JSON.parse(journal));
      this.update({ endpoint, ready, workspace, connection: 'online', pending,
        ...(same ? {} : { sessions: [], nextSession: null, selected: undefined, pages: {}, runs: {}, drafts: {} }),
      });
      await this.list();
      if (!this.state.selected && this.state.sessions[0]) this.update({ selected: this.state.sessions[0].sessionId });
      if (this.state.selected) await this.select(this.state.selected);
      if (pending) await this.resolvePending();
      if (ready.capabilities.includes('settings.get')) await this.readSettings();
      if (generation !== this.generation) return;
      if (ready.capabilities.includes('ai.get')) void this.refreshAi();
      this.schedule();
    } catch (error) {
      if (generation !== this.generation) return;
      this.client.close();
      this.update({ connection: 'offline', error: errorText(error), loading: false });
    }
  }

  private async list(after = 0) {
    const generation = this.generation;
    const workspace = this.state.workspace;
    if (!workspace) return;
    const page = await this.client.call('sessions.list', { workspaceId: workspace.workspaceId, after, limit: 50, order: 'desc' });
    if (generation !== this.generation) return;
    const sessions = new Map(this.state.sessions.map((session) => [session.sessionId, session]));
    for (const session of page.sessions) sessions.set(session.sessionId, session);
    this.update({ sessions: [...sessions.values()].sort((a, b) => b.seq - a.seq), nextSession: after === 0 && this.state.sessions.length > 50 ? this.state.nextSession : page.nextAfter });
    this.lastListRefresh = Date.now();
  }
  async moreSessions() { try { if (this.state.nextSession !== null) await this.list(this.state.nextSession); } catch (error) { this.update({ error: errorText(error) }); } }

  async select(sessionId: string) {
    const version = ++this.selection;
    this.update({ selected: sessionId, loading: !this.state.pages[sessionId], error: undefined });
    if (this.state.connection !== 'online') { this.update({ loading: false }); return; }
    try {
      await this.refreshSession(sessionId);
      const page = await this.client.call('messages.list', { sessionId, limit: 50 });
      if (version !== this.selection) return;
      this.update({ pages: { ...this.state.pages, [sessionId]: page }, loading: false });
      await this.loadRunHistory(page);
    } catch (error) { if (version === this.selection) this.update({ loading: false, error: errorText(error) }); }
  }
  async moreMessages() {
    const sessionId = this.state.selected;
    if (!sessionId || this.state.loading) return;
    const previous = this.state.pages[sessionId];
    if (!previous || previous.nextAfter === null) return;
    const version = this.selection;
    this.update({ loading: true });
    try {
      const page = await this.client.call('messages.list', { sessionId, after: previous.nextAfter, upTo: previous.upTo, limit: 50 });
      if (version !== this.selection) return;
      this.update({ pages: { ...this.state.pages, [sessionId]: { ...page, messages: [...previous.messages, ...page.messages] } } });
      await this.loadRunHistory(page);
    } catch (error) { if (version === this.selection) this.update({ error: errorText(error) }); }
    finally { if (version === this.selection) this.update({ loading: false }); }
  }

  private async loadRunHistory(page: Page) {
    const generation = this.generation;
    for (const message of page.messages) {
      if (message.role !== 'assistant' || !message.runId || this.state.runs[message.runId]) continue;
      const run = await this.client.call('runs.get', { runId: message.runId });
      if (generation !== this.generation) return;
      this.receiveRun(run);
    }
  }
  private receiveRun(run: Run) {
    const previous = this.state.runs[run.runId];
    if (previous && run.revision < previous.revision) return;
    // A storage fault can arrive without a revision increment. Never invent persisted text.
    if (!run.storageAvailable) run = { ...run, text: previous?.text ?? '' };
    this.update({ runs: { ...this.state.runs, [run.runId]: run }, sessions: this.state.sessions.map((session) => session.latestRunId === run.runId ? { ...session, latestRunState: run.state } : session) });
  }
  private async refreshSession(sessionId: string) {
    const generation = this.generation;
    const version = this.selection;
    const session = await this.client.call('sessions.get', { sessionId });
    if (generation !== this.generation) return;
    this.update({ sessions: [...this.state.sessions.filter((item) => item.sessionId !== sessionId), session].sort((a, b) => b.seq - a.seq) });
    if (this.state.selected !== sessionId || version !== this.selection) return;
    const runId = session.latestRunId;
    // Another client may have advanced this session while it was not watched.
    // Reconcile unfinished historical snapshots before rendering them over stored messages.
    for (const previous of Object.values(this.state.runs)) {
      if (previous.sessionId !== sessionId || previous.runId === runId || (final(previous) && previous.storageAvailable)) continue;
      const historical = await this.client.call('runs.get', { runId: previous.runId });
      if (generation !== this.generation || version !== this.selection) return;
      this.receiveRun(historical);
    }
    if (this.watched && this.watched !== runId) {
      const previous = this.watched; this.watched = undefined;
      await this.client.call('runs.unwatch', { runId: previous });
    }
    if (runId) {
      const run = await this.client.call(this.watched === runId ? 'runs.get' : 'runs.watch', { runId });
      if (generation !== this.generation) return;
      if (version !== this.selection) { await this.client.call('runs.unwatch', { runId }); return; }
      this.watched = runId;
      this.receiveRun(run);
    }
  }
  private schedule() {
    clearTimeout(this.poll);
    if (this.state.connection !== 'online') return;
    const generation = this.generation;
    this.poll = setTimeout(async () => {
      try {
        if (this.state.selected) { await this.refreshSession(this.state.selected); await this.refreshTail(); }
        if (Date.now() - this.lastListRefresh > 5_000) await this.list();
        await this.refreshOtherRuns();
      } catch (error) { if (generation === this.generation) this.update({ error: errorText(error) }); }
      finally { if (generation === this.generation) this.schedule(); }
    }, 1_000);
  }
  private async refreshTail() {
    const sessionId = this.state.selected;
    const page = sessionId ? this.state.pages[sessionId] : undefined;
    if (!sessionId || !page || page.nextAfter !== null || this.state.loading) return;
    const version = this.selection;
    const tail = await this.client.call('messages.list', { sessionId, after: page.upTo, limit: 50 });
    if (version !== this.selection || this.state.pages[sessionId] !== page) return;
    if (tail.messages.length) this.update({ pages: { ...this.state.pages, [sessionId]: { ...tail, messages: [...page.messages, ...tail.messages] } } });
  }

  private savePending(pending?: Pending) {
    if (pending) this.storage.setItem(this.journalKey, JSON.stringify(pending));
    else this.storage.removeItem(this.journalKey);
    this.update({ pending });
  }
  private canMutate() { return this.state.connection === 'online' && !this.state.busy && !this.state.pending && this.state.ready && this.state.workspace; }
  private async readSettings() {
    const generation = this.generation;
    const settings = await this.client.call('settings.get', {});
    if (generation === this.generation) this.update({ settings, settingsError: undefined });
  }
  async refreshSettings() {
    if (!this.canMutate() || !this.state.ready?.capabilities.includes('settings.get') || this.state.settingsLoading) return;
    const generation = this.generation;
    this.update({ settingsLoading: true, settingsError: undefined });
    try { await this.readSettings(); }
    catch (error) { if (generation === this.generation) this.update({ settings: undefined, settingsError: errorText(error) }); }
    finally { if (generation === this.generation) this.update({ settingsLoading: false }); }
  }
  async refreshAi() {
    if (this.state.connection !== 'online' || !this.state.ready?.capabilities.includes('ai.get') || this.state.aiLoading) return;
    const generation = this.generation;
    this.update({ aiLoading: true, aiError: undefined });
    try {
      const info = await this.client.call('ai.get', {});
      if (generation === this.generation) this.update({ aiInfo: info });
    } catch (error) { if (generation === this.generation) this.update({ aiInfo: undefined, aiError: errorText(error) }); }
    finally { if (generation === this.generation) this.update({ aiLoading: false }); }
  }
  async configure(selection: AiSelection, sessionId?: string) {
    if (!this.canMutate() || !this.state.aiInfo || (!sessionId && (this.state.settingsLoading || !this.state.settings?.storageAvailable))) return;
    const pending: Pending = { method: sessionId ? 'sessions.configure' : 'settings.update', selection, sessionId,
      requestId: crypto.randomUUID(), storeEpoch: this.state.ready!.storeEpoch, workspaceId: this.state.workspace!.workspaceId };
    await this.mutate(pending, () => sessionId
      ? this.client.call('sessions.configure', { sessionId, selection }, pendingIdentity(pending))
      : this.client.call('settings.update', { selection }, pendingIdentity(pending)));
  }
  async createSession() {
    if (!this.canMutate()) return;
    const pending: Pending = { method: 'sessions.create', requestId: crypto.randomUUID(), storeEpoch: this.state.ready!.storeEpoch, workspaceId: this.state.workspace!.workspaceId };
    await this.mutate(pending, () => this.client.call('sessions.create', { workspaceId: pending.workspaceId, title: `새 대화 ${(this.state.sessions[0]?.seq ?? 0) + 1}` }, pendingIdentity(pending)));
  }
  async send() {
    const session = this.state.sessions.find((item) => item.sessionId === this.state.selected);
    if (!this.canMutate() || !session || !session.model || !session.reasoningEffort || session.aiUnavailable || !session.storageAvailable || !this.state.ready!.aiExecution) return;
    const run = session.latestRunId ? this.state.runs[session.latestRunId] : undefined;
    if (session.latestRunId && (!run || !final(run) || !run.storageAvailable || run.errorCode === 'PROCESS_CLEANUP_UNKNOWN')) return;
    const text = this.state.drafts[session.sessionId] ?? '';
    if (!text.trim()) return;
    if (!text.isWellFormed() || new TextEncoder().encode(text).byteLength > this.state.ready!.limits.maxTextBytes) { this.update({ error: '입력은 UTF-8 16KiB 이내로 줄여 주세요.' }); return; }
    const pending: Pending = { method: 'runs.start', sessionId: session.sessionId, text, requestId: crypto.randomUUID(), storeEpoch: this.state.ready!.storeEpoch, workspaceId: session.workspaceId };
    await this.mutate(pending, () => this.client.call('runs.start', { sessionId: session.sessionId, text }, pendingIdentity(pending)));
  }
  async cancel(runId?: string) {
    const session = this.state.sessions.find((item) => item.sessionId === this.state.selected);
    const run = runId ? this.state.runs[runId] : session?.latestRunId ? this.state.runs[session.latestRunId] : undefined;
    if (!this.canMutate() || !run || run.state !== 'running' || !run.storageAvailable) return;
    const pending: Pending = { method: 'runs.cancel', sessionId: run.sessionId, requestId: crypto.randomUUID(), storeEpoch: this.state.ready!.storeEpoch, workspaceId: this.state.workspace!.workspaceId };
    await this.mutate(pending, () => this.client.call('runs.cancel', { runId: run.runId }, pendingIdentity(pending)));
  }
  async respondPermission(runId: string, toolId: string, decision: 'allow' | 'reject') {
    if (!this.canMutate()) return;
    const run = this.state.runs[runId];
    if (!run?.storageAvailable || run.state !== 'running' || !run.tools.some((tool) => tool.toolId === toolId && tool.state === 'pending')) return;
    const pending: Pending = { method: 'permissions.respond', runId, toolId, sessionId: run.sessionId,
      requestId: crypto.randomUUID(), storeEpoch: this.state.ready!.storeEpoch, workspaceId: this.state.workspace!.workspaceId };
    await this.mutate(pending, () => this.client.call('permissions.respond', { runId, toolId, decision }, pendingIdentity(pending)));
    await this.check();
  }
  private async refreshOtherRuns() {
    const generation = this.generation;
    const ids = new Set([
      ...this.state.sessions.filter((session) => ['running', 'cancelling'].includes(session.latestRunState ?? '')).map((session) => session.latestRunId),
      ...Object.values(this.state.runs).filter((run) => !final(run)).map((run) => run.runId),
    ]);
    for (const runId of ids) {
      if (!runId || runId === this.watched) continue;
      const run = await this.client.call('runs.get', { runId });
      if (generation !== this.generation) return;
      this.receiveRun(run);
    }
  }
  private async applyReceipt(result: { session: Session } | { run: Run } | { settings: AiSettings }, pending: Pending) {
    if ('settings' in result) {
      await this.readSettings();
    } else if ('session' in result) {
      if (pending.method === 'sessions.configure') { await this.refreshSession(result.session.sessionId); return; }
      this.update({ sessions: [result.session, ...this.state.sessions.filter((session) => session.sessionId !== result.session.sessionId)] });
      await this.select(result.session.sessionId);
    } else {
      this.receiveRun(result.run);
      if (pending.method === 'permissions.respond') {
        const generation = this.generation;
        const current = await this.client.call('runs.get', { runId: result.run.runId });
        if (generation !== this.generation) return;
        this.receiveRun(current);
      }
      if (pending.method === 'runs.start' && pending.sessionId && this.state.drafts[pending.sessionId] === pending.text)
        this.update({ drafts: { ...this.state.drafts, [pending.sessionId]: '' } });
      await this.refreshSession(result.run.sessionId);
      await this.refreshTail();
    }
  }
  private async mutate(pending: Pending, call: () => Promise<{ session: Session } | { run: Run } | { settings: AiSettings }>) {
    const generation = this.generation;
    this.update({ busy: true, error: undefined });
    let sent = false;
    let accepted = false;
    try {
      this.savePending(pending);
      sent = true;
      const receipt = await call();
      if (generation !== this.generation) return;
      accepted = true;
      await this.applyReceipt(receipt, pending);
      if (generation !== this.generation) return;
      this.savePending();
    } catch (error) {
      if (generation !== this.generation) return;
      if (sent && !accepted && error instanceof ClientError && !['DISCONNECTED', 'TIMEOUT', 'STORE_UNAVAILABLE', 'STORE_EPOCH_MISMATCH', 'PROTOCOL_MISMATCH', 'UNAVAILABLE'].includes(error.code)) {
        try { this.savePending(); } catch { /* Keep the journal for explicit recovery. */ }
      }
      this.update({ error: sent ? errorText(error) : '이 탭의 접수 확인 정보를 보관할 수 없어 전송하지 않았습니다. 브라우저 저장 설정을 확인하세요.' });
    } finally { if (generation === this.generation) this.update({ busy: false }); }
  }
  async resolvePending() {
    const generation = this.generation;
    const pending = this.state.pending;
    if (!pending || this.state.connection !== 'online' || this.state.busy) return;
    this.update({ busy: true, error: undefined });
    try {
      const receipt = await this.client.call('requests.get', { workspaceId: pending.workspaceId, requestId: pending.requestId, storeEpoch: pending.storeEpoch });
      if (generation !== this.generation) return;
      if (receipt.found) await this.applyReceipt(receipt.result, pending);
      else {
        if (pending.sessionId && pending.text && !this.state.drafts[pending.sessionId]) this.update({ drafts: { ...this.state.drafts, [pending.sessionId]: pending.text } });
        this.update({ error: '이 요청의 접수 기록이 없습니다. 입력을 확인한 뒤 직접 전송할 수 있습니다.' });
      }
      if (generation === this.generation) this.savePending();
    } catch (error) { if (generation === this.generation) this.update({ error: errorText(error) }); }
    finally { if (generation === this.generation) this.update({ busy: false }); }
  }
  async check() {
    if (this.state.pending) await this.resolvePending();
    else if (this.state.selected) {
      try { this.clearError(); await this.refreshSession(this.state.selected); await this.refreshTail(); }
      catch (error) { this.update({ error: errorText(error) }); }
    }
  }
  close() { ++this.generation; ++this.selection; clearTimeout(this.poll); this.client.close(); this.update({ connection: 'offline', busy: false, loading: false }); }
}
const pendingIdentity = (pending: Pending) => ({ requestId: pending.requestId, storeEpoch: pending.storeEpoch });
