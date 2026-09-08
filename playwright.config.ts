import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const temporary = resolve('.worknaru-test/browser-temp');
const webPort = Number(process.env.WORKNARU_TEST_WEB_PORT ?? 5173);
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535) throw new Error('Invalid WORKNARU_TEST_WEB_PORT');
mkdirSync(temporary, { recursive: true });
// Playwright creates its profile in the runner's temp directory before spawning Edge.
process.env.TEMP = temporary;
process.env.TMP = temporary;
export default defineConfig({
  testDir: 'tests', testMatch: 'web.spec.mjs', workers: 1, timeout: 45_000,
  outputDir: '.worknaru-test/browser-output', reporter: 'list',
  use: { channel: 'msedge', headless: true, viewport: { width: 1280, height: 900 },
    launchOptions: { env: { ...process.env, TEMP: temporary, TMP: temporary } },
    screenshot: 'only-on-failure',
  },
  webServer: { command: `npm run preview:web -- --port ${webPort}`, url: `http://127.0.0.1:${webPort}`, reuseExistingServer: false, timeout: 20_000 },
});
