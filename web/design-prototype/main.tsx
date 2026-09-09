import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceShell, Dialog } from '../workspace.js';
import { Icon } from '../icons.js';
import { AiControls } from '../ai-controls.js';
import { FilePreview } from '../file-approval.js';
import { DEFAULT_COLOR, validColor, palette, cssPalette, contrast } from './palette.js';
import type { Mode, Concept } from './palette.js';
import '../style.css';
import './prototype.css';

type Scene = 'chat' | 'settings' | 'connection' | 'permission';
type State = 'normal' | 'empty' | 'running' | 'error' | 'disabled' | 'permission';
const models = { authentication: 'chatgpt' as const, checkedAt: '2026-09-09T00:00:00Z', models: [{ id: 'demo-model', name: '예제 모델', efforts: ['low', 'medium', 'high'], fallbackEffort: 'medium' }] };
const file = { toolId: '00000000-0000-4000-8000-000000000025', path: '회의/제품 검토 메모.md', before: '# 제품 검토\n\n다음 주에 사용성 검토를 진행합니다.', after: '# 제품 검토\n\n다음 주 화요일에 사용성 검토를 진행합니다.\n검토 대상: Chat, 설정, 파일 승인', state: 'pending' as const, errorCode: null, createdAt: '2026-09-09T00:00:00Z' };

