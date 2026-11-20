"use strict";
// 单进程恢复编排器 v4（2026-10-07 重写；2026-11-12 接口复核 + 会话 cookie 持久化实验，默认关闭）
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
// 2026-11-12 根治「假已登录」：冷启动后 SPA 首屏 4.5s 内仍停留 growth-center，
// 仅凭 URL 判定会误判为已登录 → 不弹登录窗、直接跑任务 → 签到 401 / 派猫 login:false。
// 现在默认路径也用同源接口复核（sessionOk），复核不通过就老实开登录窗等扫码。
// --force-login：用户明确要扫码时，无条件打开登录页等待扫码。
// --check-login：只做登录态判定并打印结果（exit 0=已登录 / 1=未登录），不跑任务、不等待。
const FORCE_LOGIN = process.argv.includes('--force-login');
const CHECK_LOGIN = process.argv.includes('--check-login');
// [实验性 · 2026-11-12 实测未达预期 · 默认关闭] 会话 cookie 持久化。
// 实测：扫码后确实把 7 个会话级 cookie 转成持久并写入了 profile 的 Cookies 库
// （磁盘上 workbuddy.cn 有 6 个 is_persistent=1），但 Edge 被回收后拉起的全新窗口
// 仍跳 /login（--check-login 判 loggedIn=false）→ 服务端/SSO 侧不认可从磁盘恢复的
// 会话，或关键会话 cookie 在后续请求里被重新下发为会话级。故默认不启用，避免每天
// 做无效功、也避免无谓扩大登录态落盘面。需要再研究时显式加 --persist-cookies。
// 不打印、不写明文文件、不碰桌面端加密 token。
const PERSIST_COOKIES = process.argv.includes('--persist-cookies');
const COOKIE_DAYS = 7;

async function alive() {
  try { const r = await fetch(CDP_URL + '/json/version', { signal: AbortSignal.timeout(2000) }); return r.ok; }
  catch (e) { return false; }
}

// 权威会话探测：同源只读状态接口非 401/403 才算真登录（不会领取签到）。
// 实测：无会话时网关直接 401；2026-11-12 扫码后该请求可通过，据此可排除
// 「SPA 闪现 growth-center / 7 天应用 cookie 仍在」造成的 URL 误判。
// 连续两次 401 才判未登录，避免网关瞬时抖动把已登录误判成未登录。
async function sessionOk(page) {
  for (let i = 0; i < 2; i++) {
    let ok = false;
    try {
      ok = await page.evaluate(async () => {
        try {
          const r = await fetch('https://www.workbuddy.cn/billing/meter/checkin-status', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: '{}',
          });
          return r.status !== 401 && r.status !== 403;
        } catch (e) { return false; }
      });
    } catch (e) { ok = false; }
    if (ok) return true;
    if (i === 0) await sleep(1500);
  }
  return false;
}

