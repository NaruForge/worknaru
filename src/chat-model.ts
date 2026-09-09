import { ChatConnection } from './chat-connection.js';
import type { Chat, ChatSettings, ChatView, ModelChoice, Selection, ServiceInfo, TimelinePage } from './chat-contract.js';

type LocalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type ModelState = { connected: boolean; info: ServiceInfo | null; models: ModelChoice[]; chats: Chat[];
  selectedId: string | null; view: ChatView | null; viewLoading: boolean; draft: string; newSelection: Selection;
  error: string | null; catalogError: string | null; refreshError: string | null; modelsLoading: boolean; checking: boolean;
  settings: ChatSettings | null; settingsBusy: boolean; settingsError: string | null; settingsNotice: string | null;
  busy: boolean; lastOutcome: string | null };
export class ChatModel {
  private state: ModelState = { connected: false, info: null, models: [], chats: [], selectedId: null, view: null, viewLoading: false,
    draft: '', newSelection: { model: 'gpt-5.6-luna', effort: 'low' }, error: null, catalogError: null, refreshError: null, modelsLoading: false, checking: false,
    settings: null, settingsBusy: false, settingsError: null, settingsNotice: null, busy: false, lastOutcome: null };
  private listeners = new Set<() => void>();
  private drafts = new Map<string | null, string>();
  private views = new Map<string, ChatView>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;
  private refreshCompletion: Promise<void> | undefined;
  private refreshAgain = false;
  private revision = 0;
  private connectionRevision = 0;
  private catalogRequest = 0;
  private selectionOverridden = false;
  private storeId: string | undefined;
  private stopped = false;
  private pendingInput: { chatId: string; messageId: string; text?: string } | null = null;
  private readonly key: string;
  constructor(private client: ChatConnection, private storage?: LocalStorage) {
    this.key = `worknaru.chat.v2:${client.url}`;
    try {
      const saved = JSON.parse(storage?.getItem(this.key) ?? 'null');
      if (saved && typeof saved.selectedId === 'string') { this.state.selectedId = saved.selectedId; this.state.viewLoading = true; }
      if (typeof saved?.storeId === 'string') this.storeId = saved.storeId;
      if (saved?.pendingInput && typeof saved.pendingInput.chatId === 'string' && typeof saved.pendingInput.messageId === 'string') this.pendingInput = saved.pendingInput;
    } catch {}
    client.connection(() => {
      this.revision++;
      this.connectionRevision++;
      this.catalogRequest++;
      if (client.connected && client.info) {
        if (this.storeId && this.storeId !== client.info.storeId) {
          this.drafts.clear(); this.views.clear(); this.pendingInput = null; this.selectionOverridden = false;
          this.update({ selectedId: null, view: null, chats: [], draft: '', settings: null, error: null, settingsError: null, lastOutcome: null });
        }
        this.storeId = client.info.storeId;
        try { this.save(); } catch (error) { this.update({ error: (error as Error).message }); }
      }
      this.update({ connected: client.connected, info: client.info, modelsLoading: false, checking: false, viewLoading: this.state.selectedId !== null });
      if (client.connected) void this.retry();
    });
    client.subscribe(event => {
      if (event.type === 'message.finished' && event.chatId === this.state.selectedId) this.update({ lastOutcome:
        event.outcome === 'completed' ? '응답 완료' : event.outcome === 'cancelled' ? '실행을 취소했습니다.' : event.error ?? '실행에 실패했습니다.' });
      this.scheduleRefresh();
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<ModelState>) { if (!this.stopped) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); } }
  private save() {
    try { this.storage?.setItem(this.key, JSON.stringify({ storeId: this.storeId, selectedId: this.state.selectedId,
      pendingInput: this.pendingInput ? { chatId: this.pendingInput.chatId, messageId: this.pendingInput.messageId } : null })); }
    catch { throw new Error('요청 식별자를 브라우저에 보관하지 못했습니다. 저장 공간을 확인하세요.'); }
  }
  async connect() { try { await this.client.connect(); } catch (error) { this.update({ refreshError: (error as Error).message }); } }
  async retry() {
    if (!this.client.connected) { await this.connect(); return; }
    if (this.state.checking) return;
    const connection = this.connectionRevision;
    this.update({ checking: true, viewLoading: this.state.selectedId !== null });
    try { await Promise.all([this.reloadModels(), this.refresh()]); }
    finally { if (connection === this.connectionRevision) this.update({ checking: false }); }
  }
  private async reloadModels() {
    if (!this.client.connected || this.state.modelsLoading) return;
    const request = ++this.catalogRequest, connection = this.connectionRevision;
    this.update({ modelsLoading: true });
    try {
      const models = await this.client.call('models.list', {});
      if (connection === this.connectionRevision && request === this.catalogRequest) this.update({ models, catalogError: null });
    } catch (error) {
      if (connection === this.connectionRevision && request === this.catalogRequest) this.update({ models: [], catalogError: (error as Error).message });
    } finally {
      if (connection === this.connectionRevision && request === this.catalogRequest) this.update({ modelsLoading: false });
    }
  }
  private scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.refresh(); }, 50);
  }
  async refresh() {
    if (!this.client.connected || this.stopped) return;
    if (this.refreshing) { this.refreshAgain = true; await this.refreshCompletion; return; }
    this.refreshing = true;
    let complete!: () => void;
    this.refreshCompletion = new Promise<void>(resolve => { complete = resolve; });
    const revision = this.revision, selectedId = this.state.selectedId;
    try {
      const infoRequest = this.client.call('runtime.get', {}).then(info => {
        if (revision === this.revision) {
          const runtimeReconnected = info.connected && !this.state.info?.connected;
          // Keep connection/storage facts visible even if settings or history retrieval fails.
          this.update({ info });
          if (runtimeReconnected) void this.reloadModels();
        }
        return info;
      });
      // Settings can be unavailable after a write failure while existing history remains readable.
      const settingsRequest = this.client.call('settings.get', {}).then(settings => ({ settings, error: null }))
        .catch(error => ({ settings: null, error: (error as Error).message }));
      const [info, chats, view, settingsResult] = await Promise.all([infoRequest, this.client.call('chats.list', {}),
        selectedId ? this.client.call('chats.get', { chatId: selectedId }) : Promise.resolve(null), settingsRequest]);
      if (revision !== this.revision || selectedId !== this.state.selectedId) return;
      let merged = view;
      if (view && this.state.view?.chat.id === view.chat.id && view.timeline.revision === this.state.view.timeline.revision) {
        const first = view.timeline.items[0]?.id;
        const previous = this.state.view.timeline.items;
        const overlap = first ? previous.findIndex(item => item.id === first) : -1;
        if (overlap > 0) merged = { ...view, timeline: { ...view.timeline, items: [...previous.slice(0, overlap), ...view.timeline.items],
          before: this.state.view.timeline.before, hasOlder: this.state.view.timeline.hasOlder } };
      }
      if (view && this.pendingInput?.chatId === view.chat.id && view.timeline.items.some(item => item.messageId === this.pendingInput!.messageId)) {
        if (this.pendingInput.text !== undefined && this.state.draft === this.pendingInput.text) this.setDraft('');
        this.pendingInput = null; this.save();
      }
      if (merged) this.views.set(merged.chat.id, merged);
      const settings = settingsResult.settings;
      const currentSettings = !settings || this.state.settings && this.state.settings.revision > settings.revision ? this.state.settings : settings;
      this.update({ info, chats, view: merged, viewLoading: false, settings: currentSettings, refreshError: settingsResult.error,
        ...(!this.selectionOverridden && currentSettings ? { newSelection: currentSettings.defaults } : {}) });
    } catch (error) {
      if (revision === this.revision && (error as { code?: string }).code === 'CHAT_NOT_FOUND') {
        this.select(null); this.refreshAgain = true;
      } else if (revision === this.revision) this.update({ refreshError: (error as Error).message });
    }
    finally {
      this.refreshing = false;
      this.refreshCompletion = undefined; complete();
      if (this.refreshAgain) { this.refreshAgain = false; this.scheduleRefresh(); }
    }
  }
  select(id: string | null) {
    if (id === this.state.selectedId) return;
    this.drafts.set(this.state.selectedId, this.state.draft);
    this.revision++;
    this.update({ selectedId: id, view: id ? this.views.get(id) ?? null : null, viewLoading: id !== null, draft: this.drafts.get(id) ?? '', error: null, lastOutcome: null });
    try { this.save(); } catch (error) { this.update({ error: (error as Error).message }); }
    void this.refresh();
  }
  setDraft(value: string) { this.drafts.set(this.state.selectedId, value); this.update({ draft: value }); }
  async configure(selection: Selection) {
    if (!this.state.selectedId) { this.selectionOverridden = true; this.update({ newSelection: selection }); return; }
    this.update({ busy: true, error: null });
    try { await this.client.call('chats.configure', { chatId: this.state.selectedId, selection }); }
    catch (error) { this.update({ error: (error as Error).message }); }
    finally { this.update({ busy: false }); await this.refresh(); }
  }
  async updateDefaults(defaults: Selection) {
    if (!this.state.settings || this.state.settingsBusy || this.state.modelsLoading || !this.client.connected) return;
    const connection = this.connectionRevision;
    const expectedRevision = this.state.settings.revision;
    this.update({ settingsBusy: true, settingsError: null, settingsNotice: null });
    try {
      const settings = await this.client.call('settings.update', { expectedRevision, defaults });
      if (connection === this.connectionRevision) this.update({
        settings: this.state.settings && this.state.settings.revision > settings.revision ? this.state.settings : settings,
        settingsNotice: '새 대화 기본값을 저장했습니다. 기존 대화의 설정은 유지됩니다.' });
    } catch (error) {
      if (connection === this.connectionRevision) this.update({ settingsError: (error as Error).message });
    } finally {
      this.update({ settingsBusy: false }); await this.refresh();
    }
  }
  async recover() {
    if (!this.state.selectedId) return;
    this.update({ busy: true, error: null });
    try { await this.client.call('chats.recover', { chatId: this.state.selectedId }); }
    catch (error) { this.update({ error: (error as Error).message }); }
    finally { this.update({ busy: false }); await this.refresh(); }
  }
  async send() {
    const text = this.state.draft.trim();
    if (!text || this.state.busy || !this.client.connected) return;
    const originalDraft = this.state.draft;
    this.update({ busy: true, error: null, lastOutcome: null });
    try {
      let chatId = this.state.selectedId;
      if (!chatId) {
        chatId = crypto.randomUUID();
        this.revision++;
        this.drafts.set(chatId, originalDraft);
        this.drafts.delete(null);
        this.selectionOverridden = false;
        this.update({ selectedId: chatId, view: null });
        this.save(); // Stable creation identity survives a lost response; no initial prompt in creation.
        await this.client.call('chats.create', { id: chatId, title: text.replace(/\s+/g, ' ').slice(0, 60), selection: this.state.newSelection });
      }
      const messageId = crypto.randomUUID();
      this.pendingInput = { chatId, messageId, text: originalDraft }; this.save();
      await this.client.call('messages.send', { chatId, messageId, text });
      if (this.state.selectedId === chatId && this.state.draft === originalDraft) this.setDraft('');
    } catch (error) { this.update({ error: (error as Error).message }); }
    finally { this.update({ busy: false }); await this.refresh(); }
  }
  async cancel() {
    if (!this.state.selectedId) return;
    this.update({ error: null });
    try { await this.client.call('messages.cancel', { chatId: this.state.selectedId }); }
    catch (error) { this.update({ error: (error as Error).message }); }
    finally { await this.refresh(); }
  }
  async permission(id: string, decision: 'allow' | 'deny') {
    if (!this.state.selectedId) return;
    this.update({ error: null });
    try { await this.client.call('permissions.respond', { chatId: this.state.selectedId, permissionId: id, decision }); }
    catch (error) { this.update({ error: (error as Error).message }); }
    finally { await this.refresh(); }
  }
  async older() {
    const view = this.state.view;
    if (!view?.timeline.hasOlder || !view.timeline.before) return;
    try {
      const page: TimelinePage = await this.client.call('chats.timeline', { chatId: view.chat.id, before: view.timeline.before });
      if (this.state.selectedId !== view.chat.id || this.state.view?.timeline.revision !== page.revision) return;
      const current = this.state.view;
      const ids = new Set(current.timeline.items.map(item => item.id));
      const expanded = { ...current, timeline: { ...page, items: [...page.items.filter(item => !ids.has(item.id)), ...current.timeline.items] } };
      this.views.set(view.chat.id, expanded);
      this.update({ view: expanded });
    } catch (error) { this.update({ error: (error as Error).message }); }
  }
  close() { this.stopped = true; clearTimeout(this.refreshTimer); this.client.close(); }
}
