#!/usr/bin/env node
// ── [本机补丁] CDP 探测必须绕过系统代理 ──────────────────────────────
// 本机 HTTP_PROXY/HTTPS_PROXY 指向一个本地代理端口时，undici 的 fetch 会把
// 127.0.0.1:9223 也送去代理，拿到代理的 502 而误判「常驻 Edge 未就绪」。
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
 * WorkBuddy Buddy 加油站 每日签到（v2 · 浏览器会话版）
 *
 * ── 为什么改成浏览器会话版（2026-09-24）──────────────────────────────
 * 桌面端在 09-23→09-24 之间把登录态 workbuddy-desktop.info 里的
 * auth.accessToken / auth.refreshToken 由明文改成了加密信封对象
 * { $wbEncrypted:1, envelope:"..." }（at-rest 加密，密钥由 sidecar 经 IPC 下发，
 * 不在磁盘明文存储）。旧版脚本直接读 auth.accessToken 当明文 → mask() 对对象调
 * .slice 直接 TypeError 崩溃，请求都发不出去。
 *
 * 实测：成长中心页面的计费 API 全部跑在 https://www.workbuddy.cn/billing/meter/* ，
 * 与页面同源；持久 Edge（派猫猫同款常驻窗口）对该域持有有效会话 cookie，同源
 * fetch 带 cookie 即可鉴权（无需碰磁盘上的加密 token）。因此本脚本改为：
 *   复用派猫那套「持久 Edge + CDP」基础设施 → 在已登录页面内直接调签到 API。
 * 这与派猫猫旅行共用同一登录态，只要浏览器会话还活着就稳。
 *
 * 安全约定（务必遵守）：
 *   - 本脚本完全不读取、不打印、不落盘任何 token / accessToken / refreshToken。
 *   - 仅请求 www.workbuddy.cn 官方域名，不请求任何第三方。
 *   - 只读本机登录态的「浏览器会话」——不解析加密的 auth 文件。
 *
 * 用法：
 *   node wb_checkin.js --checkin    # 领取（幂等：已签过返回 code=10001，不会重复领）
 *   node wb_checkin.js --status     # 只读：查今日是否已签
 */

const { chromium } = require('./wb_paths').playwright();
const { spawn } = require('child_process');
const EDGE = require('./wb_paths').edge();
const PROFILE = require('./wb_paths').profile();
const CDP_PORT = 9223;
const CDP_URL = 'http://127.0.0.1:' + CDP_PORT;
const GROWTH = 'https://www.workbuddy.cn/profile/growth-center';
const API_BASE = 'https://www.workbuddy.cn/billing/meter';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function portAlive() {
  try {
    const r = await fetch(CDP_URL + '/json/version', { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (e) { return false; }
}

// 复用常驻 Edge；没有就拉起一个（detached，脚本退出后窗口继续活着，供派猫猫复用）
async function getBrowser() {
  if (!(await portAlive())) {
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
      if (await portAlive()) { up = true; break; }
    }
    if (!up) throw new Error('Edge 已拉起但调试端口 ' + CDP_PORT + ' 30s 内未就绪');
  } else {
    console.error('[i] 复用已打开的常驻 Edge 窗口');
  }
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
  return browser;
}

// 在已登录的 www.workbuddy.cn 页面内调用签到 API（同源，带会话 cookie）
async function callCheckin(page, path) {
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

async function main() {
  const mode = process.argv.includes('--checkin') ? 'checkin' : 'status';
  const browser = await getBrowser();
  console.error('[i] CDP 已连接');

  let page;
  const ctx = browser.contexts()[0];
  if (ctx && ctx.pages().length) page = ctx.pages()[0];
  else page = await browser.newPage();

  // 进入成长中心，确保落在 www.workbuddy.cn 同源且会话有效
  console.error('[i] 打开成长中心…');
  await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.error('[w] goto:', e.message.split('\n')[0]));
  await sleep(5000);
  const url = page.url();
  console.error('[i] 当前 URL:', url);
  if (url.includes('/login')) {
    console.log('❌ 登录态失效（页面跳转到登录页）。请打开 WorkBuddy 桌面端刷新登录态后重试');
    await browser.close().catch(() => {});
    process.exit(1);
  }

  if (mode === 'status') {
    const r = await callCheckin(page, '/checkin-status');
    console.log('[只读] HTTP ' + r.status + (r.json ? ' body: ' + JSON.stringify(r.json).slice(0, 300) : ' body(raw): ' + r.text.slice(0, 300)));
    await browser.close().catch(() => {});
    process.exit(0);
  }

  // 执行签到（幂等）
  const r = await callCheckin(page, '/daily-checkin');
  if (r.error) {
    console.log('❌ 请求异常: ' + r.error);
    await browser.close().catch(() => {});
    process.exit(1);
  }
  console.log('  HTTP ' + r.status);
  const d = r.json;
  if (r.status === 401 || r.status === 403) {
    console.log('❌ 令牌过期/无权限（HTTP ' + r.status + '），请打开 WorkBuddy 桌面端刷新登录态后重试');
    await browser.close().catch(() => {});
    process.exit(1);
  }
  if (d && d.code === 0) {
    const data = d.data || {};
    const credit = data.credit ?? data.today_credit ?? data.daily_credit ?? '?';
    const streak = data.streak_days ?? '?';
    console.log('🎉 签到成功！credit=' + credit + ' streak_days=' + streak);
  } else if (d && d.code === 10001) {
    console.log('✅ 今日已签到（code=10001：' + (d.msg || '已签过') + '），无需重复领取');
  } else {
    console.log('⚠️ 领取未成功: HTTP ' + r.status + ' code=' + (d && d.code) + ' msg=' + (d && d.msg));
  }

  await browser.close().catch(() => {});
}

main().catch(e => { console.error('[ERR]', e.message); process.exit(1); });
