import { test, expect } from '@playwright/test';
import { build, preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
let server, prototypeUrl;
const out=resolve('.worknaru-test/design-review');
test.beforeAll(async () => {
  mkdirSync(out,{recursive:true});
  await build({configFile:resolve('vite.prototype.config.ts'),logLevel:'error'});
  server=await preview({configFile:resolve('vite.prototype.config.ts'),preview:{host:'127.0.0.1',port:0,strictPort:true},logLevel:'error'});
  prototypeUrl=`http://127.0.0.1:${server.httpServer.address().port}/`;
});
test.afterAll(async () => { if(server) await new Promise((resolve,reject)=>server.httpServer.close(e=>e?reject(e):resolve())); });
test('prototype compares colors and preserves responsive dialog focus', async ({page}) => {
 await page.setViewportSize({width:1440,height:1100}); const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(prototypeUrl);
 const frame=page.frameLocator('iframe');
 await expect(frame.getByLabel('메시지',{exact:true})).toBeVisible();
 await page.screenshot({path:resolve(out,'overview.png'),fullPage:true});
 let combinations=0;
 for(const concept of ['A','B']) for(const mode of ['light','dark']) {
  await page.getByRole('button',{name:concept==='A'?'A · 강조색 중심':'B · 표면에도 색감',exact:true}).click();
  await page.getByRole('combobox',{name:'테마',exact:true}).selectOption(mode);
  for(const color of ['#176b56','#4361ee','#ffff00','#000000','#ffffff','#808080']) {
   await page.getByLabel('Main Color HEX').fill(color);
   await expect.poll(async()=>frame.locator('html').getAttribute('data-theme')).toBe(mode);
   await expect(page.locator('.review-meta')).toContainText(color.toUpperCase());
   combinations++;
  }
  await page.getByRole('button',{name:'기본색',exact:true}).click();
  for(const scene of ['chat','settings','connection','permission']) {
   await page.getByRole('combobox',{name:'화면',exact:true}).selectOption(scene);
   if(scene!=='chat') await expect(frame.getByRole('dialog')).toBeVisible();
   else await expect(frame.getByRole('dialog')).toHaveCount(0);
   await page.locator('iframe').screenshot({path:resolve(out,`${concept}-${mode}-${scene}.png`)});
  }
 }
 await page.getByRole('combobox',{name:'화면',exact:true}).selectOption('chat');
 for(const state of ['empty','running','error','disabled','permission','normal']) {
  await page.getByRole('combobox',{name:'상태',exact:true}).selectOption(state);
  if(state==='disabled')await expect(frame.getByLabel('메시지',{exact:true})).toBeDisabled();
  if(state==='running')await expect(frame.getByRole('button',{name:'중지',exact:true})).toBeVisible();
 }
 for(const width of ['736','390','320']) {
  await page.getByRole('combobox',{name:'화면 폭',exact:true}).selectOption(width);
  await expect.poll(()=>frame.locator('html').evaluate(el=>el.scrollWidth <= innerWidth)).toBe(true);
  const toggle=frame.getByRole('button',{name:'대화 목록 열기 또는 접기'});
  await toggle.click();await expect(frame.getByRole('dialog',{name:'대화 목록'})).toBeVisible();
  await frame.getByRole('button',{name:'대화 목록 닫기'}).press('Escape');
  await expect(frame.getByRole('dialog')).toHaveCount(0);await expect(toggle).toBeFocused();
  await page.locator('iframe').screenshot({path:resolve(out,`B-dark-${width}.png`)});
 }
 await page.getByLabel('Main Color HEX').fill('#bad');await expect(page.getByRole('alert')).toBeVisible();
 await page.getByRole('button',{name:'기본색',exact:true}).click();await expect(page.getByRole('alert')).toHaveCount(0);
 await page.getByRole('button',{name:'현재 배색',exact:true}).click();
 await expect.poll(()=>frame.locator('html').evaluate(el=>el.style.getPropertyValue('--accent'))).toBe('');
 expect(errors).toEqual([]);
 console.log(`PASS: ${combinations} palette selections, 16 screen/theme/concept captures, 6 states, 3 responsive widths with Escape/focus, invalid input and baseline reset; no page errors.`);

});