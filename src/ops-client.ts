import { request as httpRequest } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { APP_VERSION, identityProof, opsPath, readOpsToken, readRuntimeState } from './runtime-state.js';
import type { RuntimeState } from './runtime-state.js';
import { AppError, PROTOCOL_MAJOR } from './protocol.js';

export const EXIT = {
  generic: 1,
  usage: 2,
  notRunning: 3,
  noResponse: 4,
  authFailed: 5,
  targetMismatch: 6,
  busy: 7,
  stopUnconfirmed: 8,
} as const;

export type IdentifyResult = {
  instanceId: string;
  dataDir: string;
  workspace: string;
  protocolMajor: number;
  appVersion: string;
  webUi: boolean;
  aiExecution: boolean;
  port: number;
};

export type StatusResult = IdentifyResult & {
  activeRuns: number;
  pendingApprovals: number;
  pid: number;
  startedAt: string;
};

export type OpsResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
};

function samePath(left: string, right: string) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function requestOps(port: number, path: string, options: {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  timeoutMs: number;
}): Promise<OpsResponse> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError('NO_RESPONSE', '실행 정보의 포트를 사용할 수 없습니다.');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let incoming: IncomingMessage | undefined;
    const settle = (error?: AppError, value?: OpsResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request.destroy();
      incoming?.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const deadline = setTimeout(() => {
      settle(new AppError('NO_RESPONSE', '운영 제어 응답을 시간 안에 받지 못했습니다.'));
    }, options.timeoutMs);
    deadline.unref();
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: options.method,
      headers: { Host: `127.0.0.1:${port}`, Accept: 'application/json', 'Cache-Control': 'no-store', ...options.headers },
    }, (response) => {
      incoming = response;
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        settle(new AppError('TARGET_MISMATCH', '운영 제어가 다른 주소로 이동하려고 해서 거절했습니다.'));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        received += chunk.length;
        if (received > 16_384) {
          settle(new AppError('NO_RESPONSE', '운영 제어 응답이 너무 큽니다.'));
        }
      });
      response.on('end', () => settle(undefined, {
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('aborted', () => settle(new AppError('NO_RESPONSE', '운영 제어 응답이 중단되었습니다.')));
      response.on('error', () => settle(new AppError('NO_RESPONSE', '운영 제어 응답을 받지 못했습니다.')));
      response.on('close', () => {
        if (!response.complete) settle(new AppError('NO_RESPONSE', '운영 제어 연결이 종료되었습니다.'));
      });
    });
    request.on('error', () => settle(new AppError('NO_RESPONSE', '지정한 데이터 영역의 실행에 연결하지 못했습니다.')));
    request.end();
  });
}

function parseJson(body: string) {
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Not an object');
    return value as Record<string, unknown>;
  }
  catch { throw new AppError('NO_RESPONSE', '운영 제어 응답이 JSON이 아닙니다.'); }
}

function asIdentify(value: Record<string, unknown>, type: string): IdentifyResult {
  if (value.type !== type || typeof value.instanceId !== 'string' || typeof value.dataDir !== 'string'
    || typeof value.workspace !== 'string' || value.protocolMajor !== PROTOCOL_MAJOR
    || typeof value.appVersion !== 'string' || typeof value.webUi !== 'boolean'
    || typeof value.aiExecution !== 'boolean' || typeof value.port !== 'number') {
    throw new AppError('TARGET_MISMATCH', '운영 제어 응답이 이 실행의 계약과 다릅니다.');
  }
  return {
    instanceId: value.instanceId, dataDir: value.dataDir, workspace: value.workspace,
    protocolMajor: value.protocolMajor, appVersion: value.appVersion, webUi: value.webUi,
    aiExecution: value.aiExecution, port: value.port,
  };
}

export function loadRuntime(directory: string) {
  return readRuntimeState(directory);
}

export async function identifyDaemon(runtime: RuntimeState, dataDir: string) {
  if (!samePath(runtime.dataDir, dataDir)) throw new AppError('TARGET_MISMATCH', '실행 정보의 데이터 경로가 요청 대상과 다릅니다.');
  const challenge = randomBytes(32).toString('base64url');
  const response = await requestOps(runtime.port, opsPath('identify'), {
    method: 'GET', headers: { 'X-WorkNaru-Challenge': challenge }, timeoutMs: 3_000,
  });
  if (response.status !== 200) throw new AppError('NO_RESPONSE', '실행 신원 확인에 실패했습니다.');
  const body = parseJson(response.body);
  const identity = asIdentify(body, 'worknaru.ops.identify');
  if (identity.instanceId !== runtime.instanceId || !samePath(identity.dataDir, dataDir)
    || identity.port !== runtime.port || identity.appVersion !== APP_VERSION
    || identity.protocolMajor !== runtime.protocolMajor || !samePath(identity.workspace, runtime.workspace)) {
    throw new AppError('TARGET_MISMATCH', '응답한 서버가 이 데이터 영역의 실행과 일치하지 않습니다. 자격증명을 보내지 않았습니다.');
  }
  const token = readOpsToken(dataDir, identity.instanceId);
  const proof = Buffer.from(typeof body.proof === 'string' ? body.proof : '');
  const expected = Buffer.from(identityProof(token, challenge, identity));
  if (proof.length !== expected.length || !timingSafeEqual(proof, expected)) {
    throw new AppError('AUTH_FAILED', '응답한 서버의 운영 자격증명을 확인하지 못했습니다. 자격증명을 보내지 않았습니다.');
  }
  return { identity, token };
}

