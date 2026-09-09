import { ChatStore, type ChatBinding } from './chat-store.js';
import type { ChatRuntime, RuntimeChat, RuntimeEvent } from './chat-runtime.js';
import { CHAT_PROTOCOL, ChatError, type Chat, type ChatView, type ModelChoice, type ProductEvent, type Selection } from './chat-contract.js';

const sameSelection = (a: Selection | null, b: Selection | null) => !!a && !!b && a.model === b.model && a.effort === b.effort;
const unavailable = () => new ChatError('RUNTIME_UNAVAILABLE', '실행 연결을 확인하지 못했습니다. 다시 연결한 뒤 상태를 조회하세요.');

export class ChatService {
  private locks = new Map<string, Promise<unknown>>();
  private listeners = new Set<(event: ProductEvent) => void>();
  private dispatching = new Map<string, Promise<void>>();
  private storageAvailable = true;
  private unsubscribers: (() => void)[] = [];
  private closed = false;
  private watched = Promise.resolve();
  constructor(private runtime: ChatRuntime, private store: ChatStore, readonly workspace: string) {
    this.unsubscribers.push(runtime.subscribe(event => this.observe(event)), runtime.connection(() => {
      this.emit({ type: 'changed', chatId: null });
      if (runtime.connected) void this.watchAll().catch(() => {});
    }));
  }
  async start() { await this.watchAll(); }
  subscribe(listener: (event: ProductEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(event: ProductEvent) { if (!this.closed) for (const listener of this.listeners) listener(event); }
  info() { return { protocol: CHAT_PROTOCOL, workspace: this.workspace, connected: this.runtime.connected, storageAvailable: this.storageAvailable }; }
  private serial<T>(id: string, operation: () => Promise<T> | T): Promise<T> {
    if (this.closed) return Promise.reject(new ChatError('DAEMON_STOPPING', '서버를 종료하고 있습니다.'));
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.locks.set(id, next);
    void next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id); }).catch(() => {});
    return next;
  }
  private persist<T>(operation: () => T): T {
    this.requireStorage();
    try { return operation(); }
    catch (error) {
      if (error instanceof ChatError) throw error;
      this.storageAvailable = false; this.emit({ type: 'changed', chatId: null });
      throw new ChatError('STORAGE_UNAVAILABLE', '요청 정보를 저장하지 못했습니다. 새 입력을 중단하고 저장 상태를 확인하세요.');
    }
  }
  private requireStorage() { if (!this.storageAvailable) throw new ChatError('STORAGE_UNAVAILABLE', '저장 상태를 확인할 수 없어 새 요청을 받지 않습니다.'); }
  private requireConnection() { if (!this.runtime.connected) throw unavailable(); }
  private async fresh(agentId: string) {
    this.requireConnection();
    const version = this.runtime.connectionVersion;
    const value = await this.runtime.inspect(agentId);
    if (!this.runtime.connected || version !== this.runtime.connectionVersion) throw unavailable();
    if (!value) throw new ChatError('AGENT_UNAVAILABLE', '대화의 실행 기록을 찾을 수 없습니다. 새 대화에서 시작하세요.');
    return value;
  }
  private watchAll() {
    this.watched = this.watched.catch(() => {}).then(async () => {
      if (!this.closed) await this.runtime.watch(this.store.list().flatMap(binding => binding.agentId ? [binding.agentId] : []));
    });
    return this.watched;
  }
  async models(): Promise<ModelChoice[]> { this.requireConnection(); return this.runtime.catalog(); }
  async create(id: string, title: string, selection: Selection): Promise<Chat> {
    return this.serial(id, async () => {
      this.requireConnection();
      const binding = this.persist(() => this.store.create(id, title, selection));
      return this.createBinding(binding);
    });
  }
  async recover(id: string): Promise<Chat> {
    return this.serial(id, async () => { this.requireConnection(); this.requireStorage(); return this.createBinding(this.store.get(id)); });
  }
  private async createBinding(binding: ChatBinding): Promise<Chat> {
    if (!binding.agentId) {
      // The stored creation parameters and ID are reused even after a response or binding write is lost.
      const agent = await this.runtime.create(binding.id, binding.creation.title, binding.creation.selection);
      this.persist(() => this.store.bind(binding.id, agent.id));
      binding = this.store.get(binding.id);
      await this.watchAll();
    }
    this.emit({ type: 'changed', chatId: binding.id });
    return this.readChat(binding);
  }
  async list(): Promise<Chat[]> { return Promise.all(this.store.list().map(binding => this.readChat(binding))); }
  private async readChat(binding: ChatBinding): Promise<Chat> {
    const base = { id: binding.id, title: binding.title, createdAt: binding.createdAt, pendingMessageId: binding.pendingMessageId };
    if (!binding.agentId) return { ...base, status: 'creating', selection: binding.creation.selection, permissions: [], error: null };
    let agent: RuntimeChat;
    try { agent = await this.fresh(binding.agentId); }
    catch (error) { return { ...base, status: binding.pendingMessageId ? 'unknown' : 'unavailable', selection: null, permissions: [], error: (error as Error).message }; }
    // The binding can change while a native query is in flight. Read current admission facts.
    binding = this.store.get(binding.id);
    const pending = binding.pendingMessageId !== null;
    const busy = agent.state === 'busy';
    let status: Chat['status'] = 'ready';
    if (!this.storageAvailable) status = 'unavailable';
    else if (agent.permissions.length) status = 'approval';
    else if (binding.cancelRequested && (busy || this.dispatching.has(binding.id))) status = 'cancelling';
    else if (busy) status = 'running';
    else if (pending) status = this.dispatching.has(binding.id) ? 'sending' : 'unknown';
    else if (binding.configuring || !agent.selection) status = 'configuration-required';
    else if (agent.state !== 'ready') status = 'unavailable';
    return { ...base, pendingMessageId: binding.pendingMessageId, selection: agent.selection, status,
      permissions: agent.permissions.map(request => ({ ...request, responding: binding.responding?.id === request.id })),
      error: !this.storageAvailable ? '저장 상태를 확인할 수 없습니다.' : status === 'unknown'
        ? '입력의 종료 결과를 확인하지 못했습니다. 자동 재전송하지 않습니다. 기록을 확인하고 필요하면 새 대화에서 이어가세요.'
        : binding.configuring ? '모델 설정의 적용 결과를 확인하지 못했습니다. 표시된 실제 설정을 확인하고 다시 설정하세요.' : agent.error };
  }
  async get(id: string): Promise<ChatView> {
    await this.reconcile(id);
    const binding = this.store.get(id);
    const chat = await this.readChat(binding);
    const timeline = binding.agentId && this.runtime.connected ? await this.runtime.history(binding.agentId)
      : { revision: '', items: [], before: null, hasOlder: false };
    return { chat, timeline };
  }
  async timeline(id: string, before?: string) {
    this.requireConnection();
    const binding = this.store.get(id);
    if (!binding.agentId) throw new ChatError('CHAT_CREATING', '대화 생성 결과를 먼저 확인하세요.');
    return this.runtime.history(binding.agentId, before);
  }
  private async reconcile(id: string) {
    return this.serial(id, async () => {
      let binding = this.store.get(id);
      if (!binding.agentId || !this.runtime.connected || !this.storageAvailable) return;
      const agent = await this.fresh(binding.agentId);
      if (binding.configuring && agent.configurationConfirmed && sameSelection(agent.selection, binding.configuring))
        this.persist(() => this.store.setConfiguration(id, null));
      if (binding.responding && !agent.permissions.some(permission => permission.id === binding.responding!.id))
        this.persist(() => this.store.setPermission(id, null)); // No longer pending; this does not assert allowed/denied.
      if (binding.pendingMessageId && !binding.pendingExecutionId) {
        const executionId = await this.runtime.locateMessage(binding.agentId, binding.pendingMessageId);
        if (executionId) this.persist(() => this.store.link(id, binding.pendingMessageId!, executionId));
      }
      // Idle plus a user/assistant record is not a durable completion receipt. Keep an unresolved gate.
    });
  }
  private requireIdle(binding: ChatBinding, agent: RuntimeChat, configuring = false) {
    if (binding.pendingMessageId || binding.responding || agent.state !== 'ready' || agent.executionId || agent.permissions.length)
      throw new ChatError('CHAT_BUSY', '앞선 입력·승인·취소 결과를 먼저 확인하세요.');
    if (!configuring && binding.configuring) throw new ChatError('CONFIGURATION_REQUIRED', '모델 설정을 확인한 뒤 다시 입력하세요.');
  }
  async configure(id: string, selection: Selection): Promise<Chat> {
    await this.serial(id, async () => {
      this.requireStorage();
      const binding = this.store.get(id);
      if (!binding.agentId) throw new ChatError('CHAT_CREATING', '대화 생성 결과를 먼저 확인하세요.');
      this.requireIdle(binding, await this.fresh(binding.agentId), true);
      this.persist(() => this.store.setConfiguration(id, selection));
      try {
        await this.runtime.configure(binding.agentId, selection);
        const actual = await this.fresh(binding.agentId);
        if (!actual.configurationConfirmed || !sameSelection(actual.selection, selection)) throw new ChatError('CONFIGURATION_REQUIRED', '실제 적용된 모델 설정을 확인하지 못했습니다.');
        this.persist(() => this.store.setConfiguration(id, null));
      } finally { this.emit({ type: 'changed', chatId: id }); }
    });
    return this.readChat(this.store.get(id));
  }
  async send(id: string, messageId: string, text: string): Promise<{ messageId: string; accepted: true }> {
    const admitted = await this.serial(id, async () => {
      this.requireStorage();
      const binding = this.store.get(id);
      if (!binding.agentId) throw new ChatError('CHAT_CREATING', '대화 생성 결과를 먼저 확인하세요.');
      const agent = await this.fresh(binding.agentId);
      this.requireIdle(binding, agent);
      if (!agent.selection) throw new ChatError('CONFIGURATION_REQUIRED', '모델과 추론 강도를 선택하세요.');
      // An already delivered ID is never automatically re-submitted, even after its admission gate was cleared.
      if (await this.runtime.locateMessage(binding.agentId, messageId)) throw new ChatError('MESSAGE_ALREADY_SENT', '이미 전달한 입력입니다. 대화 기록을 확인하세요.');
      await this.runtime.confirmSelection(binding.agentId, agent.selection);
      this.persist(() => this.store.pending(id, messageId));
      const dispatched = this.runtime.send(binding.agentId, text, messageId, agent.selection);
      this.dispatching.set(id, dispatched);
      void dispatched.finally(() => { if (this.dispatching.get(id) === dispatched) this.dispatching.delete(id); this.emit({ type: 'changed', chatId: id }); }).catch(() => {});
      this.emit({ type: 'changed', chatId: id });
      return { dispatched }; // Release admission before waiting for delivery acknowledgement or execution.
    });
    try { await admitted.dispatched; }
    catch { throw new ChatError('MESSAGE_OUTCOME_UNKNOWN', '전달 결과를 확인하지 못했습니다. 자동 재전송하지 말고 대화 기록을 확인하세요.'); }
    return { messageId, accepted: true };
  }
  async cancel(id: string): Promise<{ requested: true }> {
    const admitted = await this.serial(id, async () => {
      const binding = this.store.get(id);
      if (!binding.agentId) throw new ChatError('CHAT_CREATING', '대화 생성 중에는 실행을 취소할 수 없습니다.');
      const actual = await this.fresh(binding.agentId);
      if (!binding.pendingMessageId && actual.state !== 'busy' && !actual.permissions.length)
        throw new ChatError('NOT_RUNNING', '취소할 실행이 없습니다.');
      if (this.storageAvailable) this.persist(() => this.store.setCancel(id));
      this.emit({ type: 'changed', chatId: id });
      return { agentId: binding.agentId, sending: this.dispatching.get(id) };
    });
    // A cancellation arriving during message admission must not run before that message starts.
    await admitted.sending?.catch(() => {});
    await this.runtime.cancel(admitted.agentId);
    return { requested: true }; // Only a matching execution.finished event confirms cancellation.
  }
  async permission(id: string, permissionId: string, decision: 'allow' | 'deny'): Promise<{ resolved: true }> {
    const admitted = await this.serial(id, async () => {
      this.requireStorage();
      const binding = this.store.get(id);
      if (!binding.agentId) throw new ChatError('CHAT_CREATING', '대화 생성 결과를 먼저 확인하세요.');
      const agent = await this.fresh(binding.agentId);
      const request = agent.permissions.find(permission => permission.id === permissionId);
      if (!request) throw new ChatError('PERMISSION_RESOLVED', '이미 처리됐거나 더 이상 대기 중인 요청이 아닙니다.');
      if (binding.responding) throw new ChatError('PERMISSION_RESPONSE_PENDING', '다른 응답의 처리 결과를 확인 중입니다. 다시 응답하지 마세요.');
      if (decision === 'allow' && !request.supported) throw new ChatError('PERMISSION_UNSUPPORTED', '이 권한 양식은 지원하지 않습니다. 거절하거나 실행을 취소하세요.');
      this.persist(() => this.store.setPermission(id, { id: permissionId, decision }));
      this.emit({ type: 'changed', chatId: id });
      return { agentId: binding.agentId };
    });
    try { await this.runtime.permission(admitted.agentId, permissionId, decision); }
    catch { throw new ChatError('PERMISSION_OUTCOME_UNKNOWN', '권한 응답의 처리 결과를 확인하지 못했습니다. 자동 재응답하지 않습니다. 상태를 다시 조회하세요.'); }
    await this.serial(id, () => {
      if (this.store.get(id).responding?.id === permissionId) this.persist(() => this.store.setPermission(id, null));
      this.emit({ type: 'changed', chatId: id });
    });
    return { resolved: true };
  }
  private observe(event: RuntimeEvent) {
    if (this.closed) return;
    let binding: ChatBinding | null;
    try { binding = this.persist(() => this.store.byAgent(event.agentId)); }
    catch { return; }
    if (!binding) return;
    void this.serial(binding.id, () => {
      const current = this.store.get(binding.id);
      if (event.type === 'message.linked' && event.messageId === current.pendingMessageId)
        this.persist(() => this.store.link(binding.id, event.messageId, event.executionId));
      if (event.type === 'permission.resolved' && current.responding?.id === event.permissionId)
        this.persist(() => this.store.setPermission(binding.id, null));
      if (event.type === 'execution.finished' && current.pendingMessageId && current.pendingExecutionId === event.executionId) {
        const messageId = current.pendingMessageId;
        if (this.persist(() => this.store.finish(binding.id, messageId, event.executionId)))
          this.emit({ type: 'message.finished', chatId: binding.id, messageId, outcome: event.outcome, error: event.error });
      }
      this.emit({ type: 'changed', chatId: binding.id });
    }).catch(() => this.emit({ type: 'changed', chatId: binding.id }));
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    await Promise.allSettled([...this.locks.values(), this.watched]);
    this.listeners.clear(); this.store.close();
  }
}
