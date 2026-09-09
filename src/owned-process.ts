import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../src/windows-runtime.ps1', import.meta.url));
export async function deadline<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  })]); } finally { clearTimeout(timer); }
}

// One job owns the private Paseo instance and its descendants. Agent lifetimes belong to Paseo.
export async function launchOwnedProcess(command: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) {
  if (process.platform !== 'win32') throw new Error('WorkNaru runtime requires Windows.');
  const name = `Local\\WorkNaru-${randomUUID()}`;
  const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-Mode', 'run', '-JobName', name], {
    cwd: command.cwd, windowsHide: true, stdio: 'pipe', env: { ...command.env,
      WORKNARU_RUNTIME_CONFIG: Buffer.from(JSON.stringify({ executable: command.executable,
        arguments: command.args, cwd: command.cwd, ownerPid: process.pid })).toString('base64') },
  }) as ChildProcessWithoutNullStreams;
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
  child.stdin.on('error', () => {});
  const stop = async () => {
    const stopper = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-Mode', 'stop', '-JobName', name], {
      windowsHide: true, stdio: 'ignore', env: command.env,
    });
    const clean = await deadline(new Promise<boolean>(resolve => {
      stopper.once('exit', code => resolve(code === 0)); stopper.once('error', () => resolve(false));
    }), 15_000, 'Runtime cleanup could not be confirmed.').catch(() => { stopper.kill(); return false; });
    child.stdin.end();
    if (!clean) throw new Error('Runtime cleanup could not be confirmed.');
    await deadline(exited, 5_000, 'Runtime owner did not exit.');
  };
  try {
    await deadline(new Promise<void>((resolve, reject) => {
      let diagnostic = '';
      child.stderr.on('data', data => {
        diagnostic = (diagnostic + String(data)).slice(-1024);
        if (diagnostic.includes('WORKNARU_JOB_READY')) resolve();
      });
      child.once('error', reject);
      void exited.then(() => reject(new Error('Runtime owner exited before launch.')));
    }), 15_000, 'Runtime owner startup timed out.');
    child.stdin.write(Buffer.from([1]));
    return { child, exited, stop };
  } catch (error) { await stop(); throw error; }
}