function authHeaders(token: string, instanceId: string) {
  return {
    Authorization: `Bearer ${token}`,
    'X-WorkNaru-Instance': instanceId,
  };
}

export async function readDaemonStatus(runtime: RuntimeState, dataDir: string): Promise<StatusResult> {
  const { identity, token } = await identifyDaemon(runtime, dataDir);
  const response = await requestOps(runtime.port, opsPath('status'), {
    method: 'GET', headers: authHeaders(token, identity.instanceId), timeoutMs: 5_000,
  });
  if (response.status === 401 || response.status === 403) {
    throw new AppError('AUTH_FAILED', '운영 제어 인증에 실패했습니다.');
  }
  if (response.status !== 200) throw new AppError('NO_RESPONSE', '상태 조회에 실패했습니다.');
  const body = parseJson(response.body);
  const status = asIdentify(body, 'worknaru.ops.status');
  if (status.instanceId !== identity.instanceId || !samePath(status.dataDir, dataDir)
    || JSON.stringify(status) !== JSON.stringify(identity)
    || !Number.isSafeInteger(body.activeRuns) || (body.activeRuns as number) < 0
    || !Number.isSafeInteger(body.pendingApprovals) || (body.pendingApprovals as number) < 0
    || body.pid !== runtime.pid || body.startedAt !== runtime.startedAt) {
    throw new AppError('TARGET_MISMATCH', '상태 응답이 확인한 실행과 일치하지 않습니다.');
  }
  return { ...status, activeRuns: body.activeRuns as number, pendingApprovals: body.pendingApprovals as number, pid: runtime.pid, startedAt: runtime.startedAt };
}

export async function stopDaemon(runtime: RuntimeState, dataDir: string, cancelActive: boolean) {
  const { identity, token } = await identifyDaemon(runtime, dataDir);
  const response = await requestOps(runtime.port, opsPath('stop'), {
    method: 'POST',
    headers: {
      ...authHeaders(token, identity.instanceId),
      ...(cancelActive ? { 'X-WorkNaru-Cancel-Active': 'yes' } : {}),
    },
    timeoutMs: 180_000,
  });
  if (response.status === 401 || response.status === 403) {
    throw new AppError('AUTH_FAILED', '운영 제어 인증에 실패했습니다.');
  }
  if (response.status === 409) {
    const body = parseJson(response.body);
    const error = new AppError('DAEMON_BUSY', '활성 실행 또는 승인 대기가 있어 종료하지 않았습니다. --cancel-active로 명시적으로 중단할 수 있습니다.');
    (error as AppError & { activeRuns?: number; pendingApprovals?: number }).activeRuns = typeof body.activeRuns === 'number' ? body.activeRuns : undefined;
    (error as AppError & { activeRuns?: number; pendingApprovals?: number }).pendingApprovals = typeof body.pendingApprovals === 'number' ? body.pendingApprovals : undefined;
    throw error;
  }
  if (response.status === 500) throw new AppError('STOP_UNCONFIRMED', '종료를 요청했지만 정리 완료를 확인하지 못했습니다.');
  if (response.status !== 200) throw new AppError('STOP_UNCONFIRMED', '종료 완료 응답을 확인하지 못했습니다.');
  const body = parseJson(response.body);
  if (body.stopped !== true || body.instanceId !== identity.instanceId) throw new AppError('STOP_UNCONFIRMED', '지정한 실행의 종료 완료 응답을 확인하지 못했습니다.');
  return { stopped: true as const };
}

export function exitCode(error: unknown) {
  if (!(error instanceof AppError)) return EXIT.generic;
  switch (error.code) {
    case 'USAGE':
    case 'INVALID_ARGUMENT':
    case 'INVALID_PORT':
    case 'INVALID_ORIGIN':
    case 'INVALID_DATA_PATH':
    case 'INVALID_WORKSPACE':
    case 'INVALID_AUTH_CONFIG': return EXIT.usage;
    case 'NOT_RUNNING':
    case 'DATA_NOT_FOUND': return EXIT.notRunning;
    case 'NO_RESPONSE': return EXIT.noResponse;
    case 'AUTH_FAILED':
    case 'INVALID_OPS_TOKEN': return EXIT.authFailed;
    case 'TARGET_MISMATCH':
    case 'INVALID_DISCOVERY': return EXIT.targetMismatch;
    case 'DAEMON_BUSY': return EXIT.busy;
    case 'STOP_UNCONFIRMED': return EXIT.stopUnconfirmed;
    default: return EXIT.generic;
  }
}
