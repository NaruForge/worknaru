import { randomUUID } from 'node:crypto';
import { ChatError } from '../dist/chat-contract.js';

// Implements the product's Chat runtime needs. No provider process or model is involved.
export class FakeChatRuntime {
  connected = true;
  connectionVersion = 1;
  agents = new Map();
  creations = new Map();
  messages = new Map();
  listeners = new Set();
  connectionListeners = new Set();
  sends = [];
  permissionCalls = [];
  createCalls = [];
  autoFinish = false;
  failCreationResponse = false;
  failSendResponse = false;
  failPermissionResponse = false;
  failConfiguration = false;
  onSend;
  timers = new Set();
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  connection(listener) { this.connectionListeners.add(listener); return () => this.connectionListeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  setConnected(value) { this.connected = value; this.connectionVersion++; for (const listener of this.connectionListeners) listener(); }
  async watch() {}
  async catalog() { return [
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
    { id: 'fake-model', label: 'Fake model', efforts: [{ id: 'medium', label: 'Medium' }] },
  ]; }
  async create(id, title, selection) {
    this.createCalls.push(id);
    const existing = this.creations.get(id);
    if (existing) return structuredClone(this.agents.get(existing));
    const agent = { id: randomUUID(), state: 'ready', selection: { ...selection }, configurationConfirmed: true,
      executionId: null, permissions: [], error: null, title };
    this.agents.set(agent.id, agent); this.creations.set(id, agent.id); this.messages.set(agent.id, []);
    if (this.failCreationResponse) { this.failCreationResponse = false; throw new Error('creation response lost'); }
    return structuredClone(agent);
  }
  async inspect(id) { return structuredClone(this.agents.get(id) ?? null); }
  async history(id, before) {
    const items = this.messages.get(id) ?? [];
    const end = before ? Number(before) : items.length;
    const start = Math.max(0, end - 200);
    return { revision: id, items: structuredClone(items.slice(start, end).map(({ executionId, ...item }) => item)), before: String(start), hasOlder: start > 0 };
  }
  async locateMessage(id, messageId) { return this.messages.get(id)?.find(item => item.messageId === messageId)?.executionId ?? null; }
  async configure(id, selection) {
    const agent = this.agents.get(id); agent.selection.model = selection.model;
    if (this.failConfiguration) { this.failConfiguration = false; agent.configurationConfirmed = false; throw new Error('effort application failed'); }
    agent.selection.effort = selection.effort; agent.configurationConfirmed = true;
  }
  async confirmSelection(id, selection) {
    const agent = this.agents.get(id);
    if (!agent?.configurationConfirmed || agent.selection.model !== selection.model || agent.selection.effort !== selection.effort)
      throw new ChatError('MODEL_UNCONFIRMED', '모델 설정을 확인하지 못했습니다.');
  }
  async send(id, text, messageId, selection) {
    this.sends.push({ id, text, messageId, selection });
    const agent = this.agents.get(id);
    const executionId = randomUUID(); agent.state = 'busy'; agent.executionId = executionId;
    this.messages.get(id).push({ id: randomUUID(), kind: 'user', text, messageId, executionId });
    this.emit({ type: 'message.linked', agentId: id, messageId, executionId });
    if (this.onSend) await this.onSend({ id, text, messageId, executionId });
    else if (text.includes('[permission]') || text.includes('[unsupported]')) {
      const request = { id: randomUUID(), title: '명령 실행 권한', description: '임시 Workspace의 명령을 실행합니다.',
        detail: 'echo WORKNARU_TEST', supported: !text.includes('[unsupported]'), responding: false };
      agent.permissions = [request]; this.emit({ type: 'changed', agentId: id });
    } else if (this.autoFinish && !text.includes('[hold]')) {
      const item = { id: randomUUID(), kind: 'assistant', text: '검증 응답' };
      this.messages.get(id).push(item); this.emit({ type: 'changed', agentId: id });
      const timer = setTimeout(() => { this.timers.delete(timer); item.text += ': 대화를 이어갈 수 있습니다.'; this.finish(id); }, 180);
      this.timers.add(timer);
    }
    if (this.failSendResponse) { this.failSendResponse = false; throw new Error('send response lost'); }
  }
  finish(id, outcome = 'completed', executionId = this.agents.get(id).executionId) {
    const agent = this.agents.get(id); agent.state = 'ready'; agent.executionId = null; agent.permissions = [];
    this.emit({ type: 'execution.finished', agentId: id, executionId, outcome, error: null });
    this.emit({ type: 'changed', agentId: id });
  }
  async cancel(id) { if (this.agents.get(id).executionId) this.finish(id, 'cancelled'); }
  async permission(id, permissionId, decision) {
    this.permissionCalls.push({ id, permissionId, decision });
    const agent = this.agents.get(id); agent.permissions = [];
    if (this.failPermissionResponse) { this.failPermissionResponse = false; throw new Error('permission response lost'); }
    this.emit({ type: 'permission.resolved', agentId: id, permissionId });
    this.messages.get(id).push({ id: randomUUID(), kind: 'assistant', text: decision === 'allow' ? '이번 요청을 허용했습니다.' : '요청을 거절했습니다.' });
    this.finish(id);
  }
  close() { for (const timer of this.timers) clearTimeout(timer); this.listeners.clear(); this.connectionListeners.clear(); }
}
