// 诊断2：取出 session cookie 值，用 curl 等价请求验证服务端是否认这个登录态
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
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  // 服务端直连测试：带全部 cookie 请求成长中心，看重定向
  const r1 = await fetch(GROWTH, { redirect: 'manual', headers: { cookie: cookieHeader, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0' }, signal: AbortSignal.timeout(15000) });
  console.log('服务端 GET /profile/growth-center →', r1.status, r1.headers.get('location') || '(无跳转)');

  // localStorage 里 loggedIn 的值
  const page = await context.newPage();
  await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(4000);
  const loggedIn = await page.evaluate(() => localStorage.getItem('loggedIn')).catch(() => '(读取失败)');
  console.log('localStorage.loggedIn =', JSON.stringify(loggedIn));
  console.log('页面最终 URL:', page.url());
  await page.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.message || e); process.exit(1); });
