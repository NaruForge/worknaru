import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatStateStore } from '../src/chat-state.js';
import { Chat, ConversationList } from './chat.js';
import type { TranscriptPosition } from './chat.js';
import { Button, Field, Input, Dialog, MainPanel } from './ui.js';
import { WorkspaceShell } from './shell.js';
import type { ColorPreference } from './appearance.js';
import { AppearanceSettings, useAppearance } from './appearance-settings.js';
import type { Mode } from './theme-palette.js';
import { useWorkspaceNavigation } from './navigation.js';
import { SettingsNavigation } from './settings-navigation.js';
import { AiControls } from './ai-controls.js';
import { defaultDaemonEndpoint, developmentEndpoint, developmentKeyRequired, useDevServer } from './dev-server.js';
import { FileApprovalPanel, fileStateLabel } from './file-approval.js';

export function App({ model, appearance }: { model: ChatStateStore; appearance: ColorPreference }) {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [keyRequired] = useState(developmentKeyRequired);
  const [connectionOpen, setConnectionOpen] = useState(keyRequired);
  const navigation = useWorkspaceNavigation(model);
  const settingsOpen = navigation.route.module === 'settings';
  const settingsSection = navigation.route.settingsSection;
  const activeRoute = useRef(navigation.route);
  activeRoute.current = navigation.route;
  const chatListScroll = useRef(0);
  const transcriptPosition = useRef<TranscriptPosition | undefined>(undefined);
  const [permissionId, setPermissionId] = useState<string>();
  const fileRequests = Object.values(state.runs).flatMap((run) => run.tools.map((tool) => ({ run, tool })));
  const displayedPermissions = fileRequests.filter(({ run, tool }) => (run.state === 'running' && tool.state === 'pending') || tool.toolId === permissionId);
  const [endpoint, setEndpoint] = useState(() => defaultDaemonEndpoint());
  const [tokenInput, setTokenInput] = useState('');
  const credentials = useRef({ endpoint: '', token: '' });
  const autoConnected = useRef(false);
  const dev = useDevServer((address) => endpoint.trim() === address && tokenInput ? tokenInput : credentials.current.endpoint === address ? credentials.current.token : '');
  const [theme, setTheme] = useState<Mode>(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const [wide, setWide] = useState(innerWidth >= 860);
  const [expanded, setExpanded] = useState({chat: true, settings: true});
  useEffect(() => {
    const query = matchMedia('(min-width: 860px)');
    const update = () => setWide(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useAppearance(appearance, theme);
  useEffect(() => {
    const address = developmentEndpoint();
    if (!keyRequired && address && !autoConnected.current) {
      autoConnected.current = true;
      credentials.current = { endpoint: address, token: '' };
      void model.connect(address, '').then(async () => {
        await navigation.connected();
        if (model.getSnapshot().connection !== 'online') setConnectionOpen(true);
      });
    }
  }, [model, keyRequired]);
  const connect = async () => {
    credentials.current = { endpoint: endpoint.trim(), token: tokenInput };
    setTokenInput('');
    await model.connect(credentials.current.endpoint, credentials.current.token);
    if (model.getSnapshot().connection === 'online') { await navigation.connected(); setConnectionOpen(false); }
  };
  const reconnect = () => {
    if (credentials.current.endpoint && (!keyRequired || credentials.current.token)) void model.connect(credentials.current.endpoint, credentials.current.token).then(navigation.connected);
    else setConnectionOpen(true);
  };
  const createSession = async () => {
    const before = model.getSnapshot().selected;
    await model.createSession();
    const selected = model.getSnapshot().selected;
    if (selected && selected !== before && activeRoute.current.module === 'chat' && activeRoute.current.view !== 'modules') navigation.openSession(selected);
  };
  const listStatus = !wide && navigation.route.view === 'list' && <div className="list-status">
    {state.connection !== 'online' && <p role="status">{state.connection === 'connecting' ? '연결 확인 중…' : '연결이 끊겼습니다.'}<Button disabled={state.connection === 'connecting'} onClick={reconnect}>다시 연결</Button></p>}
    {state.pending && <p role="status">{state.busy ? '접수 확인 중…' : '접수 여부 확인이 필요합니다.'}{!state.busy && <Button disabled={state.connection !== 'online'} onClick={() => void model.resolvePending()}>접수 확인</Button>}</p>}
    {state.error && <p className="error-text" role="alert">{state.error}</p>}
  </div>;
  const list = <>{settingsOpen ? <SettingsNavigation selected={settingsSection} select={navigation.openSettings} /> : <ConversationList state={state} model={model} select={navigation.openSession} create={() => void createSession()} scrollPosition={chatListScroll} visible={wide || navigation.route.view === 'list'} />}{listStatus}</>;
  useEffect(() => {
    if (wide) return;
    const frame = requestAnimationFrame(() => {
      if (document.querySelector('dialog[open]')) return;
      const selector = navigation.route.view === 'modules' ? '.module-picker h1' : navigation.route.view === 'list' ? '.stacked-list [aria-current], .stacked-list .ui-button' : '.stacked-toolbar .ui-button';
      document.querySelector<HTMLElement>(selector)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [wide, navigation.route.module, navigation.route.view]);
  const refreshSettings = () => { void model.refreshSettings(); void model.refreshAi(); };
  const workspaceName = state.workspace?.path.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Workspace';
  const devStop = dev.enabled && <Button className="dev-stop" onClick={() => void dev.check()} disabled={dev.stage !== 'idle'}>개발 서버 종료</Button>;
  if (dev.stage === 'stopped') return <main className="dev-stopped"><span className="mark">w</span><h1>종료되었습니다.</h1><p>대화와 설정은 보존했습니다. 이 탭을 닫아도 됩니다.</p><p className="muted">다시 시작하려면 프로젝트 폴더에서 npm run dev를 실행하세요.</p></main>;
  return <>
    <WorkspaceShell sidebarLabel={settingsOpen ? '설정 메뉴' : '대화 목록'} name={workspaceName} online={state.connection === 'online'} sidebar={wide && expanded[navigation.route.module] ? list : undefined}
      theme={theme} toggleTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')} connection={() => setConnectionOpen(true)}
      settings={() => { navigation.openModule('settings'); refreshSettings(); }} chat={() => navigation.openModule('chat')} settingsActive={settingsOpen} sectionLabel={settingsOpen ? '플랫폼 설정' : undefined}
      devStop={devStop}
      listOpen={expanded[navigation.route.module]} navigationLabel={settingsOpen ? '설정 메뉴 열기 또는 접기' : '대화 목록 열기 또는 접기'} toggleList={wide ? () => setExpanded(current => ({...current, [navigation.route.module]: !current[navigation.route.module]})) : undefined}
      stacked={!wide ? {view: navigation.route.view, list, backLabel: navigation.route.view === 'main' ? settingsOpen ? '← 설정 메뉴' : '← 대화 목록' : '← Module', back: navigation.back} : undefined}>

      {settingsOpen ? (wide || navigation.route.view === 'main') && <MainPanel title="설정" back={wide ? () => navigation.openModule('chat') : undefined}>
      <div className="settings-content">
        {settingsSection === 'appearance' && <AppearanceSettings preference={appearance} />}
        {settingsSection === 'connection' && <section><h2>Workspace 연결</h2><p className="muted small">{state.connection === 'online' ? '연결됨' : '연결 끊김'} · {state.endpoint || endpoint}</p>
          <Button variant="outline" className="settings-action" onClick={() => setConnectionOpen(true)}>연결 설정 변경</Button></section>}
        {settingsSection === 'ai' && <><section><div className="settings-section-heading"><h2>AI 인증</h2><Button variant="outline" className="settings-action" disabled={state.connection !== 'online' || state.busy || !!state.pending || state.aiLoading || state.settingsLoading} onClick={refreshSettings}>{state.aiLoading || state.settingsLoading ? '확인 중…' : '상태 새로고침'}</Button></div>
          <p className="auth-status">{!state.ready?.aiExecution ? 'AI 연결 비활성' : state.aiLoading ? '인증 상태 확인 중…' : state.aiInfo ? ({ chatgpt: 'ChatGPT 로그인 정보 확인됨', apiKey: 'API 키 인증 정보 확인됨', other: '제공자 인증 정보 확인됨', signedOut: '로그인 정보 없음' })[state.aiInfo.authentication] : '인증 상태 확인 필요'}</p>
          <p className="muted small">기존 Codex CLI 로그인 정보를 사용합니다. WorkNaru 연결 키와 별개의 인증입니다.</p>
          {state.aiInfo?.authentication === 'signedOut' && <p className="muted small">Codex CLI에서 로그인한 뒤 Daemon을 다시 실행하세요.</p>}
          {state.aiError && <p className="error-text small" role="alert">{state.aiError}</p>}
        </section>
        <section><h2>새 대화 기본값</h2><p className="muted small">선택하면 저장됩니다. 기존 대화의 설정은 유지됩니다.</p>
          <AiControls defaults info={state.aiInfo} selection={state.settings?.selection} disabled={state.connection !== 'online' || state.busy || !!state.pending || !!state.settingsLoading || !state.settings?.storageAvailable} change={(selection) => void model.configure(selection)} />
          {state.settingsError && <p className="error-text small" role="alert">{state.settingsError}</p>}
        </section>
        <section><h2>파일 수정 권한</h2><p className="muted small">{state.ready?.capabilities.includes('permissions.respond') ? 'Workspace 텍스트 파일 수정 · 요청마다 변경 내용을 확인하고 허용 또는 거절합니다.' : '텍스트 대화 · 도구 실행 미지원'}</p></section></>}
        {state.pending && <p role="status">{state.busy ? '접수 확인 중…' : '접수 여부 확인이 필요합니다.'}{!state.busy && <Button variant="outline" className="settings-action" onClick={() => void model.resolvePending()}>접수 확인</Button>}</p>}
        {state.error && <p className="error-text small" role="alert">{state.error}</p>}
      </div>
    </MainPanel> : <Chat state={state} model={model} scrollPosition={transcriptPosition} reconnect={reconnect} create={() => void createSession()} visible={wide || navigation.route.view === 'main'} approvals={displayedPermissions.map(permission => <FileApprovalPanel key={permission.tool.toolId} tool={permission.tool} open={permissionId === permission.tool.toolId} context={state.sessions.find(session => session.sessionId === permission.run.sessionId)?.title} onToggle={open => setPermissionId(current => open ? permission.tool.toolId : current === permission.tool.toolId ? undefined : current)}><div className="permission-content">
        <p role="status" aria-label="파일 수정 상태">{fileStateLabel(permission.tool)}</p>
        {permission.tool.errorCode === 'FILE_CONFLICT' && <p>승인 대기 중 원본이 변경되어 덮어쓰지 않았습니다. 파일을 다시 읽고 수정안을 확인하세요.</p>}
        {permission.tool.state === 'unknown' && <p>파일의 실제 내용을 확인하세요. 이 요청은 자동 재실행하지 않습니다.</p>}
        {permission.tool.state === 'pending' && <><p className="muted small">이번 수정에만 적용됩니다. 접어도 승인하거나 거절하지 않습니다.</p><div className="permission-actions">
          <Button disabled={state.connection !== 'online' || state.busy || !!state.pending || !permission.run.storageAvailable} onClick={() => void model.respondPermission(permission.run.runId, permission.tool.toolId, 'reject')}>거절</Button>
          <Button variant="primary" disabled={state.connection !== 'online' || state.busy || !!state.pending || !permission.run.storageAvailable} onClick={() => void model.respondPermission(permission.run.runId, permission.tool.toolId, 'allow')}>이번 수정 허용</Button>
          <Button disabled={state.connection !== 'online' || state.busy || !!state.pending || !permission.run.storageAvailable} onClick={() => void model.cancel(permission.run.runId)}>실행 중지</Button>
        </div></>}
        {state.connection !== 'online' && <p role="status">연결이 끊겼습니다. 다시 연결한 뒤 현재 승인 상태를 확인하세요.</p>}
        {!permission.run.storageAvailable && <p role="alert">저장 상태를 확인하지 못했습니다. 파일 적용 결과를 추정하지 말고 저장소 복구 후 다시 확인하세요.</p>}
        {state.pending && <p role="status">{state.busy ? '접수 확인 중…' : '접수 여부 확인이 필요합니다.'}{!state.busy && <Button onClick={() => void model.resolvePending()}>접수 확인</Button>}</p>}
        {state.error && <p className="error-text" role="alert">{state.error}</p>}
      </div></FileApprovalPanel>)} />}
    </WorkspaceShell>
    {connectionOpen && <Dialog title="Workspace 연결" close={() => setConnectionOpen(false)}>
      <p className="muted">실행 중인 로컬 Daemon에 연결합니다.</p>
      <form onSubmit={(event) => { event.preventDefault(); void connect(); }} className="connection-form">
        <Field label="Daemon 주소">{props => <Input {...props} type="url" required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} spellCheck={false} />}</Field>
        {keyRequired && <><Field label="연결 키">{props => <Input {...props} type="password" required value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} autoComplete="off" />}</Field>
        <p className="muted small">연결 키는 이 화면의 메모리에서만 사용합니다. 화면을 새로 열면 다시 입력합니다.</p></>}
        {state.error && <p role="alert" className="error-text">{state.error}</p>}
        <Button variant="primary" type="submit" disabled={state.connection === 'connecting'}>{state.connection === 'connecting' ? '연결 확인 중…' : '연결'}</Button>
      </form>
      {devStop}
    </Dialog>}
    {dev.enabled && dev.stage !== 'idle' && <Dialog title="개발 서버 종료" close={() => { if (!['checking', 'stopping'].includes(dev.stage)) dev.dismiss(); }}>
      {dev.stage === 'key' && <form className="connection-form" onSubmit={(event) => { event.preventDefault(); void dev.check(dev.key); }}>
        <p>이번 실행의 연결 키를 붙여넣으세요.</p><Field label="종료용 연결 키">{props => <Input {...props} type="password" autoComplete="off" value={dev.key} onChange={(event) => dev.setKey(event.target.value)} required />}</Field>
        <Button type="submit" variant="primary">종료 확인</Button>
      </form>}
      {dev.stage === 'checking' && <p role="status">진행 중인 AI 응답을 확인하고 있습니다…</p>}
      {dev.stage === 'confirm' && <><p>진행 중인 AI 응답이 {dev.activeRuns}개 있습니다. 중단하고 개발 서버를 종료할까요?</p><p className="muted small">다른 탭의 응답도 중단됩니다. 저장된 기록은 남지만, 중단한 대화의 후속 질문은 새 대화에서 시작해야 합니다. 보내지 않은 초안은 저장되지 않습니다.</p><div className="dev-actions"><Button onClick={dev.dismiss}>계속 점검하기</Button><Button variant="primary" onClick={() => void dev.confirm()}>응답 중단 후 종료</Button></div></>}
      {dev.stage === 'stopping' && <p role="status">AI 프로세스와 개발 서버를 종료하고 있습니다…</p>}
      {dev.stage === 'error' && <><p className="error-text" role="alert">{dev.error}</p><Button onClick={dev.dismiss}>닫기</Button></>}
    </Dialog>}
  </>;
}
