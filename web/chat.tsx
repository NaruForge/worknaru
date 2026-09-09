import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { ChatModel } from '../src/chat-model.js';
import type { Chat, Selection, TimelineItem } from '../src/chat-contract.js';
import { Button, Field, IconButton, Select, TextArea } from './ui.js';
import { Icon } from './icons.js';
import { ColorPreference } from './appearance.js';
import { useAppearance } from './appearance-settings.js';
import { WorkspaceShell } from './shell.js';
import { SettingsNavigation } from './settings-navigation.js';
import { Settings } from './settings.js';
import { useNavigation } from './navigation.js';
import { useChatScroll } from './chat-scroll.js';

const labels: Record<Chat['status'], string> = { creating: '대화 생성 확인 중', ready: '입력 가능', sending: '입력 전달 중', running: '응답 중',
  approval: '권한 승인 대기', cancelling: '취소 확인 중', unknown: '결과 확인 필요', 'configuration-required': '모델 설정 확인 필요', unavailable: '연결 확인 필요' };
function Message({ item }: { item: TimelineItem }) {
  if (item.kind === 'tool' || item.kind === 'reasoning') return <details className="chat-detail" data-message-id={item.id}><summary>{item.kind === 'tool'
    ? `${item.tool?.name ?? '도구'} · ${item.tool?.state === 'running' ? '실행 중' : item.tool?.state === 'failed' ? '실패' : item.tool?.state === 'cancelled' ? '취소됨' : '완료'}` : '생각 과정'}</summary><pre>{item.text}</pre></details>;
  return <article className={`message ${item.kind}`} data-message-id={item.id}><div className="message-author">{item.kind === 'user' ? '나' : item.kind === 'assistant' ? 'AI' : '안내'}</div><div className="message-text">{item.text}</div></article>;
}
type State = ReturnType<ChatModel['getSnapshot']>;
function ChatPanel({ model, state, visible }: { model: ChatModel; state: State; visible: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const { scroller, onScroll, follow, away } = useChatScroll(`${state.info?.storeId}:${state.selectedId}`, state.view?.timeline, visible);
  const composing = useRef(false);
  const chat = state.view?.chat ?? state.chats.find(chat => chat.id === state.selectedId);
  const selection = chat?.selection ?? state.newSelection;
  const currentModel = state.models.find(model => model.id === selection.model);
  const idle = !state.viewLoading && !state.checking && !state.refreshError && (!state.selectedId || !!chat && ['ready', 'configuration-required'].includes(chat.status));
  const canSend = state.connected && state.info?.connected && state.info.storageAvailable && !!state.settings && !state.modelsLoading && !state.checking && !state.refreshError && !state.viewLoading &&
    (!state.selectedId || chat?.status === 'ready') && !!currentModel?.efforts.some(effort => effort.id === selection.effort);
  const canCancel = !!chat && ['sending', 'running', 'approval', 'cancelling', 'unknown'].includes(chat.status);
  const changeModel = (id: string) => {
    const chosen = state.models.find(model => model.id === id); if (!chosen) return;
    const effort = chosen.efforts.some(effort => effort.id === selection.effort) ? selection.effort : chosen.efforts.find(effort => effort.id === 'low')?.id ?? chosen.efforts[0]?.id;
    if (effort) void model.configure({ model: id, effort });
  };
  const controls = <div className="ai-controls ai-controls--compact"><Field label="Model" labelHidden>{props => <Select {...props} compact leadingIcon={<Icon name="sparkles" />} value={selection.model}
    disabled={!state.connected || !state.info?.connected || state.busy || state.modelsLoading || !idle} onChange={event => changeModel(event.target.value)}>
    {!currentModel && <option value={selection.model}>{selection.model}</option>}{state.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
  </Select>}</Field><Field label="Reasoning Effort" labelHidden>{props => <Select {...props} compact leadingIcon={<Icon name="reasoning" />} value={selection.effort}
    disabled={!state.connected || !state.info?.connected || state.busy || state.modelsLoading || !idle || !currentModel} onChange={event => { void model.configure({ ...selection, effort: event.target.value } as Selection); }}>
    {!currentModel?.efforts.some(effort => effort.id === selection.effort) && <option value={selection.effort}>{selection.effort}</option>}
    {currentModel?.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.label}</option>)}
  </Select>}</Field></div>;
  const error = state.error ?? state.catalogError ?? state.refreshError ?? chat?.error;
  return <section className="chat" aria-label="Chat"><header className="chat-heading"><div><span className="eyebrow">Chat</span><h1>{chat?.title ?? '새 대화'}</h1></div><span className="run-state" role="status">{state.viewLoading ? '기록 확인 중' : chat ? labels[chat.status] : '대화를 시작하세요'}</span></header>
          <div className="transcript-scroll" ref={scroller} onScroll={onScroll}>
            <div className="reading" aria-label="대화 기록" aria-live="polite">
              {state.view?.timeline.hasOlder && <Button className="more-records" onClick={() => { void model.older(); }}>이전 기록 보기</Button>}
              {!state.view?.timeline.items.length && <div className="empty"><div className="mark">W</div><h2>무엇을 함께 할까요?</h2><p>작업을 설명하거나 Workspace의 파일에 대해 물어보세요.</p></div>}
              {state.view?.timeline.items.map(item => <Message key={item.id} item={item} />)}
            </div>
          </div>
          {away && <Button density="compact" className="new-output" onClick={follow}>최근 내용으로 이동 ↓</Button>}
          <div className="compose-area">
            <div className="approval-stack">{chat?.permissions.map(permission => <details key={permission.id} className="file-approval"><summary><strong>도구 권한 요청</strong><span>{permission.title}</span><span className="file-approval-hint">내용 확인</span></summary>
              <div className="file-approval-body"><p>{permission.description}</p><pre className="chat-permission-detail">{permission.detail}</pre>
                {!permission.supported && <p role="alert">이 권한 양식은 지원하지 않습니다. 거절하거나 실행을 취소하세요.</p>}
                <div className="chat-permission-actions"><Button variant="primary" disabled={!state.connected || permission.responding || !permission.supported} onClick={() => { void model.permission(permission.id, 'allow'); }}>이번 요청 허용</Button>
                  <Button variant="outline" disabled={!state.connected || permission.responding} onClick={() => { void model.permission(permission.id, 'deny'); }}>거절</Button></div>
                {permission.responding && <p role="status">응답 결과를 확인하고 있습니다.</p>}
              </div></details>)}</div>
            {error && <div className="error-banner" role="alert"><span>{error}</span><Button density="compact" disabled={state.modelsLoading} onClick={() => { void model.retry(); }}>상태 확인</Button></div>}
            {!error && !state.modelsLoading && state.connected && state.settings && !currentModel?.efforts.some(effort => effort.id === selection.effort) &&
              <p className="notice">선택한 모델과 추론 강도를 확인할 수 없습니다. 지원하는 값을 선택하거나 목록을 다시 조회하세요.</p>}
            {chat?.status === 'unknown' && <p className="notice notice--neutral">이 입력의 종료를 확인하지 못했습니다. 기록과 상태를 확인하고, 필요하면 새 대화에서 이어가세요. 자동으로 다시 전송하지 않습니다.</p>}
            {chat?.status === 'creating' && <Button disabled={state.busy} onClick={() => { void model.recover(); }}>대화 생성 결과 확인</Button>}
            {chat?.status === 'configuration-required' && <Button disabled={state.busy} onClick={() => { void model.configure(selection); }}>표시된 모델 설정 확인</Button>}
            <form className="compose" onSubmit={event => { event.preventDefault(); void model.send(); }}>
              <TextArea ref={input} aria-label="메시지" presentation="plain" rows={3} placeholder="메시지를 입력하세요" value={state.draft} onChange={event => model.setDraft(event.target.value)}
                onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
                onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (canSend) void model.send(); } }} />
              <div className="compose-controls">{controls}{canCancel
                ? <IconButton shape="round" label="실행 취소" disabled={!state.connected || chat?.status === 'cancelling'} onClick={() => { void model.cancel(); }}><Icon name="stop" /></IconButton>
                : <IconButton shape="round" label="메시지 보내기" variant="primary" type="submit" disabled={!canSend || state.busy || !state.draft.trim()}><Icon name="arrow" /></IconButton>}</div>
            </form><p className="compose-help">Workspace 파일 수정은 기본 허용 · 추가 권한은 요청 시 승인</p>
            <div className="chat-outcome" role="status">{state.lastOutcome}</div>
          </div>
        </section>;
}

