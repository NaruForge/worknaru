import { useLayoutEffect, useRef, useState } from 'react';
import type { SettingsSection } from './settings-navigation.js';

export type Route = { screen: 'chat' | 'settings'; view: 'modules' | 'list' | 'main'; section: SettingsSection; chatId: string | null };
const initial = (chatId: string | null): Route => ({ screen: 'chat', view: 'main', section: 'appearance', chatId });
function readRoute(value: unknown, scope: string): Route | null {
  const entry = value as { scope?: unknown; route?: Partial<Route> } | null;
  const route = entry?.route;
  if (entry?.scope !== scope || !route || !['chat', 'settings'].includes(route.screen ?? '') ||
    !['modules', 'list', 'main'].includes(route.view ?? '') || !['appearance', 'connection', 'ai'].includes(route.section ?? '') ||
    !(route.chatId === null || typeof route.chatId === 'string' && /^[0-9a-f-]{36}$/i.test(route.chatId))) return null;
  return route as Route;
}

// Browser history contains navigation only. Scope prevents a previous data store's IDs being replayed.
export function useNavigation(scope: string | null, selectedId: string | null, select: (id: string | null) => void) {
  const [route, setRoute] = useState<Route>(() => initial(selectedId));
  const current = useRef(route), callback = useRef(select), activeScope = useRef<string | null>(null);
  const requestedSelection = useRef<{ id: string | null } | null>(null);
  const selection = useRef(selectedId); selection.current = selectedId;
  current.current = route; callback.current = select;
  const write = (next: Route, replace: boolean) => {
    if (!activeScope.current) return;
    const state = { ...history.state, worknaru: { scope: activeScope.current, route: next } };
    if (replace) history.replaceState(state, ''); else history.pushState(state, '');
  };
  useLayoutEffect(() => {
    if (!scope) return;
    activeScope.current = scope;
    const restored = readRoute(history.state?.worknaru, scope) ?? initial(selectedId);
    current.current = restored; setRoute(restored);
    requestedSelection.current = restored.chatId === selection.current ? null : { id: restored.chatId };
    callback.current(restored.chatId); write(restored, true);
    const receive = () => {
      const next = readRoute(history.state?.worknaru, scope) ?? initial(null);
      current.current = next; setRoute(next);
      requestedSelection.current = next.chatId === selection.current ? null : { id: next.chatId };
      callback.current(next.chatId); write(next, true);
    };
    addEventListener('popstate', receive);
    return () => { activeScope.current = null; removeEventListener('popstate', receive); };
  }, [scope]);
  useLayoutEffect(() => {
    if (requestedSelection.current) {
      if (requestedSelection.current.id !== selectedId) return;
      requestedSelection.current = null;
    }
    if (current.current.chatId === selectedId) return;
    const next = { ...current.current, chatId: selectedId };
    current.current = next; setRoute(next); write(next, true);
  }, [selectedId]);
  const navigate = (patch: Partial<Route>) => {
    const next = { ...current.current, ...patch };
    if (JSON.stringify(next) === JSON.stringify(current.current)) return;
    current.current = next; setRoute(next); write(next, false);
    requestedSelection.current = next.chatId === selection.current ? null : { id: next.chatId };
    callback.current(next.chatId);
  };
  return { route, navigate };
}
