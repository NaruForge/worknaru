import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const temporary = resolve('.worknaru-test/browser-temp');
mkdirSync(temporary, { recursive: true });
export default defineConfig({
  testDir: 'tests', testMatch: 'web.spec.mjs', workers: 1, timeout: 45_000,
  outputDir: '.worknaru-test/browser-output', reporter: 'list',
  use: { channel: 'msedge', headless: true, viewport: { width: 1280, height: 900 },
    launchOptions: { env: { ...process.env, TEMP: temporary, TMP: temporary } },
    screenshot: 'only-on-failure',
  },
  webServer: { command: 'npm run preview:web', url: 'http://127.0.0.1:5173', reuseExistingServer: false, timeout: 20_000 },
});
