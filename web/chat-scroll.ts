import { useLayoutEffect, useRef, useState } from 'react';
import type { TimelinePage } from '../src/chat-contract.js';

type Position = { top: number; follow: boolean; anchor?: string; offset: number };
export function useChatScroll(key: string, timeline: TimelinePage | undefined, visible: boolean) {
  const scroller = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, Position>());
  const geometry = useRef({ width: 0, height: 0 });
  const [away, setAway] = useState(false);
  const latest = useRef({ key, timeline, visible }); latest.current = { key, timeline, visible };
  const capture = (follow?: boolean) => {
    const element = scroller.current;
    if (!element || !latest.current.visible || !element.getClientRects().length || !latest.current.timeline) return;
    const top = element.getBoundingClientRect().top;
    const anchor = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => node.getBoundingClientRect().bottom > top);
    const following = follow ?? element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    positions.current.set(latest.current.key, { top: element.scrollTop, follow: following,
      anchor: anchor?.dataset.messageId, offset: anchor ? anchor.getBoundingClientRect().top - top : 0 });
    geometry.current = { width: element.clientWidth, height: element.clientHeight }; setAway(!following);
  };
  const restore = () => {
    const element = scroller.current;
    if (!element || !latest.current.visible || !element.getClientRects().length || !latest.current.timeline) return;
    const position = positions.current.get(latest.current.key);
    if (!position || position.follow) element.scrollTop = element.scrollHeight;
    else {
      const anchor = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => node.dataset.messageId === position.anchor);
      element.scrollTop = anchor
        ? element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - position.offset
        : position.top; // A replaced/deleted anchor falls back to the nearest available scroll position.
    }
    capture(position?.follow ?? true);
  };
  useLayoutEffect(restore, [key, timeline, visible]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(restore);
    if (scroller.current) { observer.observe(scroller.current); if (scroller.current.firstElementChild) observer.observe(scroller.current.firstElementChild); }
    return () => observer.disconnect();
  }, []);
  const onScroll = () => {
    const element = scroller.current;
    if (!element || !latest.current.visible || !element.getClientRects().length) return;
    if (element.clientWidth !== geometry.current.width || element.clientHeight !== geometry.current.height) restore();
    else capture();
  };
  const follow = () => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; capture(true); };
  return { scroller, onScroll, follow, away };
}
