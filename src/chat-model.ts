import { ChatConnection } from './chat-connection.js';
import type { Chat, ChatView, ModelChoice, Selection, ServiceInfo, TimelinePage } from './chat-contract.js';

type LocalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type ModelState = { connected: boolean; info: ServiceInfo | null; models: ModelChoice[]; chats: Chat[];
  selectedId: string | null; view: ChatView | null; draft: string; newSelection: Selection;
  error: string | null; busy: boolean; lastOutcome: string | null };
export class ChatModel {
  private state: ModelState = { connected: false, info: null, models: [], chats: [], selectedId: null, view: null,
    draft: '', newSelection: { model: 'gpt-5.6-luna', effort: 'low' }, error: null, busy: false, lastOutcome: null };
  private listeners = new Set<() => void>();
  private drafts = new Map<string | null, string>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;
  private refreshAgain = false;
  private revision = 0;
  private stopped = false;
  private pendingInput: { chatId: string; messageId: string; text?: string } | null = null;
  private readonly key: string;
  constructor(private client: ChatConnection, private storage?: LocalStorage) {
    this.key = `worknaru.chat.v2:${client.url}`;
    try {
      const saved = JSON.parse(storage?.getItem(this.key) ?? 'null');
      if (saved && typeof saved.selectedId === 'string') this.state.selectedId = saved.selectedId;
      if (saved?.pendingInput && typeof saved.pendingInput.chatId === 'string' && typeof saved.pendingInput.messageId === 'string') this.pendingInput = saved.pendingInput;
    } catch {}
    client.connection(() => {
      this.revision++;
      this.update({ connected: client.connected, info: client.info });
      if (client.connected) void this.initialize();
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
    try { this.storage?.setItem(this.key, JSON.stringify({ selectedId: this.state.selectedId,
      pendingInput: this.pendingInput ? { chatId: this.pendingInput.chatId, messageId: this.pendingInput.messageId } : null })); }
    catch { throw new Error('요청 식별자를 브라우저에 보관하지 못했습니다. 저장 공간을 확인하세요.'); }
  }
  async connect() { try { await this.client.connect(); } catch (error) { this.update({ error: (error as Error).message }); } }
  private async initialize() {
    const revision = this.revision;
    try {
      const models = await this.client.call('models.list', {});
      if (revision !== this.revision) return;
      this.update({ models, error: null }); await this.refresh();
    } catch (error) { if (revision === this.revision) { this.update({ error: (error as Error).message }); await this.refresh(); } }
  }
  private scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.refresh(); }, 50);
  }
  async refresh() {
    if (!this.client.connected || this.stopped) return;
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshing = true;
    const revision = this.revision, selectedId = this.state.selectedId;
    try {
      const [info, chats, view] = await Promise.all([this.client.call('runtime.get', {}), this.client.call('chats.list', {}),
        selectedId ? this.client.call('chats.get', { chatId: selectedId }) : Promise.resolve(null)]);
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
      this.update({ info, chats, view: merged });
    } catch (error) {
      if (revision === this.revision && (error as { code?: string }).code === 'CHAT_NOT_FOUND') {
        this.select(null); this.refreshAgain = true;
      } else if (revision === this.revision) this.update({ error: (error as Error).message });
    }
    finally {
      this.refreshing = false;
      if (this.refreshAgain) { this.refreshAgain = false; this.scheduleRefresh(); }
    }
  }
  select(id: string | null) {
    this.drafts.set(this.state.selectedId, this.state.draft);
    this.revision++;
    this.update({ selectedId: id, view: null, draft: this.drafts.get(id) ?? '', error: null, lastOutcome: null });
    try { this.save(); } catch (error) { this.update({ error: (error as Error).message }); }
    void this.refresh();
  }
  setDraft(value: string) { this.drafts.set(this.state.selectedId, value); this.update({ draft: value }); }
  async configure(selection: Selection) {
    if (!this.state.selectedId) { this.update({ newSelection: selection }); return; }
    this.update({ busy: true, error: null });
    try { await this.client.call('chats.configure', { chatId: this.state.selectedId, selection }); }
    catch (error) { this.update({ error: (error as Error).message }); }
    finally { this.update({ busy: false }); await this.refresh(); }
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
      this.update({ view: { ...current, timeline: { ...page, items: [...page.items.filter(item => !ids.has(item.id)), ...current.timeline.items] } } });
    } catch (error) { this.update({ error: (error as Error).message }); }
  }
  close() { this.stopped = true; clearTimeout(this.refreshTimer); this.client.close(); }
}
