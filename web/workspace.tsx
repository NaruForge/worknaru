import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { ChatStateStore } from '../src/chat-state.js';
import { Chat, ConversationList } from './chat.js';
import { Icon } from './icons.js';

function Dialog({ title, children, close, drawer = false }: { title: string; children: ReactNode; close: () => void; drawer?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.showModal();
    return () => { ref.current?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  return <dialog ref={ref} className={drawer ? 'drawer' : 'dialog'} aria-label={title} onCancel={(event) => { event.preventDefault(); close(); }} onKeyDown={(event) => {
    if (event.key !== 'Tab') return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter((element) => element.getClientRects().length > 0);
    const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <div className="panel-heading"><strong>{title}</strong><button onClick={close} aria-label={`${title} 닫기`} autoFocus><Icon name="close" /></button></div>
    {children}
  </dialog>;
}

// The platform shell accepts optional navigation; Chat supplies its own list and body.
function WorkspaceShell({ name, online, sidebar, children, connection, theme, toggleTheme, listOpen, toggleList, navigationLabel }: {
  name: string; online: boolean; sidebar?: ReactNode; children: ReactNode; connection: () => void;
  theme: string; toggleTheme: () => void; listOpen?: boolean; toggleList?: () => void; navigationLabel?: string;
}) {
  const [services, setServices] = useState(false);
  return <div className="window">
    <header className="chrome">
      <button className="mobile-services" onClick={() => setServices(true)} aria-label="서비스 열기"><Icon name="grid" /></button>
      <div className="brand"><span className="mark">w</span><span>WorkNaru</span></div>
      <span className="divider" /><span className="workspace-name" title={name}><Icon name="folder" />{name}</span>
      <span className="spacer" />
      <button className="connection" onClick={connection}><span className={online ? 'dot' : 'dot offline'} />{online ? '연결됨' : '연결 끊김'}</button>
      <button className="theme" onClick={toggleTheme} aria-label={theme === 'dark' ? '밝은 테마' : '어두운 테마'}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
    </header>
    <div className="layout">
      <nav className="rail" aria-label="서비스"><button className="selected" aria-current="page" onClick={() => {}}><Icon name="chat" />Chat</button><span className="spacer" /><button onClick={connection}><Icon name="settings" />연결</button></nav>
      {sidebar && <aside className="sidebar" aria-label="대화 목록">{sidebar}</aside>}
      <main className="main"><div className="module-tools">{toggleList && <button onClick={toggleList} aria-label={navigationLabel ?? '목록 열기 또는 접기'} aria-expanded={listOpen}><Icon name="list" /></button>}<span>기본 제공 Module</span></div>{children}</main>
    </div>
    {services && <Dialog title="서비스" close={() => setServices(false)} drawer><button className="service-entry selected" onClick={() => setServices(false)}><Icon name="chat" />Chat</button><button className="service-entry" onClick={() => { setServices(false); connection(); }}><Icon name="settings" />연결 설정</button></Dialog>}
  </div>;
}

export function App({ model }: { model: ChatStateStore }) {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [connectionOpen, setConnectionOpen] = useState(true);
  const [endpoint, setEndpoint] = useState('ws://127.0.0.1:4310/ws');
  const [tokenInput, setTokenInput] = useState('');
  const credentials = useRef({ endpoint: '', token: '' });
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
  const workspaceName = state.workspace?.path.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Workspace';
  return <>
    <WorkspaceShell name={workspaceName} online={state.connection === 'online'} sidebar={wide && expanded ? list : undefined}
      theme={theme} toggleTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')} connection={() => setConnectionOpen(true)}
      listOpen={wide ? expanded : drawer} navigationLabel="대화 목록 열기 또는 접기" toggleList={() => wide ? setExpanded(!expanded) : setDrawer(!drawer)}>
      <Chat state={state} model={model} reconnect={reconnect} />
    </WorkspaceShell>
    {!wide && drawer && <Dialog title="대화 목록" close={() => setDrawer(false)} drawer>{list}</Dialog>}
    {connectionOpen && <Dialog title="Workspace 연결" close={() => setConnectionOpen(false)}>
      <p className="muted">실행 중인 로컬 Daemon에 연결합니다.</p>
      <form onSubmit={(event) => { event.preventDefault(); void connect(); }} className="connection-form">
        <label>Daemon 주소<input type="url" required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} spellCheck={false} /></label>
        <label>연결 키<input type="password" required value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} autoComplete="off" /></label>
        <p className="muted small">연결 키는 이 화면의 메모리에서만 사용합니다. 화면을 새로 열면 다시 입력합니다.</p>
        {state.error && <p role="alert" className="error-text">{state.error}</p>}
        <button className="primary" type="submit" disabled={state.connection === 'connecting'}>{state.connection === 'connecting' ? '연결 확인 중…' : '연결'}</button>
      </form>
    </Dialog>}
  </>;
}
