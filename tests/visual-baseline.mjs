import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { release } from 'node:os';

export function visualEnvironment(browser) {
  const fonts = ['segoeui.ttf', 'segoeuib.ttf', 'seguisb.ttf', 'malgun.ttf', 'malgunbd.ttf'];
  return {
    platform: process.platform, osRelease: release(), browserVersion: browser.version(),
    fonts: Object.fromEntries(fonts.map(name => [name, createHash('sha256').update(readFileSync(join(process.env.WINDIR ?? 'C:/Windows', 'Fonts', name))).digest('hex')])),
  };
}
let verified = false;
export async function visualSnapshot(target, name, browser) {
  if (!verified) {
    expect(process.platform, 'The committed visual baseline requires Windows/Edge; do not overwrite it from another platform.').toBe('win32');
    const baseline = JSON.parse(readFileSync(new URL('./visual-environment.json', import.meta.url), 'utf8'));
    expect(visualEnvironment(browser), 'Review browser/OS/font changes before replacing the visual baseline.').toEqual(baseline);
    verified = true;
  }
  await expect(target).toHaveScreenshot(name, { animations: 'disabled', caret: 'hide', scale: 'css', maxDiffPixels: 0, threshold: 0.1 });
}
