import { useEffect, useRef, useState } from 'react';
import type { ChatStateStore } from '../src/chat-state.js';

export type SettingsSection = 'appearance' | 'connection' | 'ai';
type Route = {
  module: 'chat' | 'settings';
  view: 'modules' | 'list' | 'main';
  settingsSection: SettingsSection;
  sessionId?: string;
};
type Entry = { version: 1; scope?: string; route: Route; parent?: Route };
const initial: Route = { module: 'chat', view: 'list', settingsSection: 'appearance' };
const validRoute = (value: unknown): value is Route => {
  if (!value || typeof value !== 'object') return false;
  const route = value as Route;
  return ['chat', 'settings'].includes(route.module) && ['modules', 'list', 'main'].includes(route.view)
    && ['appearance', 'connection', 'ai'].includes(route.settingsSection)
    && (route.sessionId === undefined || /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(route.sessionId));
};
const readEntry = (): Entry | undefined => {
  const entry = history.state?.worknaruNavigation;
  return entry?.version === 1 && validRoute(entry.route) && (entry.parent === undefined || validRoute(entry.parent))
    && (entry.scope === undefined || typeof entry.scope === 'string') ? entry : undefined;
};

// Presentation navigation only. History stores IDs and view choices, never drafts,
// credentials, requests, or approval decisions. Daemon state remains in the model.
export function useWorkspaceNavigation(model: ChatStateStore) {
  const [route, setRoute] = useState<Route>(() => readEntry()?.route ?? initial);
  const current = useRef(route);
  const scope = useRef<string | undefined>(undefined);
  // Connection publishes the new Workspace before all initialization requests
  // finish. Compare history with that live identity, not only the last callback.
  const canRestore = (entry: Entry) => {
    const state = model.getSnapshot();
    const liveScope = state.workspace && state.ready ? `${state.workspace.workspaceId}:${state.ready.storeEpoch}` : undefined;
    return state.connection !== 'connecting' && entry.scope === scope.current && entry.scope === liveScope;
  };
  current.current = route;
  const write = (next: Route, parent: Route | undefined, replace: boolean) => {
    const entry: Entry = { version: 1, scope: scope.current, route: next, parent };
    try {
      const state = { ...history.state, worknaruNavigation: entry };
      if (replace) history.replaceState(state, '', location.href);
      else history.pushState(state, '', location.href);
    } catch { /* Navigation still works if this browser disallows history writes. */ }
    current.current = next;
    setRoute(next);
  };
  const navigate = (patch: Partial<Route>) => write({ ...current.current, ...patch, sessionId: patch.sessionId ?? model.getSnapshot().selected }, current.current, false);
  const restore = (entry: Entry) => {
    // Returning to a menu preserves its latest selection, as on the desktop.
    const next = entry.route.view === 'main' ? entry.route : {
      ...entry.route, settingsSection: current.current.settingsSection, sessionId: model.getSnapshot().selected,
    };
    write(next, entry.parent, true);
    if (next.view === 'main' && next.module === 'chat' && next.sessionId && next.sessionId !== model.getSnapshot().selected)
      void model.select(next.sessionId);
  };
  useEffect(() => {
    const pop = () => {
      const entry = readEntry();
      if (entry && canRestore(entry)) restore(entry);
      else write({ ...initial, sessionId: model.getSnapshot().selected }, undefined, true);
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, [model]);
  const connected = async () => {
    const state = model.getSnapshot();
    if (state.connection !== 'online' || !state.workspace || !state.ready) return;
    const nextScope = `${state.workspace.workspaceId}:${state.ready.storeEpoch}`;
    if (scope.current === nextScope) return;
    const saved = readEntry();
    const firstConnection = scope.current === undefined;
    scope.current = nextScope;
    if (saved?.scope === nextScope) {
      write(saved.route, saved.parent, true);
      if (saved.route.sessionId && saved.route.sessionId !== state.selected) await model.select(saved.route.sessionId);
    } else {
      // Retain pre-connection Settings navigation, but never carry a Session ID
      // from another Workspace or storage generation into this connection.
      const next = firstConnection && saved?.scope === undefined ? current.current : initial;
      write({ ...next, sessionId: state.selected }, undefined, true);
    }
  };
  const back = () => {
    const target = current.current.view === 'main' ? 'list' : 'modules';
    const entry = readEntry();
    if (entry && entry.scope === scope.current && entry.route.view === current.current.view && entry.route.module === current.current.module
      && entry.parent?.view === target && (target === 'modules' || entry.parent.module === current.current.module)) history.back();
    else write({ ...current.current, view: target, sessionId: model.getSnapshot().selected }, undefined, true);
  };
  return {
    route, connected, back,
    openModule: (module: Route['module']) => navigate({ module, view: 'list' }),
    openSettings: (settingsSection: SettingsSection) => navigate({ module: 'settings', view: 'main', settingsSection }),
    openSession: (sessionId: string) => {
      navigate({ module: 'chat', view: 'main', sessionId });
      if (model.getSnapshot().selected !== sessionId) void model.select(sessionId);
    },
  };
}
