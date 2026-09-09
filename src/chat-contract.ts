import { z } from 'zod';

export const CHAT_PROTOCOL = 2;
export const SelectionSchema = z.object({ model: z.string().min(1).max(160), effort: z.string().min(1).max(40) }).strict();
export type Selection = z.infer<typeof SelectionSchema>;
export type ChatSettings = { revision: number; defaults: Selection };
export type ModelChoice = { id: string; label: string; efforts: { id: string; label: string }[] };
export type Permission = { id: string; title: string; description: string; detail: string; supported: boolean; responding: boolean };
export type TimelineItem = { id: string; kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'notice' | 'error'; text: string;
  messageId?: string; tool?: { name: string; state: 'running' | 'completed' | 'failed' | 'cancelled' } };
export type TimelinePage = { revision: string; items: TimelineItem[]; before: string | null; hasOlder: boolean };
export type Chat = { id: string; title: string; createdAt: string; selection: Selection | null;
  status: 'creating' | 'ready' | 'sending' | 'running' | 'approval' | 'cancelling' | 'unknown' | 'configuration-required' | 'unavailable';
  pendingMessageId: string | null; permissions: Permission[]; error: string | null };
export type ChatView = { chat: Chat; timeline: TimelinePage };
export type ProductEvent = { type: 'changed'; chatId: string | null } |
  { type: 'message.finished'; chatId: string; messageId: string; outcome: 'completed' | 'failed' | 'cancelled'; error: string | null };
export type ServiceInfo = { protocol: typeof CHAT_PROTOCOL; workspace: string; storeId: string; connected: boolean; storageAvailable: boolean };

const id = z.string().uuid();
const chatId = z.object({ chatId: id }).strict();
export const ChatParams = {
  'runtime.get': z.object({}).strict(),
  'models.list': z.object({}).strict(),
  'chats.list': z.object({}).strict(),
  'settings.get': z.object({}).strict(),
  'settings.update': z.object({ expectedRevision: z.number().int().nonnegative(), defaults: SelectionSchema }).strict(),
  'chats.create': z.object({ id, title: z.string().trim().min(1).max(100), selection: SelectionSchema.optional() }).strict(),
  'chats.recover': chatId,
  'chats.get': chatId,
  'chats.watch': chatId,
  'chats.timeline': z.object({ chatId: id, before: z.string().max(1024).optional() }).strict(),
  'chats.configure': z.object({ chatId: id, selection: SelectionSchema }).strict(),
  'messages.send': z.object({ chatId: id, messageId: id, text: z.string().trim().min(1).max(32_000) }).strict(),
  'messages.cancel': chatId,
  'permissions.respond': z.object({ chatId: id, permissionId: z.string().min(1).max(300), decision: z.enum(['allow', 'deny']) }).strict(),
};
export type ChatMethod = keyof typeof ChatParams;
export type ChatResult = {
  'runtime.get': ServiceInfo; 'models.list': ModelChoice[]; 'chats.list': Chat[];
  'settings.get': ChatSettings; 'settings.update': ChatSettings;
  'chats.create': Chat; 'chats.recover': Chat; 'chats.get': ChatView; 'chats.watch': ChatView;
  'chats.timeline': TimelinePage; 'chats.configure': Chat;
  'messages.send': { messageId: string; accepted: true }; 'messages.cancel': { requested: true };
  'permissions.respond': { resolved: true };
};
export type CallParams<M extends ChatMethod> = z.infer<(typeof ChatParams)[M]>;
export const CallSchema = z.object({ type: z.literal('call'), id: z.string().min(1).max(100),
  method: z.enum(Object.keys(ChatParams) as [ChatMethod, ...ChatMethod[]]), params: z.unknown() }).strict();
export type Reply = { type: 'reply'; id: string; ok: true; result: unknown } |
  { type: 'reply'; id: string; ok: false; error: { code: string; message: string } };

export class ChatError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
