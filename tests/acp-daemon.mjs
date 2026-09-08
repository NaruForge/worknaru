// Process-level test entrypoint; production has no fake-agent environment switch.
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../dist/daemon.js';
const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, workspace: { type: 'string' }, port: { type: 'string' }, origin: { type: 'string', multiple: true } } });
const root = fileURLToPath(new URL('../', import.meta.url));
const testRoot = dirname(values['data-dir']);
const daemon = await startDaemon({ projectRoot: root, dataDirectory: values['data-dir'], workspaceDirectory: values.workspace, token: process.env.WORKNARU_TOKEN,
  origins: values.origin, port: values.port === undefined ? 0 : Number(values.port),
  acp: { command: { executable: process.execPath, arguments: [process.env.TEST_AGENT_ENTRY ?? join(root, 'tests/fake-acp.mjs')], cwd: values.workspace,
    env: { ...process.env, TEST_AGENT_LOG: join(testRoot, 'agent.log'), TEMP: testRoot, TMP: testRoot },
  } },
});
console.log(JSON.stringify({ type: 'daemon.ready', url: daemon.url, workspace: daemon.workspace, storeEpoch: daemon.storeEpoch, daemonInstanceId: daemon.daemonInstanceId }));
process.once('SIGINT', () => void daemon.close());
process.once('SIGTERM', () => void daemon.close());
