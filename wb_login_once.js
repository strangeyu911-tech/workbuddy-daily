// 一次性登录引导器（Edge 版）v5 —— CDP 附着常驻窗口版
//
// 迭代历史：
//   v1 spawn 盲发：对启动结果毫无感知。
//   v2 Playwright headful：cookie 判据太松，谎报成功（2026-09-06 踩到）。
//   v3 判据改为「页面 URL 真正离开 /login」+ headless 权威验证。
//   v4 网络预检降级为警告、新增 --fresh / --proxy 等。
//   v5（本版）改为与 wb_auto_task.js 相同的「常驻 Edge + CDP 附着」架构：
//      - 背景发现：workbuddy.cn 登录 = Keycloak SSO（/console/accounts 302 →
//        auth/realms/copilot）。Keycloak identity cookie 是浏览器会话级，
//        v4 登录完关浏览器它就没了；磁盘上只剩 7 天期的 app session cookie，
//        而该 cookie 会在服务端被单独作废（2026-09-06 实测：cookie 在、
//        服务端 302 回登录页）→ 登录态莫名失效。
//      - 对策：登录也在常驻窗口里新开 tab 完成，登完**不关浏览器**。
//        SSO 会话常驻内存，app session 落盘，双保险。
//      - 若 9223 端口已有常驻 Edge 则直接附着复用（不再 killStaleEdge，
//        不再和派猫窗口抢 profile）；没有就拉起一个并保持常驻。
//
// 用法:
//   node wb_login_once.js                 # 登录（复用/拉起常驻窗口，默认等 8 分钟）
//   node wb_login_once.js --timeout=15    # 自定义等待分钟数
//   node wb_login_once.js --probe         # 只做网络预检
//   node wb_login_once.js --fresh         # 关掉常驻 Edge、备份旧 profile、全新重来
//   node wb_login_once.js --kill          # 只关掉常驻 Edge 后退出
//   node wb_login_once.js --proxy=host:port
//   node wb_login_once.js --strict        # 网络预检失败即中止（默认只警告）

