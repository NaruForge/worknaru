import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { ChatState, ChatStateStore } from '../src/chat-state.js';
import type { Run, Session } from '../src/web-client.js';
import { Icon } from './icons.js';
import { Button, IconButton, TextArea } from './ui.js';
import { AiControls } from './ai-controls.js';
import { FileToolHistory } from './file-approval.js';

const active = (run?: Run) => run && ['running', 'cancelling'].includes(run.state);
const runLabel = (run?: Run) => !run ? '새 대화' : run.tools.some((tool) => tool.state === 'pending') ? '파일 수정 승인 대기' : ({ running: '응답 중', cancelling: '중지 중', completed: '응답 완료', cancelled: '중지 완료', failed: '응답 실패' })[run.state];
const currentRun = (state: ChatState, session?: Session) => session?.latestRunId ? state.runs[session.latestRunId] : undefined;

export type TranscriptPosition = { key: string; top: number; stick: boolean };

export function ConversationList({ state, model, select, create, scrollPosition, visible }: { state: ChatState; model: ChatStateStore; select: (id: string) => void; create: () => void; scrollPosition: RefObject<number>; visible: boolean }) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (list.current && visible) list.current.scrollTop = scrollPosition.current; }, [scrollPosition, visible]);
  return <div className="chat-navigation">
    <div className="panel-heading"><strong>Chat</strong></div>
    <Button variant="outline" className="new-chat" disabled={state.connection !== 'online' || state.busy || !!state.pending} onClick={create}><Icon name="plus" />새 대화</Button>
    <span className="list-caption">대화</span>
    <div className="conversation-list" ref={list} onScroll={event => { if (event.currentTarget.getClientRects().length) scrollPosition.current = event.currentTarget.scrollTop; }}>
      {state.sessions.map((session) => <Button key={session.sessionId} className={state.selected === session.sessionId ? 'selected' : ''} aria-current={state.selected === session.sessionId ? 'true' : undefined} onClick={() => select(session.sessionId)}>
        <span className="entry-title">{session.title}</span>
        <span className="entry-info">{session.latestRunState === 'running' ? '응답 중' : session.latestRunState === 'cancelling' ? '중지 중' : session.aiUnavailable ? '기록 보기' : '대화'}{state.drafts[session.sessionId] ? ' · 초안 있음' : ''}</span>
      </Button>)}
      {!state.sessions.length && <p className="muted small">새 대화를 시작하면 여기에 표시됩니다.</p>}
      {state.nextSession !== null && <Button onClick={() => void model.moreSessions()} disabled={state.connection !== 'online'}>대화 더 불러오기</Button>}
    </div>
    <p className="sidebar-bottom">기록은 연결된 Workspace에 보관됩니다.</p>
  </div>;
}

function notice(state: ChatState, session?: Session, run?: Run): { title: string; text: string; action?: 'reconnect' | 'check' | 'new'; neutral?: boolean } | undefined {
  if (state.connection !== 'online') return { title: state.connection === 'connecting' ? '연결 확인 중' : '연결이 끊겼습니다', text: '마지막 확인 기록을 표시합니다. 연결 후 현재 상태를 다시 확인합니다.', action: 'reconnect' };
  if (state.pending) return { title: state.busy ? (state.pending.method === 'runs.cancel' ? '중지 접수 확인 중' : '접수 확인 중') : '접수 여부를 확인해야 합니다', text: '같은 요청의 접수 기록을 조회합니다. 새 요청으로 자동 재전송하지 않습니다.', action: state.busy ? undefined : 'check' };
  if (session?.storageAvailable === false || run?.storageAvailable === false) return { title: '저장 상태를 확인할 수 없습니다', text: '마지막 저장 확인 내용만 표시합니다. Daemon의 저장 문제를 해결한 뒤 기록 상태를 확인해 주세요.', action: 'check' };
  if (run?.errorCode === 'PROCESS_CLEANUP_UNKNOWN') return { title: '실행 종료를 확인할 수 없습니다', text: '이 대화의 새 실행을 막았습니다. Daemon에서 종료가 확인될 때까지 기다려 주세요.', action: 'check' };
  if (run?.errorCode && ['MODEL_UNCONFIRMED', 'MODEL_UNSUPPORTED', 'TEST_MODEL_REQUIRED'].includes(run.errorCode)) return { title: '모델 설정을 적용하지 못했습니다', text: '선택한 모델과 추론 강도를 확인하지 못해 질문을 전달하지 않았습니다. 입력과 기록은 보존됩니다. 설정을 확인하고 새 대화를 시작해 주세요.', action: 'new' };
  if (run?.errorCode?.startsWith('SESSION_RESUME_')) return { title: '기존 대화를 이어갈 수 없습니다', text: 'AI가 이전 대화를 불러오지 못해 새 질문을 전달하지 않았습니다. 입력과 저장된 기록은 남아 있습니다. 새 대화에서 시작해 주세요.', action: 'new' };
  if (run?.errorCode === 'AGENT_CAPACITY') return { title: 'AI 연결 한도에 도달했습니다', text: '현재 최대 4개 대화를 AI에 연결할 수 있습니다. 목록에서 연결이 유지된 다른 대화를 선택해 주세요.' };
  if (run?.state === 'cancelling') return { neutral: true, title: '중지 중', text: '중지 요청을 접수했습니다. 실제 실행이 끝나는지 확인하고 있습니다.' };
  if (run?.state === 'cancelled') return { neutral: true, title: '응답을 중지했습니다', text: '저장된 부분은 남아 있습니다. 대화를 이어가려면 새 대화를 시작해 주세요.', action: 'new' };
  if (session?.aiUnavailable) return { neutral: true, title: '이 대화는 기록 보기로 열렸습니다', text: 'AI 연결이 종료되어 기존 맥락을 이어갈 수 없습니다. 새 대화에서 시작해 주세요.', action: 'new' };
  if (run?.state === 'failed') return { title: 'AI 응답을 완료하지 못했습니다', text: '저장된 기록은 유지됩니다. 새 대화에서 다시 시작해 주세요.', action: 'new' };
  if (!state.ready?.aiExecution) return { neutral: true, title: '기록 조회 모드입니다', text: '대화 실행을 사용하려면 AI 연결 기능을 켠 Daemon에 연결해 주세요.' };
}

