// Small development client for the first text flow; no product UI or client framework.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';
import type { Run } from './public-contract.js';

const { values } = parseArgs({ options: { url: { type: 'string' }, text: { type: 'string' }, session: { type: 'string' } } });
if (!values.url || !values.text || !process.env.WORKNARU_TOKEN) {
  console.error('Usage: node dist/chat-client.js --url ws://127.0.0.1:<port>/ws --text "안녕" [--session <sessionId>]\nSet WORKNARU_TOKEN to the daemon token.');
  process.exitCode = 1;
} else {
  const ws = new WebSocket(values.url, { maxPayload: 256 * 1024 });
  ws.on('error', () => {});
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let readyResolve!: (value: any) => void;
  let readyReject!: (error: Error) => void;
  const readyPromise = new Promise<any>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let finishResolve!: () => void;
  let finishReject!: (error: Error) => void;
  const finished = new Promise<void>((resolve, reject) => { finishResolve = resolve; finishReject = reject; });
  void readyPromise.catch(() => {});
  void finished.catch(() => {});
  let runId: string | undefined;
  let lastRevision = -1;
  let shown = '';
  const requestId = randomUUID();
  let sessionId = values.session;
  function show(run: Run) {
    if (run.runId !== runId) return;
    if (!run.storageAvailable) { finishReject(new Error('STORE_UNAVAILABLE: 저장 장애입니다. 마지막 접수 결과와 기록을 다시 확인하세요.')); return; }
    if (run.revision <= lastRevision) return;
    lastRevision = run.revision;
    process.stdout.write(run.text.slice(shown.length));
    shown = run.text;
    if (run.errorCode === 'PROCESS_CLEANUP_UNKNOWN') { finishReject(new Error('PROCESS_CLEANUP_UNKNOWN: 실행 종료를 확인할 수 없습니다.')); return; }
    if (['completed', 'failed', 'cancelled'].includes(run.state)) {
      console.log('\n' + JSON.stringify({ sessionId, runId, state: run.state, errorCode: run.errorCode }));
      if (run.state === 'failed') process.exitCode = 1;
      finishResolve();
    }
  }
  ws.on('message', (raw) => {
    const value = JSON.parse(raw.toString());
    if (value.type === 'ready') readyResolve(value);
    else if (value.type === 'connection.error') readyReject(new Error(value.error.code));
    else if (value.type === 'run.changed') show(value.run);
    else if (value.type === 'response') {
      const waiter = pending.get(value.callId);
      pending.delete(value.callId);
      if (value.ok) waiter?.resolve(value.result);
      else waiter?.reject(new Error(`${value.error.code}: ${value.error.message}`));
    }
  });
  ws.on('close', () => {
    const error = new Error('연결이 끊겼습니다. 입력을 자동 재전송하지 않습니다.');
    readyReject(error); finishReject(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  function call(method: string, params: object, mutation: object = {}) {
    const callId = randomUUID();
    return new Promise<any>((resolve, reject) => {
      pending.set(callId, { resolve, reject });
      ws.send(JSON.stringify({ type: 'request', callId, method, params, ...mutation }));
    });
  }
  const deadline = setTimeout(() => ws.terminate(), 150_000);
  let cancel: (() => void) | undefined;
  try {
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', protocolMajor: 1, token: process.env.WORKNARU_TOKEN }));
    const ready = await readyPromise;
    if (!ready.aiExecution) throw new Error('데몬을 --acp 옵션으로 실행하세요.');
    const workspace = await call('workspaces.get', {});
    if (!sessionId) sessionId = (await call('sessions.create', { workspaceId: workspace.workspaceId }, { requestId: randomUUID(), storeEpoch: ready.storeEpoch })).session.sessionId;
    const receipt = await call('runs.start', { sessionId, text: values.text }, { requestId, storeEpoch: ready.storeEpoch });
    runId = receipt.run.runId;
    cancel = () => { if (runId) void call('runs.cancel', { runId }, { requestId: randomUUID(), storeEpoch: ready.storeEpoch }).catch(finishReject); };
    process.on('SIGINT', cancel);
    show(await call('runs.watch', { runId }));
    // Health is queried too: storage failure cannot itself commit a new revision.
    const health = setInterval(() => { void call('runs.get', { runId }).then(show).catch(finishReject); }, 1000);
    try { await finished; } finally { clearInterval(health); }
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Client error', sessionId, runId, requestId }));
    process.exitCode = 1;
  } finally {
    if (cancel) process.off('SIGINT', cancel);
    clearTimeout(deadline);
    ws.terminate();
  }
}
