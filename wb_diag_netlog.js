// 诊断3：加载成长中心时监听全部网络响应，找出判定登录态的接口（401/403/重定向）
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

const { chromium } = require('./wb_paths').playwright();
const { spawn } = require('child_process');

const EDGE = require('./wb_paths').edge();
const PROFILE = require('./wb_paths').profile();
const CDP_URL = 'http://127.0.0.1:9223';
const GROWTH = 'https://www.workbuddy.cn/profile/growth-center';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function portAlive() {
  try { const r = await fetch(CDP_URL + '/json/version', { signal: AbortSignal.timeout(2000) }); return r.ok; }
  catch (e) { return false; }
}

(async () => {
  if (!(await portAlive())) {
    const child = spawn(EDGE, [
      '--remote-debugging-port=9223', '--user-data-dir=' + PROFILE,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 30; i++) { await sleep(1000); if (await portAlive()) break; }
  }
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
  const context = browser.contexts()[0];
  const page = await context.newPage();

  const hits = [];
  page.on('response', r => {
    const u = r.url();
    const s = r.status();
    if (s >= 300 || /user|login|auth|session|profile|growth|info/i.test(u)) {
      hits.push(`${s}  ${r.request().method()}  ${u.slice(0, 120)}`);
    }
  });

  await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(8000);
  console.log('最终 URL:', page.url());
  console.log('--- 关键响应 ---');
  for (const h of hits.slice(0, 40)) console.log(h);

  // 顺带在页面内发一次同源请求试试 user info 类接口
  const apiTest = await page.evaluate(async () => {
    const out = [];
    for (const p of ['/api/user/info', '/api/user', '/api/account/info', '/pas/api/user/info', '/api/passport/user/info']) {
      try {
        const r = await fetch(p, { redirect: 'manual', credentials: 'include' });
        out.push(p + ' → ' + r.status);
      } catch (e) { out.push(p + ' → ERR ' + e.message); }
    }
    return out;
  }).catch(e => ['evaluate失败: ' + e.message]);
  console.log('--- 同源接口探测 ---');
  for (const t of apiTest) console.log(t);

  await page.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.message || e); process.exit(1); });
