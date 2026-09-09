import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { ColorPreference, applyAppearance } from './appearance.js';
import { DEFAULT_COLOR, validColor } from './theme-palette.js';
import type { Mode } from './theme-palette.js';
import { Button, Field, Input } from './ui.js';

export function useAppearance(preference: ColorPreference, mode: Mode) {
  const snapshot = useSyncExternalStore(preference.subscribe, preference.getSnapshot);
  useLayoutEffect(() => applyAppearance(document.documentElement, snapshot.color, mode), [snapshot.color, mode]);
  useEffect(() => {
    const receive = (event: StorageEvent) => {
      try { if (event.storageArea === localStorage) preference.receiveStorage(event.key, event.newValue); }
      catch { /* Browser access policy changed; do not discard the current preview. */ }
    };
    addEventListener('storage', receive); return () => removeEventListener('storage', receive);
  }, [preference]);
  return snapshot;
}

export function AppearanceSettings({ preference }: { preference: ColorPreference }) {
  const snapshot = useSyncExternalStore(preference.subscribe, preference.getSnapshot);
  const [draft, setDraft] = useState(snapshot.applied);
  useEffect(() => { setDraft(snapshot.applied); }, [snapshot.revision]);
  useEffect(() => () => preference.cancel(), [preference]);
  const update = (value: string) => { setDraft(value); preference.preview(value); };
  const invalid = !validColor(draft);
  return <section className="appearance-settings"><h2>화면 배색</h2><p className="muted small">Main Color 하나로 전체 배색을 조절합니다. 이 브라우저의 같은 주소에서만 유지됩니다.</p>
    <div className="appearance-color"><Input type="color" aria-label="Main Color 선택" value={snapshot.color} onChange={event => update(event.target.value)} />
      <Field label="Main Color HEX" description="예: #176b56" error={invalid ? '#RRGGBB 형식으로 입력해 주세요.' : undefined}>{props => <Input {...props} value={draft} onChange={event => update(event.target.value)} spellCheck={false} maxLength={7} />}</Field>
    </div>
    <p className="muted small">색을 바꾸면 바로 미리 봅니다. 적용하지 않고 설정을 나가면 이전 배색으로 돌아갑니다.</p>
    <div className="appearance-actions"><Button onClick={() => update(DEFAULT_COLOR)}>기본색 복원</Button><span className="spacer" /><Button onClick={() => { preference.cancel(); setDraft(preference.getSnapshot().applied); }}>취소</Button><Button variant="primary" disabled={invalid} onClick={() => preference.apply(draft)}>배색 적용</Button></div>
    {snapshot.message && <p role="status" className="small">{snapshot.message}</p>}
  </section>;
}
