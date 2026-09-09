import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceShell } from '../shell.js';
import { Button, IconButton, Field, Input, Select, TextArea, Dialog, MainPanel } from '../ui.js';
import { ColorPreference } from '../appearance.js';
import { AppearanceSettings, useAppearance } from '../appearance-settings.js';
import { Icon } from '../icons.js';
import { SettingsNavigation } from '../settings-navigation.js';
import type { SettingsSection } from '../navigation.js';
import { AiControls } from '../ai-controls.js';
import { FileApprovalPanel } from '../file-approval.js';
import type { Mode } from '../theme-palette.js';
import '../style.css';
import './prototype.css';

type Scene = 'chat' | 'settings' | 'connection' | 'permission' | 'controls';
type View = 'modules' | 'list' | 'main';
type PrototypeRoute = { scene: Scene; view: View; settingsTab: SettingsSection; chatIndex: number };
type State = 'normal' | 'empty' | 'running' | 'error' | 'disabled' | 'permission';
const models = { authentication: 'chatgpt' as const, checkedAt: '2026-09-09T00:00:00Z', models: [{ id: 'demo-model', name: '예제 모델', efforts: ['low', 'medium', 'high'], fallbackEffort: 'medium' }] };
const file = { toolId: '00000000-0000-4000-8000-000000000025', path: '회의/제품 검토 메모.md', before: '# 제품 검토\n\n다음 주에 사용성 검토를 진행합니다.', after: '# 제품 검토\n\n다음 주 화요일에 사용성 검토를 진행합니다.\n검토 대상: Chat, 설정, 파일 승인', state: 'pending' as const, errorCode: null, createdAt: '2026-09-09T00:00:00Z' };

