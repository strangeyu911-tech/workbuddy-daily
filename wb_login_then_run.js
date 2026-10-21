"use strict";
// 单进程恢复编排器 v2（2026-10-07 重写）
// 目标：用一个常驻 Node 进程把「拉起 Edge → 检查/建立登录态 → 同会话内跑 派猫 + 签到」串完。
//
// 为什么这么写（本机实测教训）：
//  1) detached 起的 msedge.exe 会在父进程退出时被本环境的 job object 一并回收 →
//     自动化必须与 Edge 同生共死，故登录等待与跑任务必须在同一个进程里。
//  2) execSync 会经 cmd.exe，本机实测抛 spawnSync cmd.exe EBUSY →
//     子任务改用 spawn(process.execPath) 直连 node，不经 shell。
//  3) 顺序不能颠倒：wb_auto_task.js 只关 tab、保留浏览器；wb_checkin.js 末尾会
//     browser.close() 把整个 Edge 关掉，必须放最后。
//  4) 若成长中心的 SSO 会话已在（profile 持久 cookie 仍有效），则无需用户扫码，直接跑。

const { spawn } = require('child_process');
const P = require('./wb_paths');
const { chromium } = P.playwright();

const EDGE = P.edge();
const PROFILE = P.profile();
const CDP_PORT = 9223;
const CDP_URL = 'http://127.0.0.1:' + CDP_PORT;
const GROWTH = 'https://www.workbuddy.cn/profile/growth-center';
const LOGIN = 'https://www.workbuddy.cn/login/?platform=usercenter&redirect_uri=https%3A%2F%2Fwww.workbuddy.cn%2Fprofile%2Fgrowth-center';
const NODE = process.execPath;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WAIT_MIN = 20;

async function alive() {
  try { const r = await fetch(CDP_URL + '/json/version', { signal: AbortSignal.timeout(2000) }); return r.ok; }
  catch (e) { return false; }
}

// 直连 node 跑子脚本（不经 cmd.exe），收集 stdout/stderr
function runNode(script, args) {
  return new Promise((resolve) => {
    const p = spawn(NODE, [script].concat(args || []), {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', e => resolve({ code: -1, out, err: err + '\n' + String(e && e.message || e) }));
    p.on('close', code => resolve({ code, out, err }));
  });
}

(async () => {
  // ── 1) 确保常驻 Edge ──────────────────────────────────────────────
  if (!(await alive())) {
    console.log('[1] 拉起常驻 Edge（9223, profile=wb_auto_profile_edge）…');
    const child = spawn(EDGE, [
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--disable-session-crashed-bubble', '--window-size=1200,800',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    let up = false;
    for (let i = 0; i < 60; i++) { await sleep(1000); if (await alive()) { up = true; break; } }
    if (!up) { console.error('[x] Edge 60s 内未就绪'); process.exit(2); }
  } else {
    console.log('[1] 复用已存在的常驻 Edge');
  }

  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
  const ctx = browser.contexts()[0] || await browser.newContext();

  // ── 2) 检查登录态（成长中心是否已过 SSO）──────────────────────────
  const page = await ctx.newPage();
  await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 45000 })
    .catch(e => console.log('[w] goto growth:', e.message.split('\n')[0]));
  await sleep(4500);
  let cur = '';
  try { cur = page.url(); } catch (e) { cur = ''; }
  let loggedIn = !!cur && /workbuddy\.cn/.test(cur) && !/\/login/.test(cur);
  console.log('[2] 成长中心 URL: ' + cur + ' → ' + (loggedIn ? '已登录' : '未登录'));

  if (!loggedIn) {
    console.log('[2b] 未登录：打开登录页。请在弹出的 Edge 窗口里扫码 / 输账号登录（最多等 ' + WAIT_MIN + ' 分钟）…');
    await page.goto(LOGIN, { waitUntil: 'domcontentloaded', timeout: 45000 })
      .catch(e => console.log('[w] goto login:', e.message.split('\n')[0]));

    const deadline = Date.now() + WAIT_MIN * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(3000);
      // 轮询所有 tab（登录有可能在弹窗里完成）
      let urls = [];
      try { urls = (ctx.pages() || []).map(p => { try { return p.url(); } catch (e) { return ''; } }).filter(Boolean); } catch (e) {}
      if (urls.some(u => /workbuddy\.cn/.test(u) && !/\/login/.test(u))) { loggedIn = true; break; }
    }
    if (!loggedIn) {
      console.log('[x] 等待登录超时，仍未检测到登录成功。');
      try { await browser.disconnect(); } catch (e) {}
      process.exit(1);
    }
    console.log('[2b] ✓ 检测到登录成功，复验成长中心 SSO …');
    await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(4500);
    let u2 = '';
    try { u2 = page.url(); } catch (e) {}
    if (/\/login/.test(u2)) {
      console.log('[x] 主站已登录，但成长中心仍要求登录（SSO 未覆盖该域）：' + u2);
      try { await browser.disconnect(); } catch (e) {}
      process.exit(3);
    }
    console.log('[2b] ✓ 成长中心会话可用');
  }

  // ── 3) 释放 CDP 句柄（不关浏览器），把同一 Edge 让给子任务复用 ────
  try { await browser.disconnect(); } catch (e) {}

  console.log('[3] 跑 派猫猫旅行（wb_auto_task.js）…');
  const auto = await runNode('wb_auto_task.js', []);
  console.log('----- wb_auto_task.js stdout -----');
  console.log((auto.out || '').trim());
  if ((auto.err || '').trim()) { console.log('----- wb_auto_task.js stderr -----'); console.log(auto.err.trim()); }

  console.log('[4] 跑 签到（wb_checkin.js --checkin）…');
  const chk = await runNode('wb_checkin.js', ['--checkin']);
  console.log('----- wb_checkin.js stdout -----');
  console.log((chk.out || '').trim());
  if ((chk.err || '').trim()) { console.log('----- wb_checkin.js stderr -----'); console.log(chk.err.trim()); }

  console.log('[done]');
  process.exit(0);
})().catch(e => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
