// 一次性登录引导器（Edge 版）v3 —— Playwright 受控启动 + 网络预检 + 权威验证
//
// 迭代历史：
//   v1 spawn 盲发：stdio:'ignore' + unref，对启动结果毫无感知，窗口卡住了照样打印「✅ 已启动」。
//   v2 改 Playwright headful：能报超时了，但「cookie 有变化」判据太松 —— 登录页加载失败时
//      Edge 也会写点 cookie，导致谎报「登录成功」（2026-09-06 实测踩到）。
//   v3 修正：
//      1) 启动前先做网络预检，网络不通直接说清楚，不让用户对着空窗口干等；
//      2) 成功判据改为「页面 URL 真正离开 /login」，cookie 只作参考；
//      3) 收尾时用 headless 打开成长中心做一次权威验证（是否仍被 302 到登录页），
//         把「网络不通」和「没登录」分开报告。
//   v4 修正：
//      4) 网络预检不再硬中止 —— 在某些受限终端（如自动化沙箱）里探测必然失败，
//         但用户本机网络是好的，硬中止反而挡住了正常流程。改为仅警告（--strict 才中止）。
//      5) 新增 --fresh：把旧 profile 改名备份后用全新目录，一键排除 profile 层面的疑难杂症。
//      6) 打开页面后打印实际 URL / 标题 / HTTP 状态，便于一眼看出卡在哪一步。
//
// 用法:
//   node wb_login_once.js                 # 打开可见 Edge，登录后自动收尾（默认 8 分钟）
//   node wb_login_once.js --timeout=15    # 自定义等待分钟数
//   node wb_login_once.js --probe         # 只做网络预检，不启动浏览器
//   node wb_login_once.js --fresh         # 备份旧 profile，用全新目录重来
//   node wb_login_once.js --proxy=host:port  # 让浏览器走指定代理
//   node wb_login_once.js --strict        # 网络预检失败即中止（默认只警告）
//   node wb_login_once.js --force         # 同义于忽略预检警告（保留兼容）

