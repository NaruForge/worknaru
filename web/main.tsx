import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './workspace.js';
import { ChatStateStore } from '../src/chat-state.js';
import { WebClient } from '../src/web-client.js';
import './style.css';

const model = new ChatStateStore(new WebClient(), {
  getItem: (key) => sessionStorage.getItem(key),
  setItem: (key, value) => sessionStorage.setItem(key, value),
  removeItem: (key) => sessionStorage.removeItem(key),
});
createRoot(document.getElementById('root')!).render(<StrictMode><App model={model} /></StrictMode>);
window.addEventListener('pagehide', () => model.close());
