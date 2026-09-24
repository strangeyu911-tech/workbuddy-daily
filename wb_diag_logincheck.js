// 诊断：附着常驻 Edge（没有就拉起），列出 workbuddy.cn 的 cookie 名单 + 成长中心实际跳转情况
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

  const cookies = await context.cookies(['https://www.workbuddy.cn']);
  console.log('cookie 数量:', cookies.length);
  for (const c of cookies) {
    const exp = c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 16) : 'session';
    console.log(`  ${c.name}  domain=${c.domain}  expires=${exp}${c.httpOnly ? ' httpOnly' : ''}`);
  }

  const page = await context.newPage();
  await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(5000);
  console.log('最终 URL:', page.url());
  console.log('标题:', await page.title().catch(() => '(?)'));
  // localStorage 里有没有 token 类的键
  const ls = await page.evaluate(() => Object.keys(localStorage).map(k => k)).catch(() => []);
  console.log('localStorage keys:', JSON.stringify(ls));
  await page.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.message || e); process.exit(1); });
