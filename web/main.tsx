import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './workspace.js';
import { ChatStateStore } from '../src/chat-state.js';
import { WebClient } from '../src/web-client.js';
import { developmentEndpoint, developmentKeyRequired } from './dev-server.js';
import './style.css';
import { ColorPreference, applyAppearance } from './appearance.js';
const appearance = new ColorPreference(() => localStorage);
applyAppearance(document.documentElement, appearance.getSnapshot().color, matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

const model = new ChatStateStore(new WebClient(developmentEndpoint(), developmentKeyRequired()), {
  getItem: (key) => sessionStorage.getItem(key),
  setItem: (key, value) => sessionStorage.setItem(key, value),
  removeItem: (key) => sessionStorage.removeItem(key),
});
createRoot(document.getElementById('root')!).render(<StrictMode><App model={model} appearance={appearance} /></StrictMode>);
window.addEventListener('pagehide', () => model.close());
