// 诊断2：开弹窗→点「领取 5 积分」→观察按钮态/跳页，并尝试关闭
const { chromium } = require('./wb_paths').playwright();
const EDGE = require('./wb_paths').edge();
const PROFILE = require('./wb_paths').profile();
const GROWTH = 'https://www.workbuddy.cn/profile/growth-center';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function killStaleEdge() {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*wb_auto_profile_edge*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try { require('child_process').spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' }); } catch (e) {}
}
(async () => {
  killStaleEdge(); await sleep(1500);
  const context = await chromium.launchPersistentContext(PROFILE, { executablePath: EDGE, headless: true, args: ['--no-first-run','--disable-gpu','--disable-dev-shm-usage'] });
  const page = await context.newPage();
  await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(8000);
  // 点领取礼物
  await page.locator('button.gs-buddy-travel').first().click({ timeout: 6000 });
  await sleep(2000);
  // 点「领取 5 积分」
  const claim = page.locator('button,[role=button],a.btn,div.btn').filter({ hasText: /领取\s*\d+\s*积分/ }).first();
  const claimed = await claim.count() ? (await claim.innerText()).trim() : '(none)';
  if (await claim.count()) { await claim.click({ timeout: 4000 }).catch(()=>{}); }
  await sleep(2000);
  const afterClaim = await page.evaluate(() => {
    const b = document.querySelector('button.gs-buddy-travel');
    const overlay = document.querySelector('[class*=modal],[class*=dialog],[class*=overlay],[class*=popup],[role=dialog]');
    return { url: location.href, btnTxt: b ? b.innerText.replace(/\s+/g,' ').trim() : '(no btn)',
             overlayTxt: overlay ? overlay.innerText.replace(/\s+/g,' ').trim().slice(0,120) : '(no overlay)' };
  });
  // 尝试关闭：Escape
  await page.keyboard.press('Escape').catch(()=>{});
  await sleep(1500);
  const afterEsc = await page.evaluate(() => {
    const b = document.querySelector('button.gs-buddy-travel');
    const overlay = document.querySelector('[class*=modal],[class*=dialog],[class*=overlay],[class*=popup],[role=dialog]');
    return { url: location.href, btnTxt: b ? b.innerText.replace(/\s+/g,' ').trim() : '(no btn)',
             overlayTxt: overlay ? overlay.innerText.replace(/\s+/g,' ').trim().slice(0,120) : '(no overlay)' };
  });
  console.log(JSON.stringify({ claimed, afterClaim, afterEsc }, null, 2));
  try { await context.close(); } catch(e){}
  try { killStaleEdge(); } catch(e){}
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.stack || e); try { killStaleEdge(); } catch(_){} process.exit(1); });