const fs = require("fs");
const path = require('path');
const { chromium } = require('C:/Users/23159/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
let PROFILE = path.join(__dirname, 'wb_auto_profile_edge');
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

// 清理占用同一 profile 的遗留 Edge（headless 自动化可能没退干净）
function killStaleEdge() {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*wb_auto_profile_edge*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try {
    require('child_process').spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
  } catch (e) { /* 无遗留进程时正常 */ }
}

// 网络预检：node 直连目标站，重试 3 次（本机网络抖动多，单次失败不作数）
async function netProbe() {
  for (let i = 1; i <= 3; i++) {
    try {
      await fetch(GROWTH, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      return { ok: true, tryCount: i };
    } catch (e) {
      if (i < 3) await sleep(1500);
    }
  }
  return { ok: false };
}

function printNetHelp() {
  console.error('   注意：探测失败**不一定**代表你上不了网 —— 若本脚本运行在受限终端');
  console.error('   （如自动化沙箱、容器内），出网本身就被限制，浏览器也会跟着失败。');
  console.error('   判断方法：用你平时那个 Edge 直接打开 https://www.workbuddy.cn/ 看是否正常。');
  console.error('   若本机浏览器正常，请改在**自己打开的 CMD / PowerShell 窗口**里运行本脚本。');
  console.error('   若确实需要代理才能访问，加参数: node wb_login_once.js --proxy=127.0.0.1:端口');
}

// 权威验证：headless 打开成长中心，看是否仍被 302 到登录页
// 失败会自动重试一次（上一个浏览器刚退出时 profile 可能还没释放干净）
async function verifyLogin() {
  for (let attempt = 1; attempt <= 2; attempt++) {
    killStaleEdge();
    await sleep(2000);
    let context;
    try {
      context = await chromium.launchPersistentContext(PROFILE, {
        executablePath: EDGE, headless: true, timeout: 45000,
        args: ['--no-first-run', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (e) {
      if (attempt === 2) return 'verify-failed:' + String(e.message || e).split('\n')[0];
      continue;
    }
    let verdict;
    try {
      const page = context.pages()[0] || await context.newPage();
      await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
      verdict = /\/login/.test(page.url()) ? 'not-logged-in' : 'logged-in';
    } catch (e) {
      verdict = 'network-error:' + String(e.message || e).split('\n')[0];
    }
    try { await context.close(); } catch (e) {}
    killStaleEdge();
    if (verdict === 'logged-in' || verdict === 'not-logged-in') return verdict;
    if (attempt === 1) { await sleep(3000); continue; }
    return verdict;
  }
  return 'verify-failed:未知';
}

(async () => {
  console.log('[0/5] 网络预检…');
  const probe = await netProbe();
  if (probe.ok) {
    console.log('    ✓ workbuddy.cn 可达（第 ' + probe.tryCount + ' 次探测通过）');
  } else {
    console.error('    ✗ 连续 3 次探测失败');
    printNetHelp();
    console.error('\n⚠️ 仅警告，继续打开浏览器（预检失败可能是终端环境受限，不代表你上不了网）');
    if (has('--strict')) { console.error('   --strict 已指定，中止。'); process.exit(2); }
  }
  if (has('--probe')) { console.log('probe 模式结束。'); process.exit(probe.ok ? 0 : 2); }

  console.log('[1/5] 清理占用自动化 profile 的遗留 Edge 进程…');
  killStaleEdge();
  await sleep(1500);

  // --fresh：旧 profile 改名备份，用全新目录重来，排除 profile 层面的疑难杂症
  if (has('--fresh')) {
    if (fs.existsSync(PROFILE)) {
      const bak = PROFILE + '.bak.' + Date.now();
      try {
        fs.renameSync(PROFILE, bak);
        console.log('    ✓ 已备份旧 profile → ' + path.basename(bak));
      } catch (e) {
        console.error('    ✗ 备份失败（可能有 Edge 仍占用该目录）: ' + e.message);
        process.exit(1);
      }
    }
    console.log('    ✓ 将使用全新的空 profile');
  }

  console.log('[2/5] 启动 Edge（专用 profile，可见窗口）…');
  const proxyArg = argv.find(x => x.startsWith('--proxy='));
  const extraArgs = proxyArg ? ['--proxy-server=' + proxyArg.split('=')[1]] : [];
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE, {
      executablePath: EDGE, headless: false, timeout: 60000,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',                      // headful 卡死首因
        '--disable-dev-shm-usage',
        '--disable-session-crashed-bubble',   // 别弹「上次崩溃要恢复吗」
        '--start-maximized',
        ...extraArgs,
      ],
    });
  } catch (e) {
    console.error('❌ Edge 启动失败: ' + String(e.message || e).split('\n')[0]);
    console.error('   常见原因: 已有 Edge 占用该 profile / Edge 路径不对 / ABE 注册表未重启生效');
    process.exit(1);
  }
  console.log('    ✓ Edge 已就绪' + (proxyArg ? '（代理: ' + proxyArg.split('=')[1] + '）' : ''));

  const page = context.pages()[0] || await context.newPage();
  try { await page.bringToFront(); } catch (e) {}

  console.log('[3/5] 打开登录页…');
  let loaded = false;
  try {
    const resp = await page.goto(LOGIN, { waitUntil: 'domcontentloaded', timeout: 45000 });
    loaded = true;
    console.log('    ✓ 已加载  HTTP ' + (resp && resp.status()) + '  URL: ' + page.url());
    console.log('      标题: ' + (await page.title().catch(() => '(读取失败)')));
  } catch (e) {
    console.error('    ⚠️ 登录页加载失败: ' + String(e.message || e).split('\n')[0]);
    console.error('      当前 URL: ' + page.url());
    printNetHelp();
    console.error('    （浏览器仍然可用，可手动在地址栏访问 https://www.workbuddy.cn/login）');
  }

  console.log('[4/5] 请在弹出的 Edge 窗口里扫码 / 输账号登录 www.workbuddy.cn');
  console.log('      登录成功后本脚本会自动结束；直接关掉窗口也会正常退出（上限 ' + WAIT_MIN + ' 分钟）。');

  let closed = false;
  context.on('close', () => { closed = true; });
  const deadline = Date.now() + WAIT_MIN * 60 * 1000;
  let outcome = 'timeout';
  const baseline = (await context.cookies(['https://www.workbuddy.cn']).catch(() => [])).length;

  while (Date.now() < deadline) {
    if (closed) { outcome = 'closed'; break; }
    try {
      // 唯一可靠判据：任一页面 URL 真正离开了 /login
      const urls = context.pages().map(p => p.url()).filter(Boolean);
      if (loaded && urls.some(u => /workbuddy\.cn/.test(u) && !/\/login/.test(u))) {
        outcome = 'redirected';
        break;
      }
      // cookie 变化只做提示，不作为成功判据（v2 误报的根源）
      const n = (await context.cookies(['https://www.workbuddy.cn']).catch(() => [])).length;
      if (n > baseline + 2) { /* 有动静，但不下结论 */ }
    } catch (e) { /* 浏览器正在关闭 */ }
    await sleep(2000);
  }

  if (outcome === 'timeout') console.log('\n⏱ 等待超时（' + WAIT_MIN + ' 分钟）。');
  else if (outcome === 'closed') console.log('\n👋 检测到浏览器已关闭。');
  else console.log('\n✅ 检测到页面已离开登录页。');

  try { await context.close(); } catch (e) {}
  await sleep(1000);

  console.log('[5/5] 用 headless 复验登录态…');
  const verdict = await verifyLogin();
  if (verdict === 'logged-in') {
    console.log('✅ 登录态有效 —— 成长中心可直接进入，每日派猫自动化可正常运行。');
  } else if (verdict === 'not-logged-in') {
    console.log('❌ 仍未登录 —— 成长中心被重定向到登录页，请重跑本脚本完成登录。');
  } else if (verdict.startsWith('network-error')) {
    console.log('⚠️ 复验这一步没能完成: ' + verdict.slice('network-error:'.length));
    console.log('   这多半与登录无关 —— 常见原因是上一步的浏览器刚退出、profile 还没释放干净。');
    console.log('   直接双击 run_cat.bat 跑一次派猫，看输出里 login 是否为 true 即可确认登录态。');
  } else {
    console.log('⚠️ 验证未完成: ' + verdict);
  }
  console.log('   登录态目录: ' + PROFILE);
  process.exit(0);
})().catch(e => {
  console.error('ERR', (e && e.stack) || e);
  try { killStaleEdge(); } catch (_) {}
  process.exit(1);
});
