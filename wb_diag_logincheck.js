// 诊断：附着常驻 Edge（没有就拉起），列出 workbuddy.cn 的 cookie 名单 + 成长中心实际跳转情况
const { chromium } = require('C:/Users/23159/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { spawn } = require('child_process');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = 'C:/Users/23159/WorkBuddy/2026-08-15-22-57-14/wb_auto_profile_edge';
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
