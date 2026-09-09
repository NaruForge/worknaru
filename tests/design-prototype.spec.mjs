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

test('actual appearance controls preview, cancel, apply, reload and synchronize tabs', async ({page,context}) => {
  await page.goto(prototypeUrl);
  const f=page.frameLocator('iframe'), input=f.getByRole('textbox',{name:'Main Color HEX'});
  await expect(input).toHaveValue('#176b56');
  const accent=()=>f.locator('html').evaluate(el=>el.style.getPropertyValue('--accent-background'));
  const original=await accent();
  await input.fill('#4361ee');await expect.poll(accent).not.toBe(original);
  await f.getByRole('button',{name:'취소',exact:true}).click();await expect(input).toHaveValue('#176b56');await expect.poll(accent).toBe(original);
  await input.fill('#a43e75');await f.getByRole('button',{name:'Chat으로 돌아가기'}).click();await expect.poll(accent).toBe(original);
  await f.getByRole('button',{name:'Settings',exact:true}).click();
  await input.fill('#4361ee');await f.getByRole('button',{name:'배색 적용'}).click();
  await expect(f.getByText('이 브라우저에 배색을 저장했습니다.',{exact:true})).toBeVisible();
  await page.reload();await expect(input).toHaveValue('#4361ee');
  const other=await context.newPage();await other.goto(`${prototypeUrl}index.html?frame=true&scene=settings`);
  await other.getByRole('textbox',{name:'Main Color HEX'}).fill('#a43e75');await other.getByRole('button',{name:'배색 적용'}).click();
  await expect(input).toHaveValue('#a43e75');await expect(f.getByText('다른 탭에서 변경한 배색을 반영했습니다.')).toBeVisible();
  expect(await page.evaluate(()=>localStorage.getItem('worknaru.appearance.v1'))).toBe(null);
  await other.close();
});

test('appearance errors preserve a valid preview and report storage failure honestly', async ({page}) => {
  await page.goto(prototypeUrl);const f=page.frameLocator('iframe'), input=f.getByRole('textbox',{name:'Main Color HEX'});
  await input.fill('#bad');await expect(input).toHaveAttribute('aria-invalid','true');await expect(f.getByRole('button',{name:'배색 적용'})).toBeDisabled();
  const described=await input.getAttribute('aria-describedby');expect(described).toBeTruthy();
  await page.getByRole('checkbox',{name:'저장 실패 체험'}).check();await input.fill('#4361ee');
  await f.getByRole('button',{name:'배색 적용'}).click();await expect(f.getByText(/현재 탭에는 적용했지만/)).toBeVisible();
  await page.reload();await expect(input).toHaveValue('#176b56');
  await page.evaluate(()=>localStorage.setItem('worknaru.prototype.appearance.v1:/index.html','{"version":1,"mainColor":"not-a-color"}'));
  await page.reload();await expect(input).toHaveValue('#176b56');
});

test('actual controls and dialogs remain usable across themes, states and viewport boundaries', async ({page}) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1440,height:1100});await page.goto(prototypeUrl);const f=page.frameLocator('iframe');
  for(const mode of ['light','dark']){
    await page.getByRole('combobox',{name:'테마',exact:true}).selectOption(mode);
    for(const scene of ['settings','controls','connection','permission','chat']){
      await page.getByRole('combobox',{name:'화면',exact:true}).selectOption(scene);
      await expect.poll(()=>f.locator('html').getAttribute('data-theme')).toBe(mode);
      await page.locator('iframe').screenshot({path:resolve(out,`v3-${mode}-${scene}.png`)});
    }
  }
  await page.getByRole('combobox',{name:'화면',exact:true}).selectOption('controls');
  await page.getByRole('combobox',{name:'상태',exact:true}).selectOption('running');
  await expect(f.getByRole('button',{name:'확인 중…'})).toBeDisabled();
  await page.getByRole('combobox',{name:'상태',exact:true}).selectOption('error');await expect(f.getByRole('textbox',{name:'자료 제목'})).toHaveAttribute('aria-invalid','true');
  await page.getByRole('combobox',{name:'상태',exact:true}).selectOption('normal');
  await page.getByRole('combobox',{name:'화면',exact:true}).selectOption('chat');
  for(const width of [860,859,736,600,599,390,320]){
    await page.locator('iframe').evaluate((el,w)=>el.style.width=`${w}px`,width);
    await expect.poll(()=>f.locator('html').evaluate(el=>el.scrollWidth <= innerWidth)).toBe(true);
    if(width<860){
      await expect(f.getByRole('dialog')).toHaveCount(0);
      await expect(f.locator('.stacked-list')).toBeVisible();
      await f.locator('.conversation-list').getByRole('button').first().click();
      await expect(f.getByRole('textbox',{name:'메시지'})).toBeVisible();
      const back=f.getByRole('button',{name:'← 대화 목록',exact:true});
      expect((await back.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await back.click();await expect(f.locator('.stacked-list')).toBeVisible();
    }
    await page.locator('iframe').screenshot({path:resolve(out,`v3-dark-${width}.png`)});
  }
  expect(errors).toEqual([]);
});

