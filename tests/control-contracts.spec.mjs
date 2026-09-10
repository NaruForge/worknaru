import { test, expect } from '@playwright/test';
import { build, preview } from 'vite';
import { resolve } from 'node:path';
import { visualSnapshot } from './visual-baseline.mjs';
import { contrast } from '../web/theme-palette.ts';
let server, url;
test.beforeAll(async()=>{
  await build({configFile:resolve('vite.prototype.config.ts'),logLevel:'error'});
  server=await preview({configFile:resolve('vite.prototype.config.ts'),preview:{host:'127.0.0.1',port:0,strictPort:true},logLevel:'error'});
  url=`http://127.0.0.1:${server.httpServer.address().port}/index.html?frame=true&scene=controls`;
});
test.afterAll(async()=>{if(server) await new Promise(resolve=>server.httpServer.close(resolve));});
const controls=page=>[page.getByRole('textbox',{name:'자료 제목'}),page.getByRole('combobox',{name:'검토 방식'}),page.getByRole('textbox',{name:'검토 의견'})];

test('framed Field invalid borders and descriptions survive product ancestor styles',async({page})=>{
  await page.goto(`${url}&state=error`);
  for(const ancestor of ['', 'settings-content', 'connection-form']) {
    await page.locator('.control-fields').evaluate((el,ancestor)=>el.className=`control-fields ${ancestor}`,ancestor);
    for(const control of controls(page)) {
      await expect(control).toHaveAttribute('aria-invalid','true');
      const result=await control.evaluate(el=>({border:getComputedStyle(el).borderTopColor,danger:getComputedStyle(document.getElementById(el.getAttribute('aria-describedby').split(' ').at(-1))).color,descriptions:el.getAttribute('aria-describedby').split(' ').map(id=>document.getElementById(id)?.textContent)}));
      expect(result.descriptions).toContain('입력 내용을 다시 확인해 주세요.');
      await expect.soft(control).toHaveCSS('border-top-color',result.danger);
      await control.focus();
      await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      await expect(control).toBeFocused();
      await expect(control).toHaveCSS('outline-style','solid');
      await expect(control).toHaveCSS('border-top-color',result.danger);
      await control.evaluate(el=>el.disabled=true);
      await expect(control).toHaveCSS('border-top-color',result.danger);
      await control.evaluate(el=>el.disabled=false);
    }
  }
});

test('default control geometry is stable across variants and loading',async({page})=>{
  await page.goto(url);
  const items=[page.getByRole('button',{name:'주요 조치'}),page.getByRole('button',{name:'보조 조치'}),page.getByRole('button',{name:'일반 조치'}),...controls(page).slice(0,2)];
  for(const item of items){
    expect((await item.boundingBox()).height).toBe(40);
    await expect(item).toHaveCSS('font-size','14px');
    await expect(item).toHaveCSS('border-top-width','1px');
    await expect(item).toHaveCSS('border-radius','6px');
  }
  const height=(await page.getByRole('button',{name:'상태 확인',exact:true}).boundingBox()).height;
  await page.evaluate(()=>window.postMessage({type:'prototype-config',query:'frame=true&scene=controls&state=running'},location.origin));
  const loading=page.getByRole('button',{name:'확인 중…',exact:true});
  await expect(loading).toBeDisabled();await expect(loading).toHaveAttribute('aria-busy','true');
  expect((await loading.boundingBox()).height).toBe(height);
});

test('focus consumes its own token and clearing errors restores normal fields',async({page})=>{
  await page.goto(`${url}&state=error`);
  // Deliberately separate focus from accent to prove semantic token consumption.
  await page.locator('html').evaluate(el=>el.style.setProperty('--focus-ring','#7040ab'));
  for(const control of controls(page)){
    await control.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
    await expect(control).toHaveCSS('outline-color','rgb(112, 64, 171)');
  }
  await page.getByRole('button',{name:'주요 조치'}).focus();
  await expect(page.getByRole('button',{name:'주요 조치'})).toHaveCSS('outline-color','rgb(112, 64, 171)');
  await page.evaluate(()=>window.postMessage({type:'prototype-config',query:'frame=true&scene=controls'},location.origin));
  for(const control of controls(page)){
    await expect(control).not.toHaveAttribute('aria-invalid','true');
    const expected=await page.getByRole('textbox',{name:'저장 위치'}).evaluate(el=>getComputedStyle(el).borderTopColor);
    await expect(control).toHaveCSS('border-top-color',expected);
  }
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('compact choices, round actions and long fields remain reachable at viewport boundaries',async({page})=>{
  await page.goto(url);
  for(const width of [1280,860,859,736,600,599,390,320]){
    await page.setViewportSize({width,height:width===320?480:900});
    await expect(page.getByRole('textbox',{name:/자료 제목|긴 제목을 가진/})).toBeVisible();
    await page.getByRole('textbox',{name:/자료 제목|긴 제목을 가진/}).fill('긴 한글과 English 제목 '.repeat(20));
    await page.getByRole('textbox',{name:'검토 의견'}).fill('의견과 longunbrokentext'.repeat(20));
    await page.locator('.control-fields> .ui-field>label').first().evaluate(el=>el.textContent='긴 제목을 가진 입력 항목의 한글 English label 확인');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const compact=page.getByRole('combobox',{name:'Model',exact:true});
    await compact.scrollIntoViewIfNeeded();await expect(compact).toBeInViewport();
    expect((await compact.boundingBox()).height).toBe(30);
    const round=page.getByRole('button',{name:'전송 예제'});
    expect((await round.boundingBox()).height).toBe(34);
    await round.scrollIntoViewIfNeeded();await expect(round).toBeInViewport();
    if(width<860) expect((await page.getByRole('button',{name:'← Module',exact:true}).boundingBox()).height).toBeGreaterThanOrEqual(44);
  }
});

test('representative Main Colors preserve actual DOM error and focus contrast',async({page})=>{
  await page.goto(url);
  for(const color of ['#4361ee','#ffffff','#0000ff']) for(const mode of ['light','dark']) {
    await page.evaluate(color=>localStorage.setItem('worknaru.prototype.appearance.v1:/index.html',JSON.stringify({version:1,mainColor:color})),color);
    await page.goto(`${url}&state=error&mode=${mode}`);
    for(const control of controls(page)){
      const metrics=await control.evaluate(el=>{
        const css=getComputedStyle(el),toHex=value=>'#'+value.match(/\d+/g).slice(0,3).map(v=>Number(v).toString(16).padStart(2,'0')).join('');
        return {border:toHex(css.borderTopColor),surface:toHex(css.backgroundColor),focus:css.getPropertyValue('--focus-ring').trim(),canvas:css.getPropertyValue('--surface-canvas').trim()};
      });
      expect(contrast(metrics.border,metrics.surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(metrics.focus,metrics.canvas)).toBeGreaterThanOrEqual(3);
    }
  }
});

for(const mode of ['light','dark']) for(const state of ['normal','error','disabled','running']) {
  test(`control baseline ${mode} ${state}`, { tag: '@visual' }, async({page,browser})=>{
    await page.goto(`${url}&mode=${mode}&state=${state}`);
    await expect(page.getByRole('textbox',{name:'자료 제목'})).toBeVisible();
    await page.evaluate(()=>document.fonts.ready);
    await visualSnapshot(page.locator('.control-samples'),`controls-${mode}-${state}.png`,browser);
    if(state==='error'){
      await page.getByRole('textbox',{name:'검토 의견'}).focus();
      await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
      await visualSnapshot(page.locator('.control-samples'),`controls-${mode}-invalid-focus.png`,browser);
    }
  });
}
