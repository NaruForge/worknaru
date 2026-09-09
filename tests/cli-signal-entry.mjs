// Exercise the actual SIGINT handler; Windows child.kill('SIGINT') force-kills instead.
import { runCli } from '../dist/cli.js';
import { exitCode } from '../dist/ops-client.js';
process.on('message', () => process.emit('SIGINT'));
try { await runCli(); }
catch (error) { console.error(error); process.exitCode = exitCode(error); }
finally { process.disconnect?.(); }
