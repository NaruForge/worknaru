import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';
import { ChatConnection, type SocketLike } from './chat-connection.js';
import { ChatParams, type ChatMethod } from './chat-contract.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  url: { type: 'string', default: 'ws://127.0.0.1:4310/ws' }, file: { type: 'string' }, watch: { type: 'boolean', default: false },
} });
const endpoint = new URL(values.url!);
if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname) || endpoint.pathname !== '/ws') throw new Error('Use a loopback WorkNaru /ws endpoint.');
const request = values.file ? JSON.parse(readFileSync(values.file, 'utf8')) : positionals.length ? JSON.parse(positionals.join(' ')) : { method: 'runtime.get', params: {} };
if (typeof request.method !== 'string' || !(request.method in ChatParams)) throw new Error('Unknown WorkNaru method.');
const method = request.method as ChatMethod;
const params = ChatParams[method].parse(request.params ?? {});
const client = new ChatConnection(values.url!, url => new WebSocket(url) as unknown as SocketLike, false);
const close = () => client.close();
process.on('SIGINT', close); process.on('SIGTERM', close);
try {
  await client.connect();
  if (values.watch) client.subscribe(event => console.log(JSON.stringify({ type: 'event', event })));
  console.log(JSON.stringify({ type: 'result', method, result: await client.call(method, params) }));
  if (!values.watch) close();
} catch (error) { console.error(JSON.stringify({ error: (error as Error).message })); process.exitCode = 1; close(); }
