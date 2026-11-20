#!/usr/bin/env node
// ── [本机补丁] CDP 探测必须绕过系统代理 ──────────────────────────────
// 本机 HTTP_PROXY/HTTPS_PROXY 指向一个本地代理端口时，undici 的 fetch 会把
// 127.0.0.1:922x 这类环回请求也送去代理，拿到代理的 502 而误判「端口未就绪」。
// 注意：传 `proxy: undefined` 到 fetch init **无效** —— undici 读的是环境变量。
// 本仓库出网只有两类（本机 CDP + 腾讯官方域名），都该直连，故直接清空代理变量。
if (!globalThis.__loopbackNoProxy) {
  globalThis.__loopbackNoProxy = true;
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    if (process.env[k]) delete process.env[k];
  }
  process.env.NO_PROXY = "127.0.0.1,localhost,::1";
  process.env.no_proxy = process.env.NO_PROXY;
}

"use strict";
/**
 * WorkBuddy Buddy 加油站 每日签到（v3 · 桌面端会话优先版）
 *
 * ── 为什么改成桌面端优先（2026-11-20）──────────────────────────────
 * v2 靠自己拉起的常驻 Edge（9223）+ 会话级 cookie。实测该 cookie 一关窗/一重启
 * 就焚，且 09-24 起桌面端 accessToken 变加密信封、独立脚本无法续期 → 每天
 * 19:30 反复报「登录态失效」，但账号积分其实照常到账（服务端 checkin_dates
 * 连续 11 天，含脚本报失败的所有日子）。
 *
 * 真凶是 WorkBuddy 桌面端自己：它常驻运行、持有完整 OAuth 会话（refreshToken
 * 静默续期），页面内同源调官方签到接口即可，无需扫码、无需脚本。CDP 直连验证：
 * 在桌面端渲染进程里 POST /billing/meter/checkin-activity-status（仅带 cookie）
 * 返回 200 active:true / today_checked_in:true / streak_days:11。
 *
 * 因此 v3 改为「学桌面端的方法」：
 *   1) 优先附着桌面端自带的 CDP 9222（主进程常开），在它的页面内调新接口
 *      `/billing/meter/checkin-activity-status` 查当天是否已签；
 *   2) 已签 → 直接判成功（幂等，不重复领取）；未签 → 调 `/daily-checkin` 领取；
 *   3) 桌面端不在/连不上 → 回退 v2 的独立 Edge（9223）路径，保持向后兼容。
 *
 * 与旧接口的区别：
 *   - `/checkin-status`       旧接口，现在恒返回 active:false/全零，已废弃；
 *   - `/checkin-activity-status` 桌面端真正在用的接口，字段权威（today_checked_in、
 *     streak_days、checkin_dates、daily_credit）。
 *
 * 安全约定（务必遵守）：
 *   - 本脚本完全不读取、不打印、不落盘任何 token / accessToken / refreshToken。
 *   - 仅请求 www.workbuddy.cn 官方域名，不请求任何第三方。
 *   - 附着桌面端时只 disconnect() CDP 句柄，**绝不 close()**（会把用户的
 *     WorkBuddy 桌面端整个关掉）；即使 --close 也只对独立 Edge 生效。
 *
 * 用法：
 *   node wb_checkin.js --checkin    # 领取（幂等；已签则跳过）
 *   node wb_checkin.js --status     # 只读：查今日是否已签
 *   node wb_checkin.js --checkin --close   # 仅对回退的独立 Edge 生效，跑完关窗
 *   node wb_checkin.js --checkin --no-desktop   # 强制走旧路径（排障用）
 */

const { chromium } = require('./wb_paths').playwright();
const { spawn } = require('child_process');
const EDGE = require('./wb_paths').edge();
const PROFILE = require('./wb_paths').profile();

// 桌面端 WorkBuddy 自带的 CDP 端口（主进程常开，登录后含 workbuddy.cn 会话）
const DESKTOP_CDP_PORT = Number(process.env.WB_DESKTOP_CDP || 9222);
const DESKTOP_CDP_URL = 'http://127.0.0.1:' + DESKTOP_CDP_PORT;
// 旧路径：独立常驻 Edge（派猫猫同款），仅在桌面端不可用时使用
const CDP_PORT = 9223;
const CDP_URL = 'http://127.0.0.1:' + CDP_PORT;

