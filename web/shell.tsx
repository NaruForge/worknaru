import type { ReactNode } from 'react';
import { Button, IconButton } from './ui.js';
import { Icon } from './icons.js';
// The platform shell accepts optional navigation; Chat supplies its own list and body.
export function WorkspaceShell({ name, online, sidebar, children, connection, settings, theme, toggleTheme, listOpen, toggleList, navigationLabel, devStop, sidebarLabel = 'Module 목록', chat, settingsActive = false, sectionLabel = '기본 제공 Module', stacked }: {
  name: string; online: boolean; sidebar?: ReactNode; children: ReactNode; connection: () => void;
  theme: string; toggleTheme: () => void; listOpen?: boolean; toggleList?: () => void; navigationLabel?: string;
  settings: () => void; sidebarLabel?: string; chat?: () => void; settingsActive?: boolean; sectionLabel?: string;
  devStop?: ReactNode;
  stacked?: { view: 'modules' | 'list' | 'main'; list?: ReactNode; backLabel: string; back: () => void };
}) {
  return <div className={`window${stacked ? ' window--stacked' : ''}`}>
    <header className="chrome">
      <div className="brand"><span className="mark">w</span><span>WorkNaru</span></div>
      <span className="divider" /><span className="workspace-name" title={name}><Icon name="folder" />{name}</span>
      <span className="spacer" />{devStop}
      <Button className="connection" onClick={connection}><span className={online ? 'dot' : 'dot offline'} />{online ? '연결됨' : '연결 끊김'}</Button>
      <IconButton className="theme" onClick={toggleTheme} label={theme === 'dark' ? '밝은 테마' : '어두운 테마'}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></IconButton>
    </header>
    <div className="layout">
      <nav className="rail" aria-label="서비스"><Button data-focus-fallback className={settingsActive ? undefined : 'selected'} aria-current={settingsActive ? undefined : 'page'} onClick={chat}><Icon name="chat" />Chat</Button><span className="spacer" /><Button className={settingsActive ? 'selected' : undefined} aria-current={settingsActive ? 'page' : undefined} onClick={settings} aria-label="Settings"><Icon name="settings" />설정</Button></nav>
      {sidebar && <aside className="sidebar" aria-label={sidebarLabel}>{sidebar}</aside>}
      <main className="main">{stacked ? <>
        {stacked.view === 'modules' ? <section className="module-picker" aria-label="Module 선택"><h1 tabIndex={-1}>Module</h1><Button onClick={chat}><Icon name="chat" /><span><strong>Chat</strong><span>대화 목록과 AI 작업</span></span><span aria-hidden="true">›</span></Button><Button onClick={settings}><Icon name="settings" /><span><strong>설정</strong><span>화면 · 연결 · AI</span></span><span aria-hidden="true">›</span></Button></section> : <div className="stacked-toolbar"><Button data-focus-fallback onClick={stacked.back}>{stacked.backLabel}</Button></div>}
        <section className="stacked-list" aria-label={sidebarLabel} hidden={stacked.view !== 'list'}>{stacked.list}</section>
        <div className="stacked-main" hidden={stacked.view !== 'main'}>{children}</div>
      </> : <><div className="module-tools">{toggleList && <IconButton onClick={toggleList} label={navigationLabel ?? '목록 열기 또는 접기'} aria-expanded={listOpen}><Icon name="list" /></IconButton>}<span>{sectionLabel}</span></div>{children}</>}</main>
    </div>
  </div>;
}
