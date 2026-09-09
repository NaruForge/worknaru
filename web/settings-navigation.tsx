import { Button } from './ui.js';
import type { SettingsSection } from './navigation.js';

export const settingsSections: Record<SettingsSection, string> = { appearance: '화면', connection: '연결', ai: 'AI' };
export function SettingsNavigation({ selected, select }: { selected: SettingsSection; select: (section: SettingsSection) => void }) {
  return <nav className="settings-navigation" aria-label="설정 메뉴"><div className="panel-heading"><strong>설정</strong></div>
    {(Object.entries(settingsSections) as [SettingsSection, string][]).map(([id, title]) => <Button key={id} className={selected === id ? 'selected' : undefined} aria-current={selected === id ? 'page' : undefined} onClick={() => select(id)}>{title}</Button>)}
  </nav>;
}
