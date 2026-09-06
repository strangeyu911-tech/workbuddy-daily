// 诊断：点击派猫按钮后，是否出现二次确认弹窗/模态框，并尝试完成派遣
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
  killStaleEdge();
  await sleep(1500);
  const context = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: true,
    args: ['--no-first-run', '--disable-gpu', '--disable-dev-shm-usage']
  });
  const page = await context.newPage();
  const log = [];
  await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(6000);

  const btn = page.locator('button.gs-buddy-travel').first();
  const before = (await btn.innerText()).replace(/\s+/g, ' ').trim();
  log.push('BUTTON_BEFORE=' + before + ' enabled=' + (await btn.isEnabled().catch(() => false)));

  // 点击主按钮
  await btn.click({ timeout: 6000 });
  log.push('CLICKED_MAIN');
  await sleep(1500);

  // 查找可能的二次确认弹窗（DOM 模态框 / 含 确定/确认/出发/去吧 的按钮）
  const candidates = await page.evaluate(() => {
    const res = [];
    // 常见模态框容器
    const modals = document.querySelectorAll('[role="dialog"], .modal, .dialog, .confirm, [class*="modal"], [class*="dialog"], [class*="confirm"]');
    modals.forEach(m => res.push({ type: 'modal', text: (m.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200) }));
    // 含确认语义的按钮
    const btns = Array.from(document.querySelectorAll('button, [role="button"], a.btn, div.btn'));
    btns.forEach(b => {
      const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
      if (/确定|确认|出发|去吧|开始旅行|立即出发|去旅行/.test(t)) res.push({ type: 'confirmBtn', text: t });
    });
    return res;
  });
  log.push('CANDIDATES=' + JSON.stringify(candidates));

  // 若存在确认按钮，点击第一个
  let confirmClicked = false;
  if (candidates.some(c => c.type === 'confirmBtn')) {
    const cb = page.locator('button, [role="button"], a.btn, div.btn').filter({ hasText: /确定|确认|出发|去吧|开始旅行|立即出发|去旅行/ }).first();
    try { await cb.click({ timeout: 4000 }); confirmClicked = true; log.push('CLICKED_CONFIRM'); } catch (e) { log.push('CONFIRM_CLICK_FAIL=' + e.message.split('\n')[0]); }
  }
  await sleep(8000); // 等待派遣请求完成 + 状态刷新

  const after = (await btn.innerText()).replace(/\s+/g, ' ').trim();
  const afterEnabled = await btn.isEnabled().catch(() => false);
  log.push('BUTTON_AFTER=' + after + ' enabled=' + afterEnabled);

  console.log(JSON.stringify({ login: !page.url().includes('/login'), log, confirmClicked }, null, 2));
  try { await context.close(); } catch (e) {}
  try { killStaleEdge(); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.stack || e); try { killStaleEdge(); } catch (_) {} process.exit(1); });
