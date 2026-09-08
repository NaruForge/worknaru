import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AppError } from './protocol.js';

const script = fileURLToPath(new URL('../src/windows-agent.ps1', import.meta.url));

export type AgentCommand = { executable: string; arguments: string[]; cwd: string; env: NodeJS.ProcessEnv };

export function withTimeout<T>(operation: Promise<T>, ms: number, code = 'AGENT_TIMEOUT'): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([operation, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AppError(code, '에이전트 응답을 기한 내 확인하지 못했습니다.')), ms);
  })]).finally(() => clearTimeout(timer));
}

export async function stopAgentJob(jobName: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-Mode', 'stop', '-JobName', jobName], {
    env, windowsHide: true, stdio: 'ignore',
  });
  try {
    return await withTimeout(new Promise<boolean>((resolve) => {
      child.once('error', () => resolve(false));
      child.once('exit', (code) => resolve(code === 0));
    }), 15_000, 'PROCESS_CLEANUP_UNKNOWN');
  } catch {
    child.kill();
    return false;
  }
}

export async function launchAgentJob(jobName: string, command: AgentCommand, signal?: AbortSignal) {
  if (process.platform !== 'win32') throw new AppError('UNSUPPORTED_PLATFORM', '첫 ACP 실행은 Windows에서 제공합니다.');
  const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-Mode', 'run', '-JobName', jobName], {
    cwd: command.cwd, env: { ...command.env, WORKNARU_AGENT_CONFIG: Buffer.from(JSON.stringify({
      executable: command.executable, arguments: command.arguments, cwd: command.cwd,
    })).toString('base64') },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal,
  });
  const exited = new Promise<void>((resolve) => {
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
  });
  child.stdin.on('error', () => { /* ACP connection reports the failure. */ });
  try {
    await withTimeout(new Promise<void>((resolve, reject) => {
      let diagnostics = '';
      child.stderr.on('data', (data: Buffer) => {
        diagnostics = (diagnostics + data.toString()).slice(-1024);
        if (diagnostics.includes('WORKNARU_JOB_READY')) resolve();
      });
      child.once('error', () => reject(new AppError('AGENT_START_FAILED', '에이전트 관리 프로세스를 시작하지 못했습니다.')));
      void exited.then(() => reject(new AppError('AGENT_START_FAILED', '에이전트 관리 프로세스가 종료됐습니다.')));
    }), 15_000);
    child.stdin.write(Buffer.from([1]));
  } catch (error) {
    child.stdin.end();
    await stopAgentJob(jobName, command.env);
    throw error;
  }
  let stopping: Promise<boolean> | undefined;
  return {
    child, exited,
    stop(): Promise<boolean> {
      stopping ??= (async () => {
        child.stdin.end();
        return stopAgentJob(jobName, command.env);
      })();
      return stopping;
    },
  };
}