function SceneView() {
  const [params, setParams] = useState(() => new URLSearchParams(location.search));
  useEffect(() => {
    const receive = (e: MessageEvent) => { if (e.origin === location.origin && e.source === parent && e.data?.type === 'prototype-config') setParams(new URLSearchParams(e.data.query)); };
    addEventListener('message', receive);
    if (parent !== window) parent.postMessage({ type: 'prototype-ready' }, location.origin);
    return () => removeEventListener('message', receive);
  }, []);
  const mode = params.get('mode') === 'dark' ? 'dark' : 'light';
  const storageBlocked = useRef(false);
  storageBlocked.current = params.get('storage') === 'blocked';
  const [preference] = useState(() => new ColorPreference(() => {
    if (storageBlocked.current) throw new Error('Prototype storage failure');
    return localStorage;
  }, `worknaru.prototype.appearance.v1:${location.pathname}`));
  useAppearance(preference, mode);
  const scenario = (params.get('state') ?? 'normal') as State;
  const [scene, setScene] = useState<Scene>('chat');
  const [settingsTab, setSettingsTab] = useState<SettingsSection>('appearance');
  const [view, setView] = useState<View>('list');
  const [chatIndex, setChatIndex] = useState(0);
  const [chatTitles, setChatTitles] = useState(['제품 검토 회의 정리', '9월 업무 계획', '자료 검토 질문', ...Array.from({length: 15}, (_, i) => `검토 대화 ${i + 4}`)]);
  const [drafts, setDrafts] = useState<Record<number, string>>({0:'회의 내용을 실행 항목으로 정리해 주세요.'});
  const draft = drafts[chatIndex] ?? '';
  const setDraft = (value: string) => setDrafts(current => ({...current, [chatIndex]: value}));
  const [feedback, setFeedback] = useState('');
  const [expanded, setExpanded] = useState(true);
  const [wide, setWide] = useState(innerWidth >= 860);
  const [selection, setSelection] = useState({ model: 'demo-model', reasoningEffort: 'medium' });
  const requestedScene = (params.get('scene') ?? 'chat') as Scene;
  const route = useRef<PrototypeRoute>({scene, view, settingsTab, chatIndex});
  route.current = {scene, view, settingsTab, chatIndex};
  const applyRoute = (next: PrototypeRoute) => {
    setScene(next.scene); setView(next.view);
    // Back to a list keeps its latest selection; a history detail restores its item.
    if (next.view === 'main') { setSettingsTab(next.settingsTab); setChatIndex(next.chatIndex); }
  };
  const navigate = (patch: Partial<PrototypeRoute>, replace = false) => {
    const next = {...route.current, ...patch};
    const entry = {...history.state, prototypeRoute: next, prototypeParent: replace ? null : route.current};
    if (replace) history.replaceState(entry, '', location.href); else history.pushState(entry, '', location.href);
    applyRoute(next);
  };
  useEffect(() => {
    navigate({scene: requestedScene, view: params.get('list') === 'none' || ['permission','connection','controls'].includes(requestedScene) ? 'main' : 'list'}, true);
    setFeedback('');
  }, [requestedScene]);
  useEffect(() => {
    const pop = (event: PopStateEvent) => { if (event.state?.prototypeRoute) applyRoute(event.state.prototypeRoute); };
    addEventListener('popstate', pop); return () => removeEventListener('popstate', pop);
  }, []);
  useEffect(() => { const mq = matchMedia('(min-width: 860px)'); const update = () => setWide(mq.matches); mq.addEventListener('change', update); return () => mq.removeEventListener('change', update); }, []);
  const hasList = params.get('list') !== 'none' && ['chat','settings','permission'].includes(scene);
  const back = () => {
    const target = view === 'main' && hasList ? 'list' : 'modules';
    const previous = history.state?.prototypeParent as PrototypeRoute | undefined;
    if (previous?.view === target && (target === 'modules' || previous.scene === scene)) history.back();
    else navigate({view: target}, true);
  };
  useEffect(() => {
    if (!wide && view !== 'main') preference.cancel();
    if (!wide) requestAnimationFrame(() => document.querySelector<HTMLElement>(view === 'modules' ? '.module-picker h1' : view === 'list' ? '.stacked-list [aria-current], .stacked-list .ui-button' : '.stacked-toolbar .ui-button')?.focus());
  }, [view, scene, wide, preference]);
  const disabled = scenario === 'disabled';
  const approval = (scene === 'permission' || scenario === 'permission') ? <InlineApproval disabled={disabled} /> : null;
  const mainPanel = scene === 'settings' || scene === 'controls';
  const noList = !hasList;
  const list = <div className="chat-navigation"><div className="panel-heading"><strong>대화</strong></div><Button className="new-chat" onClick={() => { const index = chatTitles.length; setChatTitles(current => [...current, `새 대화 ${index + 1}`]); navigate({scene:'chat', chatIndex:index, view:'main'}); setFeedback('새 대화 예제입니다.'); }}><Icon name="plus" />새 대화</Button><div className="conversation-list">{chatTitles.map((title, i) => <Button className={i === chatIndex ? 'selected' : ''} aria-current={i === chatIndex ? 'page' : undefined} key={title} onClick={() => { navigate({scene:'chat', chatIndex:i, view:'main'}); setFeedback(`${title} 예제를 선택했습니다.`); }}><span className="entry-title">{title}</span><span className="entry-info">{drafts[i] ? '초안 있음' : '저장된 기록'}</span></Button>)}</div><p className="sidebar-bottom">예제 대화 · 실제 AI 요청 없음</p></div>;
  const settingsList = <SettingsNavigation selected={settingsTab} select={id => navigate({settingsTab:id, view:'main'})} />;
  const currentList = scene === 'settings' ? settingsList : list;
  const close = () => { navigate({scene:'chat', view:'list'}); setFeedback('업무 요청은 전송하지 않았습니다.'); };
  return <><WorkspaceShell name="제품팀 Workspace" online={scenario !== 'error'} theme={mode} toggleTheme={() => { const p = new URLSearchParams(params); p.set('mode', mode === 'light' ? 'dark' : 'light'); setParams(p); }} connection={() => navigate({scene:'connection', view:'main'})} settings={() => navigate({scene:'settings', view:'list'})} chat={() => navigate({scene:'chat', view:'list'})} settingsActive={scene === 'settings'} sectionLabel={scene === 'settings' ? '플랫폼 설정' : undefined} sidebar={wide && expanded && !noList ? currentList : undefined} sidebarLabel={scene === 'settings' ? '설정 메뉴' : '대화 목록'} listOpen={expanded} toggleList={noList || !wide ? undefined : () => setExpanded(!expanded)} navigationLabel={scene === 'settings' ? '설정 메뉴 열기 또는 접기' : '대화 목록 열기 또는 접기'} stacked={!wide ? {view, list:hasList ? currentList : undefined, backLabel:view === 'main' && hasList ? scene === 'settings' ? '← 설정 메뉴' : '← 대화 목록' : '← Module', back} : undefined}>
    {mainPanel ? (wide || view === 'main') && <MainPanel title={scene === 'settings' ? '설정' : '공통 컨트롤'} back={wide ? close : undefined}>{scene === 'controls' ? <ControlSamples state={scenario} /> : <div className="settings-content">{settingsTab === 'appearance' && <AppearanceSettings preference={preference} />}{settingsTab === 'connection' && <section><h2>Workspace 연결</h2><p className="muted small">연결됨 · 예제 Workspace</p><Button variant="outline" onClick={() => navigate({scene:'connection', view:'main'})}>연결 설정 변경</Button></section>}{settingsTab === 'ai' && <><section><h2>AI 인증</h2><p className="auth-status">연결됨 · 예제 계정</p><Button className="settings-action" onClick={() => setFeedback('인증 상태 예제입니다.')}>상태 새로고침</Button></section><section><h2>새 대화의 기본값</h2><AiControls defaults info={models} selection={selection} disabled={disabled} change={setSelection} /></section><section><h2>파일 수정 권한</h2><p className="muted small">요청마다 내용을 확인한 뒤 허용 또는 거절합니다.</p></section></>}{feedback && <p role="status">{feedback}</p>}</div>}</MainPanel> : <section className="chat" aria-label="Chat"><header className="chat-heading"><div><span className="eyebrow">Chat</span><h1>{chatTitles[chatIndex]}</h1></div><span className="spacer" /><span className="run-state">{scenario === 'running' ? '응답 중' : '저장된 기록'}</span></header>
    <div className="transcript-scroll"><div className="reading">{scenario === 'empty' ? <div className="empty"><div className="mark">w</div><h2>무엇부터 함께할까요?</h2><p>생각을 정리하거나, 궁금한 내용을 물어보세요.</p></div> : <><article className="message user"><div className="message-author">나</div><div className="message-text">오늘 제품 검토 회의에서 결정한 내용을 정리해 주세요.</div></article><article className="message assistant"><div className="message-author"><span className="spark">✦</span>AI</div><div className="message-text">{'오늘 회의의 핵심은 사용자가 작업의 흐름을 놓치지 않도록 하는 것입니다.\n\n1. 진행 중인 작업과 확인이 필요한 항목을 구별합니다.\n2. 설정을 바꾸기 전에 결과를 미리 확인할 수 있게 합니다.\n3. 다음 검토에서는 좁은 화면의 사용성을 함께 확인합니다.'}</div><div className="message-note">{scenario === 'running' ? '응답 중 · 예제 상태' : '응답 완료 · 예제 기록'}</div></article></>}</div></div>
    <div className="compose-area">{approval}{scenario === 'error' && <p className="prototype-error" role="alert">연결이 끊겼습니다. 마지막으로 확인한 기록입니다. <Button onClick={() => navigate({scene:'connection', view:'main'})}>연결 확인</Button></p>}<div className="compose"><TextArea aria-label="메시지" value={draft} onChange={e => setDraft(e.target.value)} disabled={disabled} rows={2} /><div className="compose-controls"><AiControls compact info={models} selection={selection} disabled={disabled || scenario === 'running'} change={setSelection} /><span className="spacer" /><IconButton className="compose-send" label={scenario === 'running' ? '중지' : '전송'} variant="primary" disabled={disabled || !draft.trim()} onClick={() => setFeedback('시안에서는 AI 요청을 보내지 않습니다.')}><Icon name={scenario === 'running' ? 'stop' : 'arrow'} /></IconButton></div></div><p className="compose-help" role="status">{feedback || '비교용 시안 · 입력과 버튼을 체험할 수 있습니다.'}</p></div></section>}
  </WorkspaceShell>
  {scene === 'connection' && <Dialog title="Daemon 연결" close={close}><form className="connection-form" onSubmit={e => { e.preventDefault(); setFeedback('연결 화면 예제입니다. 실제 접속은 하지 않습니다.'); }}><label>Daemon 주소<Input type="url" defaultValue="ws://127.0.0.1:4310/ws" required /></label><label>연결 키<Input type="password" placeholder="연결 키 입력" autoComplete="off" /></label>{scenario === 'error' && <p className="error-text" role="alert">연결을 확인하지 못했습니다. 주소와 실행 상태를 확인해 주세요.</p>}<Button type="submit" variant="primary" disabled={disabled}>연결</Button>{feedback && <p role="status">{feedback}</p>}</form></Dialog>}</>;

}

