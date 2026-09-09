// Shared, browser-compatible contract for the first platform file tool.
import { z } from 'zod';

export const MAX_FILE_BYTES = 8 * 1024;
export const fileApprovalSchema = z.object({
  toolId: z.uuid(), path: z.string(), before: z.string(), after: z.string(),
  state: z.enum(['pending', 'approved', 'rejected', 'applying', 'completed', 'failed', 'cancelled', 'unknown']),
  errorCode: z.string().nullable(), createdAt: z.string(),
});
export type FileApproval = z.infer<typeof fileApprovalSchema>;
export const fileReadSchema = z.strictObject({ path: z.string().min(1).max(1024) });
const fileText = z.string().max(MAX_FILE_BYTES).refine((value) => value.isWellFormed() && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) && new TextEncoder().encode(value).byteLength <= MAX_FILE_BYTES);
export const fileEditSchema = fileReadSchema.extend({ before: fileText, after: fileText });

export const fileTools = [
  { name: 'read_text_file', description: 'Read an existing UTF-8 text file within this Workspace, at most 8 KiB. Use this before proposing a file edit.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path' } }, required: ['path'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'edit_text_file', description: 'Propose replacing ONE existing UTF-8 text file (at most 8 KiB). before must exactly match the entire current file; after is the entire replacement. WorkNaru shows both to the user and waits for explicit approval before writing. A rejection must be respected; do not retry or use another tool to make the change.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' } }, required: ['path', 'before', 'after'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
];