const GROWTH = 'https://www.workbuddy.cn/profile/growth-center';
const API_BASE = 'https://www.workbuddy.cn/billing/meter';
const STATUS_PATH = '/checkin-activity-status';
const CHECKIN_PATH = '/daily-checkin';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CLOSE_AFTER = process.argv.includes('--close');        // 只对回退 Edge 生效
const NO_DESKTOP = process.argv.includes('--no-desktop');    // 强制旧路径

// 记录最近一次连接上的 browser，供异常路径释放 CDP 句柄
let lastBrowser = null;
// 'desktop' | 'edge' | null：release() 据此决定能否 close()
let lastSource = null;

// ── 释放 CDP 连接 ────────────────────────────────────────────────────
// desktop：只能 disconnect()，close() 会关掉用户的 WorkBuddy 桌面端（灾难性）。
// edge：默认也只 disconnect()（会话级 cookie 要留着给派猫猫复用）；--close 时
//       才真正关闭独立 Edge。
async function release(browser) {
  try {
    if (!browser) return;
    if (lastSource === 'desktop') await browser.disconnect();
    else if (CLOSE_AFTER) await browser.close();
    else await browser.disconnect();
  } catch (e) { /* 忽略：释放失败不应影响已完成的签到结论 */ }
}

async function portAlive(url) {
  try {
    const r = await fetch(url + '/json/version', { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (e) { return false; }
}

// ── 路径 A：桌面端会话优先 ────────────────────────────────────────────
// 桌面端是 file:// 渲染页，已登录 www.workbuddy.cn（同源 fetch 带 cookie 即可）。
// 找不到合适页面/连不上时返回 null，由调用方回退到独立 Edge。
async function tryDesktop() {
  if (NO_DESKTOP) return null;
  if (!(await portAlive(DESKTOP_CDP_URL))) {
    console.error('[i] 桌面端 CDP ' + DESKTOP_CDP_PORT + ' 未就绪，改用独立 Edge 路径');
    return null;
  }
  try {
    const browser = await chromium.connectOverCDP(DESKTOP_CDP_URL, { timeout: 12000 });
    lastBrowser = browser;
    lastSource = 'desktop';
    const ctx = browser.contexts()[0];
    const pages = ctx ? ctx.pages() : [];
    // 找桌面端主渲染页（file:// ... renderer/index.html），不要 about:srcdoc 之类
    let page = pages.find(p => p.url().startsWith('file:'));
    if (!page) page = pages.find(p => !/^about:/.test(p.url())) || null;
    if (!page) { await release(browser); lastBrowser = null; lastSource = null; return null; }

    // 只读探测：确认这个会话确实能调官方接口（不领取、不读 token）
    const probe = await callApi(page, STATUS_PATH);
    if (probe.status !== 200 || !probe.json || probe.json.code !== 0 || !probe.json.data) {
      console.error('[i] 桌面端会话未通过同源接口复核，改用独立 Edge 路径'
        + '（HTTP ' + probe.status + '）');
      await release(browser); lastBrowser = null; lastSource = null;
      return null;
    }
    console.error('[i] 已附着 WorkBuddy 桌面端会话（CDP ' + DESKTOP_CDP_PORT + '）');
    return { browser, page, source: 'desktop' };
  } catch (e) {
    console.error('[w] 桌面端附着失败：' + String(e && e.message || e).slice(0, 160));
    lastBrowser = null; lastSource = null;
    return null;
  }
}

// ── 路径 B：旧版独立 Edge ────────────────────────────────────────────
async function getEdgeBrowser() {
  if (!(await portAlive(CDP_URL))) {
    console.error('[i] 常驻 Edge 不在运行，首次拉起（之后会保持常驻）…');
    const child = spawn(EDGE, [
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + PROFILE,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-session-crashed-bubble',
      '--window-size=1200,800',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    let up = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (await portAlive(CDP_URL)) { up = true; break; }
    }
    if (!up) throw new Error('Edge 已拉起但调试端口 ' + CDP_PORT + ' 30s 内未就绪');
  } else {
    console.error('[i] 复用已打开的常驻 Edge 窗口');
  }
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
  lastBrowser = browser;
  lastSource = 'edge';

  const ctx = browser.contexts()[0];
  let page = ctx && ctx.pages().length ? ctx.pages()[0] : await browser.newPage();
  console.error('[i] 打开成长中心…');
  await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 })
    .catch(e => console.error('[w] goto:', e.message.split('\n')[0]));
  await sleep(5000);
  const url = page.url();
  console.error('[i] 当前 URL:', url);
  if (url.includes('/login')) {
    throw new Error('登录态失效（页面跳转到登录页）。请打开 WorkBuddy 桌面端刷新登录态后重试');
  }
  return { browser, page, source: 'edge' };
}

// 在已登录页面内调用签到 API（同源，带会话 cookie）。不读、不打印任何 token。
async function callApi(page, path) {
  return page.evaluate(async (arg) => {
    const { apiBase, p } = arg;
    try {
      const resp = await fetch(apiBase + p, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
      });
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* keep text */ }
      return { status: resp.status, json, text };
    } catch (e) {
      return { status: 0, json: null, text: '', error: String(e && e.message || e) };
    }
  }, { apiBase: API_BASE, p: path });
}

