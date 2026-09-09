// A concept selected by the user in issue #25 (2026-09-09).
// Color space definitions: https://www.w3.org/TR/css-color-4/#color-conversion-code
type RGB = [number, number, number];
export type Mode = 'light' | 'dark';
export const DEFAULT_COLOR = '#176b56';
export const validColor = (value: string) => /^#[\da-f]{6}$/i.test(value);
const linear = (x: number) => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4;
const gamma = (x: number) => x <= .0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - .055;
const rgb = (hex: string): RGB => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as RGB;
const luminance = (hex: string) => { const [r, g, b] = rgb(hex).map(linear) as RGB; return .2126 * r + .7152 * g + .0722 * b; };
export function contrast(a: string, b: string) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
export function toLch(hex: string): RGB {
  const [r, g, b] = rgb(hex).map(linear) as RGB;
  const l = Math.cbrt(.4122214708*r + .5363325363*g + .0514459929*b);
  const m = Math.cbrt(.2119034982*r + .6806995451*g + .1073969566*b);
  const s = Math.cbrt(.0883024619*r + .2817188376*g + .6299787005*b);
  const a = 1.9779984951*l - 2.428592205*m + .4505937099*s;
  const bb = .0259040371*l + .7827717662*m - .808675766*s;
  return [.2104542553*l + .793617785*m - .0040720468*s, Math.hypot(a, bb), Math.atan2(bb, a)];
}
export function fromLch(light: number, chroma: number, hue: number): string {
  const convert = (c: number): RGB => {
    const a = c * Math.cos(hue), b = c * Math.sin(hue);
    const l = (light + .3963377774*a + .2158037573*b) ** 3;
    const m = (light - .1055613458*a - .0638541728*b) ** 3;
    const s = (light - .0894841775*a - 1.291485548*b) ** 3;
    return [4.0767416621*l - 3.3077115913*m + .2309699292*s, -1.2684380046*l + 2.6097574011*m - .3413193965*s, -.0041960863*l - .7034186147*m + 1.707614701*s];
  };
  const inGamut = (c: number) => convert(c).every(x => x >= -1e-6 && x <= 1.000001);
  let low = inGamut(chroma) ? chroma : 0, high = chroma;
  for (let i = 0; i < 22 && low !== high; i++) { const mid = (low + high) / 2; if (inGamut(mid)) low = mid; else high = mid; }
  return '#' + convert(low).map(x => Math.round(Math.max(0, Math.min(1, gamma(x))) * 255).toString(16).padStart(2, '0')).join('');
}
export function palette(input: string, mode: Mode) {
  const main = validColor(input) ? input.toLowerCase() : DEFAULT_COLOR;
  const [sourceL, sourceC, h] = toLch(main), dark = mode === 'dark';
  const chroma = Math.min(sourceC, .18), tintC = Math.min(sourceC, .004);
  const color = (l: number, c = tintC, hue = h) => fromLch(l, c, hue);
  const canvas = color(dark ? .20 : .992), soft = color(dark ? .25 : .962), selected = color(dark ? .31 : .923, Math.min(sourceC, .045));
  const backgrounds = [canvas, soft, selected];
  const readable = (start: number, c: number, hue: number, bgs: string[], ratio = 4.5) => {
    for (let i = 0; i <= 100; i++) {
      const l = start + ((dark ? 1 : 0) - start) * i / 100;
      const candidate = color(l, c, hue);
      if (bgs.every(bg => contrast(candidate, bg) >= ratio)) return candidate;
    }
    return dark ? '#ffffff' : '#000000';
  };
  const accent = readable(Math.max(dark ? .72 : .35, Math.min(dark ? .85 : .55, sourceL)), chroma, h, backgrounds);
  const ink = readable(dark ? .94 : .25, tintC, h, backgrounds);
  const muted = readable(dark ? .73 : .49, tintC, h, backgrounds);
  const on = contrast(accent, '#ffffff') >= contrast(accent, '#000000') ? '#ffffff' : '#000000';
  const warningBg = color(dark ? .27 : .96, .035, 80 * Math.PI / 180);
  const warning = readable(dark ? .8 : .46, .10, 80 * Math.PI / 180, [warningBg]);
  const danger = readable(dark ? .78 : .48, .15, 25 * Math.PI / 180, backgrounds);
  const success = readable(dark ? .78 : .46, .12, 150 * Math.PI / 180, backgrounds);
  return { main, canvas, soft, selected, accent, ink, muted, on, warning, warningBg, danger, success,
    border: color(dark ? .37 : .86), controlBorder: readable(dark ? .62 : .58, tintC, h, backgrounds, 3),
    overlay: dark ? '#00000099' : '#18202055', shadow: dark ? '#00000030' : '#00000012' };
}
