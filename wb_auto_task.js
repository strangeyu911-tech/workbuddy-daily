// 每日自动化任务（派猫猫旅行）—— Edge 常驻窗口 + CDP 附着版 v2
//
// 迭代历史：
//   v1 每次运行都 launchPersistentContext 新起一个 headless Edge，用完即杀。
//      实测两个坑：(1) 开头 killStaleEdge 会误杀刚登录完还没退干净的 Edge；
//      (2) 新起的 headless Edge 偶发启动即崩 → page.goto 报
//      "Target page, context or browser has been closed"（2026-09-06）。
//   v2 改为「常驻浏览器 + 新开标签页」：
//      - 首次运行拉起一个专用 Edge 窗口（wb_auto_profile_edge，调试端口 9223），
//        之后保持常驻；每次任务只是附着上去新开一个 tab，跑完只关 tab。
//      - 好处：不再反复启停浏览器（根除启动崩溃与 profile 抢占），
//        登录态也常驻内存，稳定性大幅提升。
//      - 注意：要附着到"已打开的窗口"，该窗口必须带 --remote-debugging-port
//        启动。日常手动开的 Edge 没有这个参数，连不上属正常，本脚本会自己拉起
//        专用窗口。
//  - ABE 已通过注册表策略关闭(HKLM\...\ApplicationBoundEncryptionEnabled=0)，专用 profile
//    (wb_auto_profile_edge) 的登录态可被自动化携带（已验证 login:true）。
//  - 猫旅行按钮 = button.gs-buddy-travel，流程：
//      可派遣  : 文案含「派/去旅行/派遣/出发/立即」→ 点击主按钮后弹二次确认框「确定派出」，
//                必须再点确认框服务端才真正派遣（曾因漏点确认框导致假成功，已修）
//      旅行中  : 文案含「倒计时/回家/采风/旅行中」→ 猫在旅行，无需派遣（会自动回家）
//      已回家  : 同可派遣态（每日限 1 次，派完按钮 disabled 显示"累啦，明天再来吧"）
//      领礼物  : 文案含「领取/礼物」→ 猫已回家并带回奖励，先点领取，按钮回到「派猫猫旅行」可再派
//  - Buddy 加油站签到 = 桌面端专属 + 服务端门控，web 自动化与客户端 CDP 均不可达，
//    已移出本脚本，改为用户在桌面端每天点一次「立即领取」。
//  - 稳健性：SPA 渲染偶发延迟，getTravelBtn 轮询最长 25s 等待按钮出现。
//
// 用法:
//   node wb_auto_task.js            # 正常跑任务（复用/拉起常驻窗口）
//   node wb_auto_task.js --kill     # 任务结束后关掉常驻 Edge（偶尔想彻底清理时用）