const fs = require("fs");
const path = require('path');
const { chromium } = require('C:/Users/23159/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { spawn } = require('child_process');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = path.join(__dirname, 'wb_auto_profile_edge');
const CDP_PORT = 9223;
const CDP_URL = 'http://127.0.0.1:' + CDP_PORT;
const LOGIN = 'https://www.workbuddy.cn/login/?platform=usercenter&redirect_uri=https%3A%2F%2Fwww.workbuddy.cn%2Fprofile%2Fgrowth-center';
const GROWTH = 'https://www.workbuddy.cn/profile/growth-center';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const WAIT_MIN = (() => {
  const a = argv.find(x => x.startsWith('--timeout='));
  const n = a ? parseInt(a.split('=')[1], 10) : 8;
  return n > 0 ? n : 8;
})();

function killStaleEdge() {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*wb_auto_profile_edge*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try { require('child_process').spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' }); } catch (e) {}
}

async function portAlive() {
  try { const r = await fetch(CDP_URL + '/json/version', { signal: AbortSignal.timeout(2000) }); return r.ok; }
  catch (e) { return false; }
}

// 复用或拉起常驻 Edge（与 wb_auto_task.js 保持一致）
async function getBrowser() {
  if (!(await portAlive())) {
    console.log('    常驻 Edge 不在运行，拉起中（之后保持常驻）…');
    const proxyArg = argv.find(x => x.startsWith('--proxy='));
    const args = [
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + PROFILE,
      '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--disable-session-crashed-bubble',
      '--start-maximized',
    ];
    if (proxyArg) args.push('--proxy-server=' + proxyArg.split('=')[1]);
    const child = spawn(EDGE, args, { detached: true, stdio: 'ignore' });
    child.unref();
    let up = false;
    for (let i = 0; i < 30; i++) { await sleep(1000); if (await portAlive()) { up = true; break; } }
    if (!up) throw new Error('Edge 已拉起但调试端口 ' + CDP_PORT + ' 未就绪');
  } else {
    console.log('    ✓ 复用已打开的常驻 Edge 窗口');
  }
  return chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
}

async function netProbe() {
  for (let i = 1; i <= 3; i++) {
    try { await fetch(GROWTH, { redirect: 'manual', signal: AbortSignal.timeout(10000) }); return { ok: true, tryCount: i }; }
    catch (e) { if (i < 3) await sleep(1500); }
  }
  return { ok: false };
}

function printNetHelp() {
  console.error('   注意：探测失败**不一定**代表你上不了网 —— 若本脚本运行在受限终端');
  console.error('   （如自动化沙箱）里，出网本身就被限制。用你平时的 Edge 打开');
  console.error('   https://www.workbuddy.cn/ 试试即可判断。');
}

// 在常驻浏览器里新开 tab 复验（不关浏览器）
async function verifyInContext(context) {
  let page;
  try {
    page = await context.newPage();
    await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (e) {}
    await sleep(2500);
    return /\/login/.test(page.url()) ? 'not-logged-in' : 'logged-in';
  } catch (e) {
    return 'error:' + String(e.message || e).split('\n')[0];
  } finally {
    try { if (page) await page.close(); } catch (e) {}
  }
}

(async () => {
  console.log('[0/5] 网络预检…');
  const probe = await netProbe();
  if (probe.ok) console.log('    ✓ workbuddy.cn 可达（第 ' + probe.tryCount + ' 次探测通过）');
  else {
    console.error('    ✗ 连续 3 次探测失败（仅警告，继续）');
    printNetHelp();
    if (has('--strict')) { console.error('   --strict 已指定，中止。'); process.exit(2); }
  }
  if (has('--probe')) { console.log('probe 模式结束。'); process.exit(probe.ok ? 0 : 2); }

  // --kill：只关常驻 Edge
  if (has('--kill')) {
    if (await portAlive()) {
      try { const b = await chromium.connectOverCDP(CDP_URL); await b.close(); } catch (e) {}
      await sleep(1500);
    }
    killStaleEdge();
    console.log('✓ 常驻 Edge 已关闭。');
    process.exit(0);
  }

  // --fresh：先关浏览器再备份 profile
  if (has('--fresh')) {
    if (await portAlive()) {
      console.log('[1/5] --fresh：先关闭常驻 Edge…');
      try { const b = await chromium.connectOverCDP(CDP_URL); await b.close(); } catch (e) {}
      await sleep(2000);
    }
    killStaleEdge();
    await sleep(1500);
    if (fs.existsSync(PROFILE)) {
      const bak = PROFILE + '.bak.' + Date.now();
      try { fs.renameSync(PROFILE, bak); console.log('    ✓ 已备份旧 profile → ' + path.basename(bak)); }
      catch (e) { console.error('    ✗ 备份失败: ' + e.message); process.exit(1); }
    }
    console.log('    ✓ 将使用全新的空 profile');
  }

  console.log('[2/5] 就绪常驻 Edge（CDP 端口 ' + CDP_PORT + '）…');
  let browser;
  try { browser = await getBrowser(); }
  catch (e) {
    console.error('❌ Edge 启动/附着失败: ' + String(e.message || e).split('\n')[0]);
    process.exit(1);
  }
  const context = browser.contexts()[0];
  let browserGone = false;
  context.on('close', () => { browserGone = true; });

  console.log('[3/5] 新开 tab 打开登录页…');
  const page = await context.newPage();
  try {
    const resp = await page.goto(LOGIN, { waitUntil: 'domcontentloaded', timeout: 45000 });
    console.log('    ✓ 已加载  HTTP ' + (resp && resp.status()) + '  URL: ' + page.url());
    console.log('      标题: ' + (await page.title().catch(() => '(读取失败)')));
  } catch (e) {
    console.error('    ⚠️ 登录页加载失败: ' + String(e.message || e).split('\n')[0]);
    console.error('      当前 URL: ' + page.url());
    printNetHelp();
  }

  console.log('[4/5] 请在常驻 Edge 窗口的新标签页里扫码 / 输账号登录');
  console.log('      登录成功后本脚本自动结束；浏览器**不会关闭**（常驻）。上限 ' + WAIT_MIN + ' 分钟。');

  const deadline = Date.now() + WAIT_MIN * 60 * 1000;
  let outcome = 'timeout';
  while (Date.now() < deadline) {
    if (browserGone) { outcome = 'browser-closed'; break; }
    try {
      const urls = context.pages().map(p => p.url()).filter(Boolean);
      if (urls.some(u => /workbuddy\.cn/.test(u) && !/\/login/.test(u))) { outcome = 'redirected'; break; }
    } catch (e) { /* 浏览器正在关闭 */ }
    await sleep(2000);
  }

  if (outcome === 'timeout') {
    console.log('\n⏱ 等待超时（' + WAIT_MIN + ' 分钟）。浏览器保持常驻，可手动重试或 --kill 关闭。');
  } else if (outcome === 'browser-closed') {
    console.log('\n👋 整个常驻 Edge 被关闭了。下次运行会自动重新拉起。');
  } else {
    console.log('\n✅ 检测到页面已离开登录页。');
    console.log('   等待 8 秒让登录态写盘…');
    await sleep(8000);
    console.log('   在常驻浏览器内新开 tab 复验成长中心…');
    const verdict = await verifyInContext(context);
    if (verdict === 'logged-in') {
      console.log('   ✓ 登录成功且 SSO 会话已在常驻浏览器内生效');
      console.log('   ✓ 浏览器保持常驻 —— 直接运行 run_cat.bat（或 node wb_auto_task.js）即可派猫');
    } else if (verdict === 'not-logged-in') {
      console.log('   ⚠️ 页面虽已跳转，但成长中心仍要求登录。');
      console.log('     常驻窗口保持打开 —— 请在里面手动打开成长中心确认一下。');
    } else {
      console.log('   ⚠️ 复验未完成: ' + verdict);
    }
  }
  console.log('   登录态目录: ' + PROFILE);
  process.exit(0);
})().catch(e => {
  console.error('ERR', (e && e.stack) || e);
  process.exit(1);
});
