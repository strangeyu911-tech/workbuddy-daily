// 诊断：点「领取礼物」后页面发生什么（弹窗？模态？按钮变化？）
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
  const before = await page.evaluate(() => {
    const b = document.querySelector('button.gs-buddy-travel');
    return { btnTxt: b ? b.innerText.replace(/\s+/g,' ').trim() : null,
             modals: document.body.innerText.slice(0,300) };
  });
  // 点领取礼物
  const btn = page.locator('button.gs-buddy-travel').first();
  await btn.click({ timeout: 6000 });
  const steps = [];
  for (let i=0;i<6;i++){
    await sleep(1500);
    const snap = await page.evaluate(() => {
      const b = document.querySelector('button.gs-buddy-travel');
      // 找可能的弹窗/模态
      const overlay = document.querySelector('[class*=modal],[class*=dialog],[class*=overlay],[class*=popup],[role=dialog]');
      const overlayTxt = overlay ? overlay.innerText.replace(/\s+/g,' ').trim().slice(0,200) : null;
      // 所有可点元素里含 礼物/确定/开心/收下/打开 的
      const clickables = [];
      document.querySelectorAll('button,[role=button],a.btn,div.btn').forEach(el=>{
        const t = el.innerText ? el.innerText.replace(/\s+/g,' ').trim() : '';
        if (/礼物|确定|开心|收下|打开|领取|去逛|出发|旅行/.test(t)) clickables.push(t);
      });
      return { btnTxt: b ? b.innerText.replace(/\s+/g,' ').trim() : '(no btn)',
               overlayTxt, clickables: [...new Set(clickables)] };
    });
    steps.push({ t: (i+1)*1.5+'s', ...snap });
    if (snap.btnTxt && snap.btnTxt !== before.btnTxt && !/礼物/.test(snap.btnTxt)) break;
  }
  console.log(JSON.stringify({ before, steps }, null, 2));
  try { await context.close(); } catch(e){}
  try { killStaleEdge(); } catch(e){}
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.stack || e); try { killStaleEdge(); } catch(_){} process.exit(1); });
