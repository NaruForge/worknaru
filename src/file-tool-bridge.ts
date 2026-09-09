// ACP launches this small MCP stdio client. Only the daemon can edit files.
import { createInterface } from 'node:readline';
import { fileTools } from './file-approval.js';

const endpoint = process.env.WORKNARU_FILE_ENDPOINT;
const token = process.env.WORKNARU_FILE_TOKEN;
if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+\/file-tool$/.test(endpoint) || !token) process.exit(1);
const send = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
let lineBytes = 0;
process.stdin.on('data', (chunk: Buffer) => {
  for (const byte of chunk) { if (byte === 10) lineBytes = 0; else if (++lineBytes > 64 * 1024) process.exit(1); }
});
const input = createInterface({ input: process.stdin });
input.on('close', () => process.exit(0));
input.on('line', (line) => {
  if (Buffer.byteLength(line) > 64 * 1024) { process.exit(1); }
  void (async () => {
    const message = JSON.parse(line) as { id?: string | number; method: string; params?: any };
    if (message.id === undefined) return;
    if (message.method === 'initialize') {
      send(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'worknaru-files', version: '0.0.0' } });
    } else if (message.method === 'ping') send(message.id, {});
    else if (message.method === 'tools/list') send(message.id, { tools: fileTools });
    else if (message.method === 'tools/call') {
      try {
        const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(message.params), signal: AbortSignal.timeout(360_000) });
        if (!response.ok) throw new Error('File tool unavailable');
        send(message.id, await response.json());
      } catch { send(message.id, { isError: true, content: [{ type: 'text', text: '파일 도구의 결과를 확인하지 못했습니다. 자동 재시도하지 마세요.' }] }); }
    } else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
  })().catch(() => process.exit(1));
});
