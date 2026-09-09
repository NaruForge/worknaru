// Development protocol caller. Business decisions remain in the Daemon.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { helloSchema, MAX_MESSAGE_BYTES, PROTOCOL_MAJOR, requestSchema } from './protocol.js';
import type { Request } from './protocol.js';
import { runSchema } from './public-contract.js';

const readySchema = z.object({ type: z.literal('ready'), protocolMajor: z.literal(PROTOCOL_MAJOR),
  storeEpoch: z.uuid(), daemonInstanceId: z.uuid(), capabilities: z.array(z.string()), aiExecution: z.boolean(),
  limits: z.object({ maxTextBytes: z.number().int().positive() }) });
const errorSchema = z.object({ code: z.string(), message: z.string() });
const responseSchema = z.discriminatedUnion('ok', [
  z.object({ type: z.literal('response'), callId: z.string(), ok: z.literal(true), result: z.unknown().refine((v) => v !== undefined) }),
  z.object({ type: z.literal('response'), callId: z.string(), ok: z.literal(false), error: errorSchema }),
]);
const token = process.env.WORKNARU_TOKEN ?? '';
const render = (value: unknown) => {
  const json = JSON.stringify(value);
  return token ? json.replaceAll(token, '[REDACTED]') : json;
};
const output = (value: unknown) => process.stdout.write(render(value) + '\n');
class RpcError extends Error { constructor(readonly code: string, message: string) { super(message); } }

async function main() {
  let values;
  try { ({ values } = parseArgs({ options: { url: { type: 'string' }, 'request-file': { type: 'string' },
    'no-key': { type: 'boolean' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean' } } })); }
  catch { throw new RpcError('INVALID_ARGUMENT', 'Unknown or invalid command-line option. Use --help.'); }
  if (values.help) {
    console.log('npm run rpc -- --url ws://127.0.0.1:<port>/ws [--request-file <file|->] [--no-key] [--timeout-ms 60000]\nOmit --request-file to print ready. Token: WORKNARU_TOKEN. Ctrl+C disconnects without cancelling the Run.');
    return;
  }
  let url: URL;
  try { url = new URL(values.url ?? ''); } catch { throw new RpcError('INVALID_URL', 'Specify the local Daemon WebSocket URL.'); }
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/ws' || url.search || url.hash || url.username || url.password)
    throw new RpcError('INVALID_URL', 'Use ws://127.0.0.1:<port>/ws without credentials, query or fragment.');
  const timeout = Number(values['timeout-ms'] ?? 60_000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647)
    throw new RpcError('INVALID_ARGUMENT', '--timeout-ms must be an integer between 1 and 2147483647.');
  if (!values['no-key'] && !/^[a-zA-Z0-9_-]{43,128}$/.test(token))
    throw new RpcError('INVALID_TOKEN', 'Set WORKNARU_TOKEN, or explicitly use --no-key for a keyless Daemon.');
  const hello = helloSchema.parse({ type: 'hello', protocolMajor: PROTOCOL_MAJOR, ...(values['no-key'] ? {} : { token }) });
  let request: Request | undefined;
  if (values['request-file'] !== undefined) {
    let input: unknown;
    try {
      const bytes = readFileSync(values['request-file'] === '-' ? 0 : values['request-file']);
      if (bytes.length > MAX_MESSAGE_BYTES) throw new Error();
      input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
    } catch { throw new RpcError('INVALID_REQUEST', 'Read a UTF-8 JSON request of at most 64KiB from --request-file.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['method', 'params', 'requestId', 'storeEpoch'].includes(key)))
      throw new RpcError('INVALID_REQUEST', 'Provide method, params, and explicit requestId/storeEpoch for mutations.');
    const parsed = requestSchema.safeParse({ ...input, type: 'request', callId: randomUUID() });
    if (!parsed.success) throw new RpcError('INVALID_REQUEST', 'Invalid method/params or missing mutation requestId/storeEpoch.');
    request = parsed.data;
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_MESSAGE_BYTES) throw new RpcError('INVALID_REQUEST', 'Encoded request exceeds 64KiB.');
  }
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { maxPayload: 256 * 1024 });
    let ended = false;
    let phase: 'hello' | 'response' | 'watch' = 'hello';
    let sent = false;
    let responseConfirmed = false;
    let revision = -1;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: RpcError) => {
      if (ended) return;
      ended = true; clearTimeout(timer); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
      socket.terminate();
      if (sent && !responseConfirmed && request && 'requestId' in request) {
        process.stderr.write(render({ recovery: { method: 'requests.get', requestId: request.requestId, storeEpoch: request.storeEpoch },
          message: 'Do not resend automatically. Obtain workspaceId with workspaces.get and query requests.get; found:false is different from a lookup failure.' }) + '\n');
      }
      if (error) reject(error); else resolve();
    };
    const interrupt = () => finish();
    const deadline = () => { clearTimeout(timer); timer = setTimeout(() => finish(new RpcError('TIMEOUT', 'Connection or response was not confirmed. No automatic retry.')), timeout); };
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt); deadline();
    socket.on('open', () => { if (!ended) socket.send(JSON.stringify(hello)); });
    socket.on('error', () => finish(new RpcError('CONNECTION_FAILED', 'Could not communicate with the Daemon.')));
    socket.on('close', () => finish(new RpcError('DISCONNECTED', 'Connection closed before completion. No automatic retry.')));
    socket.on('message', (raw, binary) => {
      if (ended) return;
      try {
        if (binary) throw new Error();
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'connection.error') {
          const error = errorSchema.parse(frame.error); finish(new RpcError(error.code, error.message)); return;
        }
        if (phase === 'hello') {
          const ready = readySchema.parse(frame);
          if (!request) { output(ready); finish(); return; }
          if (!ready.capabilities.includes(request.method)) { finish(new RpcError('METHOD_NOT_SUPPORTED', 'The Daemon does not advertise this method.')); return; }
          phase = 'response'; deadline(); sent = true; socket.send(JSON.stringify(request)); return;
        }
        if (phase === 'response') {
          const response = responseSchema.parse(frame);
          if (response.callId !== request!.callId) throw new Error();
          responseConfirmed = true;
          if (!response.ok) { output(response); finish(new RpcError(response.error.code, response.error.message)); return; }
          if (request!.method !== 'runs.watch') { output(response); finish(); return; }
          const run = runSchema.parse(response.result);
          if (run.runId !== request!.params.runId) throw new Error();
          output({ ...response, result: run }); revision = run.revision;
          if (['completed', 'failed', 'cancelled'].includes(run.state)) { finish(); return; }
          phase = 'watch'; clearTimeout(timer); return;
        }
        const event = z.object({ type: z.literal('run.changed'), run: runSchema }).parse(frame);
        if (request!.method !== 'runs.watch' || event.run.runId !== request!.params.runId) throw new Error();
        if (event.run.revision <= revision) return;
        revision = event.run.revision; output(event);
        if (['completed', 'failed', 'cancelled'].includes(event.run.state)) finish();
      } catch { finish(new RpcError('PROTOCOL_MISMATCH', 'Invalid Daemon response or protocol version.')); }
    });
  });
}

try { await main(); }
catch (error) {
  process.stderr.write(render({ error: { code: error instanceof RpcError ? error.code : 'RPC_FAILED',
    message: error instanceof RpcError ? error.message : 'RPC could not complete.' } }) + '\n');
  process.exitCode = 1;
}