function InlineApproval({ disabled }: { disabled: boolean }) {
  const [result, setResult] = useState('');
  return <FileApprovalPanel tool={file}><p className="muted small">접어도 승인하거나 거절하지 않습니다.</p><div className="permission-actions"><Button disabled={disabled || !!result} onClick={() => setResult('거절했습니다. 예제 파일은 변경하지 않았습니다.')}>거절</Button><Button variant="primary" disabled={disabled || !!result} onClick={() => setResult('허용했습니다. 예제 파일은 변경하지 않았습니다.')}>이번 수정 허용</Button><Button disabled={disabled || !!result} onClick={() => setResult('실행을 중지했습니다. 예제 파일은 변경하지 않았습니다.')}>실행 중지</Button></div>{result && <p role="status">{result}</p>}</FileApprovalPanel>;

}

function ControlSamples({ state }: { state: State }) {
  const [value, setValue] = useState('회의 검토 자료');
  const [message, setMessage] = useState('');
  return <div className="control-samples"><p>제품에 적용한 실제 공통 컴포넌트입니다. 크기와 강조, 키보드 조작을 확인해 주세요.</p>
    <div className="appearance-actions"><Button variant="primary" disabled={state === 'disabled'} onClick={() => setMessage('주요 조치를 눌렀습니다.')}>주요 조치</Button><Button variant="outline" onClick={() => setMessage('보조 조치를 눌렀습니다.')}>보조 조치</Button><Button onClick={() => setMessage('일반 조치를 눌렀습니다.')}>일반 조치</Button><IconButton label="조치 닫기 예제" onClick={() => setMessage('아이콘 조치를 눌렀습니다.')}><Icon name="close" /></IconButton></div>
    <Button loading={state === 'running'} disabled={state === 'disabled'} variant="outline">{state === 'running' ? '확인 중…' : '상태 확인'}</Button>
    <Field label="자료 제목" description="검토할 자료의 이름을 입력하세요." error={state === 'error' ? '제목을 다시 확인해 주세요.' : undefined}>{props => <Input {...props} value={value} onChange={e => setValue(e.target.value)} disabled={state === 'disabled'} />}</Field>
    <Field label="저장 위치" description="이 예제의 경로는 읽기 전용입니다.">{props => <Input {...props} value="회의/제품 검토 메모.md" readOnly />}</Field>
    <Field label="검토 의견">{props => <TextArea {...props} placeholder="의견을 입력하세요" rows={3} disabled={state === 'disabled'} />}</Field>
    {message && <p role="status">{message}</p>}
  </div>;
}

