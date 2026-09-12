// 探针4：完整跑「领礼物」流程，全程 generous 轮询 + 逐步 dump，验证 2s 等待是否为失败根因
// 只领礼物，不派遣
const { chromium } = require('./wb_paths').playwright();
const { spawn } = require('child_process');
const EDGE = require('./wb_paths').edge();
const PROFILE = require('./wb_paths').profile();
const CDP_PORT = 9223;
const CDP_URL = 'http://127.0.0.1:' + CDP_PORT;
const GROWTH = 'https://www.workbuddy.cn/profile/growth-center';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function portAlive() {
  try { const r = await fetch(CDP_URL + '/json/version', { signal: AbortSignal.timeout(2000) }); return r.ok; }
  catch (e) { return false; }
}
async function getBrowser() {
  if (!(await portAlive())) {
    const child = spawn(EDGE, ['--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--disable-session-crashed-bubble', '--window-size=1200,800'], { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 30; i++) { await sleep(1000); if (await portAlive()) break; }
  }
  return chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
}
const dump = () => {
  const b = document.querySelector('button.gs-buddy-travel');
  const ov = document.querySelector('.gs-modal-overlay');
  const modalBtns = ov ? [...ov.querySelectorAll('button,[role=button]')]
    .map(e => ({ t: (e.innerText || '').replace(/\s+/g, ' ').trim(), disabled: !!e.disabled })) : [];
  return {
    travelBtn: b ? (b.innerText || '').replace(/\s+/g, ' ').trim() : null,
    disabled: b ? !!b.disabled : null,
    modal: ov ? { text: (ov.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300), btns: modalBtns } : null,
  };
};

(async () => {
  const browser = await getBrowser();
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
  for (let a = 0; a < 2; a++) {
    try { await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 }); break; }
    catch (e) { await sleep(4000); }
  }
  for (let i = 0; i < 30 && !(await page.locator('button.gs-buddy-travel').count()); i++) await sleep(1000);
  const log = [];
  log.push({ step: 'initial', ...(await page.evaluate(dump)) });

  await page.locator('button.gs-buddy-travel').first().click({ timeout: 8000 });

  // 观察弹窗出现耗时
  const t0 = Date.now(); let appeared = -1;
  for (let i = 0; i < 30; i++) {
    if (await page.locator('.gs-modal-overlay').count()) { appeared = Date.now() - t0; break; }
    await sleep(250);
  }
  log.push({ step: 'modalAppearedAfterMs', ms: appeared, ...(await page.evaluate(dump)) });

  await page.screenshot({ path: 'wb_probe.png' }).catch(() => {});

  const claim = page.locator('.gs-modal-overlay').locator('button', { hasText: /领取\s*\d+\s*积分/ }).first();
  const hasClaim = await claim.count();
  log.push({ step: 'claimFound', hasClaim });
  if (hasClaim) {
    await claim.click({ timeout: 6000 }).catch(e => log.push({ step: 'claimClickErr', msg: e.message.split('\n')[0] }));
    await sleep(2500);
    log.push({ step: 'afterClaim', ...(await page.evaluate(dump)) });
  }

  // 关弹窗：优先点关闭按钮 / Esc
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(1200);
  log.push({ step: 'afterEsc', ...(await page.evaluate(dump)) });

  await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const t1 = Date.now(); let btnMs = -1;
  for (let i = 0; i < 40; i++) {
    if (await page.locator('button.gs-buddy-travel').count()) { btnMs = Date.now() - t1; break; }
    await sleep(500);
  }
  log.push({ step: 'afterReload', btnAppearedAfterMs: btnMs, ...(await page.evaluate(dump)) });

  console.log(JSON.stringify(log, null, 2));
  try { await page.close(); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.stack || e); process.exit(1); });