// ── 会话 cookie 持久化（2026-11-12）─────────────────────────────────────
// 背景：常驻 Edge 由工具进程拉起，进程结束即被作业对象回收，内存里的会话级
//   cookie（SSO 身份）随之丢失 → 次日又要扫码。尝试让 Edge 脱离进程树被安全策略拦下。
// 做法：会话确认可用后，把 workbuddy.cn 下的 session cookie 补上 expires 重新注入，
//   Chromium 会将其写入 profile 的 Cookies 库（浏览器自身加密存储）。
// 安全：只在内存里搬运 cookie 对象；不打印、不写文件、不碰桌面端加密 token。
async function persistSessionCookies(ctx) {
  const res = { converted: 0, failed: 0, persistent: 0, err: '' };
  let cookies = [];
  try { cookies = await ctx.cookies(); }
  catch (e) { res.err = String(e && e.message || e).split('\n')[0]; return res; }

  const now = Math.floor(Date.now() / 1000);
  const expires = now + COOKIE_DAYS * 24 * 3600;
  const isWb = (d) => /(^|\.)workbuddy\.cn$/.test(String(d || '').replace(/^\./, ''));

  for (const c of cookies) {
    if (!isWb(c.domain)) continue;
    // -1 / 0 / 即将过期 都按会话级处理
    if (c.expires && c.expires > now + 300) { res.persistent++; continue; }
    const next = {
      name: c.name, value: c.value, expires: expires,
      httpOnly: !!c.httpOnly, secure: !!c.secure,
    };
    if (/^__Host-/.test(c.name)) {
      // __Host- 前缀：必须 host-only + path=/，用 url 让 Playwright 自行推导
      next.url = 'https://www.workbuddy.cn/';
    } else {
      next.domain = c.domain;
      next.path = c.path || '/';
    }
    if (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None') next.sameSite = c.sameSite;
    try { await ctx.addCookies([next]); res.converted++; }
    catch (e) { res.failed++; }
  }

  // 复读确认真的写成持久 cookie（只计数，绝不输出任何值）
  try {
    const after = await ctx.cookies();
    res.persistent = after.filter(c => isWb(c.domain) && c.expires > now).length;
  } catch (e) { /* 复读失败不影响转换结果 */ }
  return res;
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
  let probe = 'URL 已跳登录页';
  // 默认路径也做接口复核：URL 看着像已登录，但会话可能早已失效
  if (loggedIn) {
    const ok = await sessionOk(page);
    probe = '同源接口复核' + (ok ? '通过' : '未通过（会话已失效）');
    loggedIn = ok;
  }
  if (FORCE_LOGIN) loggedIn = false;
  console.log('[2] 成长中心 URL: ' + cur + ' → ' + (loggedIn ? '已登录' : '未登录')
    + '（' + (FORCE_LOGIN ? '--force-login：强制打开登录页等扫码' : probe) + '）');

  if (CHECK_LOGIN) {
    console.log('[check-login] loggedIn=' + loggedIn + ' → ' + (loggedIn ? '会话有效' : '会话失效，需重新扫码'));
    try { await browser.disconnect(); } catch (e) {}
    process.exit(loggedIn ? 0 : 1);
  }

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
      if (urls.some(u => /workbuddy\.cn/.test(u) && !/\/login/.test(u))) {
        // 所有路径统一用同源接口复核，确认 SSO 会话真的生效才算登录成功，
        // 避免 SPA 闪现 growth-center 就提前结束等待、拿失效会话去跑任务
        let ok = false;
        for (const p of (ctx.pages() || [])) {
          let u = ''; try { u = p.url(); } catch (e) {}
          if (!u || !/workbuddy\.cn/.test(u) || /\/login/.test(u)) continue;
          if (await sessionOk(p)) { ok = true; break; }
        }
        if (ok) { loggedIn = true; break; }
      }
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
    let ssoOk = !/\/login/.test(u2) && await sessionOk(page);
    if (!ssoOk) {
      // 登录态刚写入时可能还没覆盖到该域，给一次重试机会，别直接判死
      await sleep(4000);
      await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(4000);
      let u3 = ''; try { u3 = page.url(); } catch (e) {}
      ssoOk = !/\/login/.test(u3) && await sessionOk(page);
    }
    if (!ssoOk) {
      console.log('[x] 主站已登录，但成长中心 SSO 未生效（URL/接口复核未通过）：' + u2);
      try { await browser.disconnect(); } catch (e) {}
      process.exit(3);
    }
    console.log('[2b] ✓ 成长中心会话可用（URL + 同源接口复核通过）');
  }

  // ── 2.5) 会话 cookie 持久化（不论走「本来已登录」还是「刚扫码」，只要会话可用就做）──
  if (PERSIST_COOKIES) {
    const pr = await persistSessionCookies(ctx);
    console.log('[2.5] 会话 cookie 持久化：' + pr.converted + ' 个会话级 → 持久（' + COOKIE_DAYS + ' 天）'
      + '，当前持久 cookie ' + pr.persistent + ' 个'
      + (pr.failed ? '，' + pr.failed + ' 个转换失败（已忽略）' : '')
      + (pr.err ? '，读取失败: ' + pr.err : ''));
    // 给 Chromium 一点时间把 cookie 刷到 profile 的 Cookies 库
    await sleep(2500);
  } else {
    console.log('[2.5] 会话 cookie 持久化未启用（实验性，实测跨 Edge 重启无效；如需重试加 --persist-cookies）');
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
