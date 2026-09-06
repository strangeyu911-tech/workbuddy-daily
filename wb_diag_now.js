// 一次性诊断：打印成长中心猫旅行按钮的真实状态 + 页面关键文案
const { chromium } = require('C:/Users/23159/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = 'C:/Users/23159/WorkBuddy/2026-08-15-22-57-14/wb_auto_profile_edge';
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
  const url = page.url();
  const info = await page.evaluate(() => {
    const out = { url: location.href, btns: [] };
    document.querySelectorAll('button.gs-buddy-travel').forEach(b => out.btns.push({ txt: b.innerText.replace(/\s+/g,' ').trim(), enabled: !b.disabled, cls: b.className }));
    // 兜底：抓所有含 派/旅行/礼物/领取/倒计时 的按钮或可点元素
    document.querySelectorAll('button, [role=button], a.btn, div.btn').forEach(el => {
      const t = el.innerText ? el.innerText.replace(/\s+/g,' ').trim() : '';
      if (/派|旅行|礼物|领取|倒计时|回家|采风/.test(t)) out.btns.push({ txt: t, enabled: !el.disabled, cls: el.className, tag: el.tagName });
    });
    out.bodyHas = /领取礼物|派猫猫旅行|旅行倒计时|累啦/.test(document.body.innerText) ? document.body.innerText.match(/领取礼物|派猫猫旅行|旅行倒计时|累啦[^。]*。?/g) : [];
    return out;
  });
  console.log(JSON.stringify({ url, ...info }, null, 2));
  try { await context.close(); } catch(e){}
  try { killStaleEdge(); } catch(e){}
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.stack || e); try { killStaleEdge(); } catch(_){} process.exit(1); });
