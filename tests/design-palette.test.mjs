import { test } from 'node:test';
import assert from 'node:assert/strict';
import { palette, contrast, toLch, fromLch, validColor, DEFAULT_COLOR } from '../web/theme-palette.ts';

test('prototype color conversion preserves sRGB reference colors', () => {
  for (const color of ['#000000','#ffffff','#808080','#ff0000','#00ff00','#0000ff',DEFAULT_COLOR]) assert.equal(fromLch(...toLch(color)), color);
  assert.equal(contrast('#000000','#ffffff'), 21);
});
test('candidate palettes preserve contrast across extremes and sampled colors', () => {
  const colors = ['#000000','#ffffff','#808080','#ffff00','#ff00ff','#00ffff',DEFAULT_COLOR];
  for (let i = 0; i < 64; i++) colors.push('#' + ((i * 2654435761) & 0xffffff).toString(16).padStart(6,'0'));
  for (const input of colors) for (const mode of ['light','dark']) {
    const p = palette(input,mode);
    for (const foreground of [p.ink,p.muted,p.accent,p.danger,p.success]) for (const background of [p.canvas,p.soft,p.selected]) assert.ok(contrast(foreground,background) >= 4.5, `${input}/${mode}: ${foreground}/${background}`);
    assert.ok(contrast(p.accent,p.on) >= 4.5);
    assert.ok(contrast(p.warning,p.warningBg) >= 4.5);
    for (const bg of [p.canvas,p.soft,p.selected]) assert.ok(contrast(p.controlBorder,bg) >= 3);
  }
});
test('invalid stored or typed colors use the deterministic default palette', () => {
  for (const invalid of ['','red','#fff','#gg0000','#12345678','url(example)']) {
    assert.equal(validColor(invalid),false);
    assert.deepEqual(palette(invalid,'light'),palette(DEFAULT_COLOR,'light'));
  }
});
test('Main Color changes accents while warning remains semantically stable', () => {
  const green = palette('#176b56','light'), blue = palette('#4361ee','light');
  assert.notEqual(green.accent,blue.accent);
  assert.equal(green.warning,blue.warning);
  assert.equal(green.warningBg,blue.warningBg);
});