function SceneView() {
  const [params, setParams] = useState(() => new URLSearchParams(location.search));
  useEffect(() => {
    const receive = (e: MessageEvent) => { if (e.origin === location.origin && e.source === parent && e.data?.type === 'prototype-config') setParams(new URLSearchParams(e.data.query)); };
    addEventListener('message', receive); return () => removeEventListener('message', receive);
  }, []);
  const concept = params.get('concept') === 'B' ? 'B' : 'A';
  const mode = params.get('mode') === 'dark' ? 'dark' : 'light';
  const baseline = params.get('baseline') === 'true';
  const color = params.get('color') ?? DEFAULT_COLOR;
  const scenario = (params.get('state') ?? 'normal') as State;
  const [scene, setScene] = useState<Scene>('chat');
  const [draft, setDraft] = useState('회의 내용을 실행 항목으로 정리해 주세요.');
  const [feedback, setFeedback] = useState('');
  const [expanded, setExpanded] = useState(true), [drawer, setDrawer] = useState(false);
  const [wide, setWide] = useState(innerWidth >= 860);
  const [selection, setSelection] = useState({ model: 'demo-model', reasoningEffort: 'medium' });
  useEffect(() => { setScene((params.get('scene') ?? 'chat') as Scene); setFeedback(''); }, [params]);
  useEffect(() => { const mq = matchMedia('(min-width: 860px)'); const update = () => { setWide(mq.matches); setDrawer(false); }; mq.addEventListener('change', update); return () => mq.removeEventListener('change', update); }, []);
  const colors = palette(color, mode, concept);
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    document.documentElement.classList.toggle('candidate', !baseline);
    for (const [key, value] of Object.entries(cssPalette(colors))) { if (baseline) document.documentElement.style.removeProperty(key); else document.documentElement.style.setProperty(key, value); }
  }, [color, mode, concept, baseline]);
  const disabled = scenario === 'disabled';
  const list = <><div className="panel-heading"><strong>대화</strong></div><button className="new-chat" onClick={() => { setFeedback('새 대화 예제입니다.'); setDraft(''); }}><Icon name="plus" />새 대화</button><div className="conversation-list">{['제품 검토 회의 정리', '9월 업무 계획', '자료 검토 질문'].map((title, i) => <button className={i === 0 ? 'selected' : ''} key={title} onClick={() => { setFeedback(`${title} 예제를 선택했습니다.`); setDrawer(false); }}><span className="entry-title">{title}</span><span className="entry-info">{i === 0 ? '현재 대화 · 초안 있음' : '저장된 기록'}</span></button>)}</div><p className="sidebar-bottom">배색 비교용 예제 데이터</p></>;
  const close = () => { setScene('chat'); setFeedback('창을 닫았습니다. 업무 요청은 전송하지 않았습니다.'); };
  return <><WorkspaceShell name="제품팀 Workspace" online={scenario !== 'error'} theme={mode} toggleTheme={() => { const p = new URLSearchParams(params); p.set('mode', mode === 'light' ? 'dark' : 'light'); setParams(p); }} connection={() => setScene('connection')} settings={() => setScene('settings')} sidebar={wide && expanded ? list : undefined} listOpen={wide ? expanded : drawer} toggleList={() => wide ? setExpanded(!expanded) : setDrawer(!drawer)} navigationLabel="대화 목록 열기 또는 접기" devStop={<button className="permission-badge" onClick={() => setScene('permission')}>파일 수정 승인 1</button>}>
    <section className="chat" aria-label="Chat"><header className="chat-heading"><div><span className="eyebrow">Chat</span><h1>제품 검토 회의 정리</h1></div><span className="spacer" /><span className="run-state">{scenario === 'running' ? '응답 중' : '저장된 기록'}</span></header>
    {(scenario === 'error' || scenario === 'permission') && <div className="notice" role="status"><strong>{scenario === 'error' ? '연결이 끊겼습니다' : '파일 수정 승인을 기다리고 있습니다'}</strong><p>{scenario === 'error' ? '마지막으로 확인한 기록입니다. 연결 상태를 확인해 주세요.' : '수정 전후 내용을 확인한 뒤 허용 또는 거절해 주세요.'}</p><button onClick={() => setScene(scenario === 'error' ? 'connection' : 'permission')}>{scenario === 'error' ? '연결 확인' : '수정 내용 확인'}</button></div>}
    <div className="transcript-scroll"><div className="reading">{scenario === 'empty' ? <div className="empty"><div className="mark">w</div><h2>무엇부터 함께할까요?</h2><p>생각을 정리하거나, 궁금한 내용을 물어보세요.</p></div> : <><article className="message user"><div className="message-author">나</div><div className="message-text">오늘 제품 검토 회의에서 결정한 내용을 정리해 주세요.</div></article><article className="message assistant"><div className="message-author"><span className="spark">✦</span>AI</div><div className="message-text">{'오늘 회의의 핵심은 사용자가 작업의 흐름을 놓치지 않도록 하는 것입니다.\n\n1. 진행 중인 작업과 확인이 필요한 항목을 구별합니다.\n2. 설정을 바꾸기 전에 결과를 미리 확인할 수 있게 합니다.\n3. 다음 검토에서는 좁은 화면의 사용성을 함께 확인합니다.'}</div><div className="message-note">{scenario === 'running' ? '응답 중 · 예제 상태' : '응답 완료 · 예제 기록'}</div></article></>}</div></div>
    <div className="compose-area"><div className="compose"><textarea aria-label="메시지" value={draft} onChange={e => setDraft(e.target.value)} disabled={disabled} rows={2} /><AiControls info={models} selection={selection} disabled={disabled || scenario === 'running'} change={setSelection} /><div className="compose-controls"><span className="model-label">파일 수정 · 요청마다 승인</span><span className="spacer" /><button className="primary" disabled={disabled || !draft.trim()} onClick={() => setFeedback('시안에서는 AI 요청을 보내지 않습니다.')}><Icon name={scenario === 'running' ? 'stop' : 'arrow'} />{scenario === 'running' ? '중지' : '전송'}</button></div></div><p className="compose-help" role="status">{feedback || '비교용 시안 · 입력과 버튼을 체험할 수 있습니다.'}</p></div></section>
  </WorkspaceShell>
  {drawer && !wide && <Dialog title="대화 목록" close={() => setDrawer(false)} drawer>{list}</Dialog>}
  {scene !== 'chat' && <Dialog title={scene === 'settings' ? '설정' : scene === 'connection' ? 'Daemon 연결' : '파일 수정 승인'} close={close}>
    {scene === 'settings' ? <div className="settings-content"><section><h2>화면 배색</h2><p>Main Color를 기준으로 화면의 배색이 자동 조절됩니다.</p><p className="muted">현재 지정색 {color.toUpperCase()} · 이 브라우저에만 적용</p><p>시안 상단에서 색과 A/B를 바꿔 비교하세요.</p></section><section><h2>AI 인증</h2><p className="auth-status">연결됨 · 예제 계정</p><button className="settings-action" onClick={() => setFeedback('인증 상태 예제입니다.')}>상태 새로고침</button></section><section><h2>새 대화의 기본값</h2><AiControls defaults info={models} selection={selection} disabled={disabled} change={setSelection} /></section>{feedback && <p role="status">{feedback}</p>}</div> : scene === 'connection' ? <form className="connection-form" onSubmit={e => { e.preventDefault(); setFeedback('연결 화면 예제입니다. 실제 접속은 하지 않습니다.'); }}><label>Daemon 주소<input type="url" defaultValue="ws://127.0.0.1:4310/ws" required /></label><label>연결 키<input type="password" placeholder="연결 키 입력" autoComplete="off" /></label>{scenario === 'error' && <p className="error-text" role="alert">연결을 확인하지 못했습니다. 주소와 실행 상태를 확인해 주세요.</p>}<button className="primary" disabled={disabled}>연결</button>{feedback && <p role="status">{feedback}</p>}</form> : <div className="permission-content"><p>AI가 다음 수정을 요청했습니다.</p><FilePreview tool={file} /><p className="muted small">창을 닫는 것만으로 승인하거나 거절하지 않습니다.</p><div className="permission-actions"><button disabled={disabled} onClick={() => setFeedback('거절 결과 예제 · 실제 파일은 변경하지 않습니다.')}>거절</button><button className="primary" disabled={disabled} onClick={() => setFeedback('허용 결과 예제 · 실제 파일은 변경하지 않습니다.')}>이번 수정 허용</button><button disabled={disabled} onClick={() => setFeedback('실행 중지 예제입니다.')}>실행 중지</button></div>{feedback && <p role="status">{feedback}</p>}</div>}
  </Dialog>}</>;
}

