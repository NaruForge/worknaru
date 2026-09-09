import { z } from 'zod';
import { aiSelectionSchema } from './ai-settings.js';

export const PROTOCOL_MAJOR = 1;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_TEXT_BYTES = 16 * 1024;
export const MAX_PAGE_BYTES = 192 * 1024;

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const uuid = z.uuid();
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const base = { type: z.literal('request'), callId: id };
const mutation = { ...base, requestId: id, storeEpoch: uuid };
const textInput = z.string().min(1).max(MAX_TEXT_BYTES).refine(
  (value) => value.isWellFormed() && value.trim().length > 0 && Buffer.byteLength(value) <= MAX_TEXT_BYTES,
);

export const helloSchema = z.strictObject({
  type: z.literal('hello'),
  protocolMajor: z.number().int(),
  token: z.string().min(43).max(128).optional(),
});

export const requestSchema = z.discriminatedUnion('method', [
  z.strictObject({ ...base, method: z.literal('ai.get'), params: z.strictObject({}) }),
  z.strictObject({ ...base, method: z.literal('settings.get'), params: z.strictObject({}) }),
  z.strictObject({ ...mutation, method: z.literal('settings.update'), params: z.strictObject({ selection: aiSelectionSchema }) }),
  z.strictObject({ ...mutation, method: z.literal('sessions.configure'), params: z.strictObject({ sessionId: uuid, selection: aiSelectionSchema }) }),
  z.strictObject({ ...mutation, method: z.literal('runs.start'), params: z.strictObject({ sessionId: uuid, text: textInput }) }),
  z.strictObject({ ...mutation, method: z.literal('runs.cancel'), params: z.strictObject({ runId: uuid }) }),
  z.strictObject({ ...base, method: z.literal('runs.get'), params: z.strictObject({ runId: uuid }) }),
  z.strictObject({ ...base, method: z.literal('runs.watch'), params: z.strictObject({ runId: uuid }) }),
  z.strictObject({ ...base, method: z.literal('runs.unwatch'), params: z.strictObject({ runId: uuid }) }),
  z.strictObject({ ...base, method: z.literal('workspaces.get'), params: z.strictObject({}) }),
  z.strictObject({
    ...mutation, method: z.literal('sessions.create'),
    params: z.strictObject({ workspaceId: uuid, title: z.string().trim().min(1).max(160).refine((value) => value.isWellFormed()).default('새 대화') }),
  }),
  z.strictObject({ ...base, method: z.literal('sessions.get'), params: z.strictObject({ sessionId: uuid }) }),
  z.strictObject({
    ...base, method: z.literal('sessions.list'),
    params: z.strictObject({ workspaceId: uuid, after: sequence.default(0), limit: z.number().int().min(1).max(50).default(20), order: z.enum(['asc', 'desc']).default('asc') }),
  }),
  z.strictObject({
    ...mutation, method: z.literal('messages.append'),
    params: z.strictObject({
      sessionId: uuid,
      text: z.string().min(1).max(MAX_TEXT_BYTES).refine(
        (value) => value.isWellFormed() && value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= MAX_TEXT_BYTES,
      ),
    }),
  }),
  z.strictObject({
    ...base, method: z.literal('messages.list'),
    params: z.strictObject({
      sessionId: uuid, after: sequence.default(0), upTo: sequence.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
  }),
  z.strictObject({
    ...base, method: z.literal('requests.get'),
    params: z.strictObject({ workspaceId: uuid, requestId: id, storeEpoch: uuid }),
  }),
]);

export type Request = z.infer<typeof requestSchema>;
export type Mutation = Extract<Request, { requestId: string }>;

export class AppError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export function publicError(error: unknown) {
  return error instanceof AppError
    ? { code: error.code, message: error.message }
    : { code: 'UNAVAILABLE', message: '요청을 처리할 수 없습니다.' };
}