function Review() {
  const [mode, setMode] = useState<Mode>('light');
  const [scene, setScene] = useState<Scene>('settings'), [state, setState] = useState<State>('normal');
  const [width, setWidth] = useState(() => new URLSearchParams(location.search).get('width') ?? (innerWidth < 600 ? '320' : '1280'));
  const [blocked, setBlocked] = useState(false);
  const query = new URLSearchParams({ frame: 'true', mode, scene, state, storage: blocked ? 'blocked' : 'normal' }).toString();
  const updateFrame = () => document.querySelector('iframe')?.contentWindow?.postMessage({ type: 'prototype-config', query }, location.origin);
  useEffect(updateFrame, [query]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin === location.origin && event.source === document.querySelector('iframe')?.contentWindow && event.data?.type === 'prototype-ready') updateFrame();
    };
    addEventListener('message', receive); return () => removeEventListener('message', receive);
  }, [query]);
  return <div className="review"><header className="review-heading"><div><p className="review-kicker">WORKNARU / INTERACTION REVIEW / V5</p><h1>모바일: 목록에서 선택하고, 상세로 이동</h1><p>390px에서 Chat·설정의 목록 → 상세 → 뒤로 가기를 체험해 주세요. 넓은 화면은 세 영역을 나란히 표시합니다.</p></div><span className="review-tag">선택된 컨셉: A · 강조색 중심</span></header>
    <section className="review-controls" aria-label="체험 설정"><fieldset><legend>01 · 화면과 상태</legend><div className="review-options"><label>화면<Select aria-label="화면" value={scene} onChange={e => setScene(e.target.value as Scene)}>{Object.entries({settings:'배색 설정',controls:'공통 컨트롤',chat:'Chat',connection:'연결',permission:'파일 승인'}).map(([v,t]) => <option value={v} key={v}>{t}</option>)}</Select></label><label>상태<Select aria-label="상태" value={state} onChange={e => setState(e.target.value as State)}>{Object.entries({normal:'정상 / 선택',empty:'빈 화면',running:'진행 중',error:'오류',disabled:'비활성',permission:'승인 대기'}).map(([v,t]) => <option value={v} key={v}>{t}</option>)}</Select></label></div></fieldset>
    <fieldset><legend>02 · 테마와 화면 폭</legend><div className="review-options"><label>테마<Select aria-label="테마" value={mode} onChange={e => setMode(e.target.value as Mode)}><option value="light">Light</option><option value="dark">Dark</option></Select></label><label>화면 폭<Select aria-label="화면 폭" value={width} onChange={e => setWidth(e.target.value)}>{['1280','736','390','320'].map(w => <option value={w} key={w}>{w}px</option>)}</Select></label></div></fieldset>
    <fieldset><legend>03 · 저장과 확정된 선택</legend><p>파일 승인: 입력창 바로 위 · 배색: A</p><label className="review-checkbox"><input type="checkbox" checked={blocked} onChange={e => setBlocked(e.target.checked)} />저장 실패 체험</label><p>시안 전용 저장 영역을 사용합니다. 실제 제품 설정은 바뀌지 않습니다.</p><a href={`./index.html?${new URLSearchParams({frame:'true',scene:'settings',mode})}`} target="_blank" rel="noopener">다른 탭에서 열기 ↗</a></fieldset></section>
    <div className="review-meta"><strong>A안 · {mode} · {width}px</strong><span>적용 전 미리보기 → 적용 또는 취소 → 새로고침·다른 탭에서 확인</span></div>
    <div className="review-stage"><iframe title="WorkNaru 조작 체험" src="./index.html?frame=true&scene=settings" onLoad={updateFrame} style={{width:`${width}px`}} /></div>
    <footer className="review-footer"><strong>이 대화에 확인 결과를 남겨 주세요.</strong><span>모바일에서 목록 선택, 큰 뒤로 버튼, 브라우저 뒤로 가기와 초안·목록 위치 유지를 확인해 주세요.</span><span>실제 공통 UI를 사용합니다. Chat·연결·파일 승인의 업무 결과는 예제이며 AI 요청·파일 변경은 없습니다.</span></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('frame') ? <SceneView /> : <Review />);
