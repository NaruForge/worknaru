import type { ModelChoice, Selection, Permission, TimelinePage } from './chat-contract.js';

// The operations consumed by Chat, including its fake. No vendor types cross this boundary.
export type RuntimeChat = { id: string; state: 'ready' | 'busy' | 'starting' | 'unavailable';
  selection: Selection | null; configurationConfirmed: boolean; executionId: string | null; permissions: Permission[]; error: string | null };
export type RuntimeEvent = { type: 'changed'; agentId: string } |
  { type: 'message.linked'; agentId: string; messageId: string; executionId: string } |
  { type: 'execution.finished'; agentId: string; executionId: string; outcome: 'completed' | 'failed' | 'cancelled'; error: string | null } |
  { type: 'permission.resolved'; agentId: string; permissionId: string };
export interface ChatRuntime {
  readonly connected: boolean;
  readonly connectionVersion: number;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  connection(listener: () => void): () => void;
  catalog(): Promise<ModelChoice[]>;
  create(id: string, title: string, selection: Selection): Promise<RuntimeChat>;
  inspect(agentId: string): Promise<RuntimeChat | null>;
  history(agentId: string, before?: string): Promise<TimelinePage>;
  locateMessage(agentId: string, messageId: string): Promise<string | null>;
  watch(agentIds: string[]): Promise<void>;
  configure(agentId: string, selection: Selection): Promise<void>;
  confirmSelection(agentId: string, selection: Selection): Promise<void>;
  send(agentId: string, text: string, messageId: string, selection: Selection): Promise<void>;
  cancel(agentId: string): Promise<void>;
  permission(agentId: string, permissionId: string, decision: 'allow' | 'deny'): Promise<void>;
}