test('shell without a Module list exposes the full available content width', async ({page}) => {
  await page.setViewportSize({width:1280,height:900});
  await page.goto(`${prototypeUrl}index.html?frame=true&list=none`);
  await expect(page.getByRole('complementary')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'대화 목록 열기 또는 접기'})).toHaveCount(0);
  const main=await page.getByRole('main').boundingBox();
  expect(main.width).toBe(1216);
});


test('main controls and composer approval preserve explicit decisions', async ({page}) => {
  await page.setViewportSize({width:1440,height:1100});
  await page.goto(prototypeUrl);const f=page.frameLocator('iframe');
  await page.getByRole('combobox',{name:'화면',exact:true}).selectOption('controls');
  await expect(f.getByRole('dialog')).toHaveCount(0);
  await expect(f.getByRole('textbox',{name:'자료 제목'})).toBeVisible();
  await page.getByRole('combobox',{name:'화면',exact:true}).selectOption('permission');
  const approval=f.locator('.compose-area details.file-approval');
  await expect(approval).toBeVisible();
  await expect(f.getByRole('button',{name:'이번 수정 허용'})).toBeHidden();
  await approval.locator('summary').click();
  await expect(f.getByText('회의/제품 검토 메모.md',{exact:true})).toBeVisible();
  await expect(f.getByRole('button',{name:'이번 수정 허용'})).toBeEnabled();
  await approval.locator('summary').click();await approval.locator('summary').click();
  await expect(f.getByRole('button',{name:'이번 수정 허용'})).toBeEnabled();
  await f.getByRole('button',{name:'거절',exact:true}).click();
  await expect(f.getByText('거절했습니다. 예제 파일은 변경하지 않았습니다.')).toBeVisible();
});

test('settings navigation separates existing sections and becomes a full menu on narrow screens', async ({page}) => {
  await page.setViewportSize({width:1440,height:1100});await page.goto(prototypeUrl);
  const f=page.frameLocator('iframe');
  await expect(f.getByRole('complementary',{name:'설정 메뉴'})).toBeVisible();
  await expect(f.getByRole('complementary',{name:'대화 목록'})).toHaveCount(0);
  const nav=f.getByRole('navigation',{name:'설정 메뉴',exact:true});
  await nav.getByRole('button',{name:'AI',exact:true}).click();
  await expect(f.getByRole('heading',{name:'AI 인증'})).toBeVisible();
  await expect(f.getByRole('textbox',{name:'Main Color HEX'})).toHaveCount(0);
  await page.locator('iframe').screenshot({path:resolve(out,'v4-settings-ai.png')});
  await nav.getByRole('button',{name:'연결',exact:true}).click();
  await expect(f.getByRole('button',{name:'연결 설정 변경'})).toBeVisible();
  await nav.getByRole('button',{name:'화면',exact:true}).click();
  await expect(f.getByRole('textbox',{name:'Main Color HEX'})).toBeVisible();
  await page.locator('iframe').screenshot({path:resolve(out,'v4-settings-appearance.png')});
  await page.getByRole('combobox',{name:'화면 폭',exact:true}).selectOption('320');
  await f.getByRole('button',{name:'← 설정 메뉴'}).click();
  await expect(f.locator('.stacked-list')).toBeVisible();
  await expect(f.getByRole('dialog')).toHaveCount(0);
  await page.locator('iframe').screenshot({path:resolve(out,'v5-settings-menu-mobile.png')});
  await f.locator('.stacked-list').getByRole('button',{name:'AI',exact:true}).click();
  await expect(f.locator('.stacked-list')).toBeHidden();
  await expect(f.getByRole('heading',{name:'AI 인증'})).toBeVisible();
  await expect.poll(()=>f.locator('html').evaluate(el=>el.scrollWidth<=innerWidth)).toBe(true);

});


