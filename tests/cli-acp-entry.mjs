// Test-only process: same CLI start path with the fake ACP agent. Not a product option.
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startForegroundDaemon } from '../dist/cli.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  'data-dir': { type: 'string' }, workspace: { type: 'string' }, port: { type: 'string' },
  origin: { type: 'string', multiple: true }, 'web-ui': { type: 'boolean' },
  open: { type: 'boolean' }, 'no-open': { type: 'boolean' }, foreground: { type: 'boolean' },
} });
const testRoot = dirname(resolve(root, values['data-dir']));
process.on('message', () => process.emit('SIGINT'));
try {
  await startForegroundDaemon(values, {
    command: {
      executable: process.execPath,
      arguments: [join(root, 'tests/fake-acp.mjs')],
      cwd: values.workspace,
      env: { ...process.env, TEST_AGENT_LOG: join(testRoot, 'agent.log'), TEMP: testRoot, TMP: testRoot },
    },
  }, process.env.TEST_BROWSER_OPEN_FAIL === '1' ? async () => { throw new Error('Test browser unavailable'); } : undefined);
} catch (error) {
  console.error(JSON.stringify({ type: 'cli.error', code: error.code ?? 'UNAVAILABLE', message: error.message ?? '시작에 실패했습니다.' }));
  process.exitCode = 1;
}
finally { process.disconnect?.(); }