const { chromium } = require('C:/Users/23159/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { spawn } = require('child_process');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = 'C:/Users/23159/WorkBuddy/2026-08-15-22-57-14/wb_auto_profile_edge';
const CDP_PORT = 9223;
const CDP_URL = 'http://127.0.0.1:' + CDP_PORT;
const GROWTH = 'https://www.workbuddy.cn/profile/growth-center';
const TRAVEL_SEL = 'button.gs-buddy-travel';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const KILL_AFTER = process.argv.includes('--kill');

async function portAlive() {
  try {
    const r = await fetch(CDP_URL + '/json/version', { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (e) { return false; }
}

// 复用常驻 Edge；没有就拉起一个（detached，脚本退出后窗口继续活着）
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
    for (let i = 0; i < 30; i++) {   // 最多等 30s
      await sleep(1000);
      if (await portAlive()) { up = true; break; }
    }
    if (!up) throw new Error('Edge 已拉起但调试端口 ' + CDP_PORT + ' 30s 内未就绪（可能已有 Edge 实例占用了别的参数，试试 --kill 清理后重跑）');
  } else {
    console.error('[i] 复用已打开的常驻 Edge 窗口');
  }
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
  return browser;
}

// 轮询等待猫旅行按钮出现并读出文案（SPA 偶发延迟，最长 wait)
async function getTravelBtn(page, wait = 25000) {
  const end = Date.now() + wait;
  while (Date.now() < end) {
    const b = page.locator(TRAVEL_SEL).first();
    if (await b.count()) {
      const t = (await b.innerText()).replace(/\s+/g, ' ').trim();
      if (t) return { btn: b, txt: t };
    }
    await sleep(800);
  }
  return null;
}

(async () => {
  const res = { login: null, catTravel: null, note: '', mode: null, error: null };
  let browser, page;
  try {
    browser = await getBrowser();
    const context = browser.contexts()[0] || await browser.newContext();
    page = await context.newPage();          // 新开一个 tab，跑完只关 tab

    // ---- 进入成长中心（验证登录态）----
    await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000);

    if (page.url().includes('/login')) {
      res.login = false;
      res.catTravel = 'skipped: not logged in';
      res.note = '成长中心 302 到登录页（SSO 会话失效）→ 直接运行 wb_login_once.js，会在常驻窗口里新开登录页重新登录';
    } else {
      res.login = true;

      let state = await getTravelBtn(page);
      if (!state) {
        res.catTravel = 'no-travel-button';
      } else {
        let { btn, txt } = state;

        // ---- 领礼物态：猫已回家并带回奖励 → 开弹窗领积分 → 刷新使按钮回到「派猫猫旅行」----
        if (/领取|礼物/.test(txt)) {
          const giftEnabled = await btn.isEnabled().catch(() => false);
          if (giftEnabled) {
            try {
              await btn.click({ timeout: 6000 });                 // 开礼物弹窗
              await sleep(2000);
              const claim = page.locator('button,[role=button],a.btn,div.btn')
                .filter({ hasText: /领取\s*\d+\s*积分/ }).first(); // 弹窗内「领取 5 积分」
              if (await claim.count()) await claim.click({ timeout: 4000 }).catch(() => {});
              await sleep(1500);
              await page.keyboard.press('Escape').catch(() => {}); // 关闭弹窗
              await sleep(1000);
              await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 }); // 刷新回派遣态
              await sleep(4000);
              const s2 = await getTravelBtn(page);                 // 重新读取按钮态
              if (s2) { btn = s2.btn; txt = s2.txt; res.note = '已领回流礼物奖励'; }
            } catch (e) {}
          } else {
            res.catTravel = 'gift-claim-disabled:' + txt;
          }
        }

        // ---- 状态机 ----
        if (/倒计时|回家|采风|旅行中|距离/.test(txt)) {
          res.catTravel = 'already-traveling:' + txt; // 猫在旅行中，等自动回家即可
        } else if (/派|去旅行|派遣|出发|立即/.test(txt)) {
          const enabled = await btn.isEnabled().catch(() => false);
          if (!enabled) {
            res.catTravel = 'already-dispatched-today:' + txt;
            res.note = '今日已派猫猫旅行（按钮 disabled），明天 0 点重置';
          } else {
            try {
              await btn.click({ timeout: 6000 });
              await sleep(1500);
              // 主按钮点开后会出现二次确认弹窗（"想让 Buddy 今天去哪里逛逛？…确定派出"），
              // 必须再点「确定派出」服务端才会真正派遣——这是之前假成功(root cause)漏掉的一步。
              const confirmBtn = page.locator('button, [role="button"], a.btn, div.btn')
                .filter({ hasText: /确定派出|确定|确认|出发|去吧|开始旅行|立即出发|去旅行/ }).first();
              let confirmed = false;
              if (await confirmBtn.count()) {
                await confirmBtn.click({ timeout: 4000 });
                confirmed = true;
              }
              await sleep(6000); // 等派遣请求完成 + 状态刷新
              // 复核最终状态：只有切到「旅行中/倒计时」才算真派成功（服务端已记录）
              const s3 = await getTravelBtn(page);
              const afterTxt = s3 ? s3.txt : '';
              if (/倒计时|回家|采风|旅行中|距离/.test(afterTxt)) {
                res.catTravel = 'dispatched:' + afterTxt;
                res.note = confirmed ? '领礼物+主按钮+确认框完成派遣' : '主按钮点击后自动进入旅行态';
              } else if (confirmed) {
                res.catTravel = 'dispatched-unverified:' + afterTxt;
                res.note = '已点确认框但状态未切到旅行态，请人工核对';
              } else {
                res.catTravel = 'dispatched-unverified:' + afterTxt;
                res.note = '点了主按钮但未出现确认弹窗，请人工核对';
              }
            } catch (e) {
              res.catTravel = 'click-failed:' + txt + ' (' + e.message.split('\n')[0] + ')';
            }
          }
        } else {
          res.catTravel = 'unknown-state:' + txt;
        }
      }
    }
  } catch (e) {
    res.error = String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ');
  } finally {
    console.log(JSON.stringify(res, null, 2));
    try { if (page) await page.close(); } catch (e) {}   // 只关 tab，浏览器保持常驻
    if (KILL_AFTER) {
      try { await browser.close(); } catch (e) {}  // CDP close 会把整个 Edge 关掉
    }
    process.exit(res.error ? 1 : 0);
  }
})().catch(e => {
  console.error('ERR', e && e.stack || e);
  process.exit(1);
});
