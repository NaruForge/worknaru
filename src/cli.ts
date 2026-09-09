#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startDaemon } from './daemon.js';
import type { AcpOptions } from './acp.js';
import { APP_VERSION } from './runtime-state.js';
import { checkoutRoot, resolveExistingDataDirectory, resolveWorkspaceDirectory } from './paths.js';
import { AppError, publicError } from './protocol.js';
import { exitCode, loadRuntime, readDaemonStatus, stopDaemon } from './ops-client.js';

const root = checkoutRoot(import.meta.url);
const HELP = `WorkNaru CLI ${APP_VERSION}

사용법:
  node dist/cli.js --help
  node dist/cli.js --version
  node dist/cli.js daemon start --data-dir <dir> --workspace <folder> [옵션]
  node dist/cli.js daemon status --data-dir <dir> [--json]
  node dist/cli.js daemon stop --data-dir <dir> [--cancel-active]

daemon start 옵션:
  --foreground          기본값. 터미널에 붙은 실행입니다. 백그라운드는 제공하지 않습니다.
  --data-dir <dir>      필수. checkout 루트 기준의 프로젝트 내부 폴더.
  --workspace <folder>  필수. 기존 폴더. 상대 경로는 checkout 루트 기준입니다.
  --port <n>            기본 0(빈 포트). 충돌 시 다른 포트를 고르거나 점유 프로세스를 종료하지 않습니다.
  --origin <url>        허용 Origin. 여러 번 지정할 수 있습니다.
  --acp                 Codex ACP를 켭니다. --web-ui만으로 AI를 켜지 않습니다.
  --codex-path <file>   ACP Codex 실행 파일.
  --web-ui              검증된 dist/web을 같은 HTTP origin에서 제공합니다. 런타임 빌드를 하지 않습니다.
  --open                --web-ui와 함께 기본 브라우저를 엽니다. 실패해도 Daemon은 유지합니다.
  --no-open             브라우저를 열지 않습니다.
  --help, --version     기동·데이터 변경 없이 사용법 또는 버전만 출력합니다.

daemon status / stop:
  --data-dir <dir>      필수. 없는 폴더를 만들지 않습니다.
  --json                status를 JSON으로 출력합니다.
  --cancel-active       활성 Run과 승인 대기를 중단한 뒤 종료합니다. 기본 stop은 바쁜 실행을 거절합니다.

인증: WORKNARU_TOKEN은 업무 WebSocket 연결 키입니다. status/stop은 이 값을 네트워크로 보내지 않습니다.
운영 제어는 데이터 영역의 인스턴스 한정 ops.token을 identity 검증 후에만 사용합니다.
종료 완료는 별도 CLI 프로세스가 HTTP 본문을 받은 뒤에만 성공입니다.`;

type StartValues = {
  foreground?: boolean;
  'data-dir'?: string;
  workspace?: string;
  port?: string;
  origin?: string[];
  acp?: boolean;
  'codex-path'?: string;
  'web-ui'?: boolean;
  open?: boolean;
  'no-open'?: boolean;
  help?: boolean;
  version?: boolean;
};

function fail(error: unknown) {
  const publicized = publicError(error);
  const extra = error instanceof AppError ? error as AppError & { activeRuns?: number; pendingApprovals?: number } : undefined;
  console.error(JSON.stringify({
    type: 'cli.error', code: publicized.code, message: publicized.message,
    ...(extra?.activeRuns !== undefined ? { activeRuns: extra.activeRuns } : {}),
    ...(extra?.pendingApprovals !== undefined ? { pendingApprovals: extra.pendingApprovals } : {}),
  }));
  process.exitCode = exitCode(error);
}

function parsePort(value: string | undefined) {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw new AppError('INVALID_PORT', '포트는 0에서 65535 사이의 정수여야 합니다.');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new AppError('INVALID_PORT', '포트는 0에서 65535 사이의 정수여야 합니다.');
  }
  return port;
}

function openBrowser(url: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('exit', (code) => { child.unref(); code === 0 ? resolve() : reject(new Error('브라우저를 열지 못했습니다.')); });
  });
}

