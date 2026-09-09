import { test } from 'node:test';
import assert from 'node:assert/strict';
import { palette, contrast, toLch, fromLch, validColor, DEFAULT_COLOR } from '../web/design-prototype/palette.ts';

test('prototype color conversion preserves sRGB reference colors', () => {
  for (const color of ['#000000','#ffffff','#808080','#ff0000','#00ff00','#0000ff',DEFAULT_COLOR]) assert.equal(fromLch(...toLch(color)), color);
  assert.equal(contrast('#000000','#ffffff'), 21);
});
test('candidate palettes preserve contrast across extremes and sampled colors', () => {
  const colors = ['#000000','#ffffff','#808080','#ffff00','#ff00ff','#00ffff',DEFAULT_COLOR];
  for (let i = 0; i < 64; i++) colors.push('#' + ((i * 2654435761) & 0xffffff).toString(16).padStart(6,'0'));
  for (const input of colors) for (const mode of ['light','dark']) for (const concept of ['A','B']) {
    const p = palette(input,mode,concept);
    for (const foreground of [p.ink,p.muted,p.accent,p.danger,p.success]) for (const background of [p.canvas,p.soft,p.selected]) assert.ok(contrast(foreground,background) >= 4.5, `${input}/${mode}/${concept}: ${foreground}/${background}`);
    assert.ok(contrast(p.accent,p.on) >= 4.5);
    assert.ok(contrast(p.warning,p.warningBg) >= 4.5);
    for (const bg of [p.canvas,p.soft,p.selected]) assert.ok(contrast(p.controlBorder,bg) >= 3);
  }
});
test('invalid stored or typed colors use the deterministic default palette', () => {
  for (const invalid of ['','red','#fff','#gg0000','#12345678','url(example)']) {
    assert.equal(validColor(invalid),false);
    assert.deepEqual(palette(invalid,'light','A'),palette(DEFAULT_COLOR,'light','A'));
  }
});
test('concepts differ in surface tint without changing semantic warning hue', () => {
  const a = palette('#4361ee','light','A'), b = palette('#4361ee','light','B');
  assert.notEqual(a.soft,b.soft);
  assert.equal(a.warning,b.warning);
  assert.equal(a.warningBg,b.warningBg);
});
