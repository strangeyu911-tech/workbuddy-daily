// 只读诊断：仅读取派猫猫旅行按钮真实状态，不点击、无副作用
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
  killStaleEdge();
  await sleep(1500);
  const context = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: true,
    args: ['--no-first-run', '--disable-gpu', '--disable-dev-shm-usage']
  });
  const page = await context.newPage();
  const out = { login: null, url: null, button: null };
  await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(6000);
  out.url = page.url();
  out.login = !page.url().includes('/login');
  const btn = page.locator('button.gs-buddy-travel').first();
  if (await btn.count()) {
    const txt = (await btn.innerText()).replace(/\s+/g, ' ').trim();
    const enabled = await btn.isEnabled().catch(() => false);
    out.button = { found: true, text: txt, enabled };
  } else {
    out.button = { found: false };
  }
  console.log(JSON.stringify(out, null, 2));
  try { await context.close(); } catch (e) {}
  try { killStaleEdge(); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.stack || e); try { killStaleEdge(); } catch (_) {} process.exit(1); });