test('mobile navigation follows browser history and restores drafts and list position', async ({page}) => {
  await page.setViewportSize({width:390,height:850});
  await page.goto(`${prototypeUrl}index.html?frame=true&scene=chat`);
  const list=page.locator('.conversation-list');
  await expect(page.locator('.stacked-list')).toBeVisible();
  const selected=list.getByRole('button').nth(8);
  await selected.scrollIntoViewIfNeeded();
  const scroll=await list.evaluate(el=>el.scrollTop);
  await selected.click();
  await expect(page.getByRole('heading',{name:'검토 대화 9'})).toBeVisible();
  const draft=page.getByRole('textbox',{name:'메시지',exact:true});
  await draft.fill('목록으로 돌아가도 남겨둘 초안');
  await page.screenshot({path:resolve(out,'v5-chat-mobile.png')});
  await page.getByRole('button',{name:'← 대화 목록',exact:true}).click();
  await expect(page.locator('.stacked-list')).toBeVisible();
  await expect.poll(()=>list.evaluate(el=>el.scrollTop)).toBe(scroll);
  await expect(selected).toHaveAttribute('aria-current','page');
  await page.screenshot({path:resolve(out,'v5-chat-list-mobile.png')});
  await page.goForward();await expect(draft).toHaveValue('목록으로 돌아가도 남겨둘 초안');
  await page.goBack();await expect(page.locator('.stacked-list')).toBeVisible();
  await page.getByRole('button',{name:'← Module',exact:true}).click();
  await expect(page.getByRole('region',{name:'Module 선택'})).toBeVisible();
  await page.screenshot({path:resolve(out,'v5-module-picker-mobile.png')});
  await page.getByRole('region',{name:'Module 선택'}).getByRole('button',{name:/설정/}).click();
  await page.locator('.stacked-list').getByRole('button',{name:'AI',exact:true}).click();
  await expect(page.getByRole('heading',{name:'AI 인증'})).toBeVisible();
  await page.goBack();await expect(page.locator('.stacked-list')).toBeVisible();
  await page.goBack();await expect(page.getByRole('region',{name:'Module 선택'})).toBeVisible();
  await page.goForward();
  await page.locator('.stacked-list').getByRole('button',{name:'화면',exact:true}).click();
  const accent=()=>page.locator('html').evaluate(el=>el.style.getPropertyValue('--accent-background'));
  const original=await accent();
  await page.getByRole('textbox',{name:'Main Color HEX'}).fill('#4361ee');
  await expect.poll(accent).not.toBe(original);
  await page.getByRole('button',{name:'← 설정 메뉴',exact:true}).click();
  await expect.poll(accent).toBe(original);
  const entries=await page.evaluate(()=>history.length);
  await page.setViewportSize({width:1280,height:900});
  await expect(page.getByRole('complementary',{name:'설정 메뉴'})).toBeVisible();
  await page.setViewportSize({width:390,height:850});
  await expect(page.locator('.stacked-list')).toBeVisible();
  expect(await page.evaluate(()=>history.length)).toBe(entries);
});


test('stacked approval remains reachable in a short mobile viewport and list-free content opens directly', async ({page}) => {
  await page.setViewportSize({width:320,height:480});
  await page.goto(`${prototypeUrl}index.html?frame=true&scene=permission&state=error`);
  await expect(page.getByRole('textbox',{name:'메시지'})).toBeVisible();
  await page.locator('.file-approval summary').click();
  const allow=page.getByRole('button',{name:'이번 수정 허용'});
  await allow.scrollIntoViewIfNeeded();
  await expect(allow).toBeInViewport();
  await allow.click();await expect(page.getByRole('status').filter({hasText:'허용했습니다.'})).toBeVisible();
  await page.getByRole('textbox',{name:'메시지'}).scrollIntoViewIfNeeded();
  await expect(page.getByRole('textbox',{name:'메시지'})).toBeInViewport();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:resolve(out,'v5-short-mobile.png')});
  await page.goto(`${prototypeUrl}index.html?frame=true&scene=chat&list=none`);
  await expect(page.getByRole('textbox',{name:'메시지'})).toBeVisible();
  await expect(page.locator('.stacked-list')).toBeHidden();
  await page.getByRole('button',{name:'← Module',exact:true}).click();
  await expect(page.getByRole('region',{name:'Module 선택'})).toBeVisible();
});
