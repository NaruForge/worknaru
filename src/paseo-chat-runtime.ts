import type { AgentSnapshotPayload } from '@getpaseo/server';
import type { AgentPermissionRequest, AgentTimelineItem, ToolCallDetail } from '@getpaseo/protocol/agent-types';
import { PaseoRuntime } from './paseo-runtime.js';
import type { ChatRuntime, RuntimeChat, RuntimeEvent } from './chat-runtime.js';
import { ChatError, type Permission, type Selection, type TimelineItem, type TimelinePage } from './chat-contract.js';

function detailText(detail: ToolCallDetail | undefined): string {
  if (!detail) return '';
  switch (detail.type) {
    case 'shell': return [detail.command, detail.cwd, detail.output].filter(Boolean).join('\n');
    case 'read': case 'write': return [detail.filePath, detail.content].filter(Boolean).join('\n');
    case 'edit': return [detail.filePath, detail.unifiedDiff ?? [detail.oldString, detail.newString].filter(Boolean).join('\n→\n')].join('\n');
    case 'plain_text': case 'plan': return detail.text ?? '';
    case 'unknown': return [detail.input, detail.output].filter(value => value != null).map(value => typeof value === 'string' ? value : JSON.stringify(value, null, 2)).join('\n');
    default: return JSON.stringify(detail, null, 2);
  }
}
function permission(request: AgentPermissionRequest): Permission {
  // Codex command/file requests without custom actions map allow to one-shot accept.
  const supported = request.kind === 'tool' && !request.actions?.length &&
    ['CodexBash', 'CodexFileChange'].includes(request.name);
  return { id: request.id, title: request.title ?? request.name, description: request.description ?? '',
    detail: detailText(request.detail) || JSON.stringify(request.input ?? {}, null, 2), supported, responding: false };
}
export function mapPaseoChat(agent: AgentSnapshotPayload): RuntimeChat {
  const effort = agent.effectiveThinkingOptionId ?? agent.thinkingOptionId;
  const selection = agent.model && effort ? { model: agent.model, effort } : null;
  return { id: agent.id,
    state: agent.providerUnavailable || agent.status === 'closed' || agent.status === 'error' ? 'unavailable'
      : agent.status === 'initializing' ? 'starting' : agent.status === 'running' || agent.activeTurn ? 'busy' : 'ready',
    selection, configurationConfirmed: !!selection && agent.runtimeInfo?.model === selection.model &&
      agent.runtimeInfo?.thinkingOptionId === selection.effort && agent.effectiveThinkingOptionId === selection.effort,
    executionId: agent.activeTurn?.turnId ?? null, permissions: agent.pendingPermissions.map(permission), error: agent.lastError ?? null };
}
function timelineItem(item: AgentTimelineItem, id: string): TimelineItem {
  switch (item.type) {
    case 'user_message': return { id, kind: 'user', text: item.text, messageId: item.clientMessageId ?? item.messageId };
    case 'assistant_message': return { id, kind: 'assistant', text: item.text };
    case 'reasoning': return { id, kind: 'reasoning', text: item.text };
    case 'tool_call': return { id, kind: 'tool', text: detailText(item.detail).slice(0, 64_000),
      tool: { name: item.name, state: item.status === 'canceled' ? 'cancelled' : item.status } };
    case 'error': return { id, kind: 'error', text: item.message };
    case 'notification': return { id, kind: item.level === 'error' ? 'error' : 'notice', text: item.message };
    case 'todo': return { id, kind: 'notice', text: item.items.map(task => `${task.completed ? '✓' : '○'} ${task.text}`).join('\n') };
    default: return { id, kind: 'notice', text: item.type === 'compaction' ? '대화 맥락을 정리했습니다.' : '지원하지 않는 기록 형식입니다.' };
  }
}

