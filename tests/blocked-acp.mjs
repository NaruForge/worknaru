// Consume exactly initialization and Session creation, then stop reading stdin.
// A large prompt blocks the supervisor's write, independently of daemon lifetime.
import { appendFileSync, readSync, writeSync } from 'node:fs';
appendFileSync(process.env.TEST_AGENT_LOG, JSON.stringify({ type: 'spawn', pid: process.pid }) + '\n');
const byte = Buffer.alloc(1);
for (let n = 0; n < 2; n++) {
  let line = '';
  while (readSync(0, byte, 0, 1, null) > 0) {
    if (byte[0] === 10) break;
    line += byte.toString();
  }
  const { id, method } = JSON.parse(line);
  const result = method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } : { sessionId: 'blocked-session' };
  writeSync(1, JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
