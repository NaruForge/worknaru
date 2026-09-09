import { createInterface } from 'node:readline';
import { createPaseoDaemon, createRootLogger } from '@getpaseo/server';
import { privatePaseoConfig, type RuntimeInit } from './paseo-config.js';

const lines = createInterface({ input: process.stdin });
const init = await new Promise<RuntimeInit>((resolve, reject) => {
  lines.once('line', line => { try { resolve(JSON.parse(line)); } catch (error) { reject(error); } });
  lines.once('close', () => reject(new Error('Runtime owner disconnected.')));
});
const logger = createRootLogger({ log: { level: 'info', file: { path: 'daemon.log', level: 'info' } } }, { paseoHome: init.paseoHome });
let runtime: Awaited<ReturnType<typeof createPaseoDaemon>> | undefined;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await runtime?.stop(); process.stdout.write('WORKNARU_PASEO_STOPPED\n'); }
  catch { process.stdout.write('WORKNARU_PASEO_STOP_FAILED\n'); }
  finally { process.exit(0); }
}
lines.on('line', line => { if (line === 'stop') void stop(); });
lines.on('close', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
try {
  runtime = await createPaseoDaemon(privatePaseoConfig(init), logger);
  await runtime.start();
  const target = runtime.getListenTarget();
  if (target?.type !== 'tcp' || target.host !== '127.0.0.1' || target.port === 0) throw new Error('Invalid private runtime endpoint.');
  process.stdout.write(`WORKNARU_PASEO_READY ${JSON.stringify({ port: target.port, pid: process.pid })}\n`);
} catch (error) {
  // No config or authentication material in the owner protocol.
  process.stdout.write(`WORKNARU_PASEO_FAILED ${error instanceof Error ? error.message.replace(/[\r\n]/g, ' ').slice(0, 300) : 'Startup failed'}\n`);
  await stop();
}