export class PaseoChatRuntime implements ChatRuntime {
  private version = 0;
  constructor(private native: PaseoRuntime) { native.connection(() => { this.version++; }); }
  get connected() { return this.native.connected; }
  get connectionVersion() { return this.version; }
  connection(listener: () => void) { return this.native.connection(listener); }
  subscribe(listener: (event: RuntimeEvent) => void) {
    return this.native.subscribe(event => {
      if (!('agentId' in event)) return;
      const agentId = event.agentId;
      if (event.type === 'agent_stream') {
        const item = event.event;
        if (item.type === 'timeline' && item.item.type === 'user_message' && item.turnId) {
          const messageId = item.item.clientMessageId ?? item.item.messageId;
          if (messageId) listener({ type: 'message.linked', agentId, messageId, executionId: item.turnId });
        } else if (['turn_completed', 'turn_failed', 'turn_canceled'].includes(item.type) && 'turnId' in item && item.turnId) {
          listener({ type: 'execution.finished', agentId, executionId: item.turnId,
            outcome: item.type === 'turn_completed' ? 'completed' : item.type === 'turn_canceled' ? 'cancelled' : 'failed',
            error: item.type === 'turn_failed' ? item.error : null });
        }
      }
      if (event.type === 'agent_permission_resolved') listener({ type: 'permission.resolved', agentId, permissionId: event.requestId });
      listener({ type: 'changed', agentId });
    });
  }
  async catalog() {
    const result = await this.native.catalog();
    if (result.error || !result.models) throw new ChatError('MODELS_UNAVAILABLE', result.error ?? '모델 목록을 확인하지 못했습니다.');
    return result.models.filter(model => model.isSelectable !== false).map(model => ({ id: model.id, label: model.label,
      efforts: (model.thinkingOptions ?? []).map(effort => ({ id: effort.id, label: effort.label })) }));
  }
  async create(id: string, title: string, selection: Selection) { return mapPaseoChat(await this.native.create(id, title, selection)); }
  async inspect(agentId: string) {
    let value = await this.native.inspect(agentId);
    // A persisted snapshot is closed until Paseo loads its native session. A timeline read
    // performs that supported lazy load; closed itself never proves input readiness.
    if (value?.agent.status === 'closed' && value.agent.persistence && !value.agent.archivedAt && !value.agent.providerUnavailable) {
      const loaded = await this.native.history(agentId, { limit: 1, projection: 'canonical' });
      if (loaded.error) throw new ChatError('AGENT_UNAVAILABLE', loaded.error);
      value = await this.native.inspect(agentId);
    }
    return value ? mapPaseoChat(value.agent) : null;
  }
  private decodeCursor(value: string) {
    try {
      const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      if (typeof cursor.epoch !== 'string' || !Number.isSafeInteger(cursor.seq) || cursor.seq < 1) throw new Error();
      return { epoch: cursor.epoch as string, seq: cursor.seq as number };
    } catch { throw new ChatError('INVALID_CURSOR', '기록 조회 위치가 올바르지 않습니다.'); }
  }
  async history(agentId: string, before?: string): Promise<TimelinePage> {
    const result = await this.native.history(agentId, { limit: 200, projection: 'projected',
      ...(before ? { direction: 'before', cursor: this.decodeCursor(before) } : {}) });
    if (result.error) throw new ChatError('HISTORY_UNAVAILABLE', result.error);
    if (result.staleCursor || result.gap) throw new ChatError('HISTORY_CHANGED', '기록이 변경됐습니다. 대화를 다시 조회하세요.');
    return { revision: result.epoch, items: result.entries.map(entry => timelineItem(entry.item, `${result.epoch}:${entry.seqStart}`)),
      before: result.startCursor ? Buffer.from(JSON.stringify(result.startCursor)).toString('base64url') : null, hasOlder: result.hasOlder };
  }
  async locateMessage(agentId: string, messageId: string): Promise<string | null> {
    const unavailable = () => new ChatError('HISTORY_UNAVAILABLE', '입력 이력을 확인하지 못했습니다. 연결과 기록을 확인하세요.');
    let cursor: { epoch: string; seq: number } | undefined;
    do {
      const page = await this.native.history(agentId, { projection: 'canonical', limit: 1000, ...(cursor ? { cursor, direction: 'before' } : {}) })
        .catch(() => { throw unavailable(); });
      if (page.error) throw unavailable();
      if (page.staleCursor || page.gap || (cursor && page.epoch !== cursor.epoch))
        throw new ChatError('HISTORY_CHANGED', '입력 이력이 변경돼 중복 여부를 확인하지 못했습니다. 기록을 다시 조회하세요.');
      const match = page.entries.find(entry => entry.item.type === 'user_message' && (entry.item.clientMessageId ?? entry.item.messageId) === messageId);
      if (match?.turnId) return match.turnId;
      // An incomplete scan cannot prove that an input was never delivered.
      if (match) throw new ChatError('HISTORY_CHANGED', '입력의 실행 식별자를 확인하지 못했습니다. 기록을 확인하세요.');
      if (!page.hasOlder) return null;
      const next = page.startCursor;
      if (!next || next.epoch !== page.epoch || !Number.isSafeInteger(next.seq) || next.seq < 1 || (cursor && next.seq >= cursor.seq))
        throw new ChatError('HISTORY_CHANGED', '이전 입력 이력을 끝까지 확인하지 못했습니다. 기록을 다시 조회하세요.');
      cursor = next;
    } while (cursor);
    return null;
  }
  watch(agentIds: string[]) { return this.native.watch(agentIds); }
  configure(agentId: string, selection: Selection) { return this.native.configure(agentId, selection); }
  confirmSelection(agentId: string, selection: Selection) { return this.native.confirmSelection(agentId, selection); }
  send(agentId: string, text: string, messageId: string, selection: Selection) { return this.native.send(agentId, text, messageId, selection); }
  cancel(agentId: string) { return this.native.cancel(agentId); }
  async permission(agentId: string, permissionId: string, decision: 'allow' | 'deny') {
    const state = await this.inspect(agentId);
    const request = state?.permissions.find(request => request.id === permissionId);
    if (!request) throw new ChatError('PERMISSION_RESOLVED', '이미 처리됐거나 더 이상 대기 중인 요청이 아닙니다.');
    if (decision === 'allow' && !request.supported) throw new ChatError('PERMISSION_UNSUPPORTED', '이 권한 양식은 허용할 수 없습니다. 거절하거나 실행을 취소하세요.');
    await this.native.permission(agentId, permissionId, decision);
  }
}
