import { z } from 'zod';

export const aiSelectionSchema = z.strictObject({
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/),
  reasoningEffort: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
});
export type AiSelection = z.infer<typeof aiSelectionSchema>;
export const INITIAL_AI_SELECTION: AiSelection = { model: 'gpt-5.6-luna', reasoningEffort: 'low' };
export const aiModelSchema = z.object({
  id: z.string(), name: z.string(), efforts: z.array(z.string()).min(1), fallbackEffort: z.string(),
});
export const aiInfoSchema = z.object({
  models: z.array(aiModelSchema),
  authentication: z.enum(['chatgpt', 'apiKey', 'other', 'signedOut']),
  checkedAt: z.string(),
});
export type AiInfo = z.infer<typeof aiInfoSchema>;
export const aiSettingsSchema = z.object({ selection: aiSelectionSchema, storageAvailable: z.boolean() });
export type AiSettings = z.infer<typeof aiSettingsSchema>;
