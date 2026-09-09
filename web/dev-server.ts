import { useState } from 'react';

type Stage = 'idle' | 'key' | 'checking' | 'confirm' | 'stopping' | 'stopped' | 'error';

export function useDevServer(getToken: (endpoint: string) => string) {
  const [endpoint] = useState(() => document.querySelector<HTMLMetaElement>('meta[name="worknaru-dev-endpoint"]')?.content);
  const [instance] = useState(() => document.querySelector<HTMLMetaElement>('meta[name="worknaru-dev-instance"]')?.content);
  const [stage, setStage] = useState<Stage>('idle');
  const [key, setKey] = useState('');
  const [activeRuns, setActiveRuns] = useState(0);
  const [error, setError] = useState('');
  const request = async (path: string, token: string, confirm = false) => {
    const response = await fetch(`/__worknaru_dev/${path}`, {
      method: path === 'stop' ? 'POST' : 'GET', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, 'X-WorkNaru-Dev-Instance': instance ?? '', ...(confirm ? { 'X-WorkNaru-Confirm-Stop': 'yes' } : {}) },
      signal: AbortSignal.timeout(180_000),
    });
    const result = await response.json() as { activeRuns?: number; stopped?: boolean; error?: string };
    if (response.status === 409 && typeof result.activeRuns === 'number') return result;
    if (!response.ok) throw new Error(result.error ?? '종료 요청에 실패했습니다.');
    return result;
  };
  const failure = (reason: unknown) => {
    setError(reason instanceof Error && reason.name === 'Error' ? reason.message : '서버 응답을 받지 못해 종료 여부를 확인할 수 없습니다. 터미널의 상태를 확인하세요.');
    setStage('error');
  };
  const stop = async (token: string, confirm: boolean) => {
    setStage('stopping');
    try {
      const result = await request('stop', token, confirm);
      if (result.activeRuns) { setActiveRuns(result.activeRuns); setStage('confirm'); }
      else if (result.stopped === true) { setKey(''); setStage('stopped'); }
      else throw new Error('종료 완료를 확인하지 못했습니다.');
    } catch (reason) { failure(reason); }
  };
  const check = async (token = getToken(endpoint ?? '') || key) => {
    setError('');
    if (!token) { setStage('key'); return; }
    setKey(token);
    setStage('checking');
    try {
      const result = await request('status', token);
      if (typeof result.activeRuns !== 'number') throw new Error('실행 상태를 확인하지 못했습니다.');
      if (result.activeRuns) { setActiveRuns(result.activeRuns); setStage('confirm'); }
      else await stop(token, false);
    } catch (reason) { failure(reason); }
  };
  return { enabled: Boolean(endpoint && instance), stage, key, setKey, activeRuns, error, check,
    confirm: () => stop(key, true), dismiss: () => { setStage('idle'); setKey(''); } };
}
