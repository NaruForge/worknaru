// Consume initialization, Session creation and both model confirmations, then stop reading stdin.
// A large prompt blocks the supervisor's write, independently of daemon lifetime.
import { appendFileSync, readSync, writeSync } from 'node:fs';
appendFileSync(process.env.TEST_AGENT_LOG, JSON.stringify({ type: 'spawn', pid: process.pid }) + '\n');
const byte = Buffer.alloc(1);
for (let n = 0; n < 4; n++) {
  let line = '';
  while (readSync(0, byte, 0, 1, null) > 0) {
    if (byte[0] === 10) break;
    line += byte.toString();
  }
  const { id, method } = JSON.parse(line);
  const result = method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } : { sessionId: 'blocked-session', configOptions: [
    { id: 'model', name: 'Model', type: 'select', currentValue: 'gpt-5.6-luna', options: [{ value: 'gpt-5.6-luna', name: 'Luna' }] },
    { id: 'reasoning_effort', name: 'Reasoning effort', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] },
  ] };
  writeSync(1, JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
