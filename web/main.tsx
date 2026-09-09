import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatConnection } from '../src/chat-connection.js';
import { ChatModel } from '../src/chat-model.js';
import { ChatApp } from './chat.js';
import { ColorPreference, applyAppearance } from './appearance.js';
import './style.css';
import './chat.css';

const configured = document.querySelector<HTMLMetaElement>('meta[name="worknaru-daemon"]')?.content
  ?? new URLSearchParams(location.search).get('daemon') ?? import.meta.env.VITE_WORKNARU_URL;
const endpoint = new URL(configured ?? (import.meta.env.DEV ? 'ws://127.0.0.1:4310/ws' : `ws://${location.host}/ws`));
if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname) || endpoint.pathname !== '/ws') throw new Error('WorkNaru requires a loopback /ws endpoint.');
const appearance = new ColorPreference(() => localStorage);
applyAppearance(document.documentElement, appearance.getSnapshot().color, matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const model = new ChatModel(new ChatConnection(endpoint.href), sessionStorage);
createRoot(document.getElementById('root')!).render(<StrictMode><ChatApp model={model} appearance={appearance} /></StrictMode>);
window.addEventListener('pagehide', () => model.close());