function Review() {
  const [concept, setConcept] = useState<Concept>('A'), [mode, setMode] = useState<Mode>('light');
  const [color, setColor] = useState(DEFAULT_COLOR), [input, setInput] = useState(DEFAULT_COLOR);
  const [scene, setScene] = useState<Scene>('chat'), [state, setState] = useState<State>('normal');
  const [width, setWidth] = useState('1280'), [baseline, setBaseline] = useState(false);
  const p = palette(color, mode, concept);
  const query = new URLSearchParams({ frame: 'true', concept, mode, color, scene, state, baseline: String(baseline) }).toString();
  const updateFrame = () => document.querySelector('iframe')?.contentWindow?.postMessage({ type: 'prototype-config', query }, location.origin);
  useEffect(updateFrame, [query]);
  const chooseColor = (value: string) => { setInput(value); if (validColor(value)) { setColor(value); setBaseline(false); } };
  return <div className="review"><header className="review-heading"><div><p className="review-kicker">WORKNARU / DESIGN REVIEW / V1</p><h1>하나의 색에서 시작하는 작업 공간</h1><p>A와 B를 번갈아 보며 색감이 느껴지는 범위를 비교해 주세요.</p></div><span className="review-tag">컨셉 선택용 프로토타입</span></header>
    <section className="review-controls" aria-label="시안 비교 설정"><fieldset><legend>01 · 배색 방향</legend><div className="review-segment"><button aria-pressed={!baseline && concept === 'A'} onClick={() => { setConcept('A'); setBaseline(false); }}>A · 강조색 중심</button><button aria-pressed={!baseline && concept === 'B'} onClick={() => { setConcept('B'); setBaseline(false); }}>B · 표면에도 색감</button><button aria-pressed={baseline} onClick={() => setBaseline(true)}>현재 배색</button></div><p>{baseline ? '현재 제품 CSS의 배색입니다. 아래 예제 내용은 동일합니다.' : concept === 'A' ? '중립적인 바탕 위에 주요 조치와 선택을 강조합니다.' : '배경과 목록에도 Main Color의 색감을 은은하게 더합니다.'}</p></fieldset>
    <fieldset><legend>02 · Main Color</legend><div className="review-color"><input type="color" aria-label="Main Color 선택" value={color} onChange={e => chooseColor(e.target.value)} /><input aria-label="Main Color HEX" aria-invalid={!validColor(input)} value={input} onChange={e => chooseColor(e.target.value)} spellCheck={false} maxLength={7} /><button onClick={() => chooseColor(DEFAULT_COLOR)}>기본색</button></div>{!validColor(input) && <p role="alert">#RRGGBB 형식의 색을 입력하세요. 마지막 유효한 색으로 표시 중입니다.</p>}<div className="review-presets">{['#176b56','#4361ee','#a43e75','#ffff00','#000000','#ffffff','#808080'].map(c => <button key={c} aria-label={`색상 ${c}`} style={{ background: c }} onClick={() => chooseColor(c)} />)}</div></fieldset>
    <fieldset><legend>03 · 비교 조건</legend><div className="review-options"><label>테마<select value={mode} onChange={e => setMode(e.target.value as Mode)}><option value="light">Light</option><option value="dark">Dark</option></select></label><label>화면<select value={scene} onChange={e => setScene(e.target.value as Scene)}><option value="chat">Chat</option><option value="settings">설정</option><option value="connection">연결</option><option value="permission">파일 승인</option></select></label><label>상태<select value={state} onChange={e => setState(e.target.value as State)}>{Object.entries({normal:'정상 / 선택',empty:'빈 화면',running:'응답 중',error:'연결 오류',disabled:'비활성',permission:'승인 대기'}).map(([v,t]) => <option value={v} key={v}>{t}</option>)}</select></label><label>화면 폭<select value={width} onChange={e => setWidth(e.target.value)}>{['1280','736','390','320'].map(w => <option value={w} key={w}>{w}px</option>)}</select></label></div></fieldset></section>
    <div className="review-meta"><strong>{baseline ? '현재 배색' : `${concept}안`} · {mode} · {width}px</strong>{!baseline && <span>지정색 <i style={{background:color}} />{color.toUpperCase()} → 실제 강조색 <i style={{background:p.accent}} />{p.accent.toUpperCase()} · 버튼 글자 대비 {contrast(p.accent,p.on).toFixed(2)}:1</span>}</div>
    <div className="review-stage"><iframe title="WorkNaru 배색 체험" src={`./index.html?${new URLSearchParams({frame:'true'})}`} onLoad={updateFrame} style={{width:`${width}px`}} /></div>
    <footer className="review-footer"><strong>선택은 이 대화에 남겨 주세요.</strong><span>선호하는 A/B, 비교한 색과 테마, 수정하고 싶은 부분을 알려주시면 다음 시안에 반영합니다.</span><span>예제 데이터만 사용합니다. 실제 AI 요청·파일 수정·설정 저장은 수행하지 않습니다.</span></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('frame') ? <SceneView /> : <Review />);
