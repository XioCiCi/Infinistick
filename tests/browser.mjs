import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
let playwright;
try {playwright=require('playwright');}
catch {playwright=require(process.env.PLAYWRIGHT_MODULE_PATH||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
const executablePath=process.env.BROWSER_EXECUTABLE||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined);
const browser=await playwright.chromium.launch({headless:true,executablePath});
const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true,hasTouch:true,timezoneId:'Asia/Shanghai'});
const page=await context.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:8788';
await fs.mkdir('test-results',{recursive:true});

async function clickBlank() {await page.mouse.click(1150,700);await page.waitForTimeout(650);}
async function newNote(time='2026-10-13T15:30') {
  await page.getByRole('button',{name:'新增便签',exact:true}).click();
  await page.locator('#field-time').fill(time);
  await page.getByRole('button',{name:'创建便签',exact:true}).click();
  await page.locator('.note.editing').waitFor();
  return page.locator('.note.editing').getAttribute('data-id');
}
async function note(id) {return page.locator(`.note[data-id="${id}"]`);}
async function saved() {await page.waitForFunction(()=>document.querySelector('#save-text').textContent==='已保存');}
try {
  await page.goto(base);
  await page.locator('#password').fill('canvas-demo');
  await page.getByRole('button',{name:'进入我的画布'}).click();
  await page.locator('#app').waitFor({state:'visible'});
  await page.locator('.note').first().waitFor();
  await page.waitForTimeout(400);
  const baseline=await context.request.get(base+'/api/backup');
  const backup=await baseline.body();
  try {
    await page.screenshot({path:'test-results/overview.png'});
    const id=await newNote('2026-09-01T09:15');
    const editor=page.locator(`.note[data-id="${id}"] .editor`);
    await page.locator('.note-title-input').fill('浏览器验证便签');
    await editor.fill('第一段内容，点击空白处要保存并卷回。');
    await saved();
    // 左键拖动空白处不退出编辑。
    await page.mouse.move(1150,700);await page.mouse.down();await page.mouse.move(1180,720,{steps:4});await page.mouse.up();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.note.editing').count(),1);
    await clickBlank();
    assert.equal(await page.locator('.note.expanded').count(),0);
    let data=await (await context.request.get(base+'/api/state')).json();
    let record=data.records.find(r=>r.id===id);
    assert.equal(record.title,'浏览器验证便签');assert.ok(record.body.includes('第一段内容'));
    await (await note(id)).click();await page.waitForTimeout(350);
    assert.equal(await page.locator('.note.expanded').count(),1);
    await page.locator('.note.expanded [data-action="pin"]').click();await saved();
    await page.locator('.note.expanded [data-action="edit"]').click();
    await page.locator('.note.editing .editor').fill('钉住以后，空白处保存但不卷回。');
    const unchangedTimeView=await page.locator('#world').getAttribute('style');
    await clickBlank();
    assert.equal(await page.locator('#world').getAttribute('style'),unchangedTimeView);
    assert.equal(await page.locator('.note.expanded').count(),1);assert.equal(await page.locator('.note.editing').count(),0);
    assert.equal(await page.locator('.pin-button').getAttribute('aria-pressed'),'true');
    // 手动移动和尺寸调整持久化。
    const header=await page.locator('.note.expanded .note-header').boundingBox();
    await page.mouse.move(header.x+55,header.y+20);await page.mouse.down();await page.mouse.move(header.x+110,header.y+60,{steps:6});await page.mouse.up();await page.waitForTimeout(150);
    const handle=await page.locator('.note.expanded .resize-handle').boundingBox();
    await page.mouse.move(handle.x+9,handle.y+9);await page.mouse.down();await page.mouse.move(handle.x+70,handle.y+65,{steps:6});await page.mouse.up();await saved();
    data=await (await context.request.get(base+'/api/state')).json();record=data.records.find(r=>r.id===id);assert.ok(record.layout.width>430);
    await page.screenshot({path:'test-results/pinned.png'});
    await page.reload();await page.locator('.pin-button[aria-pressed="true"]').waitFor();
    assert.equal(await page.locator('.note.expanded').count(),1);
    // 最新时间移到时间线尾部。
    await (await note(id)).click();await page.waitForTimeout(350);
    await page.locator('.note.expanded [data-action="edit"]').click();
    // 无效时间必须保留正文和未保存状态。
    await page.locator('.record-time-input').fill('');
    await page.locator('.editor').fill('时间为空时也不能遗漏当前正文');
    await page.waitForTimeout(650);
    assert.ok((await page.locator('#save-text').textContent()).includes('保存失败'));
    await clickBlank();assert.equal(await page.locator('.note.editing').count(),1);
    await page.locator('.record-time-input').fill('2026-12-01T10:00');
    await clickBlank();data=await (await context.request.get(base+'/api/state')).json();record=data.records.find(r=>r.id===id);
    assert.equal(record.time,'2026-12-01T02:00:00+00:00');
    // 红钉编辑贴纸收起的第二次保存失败，后续输入仍需被读取。
    await page.locator('.note.expanded [data-action="edit"]').click();
    let closeRequests=0;
    await page.route('**/api/records/*',route=>++closeRequests===1?route.continue():route.abort('failed'));
    await page.locator('.editor').fill('收起失败前的正文');
    await page.locator('.note.expanded [data-action="close"]').click();await page.waitForTimeout(450);
    assert.equal(await page.locator('.note.editing').count(),1);
    assert.equal(await page.locator('.pin-button').getAttribute('aria-pressed'),'true');
    await page.locator('.editor').fill('收起失败之后仍可保存的新正文');
    await page.unroute('**/api/records/*');await page.locator('#save-status').click();await saved();await clickBlank();
    data=await (await context.request.get(base+'/api/state')).json();assert.ok(data.records.find(r=>r.id===id).body.includes('收起失败之后仍可保存的新正文'));
    // 网络失败保持编辑和展开，重试成功后再卷回。
    await page.locator('.pin-button').click();
    await page.locator('.note.expanded [data-action="edit"]').click();
    await page.route('**/api/records/*',route=>route.abort('failed'));
    await page.locator('.editor').fill('断网时不能丢失的内容');await page.waitForTimeout(850);
    await clickBlank();assert.equal(await page.locator('.note.editing').count(),1);
    await page.unroute('**/api/records/*');await page.locator('#save-status').click();await saved();await clickBlank();
    assert.equal(await page.locator('.note.expanded').count(),0);
    // 空白便签保留。
    const emptyId=await newNote();await clickBlank();
    data=await (await context.request.get(base+'/api/state')).json();assert.ok(data.records.find(r=>r.id===emptyId));
    // 图片上传、代码和富文本。
    const imageId=await newNote('2026-10-13T15:40');
    await page.locator('.note-title-input').fill('图片与代码');
    await page.locator('.editor').fill('重要片刻');
    await page.locator('.editor').press('Control+A');
    await page.locator('[data-command="bold"]').click();await page.locator('[data-command="hiliteColor"]').click();await page.locator('[data-block="h2"]').click();
    await page.locator('.editor').press('ArrowRight');await page.locator('.editor').press('End');await page.locator('.editor').press('Enter');await page.locator('[data-block="p"]').click();
    await page.keyboard.type('清单第一项');await page.locator('[data-command="insertUnorderedList"]').click();await page.locator('.editor').press('Enter');await page.locator('.editor').press('Enter');
    await page.keyboard.type('编号条目');await page.locator('[data-command="insertOrderedList"]').click();await page.locator('.editor').press('Enter');await page.locator('.editor').press('Enter');
    await page.locator('[data-action="link"]').click();await page.locator('#field-url').fill('https://example.com/notes');await page.locator('#dialog-submit').click();await page.locator('.editor').press('End');await page.locator('.editor').press('Enter');
    await page.locator('[data-action="code"]').click();await page.locator('#field-code').fill('first line\n  indented line');await page.getByRole('button',{name:'插入',exact:true}).click();
    assert.equal(await page.locator('.editor pre').textContent(),'first line\n  indented line');
    await page.locator('[data-action="image"]').click();
    await page.route('**/api/images',route=>route.abort('failed'));
    await page.locator('#image-input').setInputFiles({name:'pixel.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4WQAAAAASUVORK5CYII=','base64')});
    await page.locator('[data-upload-retry]').waitFor();await clickBlank();assert.equal(await page.locator('.note.editing').count(),1);
    await page.unroute('**/api/images');await page.locator('[data-upload-retry]').click();
    await page.locator('.editor img').waitFor();await saved();await clickBlank();
    await (await note(imageId)).click();await page.waitForTimeout(350);
    await page.locator('.note.expanded .rich-content img').click();await page.locator('#image-viewer').waitFor({state:'visible'});await page.locator('#image-close').click();
    await page.locator('.note.expanded [data-action="delete"]').click();await page.locator('#dialog-submit').click();await page.waitForTimeout(650);
    await page.locator('#trash-button').click();await page.locator(`[data-restore="${imageId}"]`).click();await page.waitForTimeout(350);
    data=await (await context.request.get(base+'/api/state')).json();record=data.records.find(r=>r.id===imageId);assert.equal(record.deleted,false);assert.ok(record.body.includes('first line\n  indented line'));assert.ok(record.body.includes('/media/'));
    const formats=await page.evaluate(html=>{
      const doc=new DOMParser().parseFromString(html,'text/html');
      return {heading:!!doc.querySelector('h2'),bold:!!doc.querySelector('b,strong,.bold'),highlight:!!doc.querySelector('mark,.highlight'),unordered:!!doc.querySelector('ul'),ordered:!!doc.querySelector('ol'),link:!!doc.querySelector('a[href="https://example.com/notes"]')};
    },record.body);
    assert.deepEqual(formats,{heading:true,bold:true,highlight:true,unordered:true,ordered:true,link:true});
    await page.locator('[data-topic]').first().click();await page.waitForTimeout(500);
    await page.locator('#new-topic').click();await page.locator('#field-name').fill('独立主题验证');await page.getByRole('button',{name:'确认',exact:true}).click();await page.waitForTimeout(500);assert.equal(await page.locator('.note').count(),0);
    await page.locator('[data-topic]').first().click();await page.waitForTimeout(350);
    const downloadPromise=page.waitForEvent('download');await page.locator('#export-button').click();const download=await downloadPromise;assert.ok(download.suggestedFilename().endsWith('.zip'));
    // 手机仅阅读，关闭不改变画布位置。
    await page.setViewportSize({width:390,height:844});await page.waitForTimeout(450);
    const worldBefore=await page.locator('#world').getAttribute('style');
    await page.locator('.note').first().tap();await page.locator('#mobile-reader').waitFor({state:'visible'});await page.screenshot({path:'test-results/mobile.png'});await page.locator('#mobile-close').click();
    assert.equal(await page.locator('#world').getAttribute('style'),worldBefore);
    assert.deepEqual(errors,[]);
    console.log('Browser checks passed: blank roll, drag, pin, resize, refresh, backdate, failed save/retry, image, code, trash, themes, backup, mobile');
  } finally {
    const session=await (await context.request.get(base+'/api/session')).json();
    const response=await context.request.post(base+'/api/restore',{headers:{'X-CSRF-Token':session.csrf,'Content-Type':'application/zip'},data:backup});
    assert.equal(response.status(),200);
  }
} finally {await browser.close();}
