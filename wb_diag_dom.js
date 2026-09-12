// 只读探针：拉起/复用常驻 Edge，进入成长中心，dump 派猫按钮 + 可见弹窗 + 所有按钮文案
// 不做任何点击（除非传 --click 才会点一下主按钮用来观察弹窗结构）
const { chromium } = require('./wb_paths').playwright();
const { spawn } = require('child_process');
const EDGE = require('./wb_paths').edge();
const PROFILE = require('./wb_paths').profile();
const CDP_PORT = 9223;
const CDP_URL = 'http://127.0.0.1:' + CDP_PORT;
const GROWTH = 'https://www.workbuddy.cn/profile/growth-center';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DO_CLICK = process.argv.includes('--click');

async function portAlive() {
  try { const r = await fetch(CDP_URL + '/json/version', { signal: AbortSignal.timeout(2000) }); return r.ok; }
  catch (e) { return false; }
}
async function getBrowser() {
  if (!(await portAlive())) {
    const child = spawn(EDGE, [
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--disable-session-crashed-bubble', '--window-size=1200,800',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 30; i++) { await sleep(1000); if (await portAlive()) break; }
  }
  return chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
}

const snapFn = () => {
  const b = document.querySelector('button.gs-buddy-travel');
  const btns = [...document.querySelectorAll('button,[role=button],a.btn,div.btn')]
    .filter(e => e.offsetParent !== null || e.getClientRects().length)
    .map(e => (e.innerText || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean).slice(0, 60);
  // 疑似弹窗容器
  const modals = [...document.querySelectorAll('[class*="modal"],[class*="Modal"],[class*="dialog"],[class*="Dialog"],[class*="popup"],[class*="Popup"],[class*="drawer"],[class*="overlay"]')]
    .filter(e => e.offsetParent !== null || e.getClientRects().length)
    .slice(0, 5)
    .map(e => ({
      cls: e.className && String(e.className).slice(0, 120),
      text: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    }));
  return {
    url: location.href,
    travelBtn: b ? {
      text: (b.innerText || '').replace(/\s+/g, ' ').trim(),
      disabled: !!b.disabled,
      outer: b.outerHTML.replace(/\s+/g, ' ').slice(0, 600),
    } : null,
    visibleButtons: btns,
    modals,
  };
};

(async () => {
  const browser = await getBrowser();
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
  const out = { steps: [] };
  for (let a = 0; a < 2; a++) {
    try { await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 }); break; }
    catch (e) { await sleep(4000); }
  }
  await sleep(6000);
  // 页面 SPA 渲染慢（实测 ~10s），轮询等按钮出现
  for (let i = 0; i < 20 && !(await page.locator('button.gs-buddy-travel').count()); i++) await sleep(1000);
  out.steps.push({ tag: 'initial', ...(await page.evaluate(snapFn)) });

  if (DO_CLICK) {
    const btn = page.locator('button.gs-buddy-travel').first();
    if (await btn.count()) {
      await btn.click({ timeout: 8000 }).catch(e => { out.clickErr = e.message.split('\n')[0]; });
      await sleep(2500);
      out.steps.push({ tag: 'afterClick', ...(await page.evaluate(snapFn)) });
    }
  }
  console.log(JSON.stringify(out, null, 2));
  try { await page.close(); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.stack || e); process.exit(1); });
