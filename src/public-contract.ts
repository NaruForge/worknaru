// Public Run response shared by storage and clients; no runtime-specific imports.
import { z } from 'zod';
import { fileApprovalSchema } from './file-approval.js';

const id = z.uuid();
const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const runSchema = z.object({
  runId: id, sessionId: id, state: z.enum(['running', 'cancelling', 'completed', 'cancelled', 'failed']),
  delivery: z.enum(['not_attempted', 'attempting']), revision: seq, text: z.string(),
  errorCode: z.string().nullable(), stopReason: z.string().nullable(), createdAt: z.string(), storageAvailable: z.boolean(),
  model: z.string().nullable().default(null), reasoningEffort: z.string().nullable().default(null), modelConfirmed: z.number().int().min(0).max(1).default(0),
  tools: z.array(fileApprovalSchema).max(4).default([]),
});
export type Run = z.infer<typeof runSchema>;
