import { TEST_SELECTION } from '../dist/paseo-config.js';

// Test-only guard: ordinary product cancellation remains available independently of model support.
export async function cancelLiveTurn(runtime, agentId, record) {
  await runtime.confirmSelection(agentId, TEST_SELECTION);
  record({ action: 'cancel', ...TEST_SELECTION, result: 'guarded action' });
  await runtime.cancel(agentId);
}