const tag = (source) => source === 'desktop' ? '桌面端会话' : '独立 Edge 会话';

async function main() {
  const mode = process.argv.includes('--checkin') ? 'checkin' : 'status';

  // 优先桌面端，失败回退独立 Edge
  let sess = await tryDesktop();
  if (!sess) sess = await getEdgeBrowser();
  console.error('[i] CDP 已连接，来源：' + sess.source);

  // ── 1) 先查权威状态（新接口）───────────────────────────────────────
  const st = await callApi(sess.page, STATUS_PATH);
  if (st.error) throw new Error('状态接口请求异常: ' + st.error);
  if (st.status === 401 || st.status === 403) {
    throw new Error('令牌过期/无权限（HTTP ' + st.status + '），请打开 WorkBuddy 桌面端刷新登录态后重试');
  }
  const sd = st.json && st.json.data;
  const already = st.status === 200 && st.json && st.json.code === 0 && sd
    ? !!sd.today_checked_in
    : false;

  if (mode === 'status') {
    if (sd) {
      const dates = Array.isArray(sd.checkin_dates) ? sd.checkin_dates.slice(0, 3).join(',') : '';
      console.log('[只读] ' + tag(sess.source)
        + ' HTTP ' + st.status
        + ' today_checked_in=' + already
        + ' streak_days=' + (sd.streak_days ?? '?')
        + ' today_credit=' + (sd.today_credit ?? '?')
        + (dates ? ' 最近签到=' + dates : ''));
    } else {
      console.log('[只读] ' + tag(sess.source) + ' HTTP ' + st.status
        + ' body: ' + JSON.stringify(st.json || st.text).slice(0, 300));
    }
    await release(sess.browser);
    return;
  }

  // ── 2) 已签 → 幂等跳过，不再重复领取 ───────────────────────────────
  if (already) {
    console.log('✅ 今日已签到（code=10001 等价：' + tag(sess.source) + ' checkin-activity-status 确认'
      + '；streak_days=' + (sd.streak_days ?? '?')
      + ' today_credit=' + (sd.today_credit ?? '?') + '），无需重复领取');
    await release(sess.browser);
    return;
  }

  // ── 3) 未签 → 领取 ─────────────────────────────────────────────────
  const r = await callApi(sess.page, CHECKIN_PATH);
  if (r.error) throw new Error('签到请求异常: ' + r.error);
  console.log('  HTTP ' + r.status);
  if (r.status === 401 || r.status === 403) {
    throw new Error('令牌过期/无权限（HTTP ' + r.status + '），请打开 WorkBuddy 桌面端刷新登录态后重试');
  }
  const d = r.json;
  if (d && d.code === 0) {
    const data = d.data || {};
    const credit = data.credit ?? data.today_credit ?? data.daily_credit ?? '?';
    const streak = data.streak_days ?? '?';
    console.log('🎉 签到成功！credit=' + credit + ' streak_days=' + streak
      + '（' + tag(sess.source) + '）');
  } else if (d && d.code === 10001) {
    console.log('✅ 今日已签到（code=10001：' + (d.msg || '已签过') + '），无需重复领取');
  } else {
    console.log('⚠️ 领取未成功: HTTP ' + r.status + ' code=' + (d && d.code) + ' msg=' + (d && d.msg));
  }
  await release(sess.browser);
}

main()
  .then(() => {
    // 显式收尾：disconnect() 后 playwright 的 CDP 句柄仍占事件循环，需主动退出。
    process.exit(0);
  })
  .catch(e => {
    if (e && e.message) console.error('[ERR]', e.message);
    Promise.resolve(lastBrowser)
      .then(b => release(b))
      .catch(() => {})
      .finally(() => process.exit(1));
  });
