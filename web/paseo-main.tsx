import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatConnection } from '../src/chat-connection.js';
import { ChatModel } from '../src/chat-model.js';
import { PaseoChatApp } from './paseo-chat.js';
import { ColorPreference, applyAppearance } from './appearance.js';
import './style.css';
import './paseo.css';

const configured = new URLSearchParams(location.search).get('daemon') ?? import.meta.env.VITE_WORKNARU_URL;
const endpoint = new URL(configured ?? (import.meta.env.DEV ? 'ws://127.0.0.1:4310/ws' : `ws://${location.host}/ws`));
if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname) || endpoint.pathname !== '/ws') throw new Error('WorkNaru requires a loopback /ws endpoint.');
const appearance = new ColorPreference(() => localStorage);
applyAppearance(document.documentElement, appearance.getSnapshot().color, matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const model = new ChatModel(new ChatConnection(endpoint.href), sessionStorage);
createRoot(document.getElementById('root')!).render(<StrictMode><PaseoChatApp model={model} appearance={appearance} /></StrictMode>);
window.addEventListener('pagehide', () => model.close());