function ConversationList({ state, model, select, position, visible }: { state: State; model: ChatModel;
  select: (id: string | null) => void; position: RefObject<number>; visible: boolean }) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (list.current && visible) list.current.scrollTop = position.current; }, [visible, position]);
  return <div className="chat-navigation">
    <div className="panel-heading"><strong>Chat</strong><Button density="compact" disabled={state.modelsLoading} onClick={() => { void model.retry(); }}>새로고침</Button></div>
    <Button className="new-chat" variant="outline" onClick={() => select(null)}>새 대화</Button>
    <div className="conversation-list" ref={list} onScroll={() => { if (visible && list.current?.getClientRects().length) position.current = list.current.scrollTop; }}>
      {state.chats.map(entry => <Button key={entry.id} aria-current={state.selectedId === entry.id ? 'page' : undefined} onClick={() => select(entry.id)}>
        <span className="entry-title">{entry.title}</span><span className="entry-info">{labels[entry.status]}</span>
      </Button>)}
    </div><div className="sidebar-bottom">Workspace 안에서 AI와 작업하세요.</div>
  </div>;
}

export function ChatApp({ model, appearance }: { model: ChatModel; appearance: ColorPreference }) {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [theme, setTheme] = useState<'light' | 'dark'>(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const [mobile, setMobile] = useState(matchMedia('(max-width: 859px)').matches);
  const [lists, setLists] = useState({ chat: true, settings: true });
  const scope = state.info ? `${state.info.storeId}:${state.info.workspace}` : null;
  const { route, navigate } = useNavigation(scope, state.selectedId, id => model.select(id));
  const root = useRef<HTMLDivElement>(null), listPosition = useRef(0);
  const settings = route.screen === 'settings', mainVisible = !mobile || route.view === 'main';
  useAppearance(appearance, theme);
  useEffect(() => { void model.connect(); }, [model]);
  useEffect(() => {
    const media = matchMedia('(max-width: 859px)'); const change = () => setMobile(media.matches);
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  useLayoutEffect(() => {
    const selector = mobile && route.view === 'modules' ? '.module-picker h1' : mobile && route.view === 'list'
      ? '.stacked-list [aria-current=page], .stacked-list .new-chat' : settings ? '.main-panel-heading h1' : 'textarea';
    const focus = root.current?.querySelector<HTMLElement>(selector);
    if (focus?.getClientRects().length) focus.focus({ preventScroll: true });
  }, [route.screen, route.view, route.section, mobile, state.selectedId]);
  const openChat = () => navigate({ screen: 'chat', view: mobile ? 'list' : 'main' });
  const openSettings = () => navigate({ screen: 'settings', view: mobile ? 'list' : 'main' });
  const sidebar = settings ? <SettingsNavigation selected={route.section} select={section => navigate({ section, view: 'main' })} />
    : <ConversationList state={state} model={model} position={listPosition} visible={!mobile || route.view === 'list'} select={chatId => navigate({ screen: 'chat', view: 'main', chatId })} />;
  return <div ref={root}>
    <WorkspaceShell className="chat-product" name={state.info?.workspace ?? 'Workspace'} online={state.connected && !!state.info?.connected}
      theme={theme} toggleTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')}
      connection={() => navigate({ screen: 'settings', section: 'connection', view: 'main' })} settings={openSettings} chat={openChat}
      settingsActive={settings} sectionLabel={settings ? '플랫폼 설정' : '기본 제공 Module'}
      sidebarLabel={settings ? '설정 메뉴' : '대화 목록'} sidebar={!mobile && lists[route.screen] ? sidebar : undefined}
      listOpen={lists[route.screen]} toggleList={() => setLists({ ...lists, [route.screen]: !lists[route.screen] })}
      navigationLabel={settings ? '설정 목록 열기 또는 접기' : '대화 목록 열기 또는 접기'}
      stacked={mobile ? { view: route.view, list: sidebar, backLabel: route.view === 'main' ? settings ? '← 설정 목록' : '← 대화 목록' : '← Module 선택',
        back: () => navigate({ view: route.view === 'main' ? 'list' : 'modules' }) } : undefined}>
      <div className="chat-host" hidden={settings}><ChatPanel state={state} model={model} visible={!settings && mainVisible} /></div>
      {settings && <Settings section={route.section} state={state} model={model} appearance={appearance} back={() => navigate({ screen: 'chat', view: 'main' })} />}
    </WorkspaceShell>
  </div>;
}