export async function startForegroundDaemon(values: StartValues, acpOverride?: AcpOptions, browser = openBrowser) {
  if (values.open && values['no-open']) throw new AppError('USAGE', '--open과 --no-open을 함께 사용할 수 없습니다.');
  if (values.open && !values['web-ui']) throw new AppError('USAGE', '--open은 --web-ui와 함께 사용하세요.');
  if (values['codex-path'] && !values.acp) throw new AppError('USAGE', '--codex-path는 --acp와 함께 사용하세요.');
  if (!values['data-dir'] || !values.workspace) {
    throw new AppError('USAGE', 'daemon start는 --data-dir과 --workspace가 필요합니다.');
  }
  const workspace = resolveWorkspaceDirectory(root, values.workspace);
  const dataDirectory = values['data-dir'];
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    void daemon?.close().then((confirmed) => { if (!confirmed) process.exitCode = 1; }, () => { process.exitCode = 1; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    daemon = await startDaemon({
      projectRoot: root, dataDirectory, workspaceDirectory: workspace.path,
      port: parsePort(values.port), origins: values.origin, token: process.env.WORKNARU_TOKEN ?? '',
      acp: acpOverride ?? (values.acp ? { codexPath: values['codex-path'] } : undefined),
      ops: true, webUi: values['web-ui'], exclusiveWorkspace: true,
    });
    if (interrupted) { if (!await daemon.close()) process.exitCode = 1; return; }
    console.log(JSON.stringify({
      type: 'daemon.ready', url: daemon.url, httpOrigin: daemon.httpOrigin, workspace: daemon.workspace,
      storeEpoch: daemon.storeEpoch, daemonInstanceId: daemon.daemonInstanceId,
      webUi: daemon.webUi, aiExecution: daemon.aiExecution,
    }));
    if (values.open) {
      try { await browser(`${daemon.httpOrigin}/`); }
      catch {
        console.error(JSON.stringify({
          type: 'cli.warning', code: 'BROWSER_OPEN_FAILED',
          message: `브라우저를 열지 못했습니다. ${daemon.httpOrigin}/ 로 직접 접속하세요.`,
          url: `${daemon.httpOrigin}/`,
        }));
      }
    }
    const confirmed = await daemon.closed;
    if (!confirmed) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function runStatus(dataDir: string, json: boolean) {
  const directory = resolveExistingDataDirectory(root, dataDir);
  const runtime = loadRuntime(directory);
  const status = await readDaemonStatus(runtime, directory);
  if (json) {
    console.log(JSON.stringify({
      type: 'daemon.status', running: true, instanceId: status.instanceId, dataDir: status.dataDir,
      workspace: status.workspace, port: status.port, url: `ws://127.0.0.1:${status.port}/ws`,
      httpOrigin: `http://127.0.0.1:${status.port}`, protocolMajor: status.protocolMajor,
      appVersion: status.appVersion, webUi: status.webUi, aiExecution: status.aiExecution,
      activeRuns: status.activeRuns, pendingApprovals: status.pendingApprovals,
    }));
    return;
  }
  console.log(`running ${status.instanceId}`);
  console.log(`data-dir ${status.dataDir}`);
  console.log(`workspace ${status.workspace}`);
  console.log(`url ws://127.0.0.1:${status.port}/ws`);
  console.log(`web-ui ${status.webUi ? 'yes' : 'no'}`);
  console.log(`ai ${status.aiExecution ? 'yes' : 'no'}`);
  console.log(`active-runs ${status.activeRuns}`);
  console.log(`pending-approvals ${status.pendingApprovals}`);
}

async function runStop(dataDir: string, cancelActive: boolean) {
  const directory = resolveExistingDataDirectory(root, dataDir);
  const runtime = loadRuntime(directory);
  await stopDaemon(runtime, directory, cancelActive);
  console.log(JSON.stringify({ type: 'daemon.stopped', stopped: true }));
}

function parseCli(argv: string[]) {
  try {
    return parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: {
        help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
        foreground: { type: 'boolean' }, 'data-dir': { type: 'string' }, workspace: { type: 'string' },
        port: { type: 'string' }, origin: { type: 'string', multiple: true },
        acp: { type: 'boolean' }, 'codex-path': { type: 'string' },
        'web-ui': { type: 'boolean' }, open: { type: 'boolean' }, 'no-open': { type: 'boolean' },
        json: { type: 'boolean' }, 'cancel-active': { type: 'boolean' },
      },
    });
  } catch {
    throw new AppError('USAGE', '알 수 없는 옵션이거나 사용법이 올바르지 않습니다. --help를 확인하세요.');
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const { values, positionals } = parseCli(argv);
  if (values.version) { console.log(`worknaru ${APP_VERSION}`); return; }
  if (values.help || positionals.length === 0) { console.log(HELP); return; }
  if (positionals[0] !== 'daemon' || positionals.length > 2) {
    throw new AppError('USAGE', '지원하는 명령은 daemon start, daemon status, daemon stop입니다.');
  }
  const command = positionals[1];
  if (!command || command === 'help') { console.log(HELP); return; }
  if (command === 'start') {
    if (values.json || values['cancel-active']) throw new AppError('USAGE', 'start에서 지원하지 않는 옵션입니다.');
    await startForegroundDaemon(values);
    return;
  }
  if (!values['data-dir']) throw new AppError('USAGE', `${command}는 --data-dir이 필요합니다.`);
  if (values.workspace || values.port || values.origin || values.acp || values['codex-path']
    || values['web-ui'] || values.open || values['no-open'] || values.foreground) {
    throw new AppError('USAGE', `${command}에서 지원하지 않는 옵션입니다.`);
  }
  if (command === 'status') {
    if (values['cancel-active']) throw new AppError('USAGE', 'status에서 지원하지 않는 옵션입니다.');
    await runStatus(values['data-dir'], Boolean(values.json));
    return;
  }
  if (command === 'stop') {
    if (values.json) throw new AppError('USAGE', 'stop에서 지원하지 않는 옵션입니다.');
    await runStop(values['data-dir'], Boolean(values['cancel-active']));
    return;
  }
  throw new AppError('USAGE', '지원하는 명령은 daemon start, daemon status, daemon stop입니다.');
}

const entry = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (entry) {
  try { await runCli(); }
  catch (error) { fail(error); }
}
