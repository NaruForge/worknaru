import { createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { z } from 'zod';
import { AppError, PROTOCOL_MAJOR } from './protocol.js';
import { assertUnlinkedFile } from './paths.js';

export const APP_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
export const RUNTIME_FILE = 'runtime.json';
export const OPS_TOKEN_FILE = 'ops.token';
const OPS_PATH = '/__worknaru_ops';

const runtimeSchema = z.strictObject({
  schema: z.literal(1),
  instanceId: z.uuid(),
  dataDir: z.string().min(1),
  workspace: z.string().min(1),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  protocolMajor: z.literal(PROTOCOL_MAJOR),
  appVersion: z.string().min(1).max(32),
  webUi: z.boolean(),
  aiExecution: z.boolean(),
});

export type RuntimeState = z.infer<typeof runtimeSchema>;

export function opsPath(action: 'identify' | 'status' | 'stop') {
  return `${OPS_PATH}/${action}`;
}

export function isOpsPath(url: string | undefined) {
  return Boolean(url && (url === OPS_PATH || url.startsWith(`${OPS_PATH}/`)));
}

function atomicWrite(path: string, body: string, secret = false) {
  try { assertUnlinkedFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temporary, '', { flag: 'wx', mode: 0o600 });
  try {
    if (secret && process.platform === 'win32') {
      // Apply the DACL before writing the secret; POSIX mode bits do not restrict Windows readers.
      execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($identity)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow'))
Set-Acl -LiteralPath $env:WORKNARU_OPS_FILE -AclObject $acl
`], { windowsHide: true, stdio: 'ignore', timeout: 10_000, env: { ...process.env, WORKNARU_OPS_FILE: temporary } });
    } else chmodSync(temporary, 0o600);
    writeFileSync(temporary, body);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeRuntimeState(directory: string, state: RuntimeState, opsToken: string) {
  // Publish the discovery last, after its instance-bound credential is ready.
  const tokenPath = join(directory, OPS_TOKEN_FILE);
  atomicWrite(tokenPath, JSON.stringify({ instanceId: state.instanceId, token: opsToken }), true);
  try { atomicWrite(join(directory, RUNTIME_FILE), `${JSON.stringify(state)}\n`); }
  catch (error) { rmSync(tokenPath); throw error; }
}

export function readRuntimeState(directory: string): RuntimeState {
  const path = join(directory, RUNTIME_FILE);
  let raw: string;
  try {
    if (assertUnlinkedFile(path, '실행 정보 파일의 링크나 형식이 올바르지 않습니다.').size > 16_384) throw new Error('Too large');
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError('NOT_RUNNING', '지정한 데이터 영역에서 실행 중인 Daemon을 찾지 못했습니다.');
    }
    throw new AppError('INVALID_DISCOVERY', '실행 정보 파일이 올바르지 않습니다. 링크이거나 파일 형식을 확인할 수 없습니다.');
  }
  let data: unknown;
  try { data = JSON.parse(raw); }
  catch { throw new AppError('INVALID_DISCOVERY', '실행 정보가 손상되었거나 완성되지 않았습니다.'); }
  const parsed = runtimeSchema.safeParse(data);
  if (!parsed.success) {
    const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    if (typeof record.protocolMajor === 'number' && record.protocolMajor !== PROTOCOL_MAJOR) {
      throw new AppError('TARGET_MISMATCH', '실행 정보의 계약 버전이 이 CLI와 다릅니다.');
    }
    throw new AppError('INVALID_DISCOVERY', '실행 정보 형식이 올바르지 않습니다.');
  }
  if (parsed.data.appVersion !== APP_VERSION) {
    throw new AppError('TARGET_MISMATCH', '실행 정보의 앱 버전이 이 CLI와 다릅니다.');
  }
  return parsed.data;
}

export function readOpsToken(directory: string, instanceId: string) {
  const path = join(directory, OPS_TOKEN_FILE);
  try {
    if (assertUnlinkedFile(path, '운영 자격증명 파일의 링크나 형식이 올바르지 않습니다.').size > 512) throw new Error('Too large');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError('INVALID_OPS_TOKEN', '운영 자격증명이 없어 실행 상태를 확인할 수 없습니다.');
    }
    throw new AppError('INVALID_DISCOVERY', '운영 자격증명 파일이 올바르지 않습니다.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { /* Report a bounded public error. */ }
  const value = z.strictObject({ instanceId: z.uuid(), token: z.string().regex(/^[a-zA-Z0-9_-]{43,128}$/) }).safeParse(parsed);
  if (!value.success) {
    throw new AppError('INVALID_OPS_TOKEN', '운영 자격증명을 확인할 수 없습니다.');
  }
  if (value.data.instanceId !== instanceId) throw new AppError('TARGET_MISMATCH', '실행 정보와 운영 자격증명의 인스턴스가 다릅니다. 다시 상태를 확인하세요.');
  return value.data.token;
}

export function identityProof(token: string, challenge: string, identity: Pick<RuntimeState, 'instanceId' | 'dataDir' | 'workspace' | 'port' | 'appVersion' | 'webUi' | 'aiExecution'> & { protocolMajor: number }) {
  return createHmac('sha256', token).update(JSON.stringify([
    challenge, identity.instanceId, identity.dataDir, identity.workspace, identity.port,
    identity.protocolMajor, identity.appVersion, identity.webUi, identity.aiExecution,
  ])).digest('base64url');
}

export function removeOwnedRuntimeState(directory: string, instanceId: string) {
  const path = join(directory, RUNTIME_FILE);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) return;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { instanceId?: string };
    if (parsed.instanceId !== instanceId) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof SyntaxError) return;
    throw error;
  }
  for (const name of [RUNTIME_FILE, OPS_TOKEN_FILE]) {
    const target = join(directory, name);
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      rmSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export function createOpsToken() {
  return randomBytes(32).toString('base64url');
}
