import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { ChatStateStore } from '../src/chat-state.js';
import { Chat, ConversationList } from './chat.js';
import { Icon } from './icons.js';
import { AiControls } from './ai-controls.js';
import { useDevServer } from './dev-server.js';

function Dialog({ title, children, close, drawer = false }: { title: string; children: ReactNode; close: () => void; drawer?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.showModal();
    return () => { ref.current?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  return <dialog ref={ref} className={drawer ? 'drawer' : 'dialog'} aria-label={title} onCancel={(event) => { event.preventDefault(); close(); }} onKeyDown={(event) => {
    if (event.key !== 'Tab') return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter((element) => element.getClientRects().length > 0);
    const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <div className="panel-heading"><strong>{title}</strong><button onClick={close} aria-label={`${title} 닫기`} autoFocus><Icon name="close" /></button></div>
    {children}
  </dialog>;
}

// The platform shell accepts optional navigation; Chat supplies its own list and body.
function WorkspaceShell({ name, online, sidebar, children, connection, settings, theme, toggleTheme, listOpen, toggleList, navigationLabel, devStop }: {
  name: string; online: boolean; sidebar?: ReactNode; children: ReactNode; connection: () => void;
  theme: string; toggleTheme: () => void; listOpen?: boolean; toggleList?: () => void; navigationLabel?: string;
  settings: () => void;
  devStop?: ReactNode;
}) {
  const [services, setServices] = useState(false);
  return <div className="window">
    <header className="chrome">
      <button className="mobile-services" onClick={() => setServices(true)} aria-label="서비스 열기"><Icon name="grid" /></button>
      <div className="brand"><span className="mark">w</span><span>WorkNaru</span></div>
      <span className="divider" /><span className="workspace-name" title={name}><Icon name="folder" />{name}</span>
      <span className="spacer" />{devStop}
      <button className="connection" onClick={connection}><span className={online ? 'dot' : 'dot offline'} />{online ? '연결됨' : '연결 끊김'}</button>
      <button className="theme" onClick={toggleTheme} aria-label={theme === 'dark' ? '밝은 테마' : '어두운 테마'}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
    </header>
    <div className="layout">
      <nav className="rail" aria-label="서비스"><button className="selected" aria-current="page" onClick={() => {}}><Icon name="chat" />Chat</button><span className="spacer" /><button onClick={settings} aria-label="Settings"><Icon name="settings" />설정</button></nav>
      {sidebar && <aside className="sidebar" aria-label="대화 목록">{sidebar}</aside>}
      <main className="main"><div className="module-tools">{toggleList && <button onClick={toggleList} aria-label={navigationLabel ?? '목록 열기 또는 접기'} aria-expanded={listOpen}><Icon name="list" /></button>}<span>기본 제공 Module</span></div>{children}</main>
    </div>
    {services && <Dialog title="서비스" close={() => setServices(false)} drawer><button className="service-entry selected" onClick={() => setServices(false)}><Icon name="chat" />Chat</button><button className="service-entry" onClick={() => { setServices(false); settings(); }}><Icon name="settings" />Settings</button></Dialog>}
  </div>;
}

export function App({ model }: { model: ChatStateStore }) {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [connectionOpen, setConnectionOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [endpoint, setEndpoint] = useState(() => document.querySelector<HTMLMetaElement>('meta[name="worknaru-dev-endpoint"]')?.content ?? 'ws://127.0.0.1:4310/ws');
  const [tokenInput, setTokenInput] = useState('');
  const credentials = useRef({ endpoint: '', token: '' });
  const dev = useDevServer((address) => endpoint.trim() === address && tokenInput ? tokenInput : credentials.current.endpoint === address ? credentials.current.token : '');
  const [theme, setTheme] = useState(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const [wide, setWide] = useState(innerWidth >= 860);
  const [expanded, setExpanded] = useState(true);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    const query = matchMedia('(min-width: 860px)');
    const update = () => { setWide(query.matches); setDrawer(false); };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const connect = async () => {
    credentials.current = { endpoint: endpoint.trim(), token: tokenInput };
    setTokenInput('');
    await model.connect(credentials.current.endpoint, credentials.current.token);
    if (model.getSnapshot().connection === 'online') setConnectionOpen(false);
  };
  const reconnect = () => {
    if (credentials.current.token) void model.connect(credentials.current.endpoint, credentials.current.token);
    else setConnectionOpen(true);
  };
  const list = <ConversationList state={state} model={model} select={(id) => { void model.select(id); setDrawer(false); }} />;
  const refreshSettings = () => { void model.refreshSettings(); void model.refreshAi(); };
  const workspaceName = state.workspace?.path.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Workspace';
  const devStop = dev.enabled && <button className="dev-stop" onClick={() => void dev.check()} disabled={dev.stage !== 'idle'}>개발 서버 종료</button>;
  if (dev.stage === 'stopped') return <main className="dev-stopped"><span className="mark">w</span><h1>종료되었습니다.</h1><p>대화와 설정은 보존했습니다. 이 탭을 닫아도 됩니다.</p><p className="muted">다시 시작하려면 프로젝트 폴더에서 npm run dev를 실행하세요.</p></main>;
  return <>
    <WorkspaceShell name={workspaceName} online={state.connection === 'online'} sidebar={wide && expanded ? list : undefined}
      theme={theme} toggleTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')} connection={() => setConnectionOpen(true)}
      settings={() => { setSettingsOpen(true); refreshSettings(); }}
      devStop={devStop}
      listOpen={wide ? expanded : drawer} navigationLabel="대화 목록 열기 또는 접기" toggleList={() => wide ? setExpanded(!expanded) : setDrawer(!drawer)}>
      <Chat state={state} model={model} reconnect={reconnect} />
    </WorkspaceShell>
    {!wide && drawer && <Dialog title="대화 목록" close={() => setDrawer(false)} drawer>{list}</Dialog>}
    {settingsOpen && <Dialog title="Settings" close={() => setSettingsOpen(false)}>
      <div className="settings-content">
        <section><h2>Workspace 연결</h2><p className="muted small">{state.connection === 'online' ? '연결됨' : '연결 끊김'} · {state.endpoint || endpoint}</p>
          <button className="settings-action" onClick={() => { setSettingsOpen(false); setConnectionOpen(true); }}>연결 설정 변경</button></section>
        <section><div className="settings-section-heading"><h2>AI 인증</h2><button className="settings-action" disabled={state.connection !== 'online' || state.busy || !!state.pending || state.aiLoading || state.settingsLoading} onClick={refreshSettings}>{state.aiLoading || state.settingsLoading ? '확인 중…' : '상태 새로고침'}</button></div>
          <p className="auth-status">{!state.ready?.aiExecution ? 'AI 연결 비활성' : state.aiLoading ? '인증 상태 확인 중…' : state.aiInfo ? ({ chatgpt: 'ChatGPT 로그인 정보 확인됨', apiKey: 'API 키 인증 정보 확인됨', other: '제공자 인증 정보 확인됨', signedOut: '로그인 정보 없음' })[state.aiInfo.authentication] : '인증 상태 확인 필요'}</p>
          <p className="muted small">기존 Codex CLI 로그인 정보를 사용합니다. WorkNaru 연결 키와 별개의 인증입니다.</p>
          {state.aiInfo?.authentication === 'signedOut' && <p className="muted small">Codex CLI에서 로그인한 뒤 Daemon을 다시 실행하세요.</p>}
          {state.aiError && <p className="error-text small" role="alert">{state.aiError}</p>}
        </section>
        <section><h2>새 대화 기본값</h2><p className="muted small">선택하면 저장됩니다. 기존 대화의 설정은 유지됩니다.</p>
          <AiControls defaults info={state.aiInfo} selection={state.settings?.selection} disabled={state.connection !== 'online' || state.busy || !!state.pending || !!state.settingsLoading || !state.settings?.storageAvailable} change={(selection) => void model.configure(selection)} />
          {state.settingsError && <p className="error-text small" role="alert">{state.settingsError}</p>}
        </section>
        <section><h2>Permission</h2><p className="muted small">텍스트 대화 · 도구 실행 미지원</p></section>
        {state.pending && <p role="status">{state.busy ? '접수 확인 중…' : '접수 여부 확인이 필요합니다.'}{!state.busy && <button className="settings-action" onClick={() => void model.resolvePending()}>접수 확인</button>}</p>}
        {state.error && <p className="error-text small" role="alert">{state.error}</p>}
      </div>
    </Dialog>}
    {connectionOpen && <Dialog title="Workspace 연결" close={() => setConnectionOpen(false)}>
      <p className="muted">실행 중인 로컬 Daemon에 연결합니다.</p>
      <form onSubmit={(event) => { event.preventDefault(); void connect(); }} className="connection-form">
        <label>Daemon 주소<input type="url" required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} spellCheck={false} /></label>
        <label>연결 키<input type="password" required value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} autoComplete="off" /></label>
        <p className="muted small">연결 키는 이 화면의 메모리에서만 사용합니다. 화면을 새로 열면 다시 입력합니다.</p>
        {state.error && <p role="alert" className="error-text">{state.error}</p>}
        <button className="primary" type="submit" disabled={state.connection === 'connecting'}>{state.connection === 'connecting' ? '연결 확인 중…' : '연결'}</button>
      </form>
      {devStop}
    </Dialog>}
    {dev.enabled && dev.stage !== 'idle' && <Dialog title="개발 서버 종료" close={() => { if (!['checking', 'stopping'].includes(dev.stage)) dev.dismiss(); }}>
      {dev.stage === 'key' && <form className="connection-form" onSubmit={(event) => { event.preventDefault(); void dev.check(dev.key); }}>
        <p>이번 실행의 연결 키를 붙여넣으세요.</p><label>종료용 연결 키<input type="password" autoComplete="off" value={dev.key} onChange={(event) => dev.setKey(event.target.value)} required /></label>
        <button type="submit" className="primary">종료 확인</button>
      </form>}
      {dev.stage === 'checking' && <p role="status">진행 중인 AI 응답을 확인하고 있습니다…</p>}
      {dev.stage === 'confirm' && <><p>진행 중인 AI 응답이 {dev.activeRuns}개 있습니다. 중단하고 개발 서버를 종료할까요?</p><p className="muted small">다른 탭의 응답도 중단됩니다. 저장된 기록은 남지만, 중단한 대화의 후속 질문은 새 대화에서 시작해야 합니다. 보내지 않은 초안은 저장되지 않습니다.</p><div className="dev-actions"><button onClick={dev.dismiss}>계속 점검하기</button><button className="primary" onClick={() => void dev.confirm()}>응답 중단 후 종료</button></div></>}
      {dev.stage === 'stopping' && <p role="status">AI 프로세스와 개발 서버를 종료하고 있습니다…</p>}
      {dev.stage === 'error' && <><p className="error-text" role="alert">{dev.error}</p><button onClick={dev.dismiss}>닫기</button></>}
    </Dialog>}
  </>;
}
