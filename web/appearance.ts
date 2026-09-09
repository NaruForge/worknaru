import { DEFAULT_COLOR, palette, validColor } from './theme-palette.js';
import type { Mode } from './theme-palette.js';

export const APPEARANCE_KEY = 'worknaru.appearance.v1';
type ColorSnapshot = { color: string; applied: string; revision: number; message: string };
const decode = (raw: string | null): string => {
  try { const value = JSON.parse(raw ?? 'null'); return value?.version === 1 && typeof value.mainColor === 'string' && validColor(value.mainColor) ? value.mainColor.toLowerCase() : DEFAULT_COLOR; }
  catch { return DEFAULT_COLOR; }
};
// Personal presentation state only; no Daemon or business requests.
export class ColorPreference {
  private snapshot: ColorSnapshot;
  private listeners = new Set<() => void>();
  constructor(private readonly getStorage: () => Pick<Storage, 'getItem' | 'setItem'>, readonly key = APPEARANCE_KEY) {
    let color = DEFAULT_COLOR;
    try { color = decode(getStorage().getItem(key)); } catch { /* Current-tab operation still works. */ }
    this.snapshot = { color, applied: color, revision: 0, message: '' };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(next: Partial<ColorSnapshot>) { this.snapshot = { ...this.snapshot, ...next }; for (const listener of this.listeners) listener(); }
  preview(color: string) { if (validColor(color)) this.update({ color: color.toLowerCase(), message: '' }); }
  cancel() { this.update({ color: this.snapshot.applied, message: '' }); }
  apply(color: string) {
    if (!validColor(color)) return false;
    const normalized = color.toLowerCase();
    let message = '이 브라우저에 배색을 저장했습니다.';
    try { this.getStorage().setItem(this.key, JSON.stringify({ version: 1, mainColor: normalized })); }
    catch { message = '현재 탭에는 적용했지만 브라우저에 저장하지 못했습니다. 새로고침하면 이전 색으로 돌아갈 수 있습니다.'; }
    this.update({ color: normalized, applied: normalized, revision: this.snapshot.revision + 1, message });
    return true;
  }
  receiveStorage(key: string | null, raw: string | null) {
    if (key !== null && key !== this.key) return;
    const color = decode(raw);
    this.update({ color, applied: color, revision: this.snapshot.revision + 1, message: '다른 탭에서 변경한 배색을 반영했습니다.' });
  }
}

export function applyAppearance(root: HTMLElement, mainColor: string, mode: Mode) {
  const p = palette(mainColor, mode);
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
  const tokens = {
    'surface-canvas': p.canvas, 'surface-subtle': p.soft, 'text-primary': p.ink, 'text-secondary': p.muted,
    'border-default': p.border, 'border-control': p.controlBorder, 'accent-background': p.accent, 'accent-foreground': p.on,
    'interaction-selected': p.selected, 'interaction-hover': p.selected, 'focus-ring': p.accent,
    'status-warning-text': p.warning, 'status-warning-background': p.warningBg, 'status-danger-text': p.danger,
    'status-success-text': p.success, 'overlay-backdrop': p.overlay, 'shadow-color': p.shadow,
  };
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(`--${key}`, value);
}
