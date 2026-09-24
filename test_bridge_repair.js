// 一次性验证脚本：模拟「重启后会话失效」→ 验证 wb_auto_task.js 的静默续期
// 流程：拉起常驻 Edge → clearCookies 清掉所有会话 cookie → 运行 wb_auto_task.js
// 预期日志：`[i] SSO 会话失效，静默续期会话（零扫码）…` 后 login:true
"use strict";
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

const { spawn } = require('child_process');
const { chromium } = require('./wb_paths').playwright();
const EDGE = require('./wb_paths').edge();
const PROFILE = require('./wb_paths').profile();
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // 1) 拉起常驻 Edge（与 wb_auto_task 同参）
  const child = spawn(EDGE, [
    '--remote-debugging-port=9223',
    '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-session-crashed-bubble', '--window-size=1200,800',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  let up = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const r = await fetch('http://127.0.0.1:9223/json/version', { signal: AbortSignal.timeout(2000) });
      if (r.ok) { up = true; break; }
    } catch (e) {}
  }
  if (!up) { console.error('Edge 30s 未就绪'); process.exit(1); }
  console.log('[test] Edge 已拉起');

  // 2) 清空全部 cookie（强制 login:false）
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 15000 });
  const ctx = browser.contexts()[0];
  await ctx.clearCookies();
  console.log('[test] cookies cleared, remaining =', (await ctx.cookies()).length);
  await browser.close();   // 只断开 CDP 连接，不关 Edge

  // 3) 跑正式任务，看桥是否触发并恢复
  const r = spawn(process.execPath, ['wb_auto_task.js'], { cwd: __dirname, stdio: 'inherit' });
  r.on('exit', code => { console.log('[test] wb_auto_task exit code =', code); process.exit(code); });
})();
