import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './daemon.js';
import { publicError } from './protocol.js';

try {
  const { values } = parseArgs({ options: {
    'data-dir': { type: 'string' }, workspace: { type: 'string' },
    port: { type: 'string' }, origin: { type: 'string', multiple: true },
    help: { type: 'boolean' },
  } });
  if (values.help || !values['data-dir'] || !values.workspace) {
    console.log('Usage: npm start -- --data-dir .worknaru-dev --workspace <existing-folder> [--port 0] [--origin http://127.0.0.1:3000]\nSet WORKNARU_TOKEN to a random base64url token (32 bytes or more).');
    if (!values.help) process.exitCode = 1;
  } else {
    const daemon = await startDaemon({
      projectRoot: fileURLToPath(new URL('../', import.meta.url)),
      dataDirectory: values['data-dir'], workspaceDirectory: values.workspace,
      port: values.port === undefined ? 0 : Number(values.port),
      token: process.env.WORKNARU_TOKEN ?? '', origins: values.origin,
    });
    console.log(JSON.stringify({ type: 'daemon.ready', ...{
      url: daemon.url, workspace: daemon.workspace,
      storeEpoch: daemon.storeEpoch, daemonInstanceId: daemon.daemonInstanceId,
    } }));
    const stop = () => { void daemon.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
} catch (error) {
  console.error(JSON.stringify({ type: 'daemon.error', error: publicError(error) }));
  process.exitCode = 1;
}
