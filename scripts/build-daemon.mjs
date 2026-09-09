import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const output = join(root, 'dist');
try {
  if (lstatSync(output).isSymbolicLink() || realpathSync(output) !== output) throw new Error('Build output must be this checkout’s dist directory.');
  rmSync(output, { recursive: true }); // Remove stale entrypoints when source files are removed.
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const require = createRequire(import.meta.url);
const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
const result = spawnSync(process.execPath, [compiler], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
