// 诊断3：领礼物→关弹窗→刷新页面→读按钮态
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
  await page.locator('button.gs-buddy-travel').first().click({ timeout: 6000 });
  await sleep(2000);
  const claim = page.locator('button,[role=button],a.btn,div.btn').filter({ hasText: /领取\s*\d+\s*积分/ }).first();
  if (await claim.count()) await claim.click({ timeout: 4000 }).catch(()=>{});
  await sleep(1500);
  await page.keyboard.press('Escape').catch(()=>{});
  await sleep(1000);
  // 刷新
  await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(8000);
  const after = await page.evaluate(() => {
    const b = document.querySelector('button.gs-buddy-travel');
    return { url: location.href, btnTxt: b ? b.innerText.replace(/\s+/g,' ').trim() : '(no btn)', enabled: b ? !b.disabled : null };
  });
  console.log(JSON.stringify({ afterReload: after }, null, 2));
  try { await context.close(); } catch(e){}
  try { killStaleEdge(); } catch(e){}
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.stack || e); try { killStaleEdge(); } catch(_){} process.exit(1); });
