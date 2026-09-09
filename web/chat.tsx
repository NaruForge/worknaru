import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChatModel } from '../src/chat-model.js';
import type { Chat, Selection, TimelineItem } from '../src/chat-contract.js';
import { Button, Field, IconButton, Select, TextArea } from './ui.js';
import { Icon } from './icons.js';
import { applyAppearance, ColorPreference } from './appearance.js';

const labels: Record<Chat['status'], string> = { creating: '대화 생성 확인 중', ready: '입력 가능', sending: '입력 전달 중', running: '응답 중',
  approval: '권한 승인 대기', cancelling: '취소 확인 중', unknown: '결과 확인 필요', 'configuration-required': '모델 설정 확인 필요', unavailable: '연결 확인 필요' };
function Message({ item }: { item: TimelineItem }) {
  if (item.kind === 'tool' || item.kind === 'reasoning') return <details className="chat-detail"><summary>{item.kind === 'tool'
    ? `${item.tool?.name ?? '도구'} · ${item.tool?.state === 'running' ? '실행 중' : item.tool?.state === 'failed' ? '실패' : item.tool?.state === 'cancelled' ? '취소됨' : '완료'}` : '생각 과정'}</summary><pre>{item.text}</pre></details>;
  return <article className={`message ${item.kind}`}><div className="message-author">{item.kind === 'user' ? '나' : item.kind === 'assistant' ? 'AI' : '안내'}</div><div className="message-text">{item.text}</div></article>;
}
export function ChatApp({ model, appearance }: { model: ChatModel; appearance: ColorPreference }) {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [theme, setTheme] = useState<'light' | 'dark'>(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const [mobile, setMobile] = useState(matchMedia('(max-width: 859px)').matches);
  const [showList, setShowList] = useState(false);
  const scroller = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null), follow = useRef(true);
  const composing = useRef(false);
  const chat = state.view?.chat ?? state.chats.find(chat => chat.id === state.selectedId);
  const selection = chat?.selection ?? state.newSelection;
  const currentModel = state.models.find(model => model.id === selection.model);
  const idle = !chat || ['ready', 'configuration-required'].includes(chat.status);
  const canSend = state.connected && state.info?.connected && state.info.storageAvailable && (!chat || chat.status === 'ready') && !!currentModel;
  const canCancel = !!chat && ['sending', 'running', 'approval', 'cancelling', 'unknown'].includes(chat.status);
  useEffect(() => { void model.connect(); }, [model]);
  useEffect(() => {
    const media = matchMedia('(max-width: 859px)'); const change = () => setMobile(media.matches);
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => { applyAppearance(document.documentElement, appearance.getSnapshot().color, theme); }, [appearance, theme]);
  useLayoutEffect(() => { follow.current = true; if (!showList) input.current?.focus(); }, [state.selectedId, showList]);
  useLayoutEffect(() => { if (follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [state.view?.timeline.items]);
  const selectChat = (id: string | null) => { model.select(id); setShowList(false); };
  const changeModel = (id: string) => {
    const chosen = state.models.find(model => model.id === id); if (!chosen) return;
    const effort = chosen.efforts.some(effort => effort.id === selection.effort) ? selection.effort : chosen.efforts.find(effort => effort.id === 'low')?.id ?? chosen.efforts[0]?.id;
    if (effort) void model.configure({ model: id, effort });
  };
  const controls = <div className="ai-controls ai-controls--compact"><Field label="Model" labelHidden>{props => <Select {...props} compact leadingIcon={<Icon name="sparkles" />} value={selection.model}
    disabled={!state.connected || state.busy || !idle} onChange={event => changeModel(event.target.value)}>
    {!currentModel && <option value={selection.model}>{selection.model}</option>}{state.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
  </Select>}</Field><Field label="Reasoning Effort" labelHidden>{props => <Select {...props} compact leadingIcon={<Icon name="reasoning" />} value={selection.effort}
    disabled={!state.connected || state.busy || !idle || !currentModel} onChange={event => { void model.configure({ ...selection, effort: event.target.value } as Selection); }}>
    {!currentModel?.efforts.some(effort => effort.id === selection.effort) && <option value={selection.effort}>{selection.effort}</option>}
    {currentModel?.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.label}</option>)}
  </Select>}</Field></div>;
  return <div className={`window chat-product ${mobile ? 'window--stacked' : ''}`}>
    <header className="chrome"><div className="brand"><span className="mark">W</span><span>WorkNaru</span></div><span className="workspace-name">{state.info?.workspace.split(/[\\/]/).at(-1) ?? 'Workspace'}</span>
      <span className="chat-connection-status" role="status">{state.connected && state.info?.connected ? '연결됨' : '연결 확인 중'}</span>
      <IconButton label={theme === 'light' ? '어두운 화면' : '밝은 화면'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}><Icon name={theme === 'light' ? 'moon' : 'sun'} /></IconButton>
    </header>
    <div className="body">
      <nav className={`sidebar chat-navigation ${mobile ? 'stacked-list' : ''}`} aria-label="대화 목록" hidden={mobile && !showList}>
        <div className="panel-heading"><strong>Chat</strong><Button density="compact" onClick={() => { void model.refresh(); }}>새로고침</Button></div>
        <Button className="new-chat" variant="outline" onClick={() => selectChat(null)}>새 대화</Button>
        <div className="conversation-list">{state.chats.map(entry => <Button key={entry.id} aria-current={state.selectedId === entry.id ? 'page' : undefined} onClick={() => selectChat(entry.id)}>
          <span className="entry-title">{entry.title}</span><span className="entry-info">{labels[entry.status]}</span>
        </Button>)}</div><div className="sidebar-bottom">Workspace 안에서 AI와 작업하세요.</div>
      </nav>
      <main className={`main ${mobile ? 'stacked-main' : ''}`} hidden={mobile && showList}>
        {mobile && <div className="stacked-toolbar"><Button onClick={() => setShowList(true)}>← 대화 목록</Button></div>}
        <section className="chat" aria-label="Chat"><header className="chat-heading"><div><span className="eyebrow">Chat</span><h1>{chat?.title ?? '새 대화'}</h1></div><span className="run-state" role="status">{chat ? labels[chat.status] : '대화를 시작하세요'}</span></header>
          <div className="transcript-scroll" ref={scroller} onScroll={() => { const element = scroller.current!; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
            <div className="reading" aria-label="대화 기록" aria-live="polite">
              {state.view?.timeline.hasOlder && <Button className="more-records" onClick={() => { void model.older(); }}>이전 기록 보기</Button>}
              {!state.view?.timeline.items.length && <div className="empty"><div className="mark">W</div><h2>무엇을 함께 할까요?</h2><p>작업을 설명하거나 Workspace의 파일에 대해 물어보세요.</p></div>}
              {state.view?.timeline.items.map(item => <Message key={item.id} item={item} />)}
            </div>
          </div>
          <div className="compose-area">
            <div className="approval-stack">{chat?.permissions.map(permission => <details key={permission.id} className="file-approval"><summary><strong>도구 권한 요청</strong><span>{permission.title}</span><span className="file-approval-hint">내용 확인</span></summary>
              <div className="file-approval-body"><p>{permission.description}</p><pre className="chat-permission-detail">{permission.detail}</pre>
                {!permission.supported && <p role="alert">이 권한 양식은 지원하지 않습니다. 거절하거나 실행을 취소하세요.</p>}
                <div className="chat-permission-actions"><Button variant="primary" disabled={!state.connected || permission.responding || !permission.supported} onClick={() => { void model.permission(permission.id, 'allow'); }}>이번 요청 허용</Button>
                  <Button variant="outline" disabled={!state.connected || permission.responding} onClick={() => { void model.permission(permission.id, 'deny'); }}>거절</Button></div>
                {permission.responding && <p role="status">응답 결과를 확인하고 있습니다.</p>}
              </div></details>)}</div>
            {(state.error || chat?.error) && <div className="error-banner" role="alert"><span>{state.error ?? chat?.error}</span><Button density="compact" onClick={() => { void model.refresh(); }}>상태 확인</Button></div>}
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
        </section>
      </main>
    </div>
  </div>;
}
