// 网络连通性诊断 v2：定位「Edge 上不了网」到底是代理、DNS 还是 HTTPS 的问题
//
// 三层对照：
//   1) node fetch   —— 证明机器本身能否出网
//   2) Edge 默认配置 —— 沿用系统代理设置
//   3) Edge --no-proxy-server —— 强制直连
// 每个配置分别测 http / 国内域名 / 目标域名，从结果即可判断是代理错、DNS 错还是 SSL 错。
//
// 用法: node wb_diag_net.js
const { chromium } = require('C:/Users/23159/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TARGETS = [
  'http://www.baidu.com',            // http（排除 HTTPS/证书因素）
  'https://www.baidu.com',           // https 国内站
  'https://www.workbuddy.cn/',       // 目标站点
];

async function nodeFetch(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { redirect: 'manual' });
    return '  OK   ' + url + '  status=' + r.status + '  ' + (Date.now() - t0) + 'ms';
  } catch (e) {
    return '  FAIL ' + url + '  ' + String(e.message || e).split('\n')[0] + '  ' + (Date.now() - t0) + 'ms';
  }
}

async function edgeRun(label, extraArgs) {
  console.log('=== Edge · ' + label + ' ===');
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: EDGE, headless: true,
      args: ['--no-first-run', '--disable-gpu', '--disable-dev-shm-usage', ...extraArgs],
    });
  } catch (e) {
    console.log('  启动失败: ' + String(e.message || e).split('\n')[0]);
    return;
  }
  const page = await browser.newPage();
  for (const url of TARGETS) {
    const t0 = Date.now();
    try {
      const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      console.log('  OK   ' + url + '  status=' + (r && r.status()) + '  ' + (Date.now() - t0) + 'ms');
    } catch (e) {
      console.log('  FAIL ' + url + '  ' + String(e.message || e).split('\n')[0] + '  ' + (Date.now() - t0) + 'ms');
    }
  }
  await browser.close();
}

(async () => {
  console.log('=== node fetch 对照组（机器本身能否出网）===');
  for (const u of TARGETS) console.log(await nodeFetch(u));
  await edgeRun('默认（沿用系统代理设置）', []);
  await edgeRun('强制直连 --no-proxy-server', ['--no-proxy-server']);
  console.log('\n判断: node 通 + Edge 全挂 → Edge 网络配置/沙箱问题');
  console.log('      node 也挂         → 机器确实出不了网，需开代理');
  process.exit(0);
})().catch(e => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