export function Chat({ state, model, reconnect, approvals, create, scrollPosition, visible = true }: { state: ChatState; model: ChatStateStore; reconnect: () => void; approvals?: ReactNode; create: () => void; scrollPosition: RefObject<TranscriptPosition | undefined>; visible?: boolean }) {
  const session = state.sessions.find((item) => item.sessionId === state.selected);
  const run = currentRun(state, session);
  const page = state.selected ? state.pages[state.selected] : undefined;
  const draft = state.selected ? state.drafts[state.selected] ?? '' : '';
  const bytes = new TextEncoder().encode(draft).byteLength;
  const tooLong = bytes > (state.ready?.limits.maxTextBytes ?? 16384);
  const blocked = state.connection !== 'online' || state.busy || !!state.pending || state.loading || !session || !!session.aiUnavailable || !session.storageAvailable || !state.ready?.aiExecution || active(run) || (session.latestRunId && !run) || run?.storageAvailable === false || run?.errorCode === 'PROCESS_CLEANUP_UNKNOWN';
  const warning = notice(state, session, run);
  const scroll = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const geometry = useRef({ width: 0, height: 0 });
  const positionKey = `${state.workspace?.workspaceId}:${state.ready?.storeEpoch}:${state.selected}`;
  const composing = useRef(false);
  const [newOutput, setNewOutput] = useState(false);
  const messages = page?.messages ?? [];
  const output = run?.text ?? '';
  const restorePosition = () => {
    const element = scroll.current;
    if (!element || !visible || !element.getClientRects().length) return;
    const saved = scrollPosition.current;
    stick.current = saved?.key === positionKey ? saved.stick : true;
    if (stick.current) { element.scrollTop = element.scrollHeight; setNewOutput(false); }
    else { element.scrollTop = saved!.top; setNewOutput(true); }
    geometry.current = { width: element.clientWidth, height: element.clientHeight };
    scrollPosition.current = { key: positionKey, top: element.scrollTop, stick: stick.current };
  };
  useLayoutEffect(() => {
    restorePosition();
  }, [positionKey, messages.length, output, visible, scrollPosition]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(restorePosition);
    if (scroll.current) observer.observe(scroll.current);
    return () => observer.disconnect();
  }, [positionKey, visible, scrollPosition]);
  const unlistedRun = run && !messages.some((message) => message.role === 'assistant' && message.runId === run.runId);
  return <section className="chat" aria-label="Chat">
    <header className="chat-heading"><div><span className="eyebrow">Chat</span><h1>{session?.title ?? '새로운 생각을 나누세요'}</h1></div><span className="spacer" /><span className="run-state" role="status">{state.loading ? '기록 불러오는 중' : runLabel(run)}</span></header>
    <div className="transcript-scroll" ref={scroll} onScroll={() => {
      const element = scroll.current!;
      if (!visible || !element.getClientRects().length) return;
      // Reflow can dispatch scroll before ResizeObserver. It is not a user's
      // choice to stop following output or to change the saved reading position.
      if (geometry.current.width !== element.clientWidth || geometry.current.height !== element.clientHeight) { restorePosition(); return; }
      stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      scrollPosition.current = { key: positionKey, top: element.scrollTop, stick: stick.current };
      if (stick.current) setNewOutput(false);
    }}>
      <div className="reading">
        {!messages.length && !unlistedRun && !state.loading && <div className="empty"><div className="mark">w</div><h2>무엇부터 함께할까요?</h2><p>생각을 정리하거나, 궁금한 내용을 물어보세요.</p>{!session && <Button variant="primary" disabled={state.connection !== 'online' || state.busy || !!state.pending} onClick={create}>첫 대화 시작</Button>}</div>}
        {messages.map((message) => {
          const messageRun = message.runId ? state.runs[message.runId] : undefined;
          const text = message.role === 'assistant' && messageRun ? messageRun.text : message.text;
          return <article key={message.messageId} className={`message ${message.role}`} aria-label={message.role === 'user' ? '내 메시지' : 'AI 메시지'}><div className="message-author">{message.role === 'user' ? '나' : <><span className="spark">✦</span>AI</>}</div><div className="message-text">{text || (active(messageRun) ? '응답을 기다리고 있습니다…' : '저장된 응답 내용이 없습니다.')}</div>{message.role === 'assistant' && messageRun && <div className="message-note">{runLabel(messageRun)}</div>}{message.role === 'assistant' && messageRun && <FileToolHistory tools={messageRun.tools} />}</article>;
        })}
        {page?.nextAfter !== null && page?.nextAfter !== undefined && <Button density="compact" variant="outline" className="more-records" disabled={state.loading || state.connection !== 'online'} onClick={() => { stick.current = false; scrollPosition.current = { key: positionKey, top: scroll.current!.scrollTop, stick: false }; void model.moreMessages(); }}>다음 기록 불러오기</Button>}
        {unlistedRun && <article className="message assistant"><div className="message-author"><span className="spark">✦</span>최근 응답</div>{page && page.nextAfter !== null && <p className="muted small">중간 대화는 ‘다음 기록 불러오기’로 확인할 수 있습니다.</p>}<div className="message-text">{run.text || (active(run) ? '응답을 기다리고 있습니다…' : '저장된 응답 내용이 없습니다.')}</div><div className="message-note">{runLabel(run)}</div></article>}
        {unlistedRun && <FileToolHistory tools={run.tools} />}
      </div>
    </div>
    {newOutput && <Button density="compact" variant="outline" className="new-output" onClick={() => { stick.current = true; scroll.current!.scrollTop = scroll.current!.scrollHeight; scrollPosition.current = { key: positionKey, top: scroll.current!.scrollTop, stick: true }; setNewOutput(false); }}>최근 내용으로 이동 ↓</Button>}
    <div className="compose-area">
    {approvals && <div className="approval-stack">{approvals}</div>}
    {warning && <div className={`notice${warning.neutral ? ' notice--neutral' : ''}`} role="status"><strong>{warning.title}</strong><p>{warning.text}</p>
      {state.pending?.text && !state.busy && <details><summary>접수 확인 중인 입력</summary><p className="message-text">{state.pending.text}</p></details>}
      {warning.action && <Button disabled={state.busy || state.connection === 'connecting'} onClick={() => warning.action === 'reconnect' ? reconnect() : warning.action === 'new' ? create() : void model.check()}>{warning.action === 'reconnect' ? '다시 연결' : warning.action === 'new' ? '새 대화 시작' : state.pending ? '접수 여부 확인' : '상태 확인'}</Button>}
    </div>}
    {state.error && state.connection === 'online' && <div className="error-banner" role="alert">{state.error}<IconButton onClick={() => model.clearError()} label="오류 안내 닫기"><Icon name="close" /></IconButton></div>}

      <div className="compose">
        <TextArea presentation="plain" aria-label="메시지" placeholder={session ? '메시지를 입력하세요…' : '새 대화를 만든 뒤 메시지를 입력하세요'} value={draft} disabled={!session} rows={2}
          onChange={(event) => model.setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); if (!blocked && !tooLong) void model.send(); } }} />

        <div className="compose-controls"><AiControls compact info={state.aiInfo} selection={session} disabled={!!blocked || state.aiLoading === true} change={(selection) => { if (session) void model.configure(selection, session.sessionId); }} /><span className="spacer" />
          {active(run) ? <IconButton shape="round" className="compose-send" variant="primary" label="응답 중지" disabled={state.connection !== 'online' || state.busy || !!state.pending || run?.state !== 'running' || run?.storageAvailable === false} onClick={() => void model.cancel()}><Icon name="stop" /></IconButton>
            : <IconButton shape="round" className="compose-send" variant="primary" label="메시지 전송" disabled={!!blocked || !session?.model || !session.reasoningEffort || tooLong || !draft.trim()} onClick={() => void model.send()}><Icon name="arrow" /></IconButton>}
        </div>
        {session && <p className="model-status">{!session.model ? '모델과 추론 강도를 선택해 주세요.' : run?.modelConfirmed === 1 && run.model === session.model && run.reasoningEffort === session.reasoningEffort ? `최근 적용: ${run.model} · ${run.reasoningEffort}` : '선택값은 다음 메시지에 적용됩니다.'}</p>}
        {state.aiError && <Button density="compact" className="settings-action small" disabled={state.aiLoading || state.connection !== 'online'} onClick={() => void model.refreshAi()}>모델 목록 다시 확인</Button>}
      </div>
      {tooLong ? <p className="error-text small" role="alert">입력이 UTF-8 16KiB를 넘었습니다. 내용을 줄여 주세요.</p> : <p className="compose-help">Enter 전송 · Shift + Enter 줄바꿈{active(run) ? ' · 응답 중에는 다음 질문의 초안을 작성할 수 있습니다.' : ''}</p>}
    </div>
  </section>;
}
