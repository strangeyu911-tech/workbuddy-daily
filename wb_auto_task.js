// 每日自动化任务（派猫猫旅行）—— Edge 常驻窗口 + CDP 附着版 v4
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
//  - 无需关闭 Edge 的 App-Bound Encryption：脚本附着在自己拉起的、带独立 --user-data-dir
//    的专用 Edge 上，cookie 由 Edge 进程自己解密与维持（2026-09-17 复核：无注册表改动）。
//    读完下面 v2 就知道为什么 —— 常驻窗口 + CDP 附着，全流程不读磁盘上的加密 cookie。
//  - 猫旅行按钮 = button.gs-buddy-travel，流程：
//      可派遣  : 文案含「派/去旅行/派遣/出发/立即」→ 点击主按钮后弹二次确认框「确定派出」，
//                必须再点确认框服务端才真正派遣（曾因漏点确认框导致假成功，已修）
//      旅行中  : 文案含「倒计时/回家/采风/旅行中」→ 猫在旅行，无需派遣（会自动回家）
//      已回家  : 同可派遣态（每日限 1 次，派完按钮 disabled 显示"累啦，明天再来吧"）
//      领礼物  : 文案含「领取/礼物」→ 猫已回家并带回奖励，先点领取（v3：轮询强校验 + 失败重试，见下），按钮回到「派猫猫旅行」可再派
//  - Buddy 加油站签到 = 桌面端专属 + 服务端门控，web 自动化与客户端 CDP 均不可达，
//    已移出本脚本，由独立的纯 API 脚本 wb_checkin.js --checkin 自动完成
//    （读桌面端登录态直接调签到接口，配合 WorkBuddy 定时自动化即可，无需任何手动操作）。
//  - 稳健性：SPA 渲染偶发延迟，getTravelBtn 轮询最长 25s 等待按钮出现。
//   v3 零扫码（2026-09-15）：SSO 会话失效时不再要求扫码，走 wb_session_bridge
//      用桌面端自己的长期令牌续期出一份新会话，再继续任务（已实测）。
//      桥失败才落回 wb_login_once.js 扫码兜底。从此重启/关窗都不再需要扫码。
//   v4 整流程重试（2026-09-16）：把「进成长中心 → 验登录 → 判定猫状态 → 执行动作」
//      抽成 runOnce()，外层最多跑 3 轮。原因：SPA 渲染抖动/冷启动竞态导致的
//      no-travel-button / click-failed / dispatched-unverified 都是**瞬时**的，
//      实测 2026-09-15、09-16 主任务每天都要人工复跑 1~2 次才派遣成功 —— 这类失败
//      重载页面再来一轮基本必过。改完一次运行即自愈（不再依赖外层 agent 复跑），
//      因此删除了 19:25 的「派猫补派兜底」自动化：它的前提「等用户扫码后重派」
//      已被 v3 消灭（v3 后 login:false 只在桌面端令牌双过期时出现），而它 19:25
//      跑时猫必在旅行中（19:00 派出、倒计时 1~4h），主任务成功时纯空转、白烧积分。
//
// 用法:
//   node wb_auto_task.js            # 正常跑任务（复用/拉起常驻窗口）
//   node wb_auto_task.js --kill     # 任务结束后关掉常驻 Edge（偶尔想彻底清理时用）

const { chromium } = require('./wb_paths').playwright();
const { spawn } = require('child_process');
const bridge = require('./wb_session_bridge');

const EDGE = require('./wb_paths').edge();
const PROFILE = require('./wb_paths').profile();
const CDP_PORT = 9223;
const CDP_URL = 'http://127.0.0.1:' + CDP_PORT;
const GROWTH = 'https://www.workbuddy.cn/profile/growth-center';
const TRAVEL_SEL = 'button.gs-buddy-travel';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const KILL_AFTER = process.argv.includes('--kill');

// ---- 整流程重试策略（v4）----
const MAX_ROUNDS = 3;   // 含首次在内最多跑几轮
// 已达目的：无需再重试
const SETTLED = /^(dispatched:|already-traveling|already-dispatched-today)/;
// 瞬时失败：重载页面再来一轮基本能过
const RETRYABLE = /^(no-travel-button|click-failed|dispatched-unverified|gift-claim-failed|gift-claim-disabled|unknown-state)/;

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

// 轮询等待页面内条件成立（返回第一个真值；超时返回 null）
// 用来替代固定 sleep —— 页面渲染/接口耗时波动大，固定等待必然偶发漏步
async function waitUntil(page, fn, timeout = 15000, interval = 500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    let v = null;
    try { v = await page.evaluate(fn); } catch (e) { v = null; }
    if (v) return v;
    await sleep(interval);
  }
  return null;
}

// 读主按钮文案（不等待）
async function readBtnText(page) {
  return page.evaluate(() => {
    const b = document.querySelector('button.gs-buddy-travel');
    return b ? (b.innerText || '').replace(/\s+/g, ' ').trim() : null;
  }).catch(() => null);
}

// 领取「回流礼物」：猫旅行回家带回的奖励，必须先领完，按钮才会回到「派猫猫旅行」
// 成功判据：主按钮文案离开「领取」态（服务端真的把奖励结算了）
// 失败最多重试 1 轮，全程把每一步记进 log，绝不静默吞异常
async function claimGift(page) {
  const log = [];
  for (let round = 1; round <= 2; round++) {
    log.push('r' + round + ':start=' + (await readBtnText(page)));
    try {
      await page.locator(TRAVEL_SEL).first().click({ timeout: 8000 });
    } catch (e) {
      log.push('r' + round + ':openFailed=' + e.message.split('\n')[0]);
      continue;
    }
    // 等礼物弹窗出现（实测 ~300ms，负载高时会更久，不能固定 sleep）
    if (!(await waitUntil(page, () => !!document.querySelector('.gs-modal-overlay'), 10000, 250))) {
      log.push('r' + round + ':modalNotFound');
      continue;
    }
    // 等弹窗内「领取 N 积分」按钮出现且可点
    const claim = page.locator('.gs-modal-overlay').locator('button,[role=button]')
      .filter({ hasText: /领取\s*\d+\s*积分/ }).first();
    let ready = false;
    const cEnd = Date.now() + 8000;
    while (Date.now() < cEnd) {
      if (await claim.count() && await claim.isEnabled().catch(() => false)) { ready = true; break; }
      await sleep(250);
    }
    if (!ready) { log.push('r' + round + ':claimBtnNotReady'); continue; }
    await claim.click({ timeout: 6000 });
    log.push('r' + round + ':claimClicked');

    // 关键：等领取请求真正落地再动页面。
    // 领取中按钮会变成「领取中…」并 disabled；成功后弹窗自动关闭、主按钮回到「派猫猫旅行」。
    // 旧版在这里 sleep(1500) 就 page.goto 刷新，把还没完成的领取请求打断 —— 本次故障根因。
    const changed = await waitUntil(page, () => {
      const b = document.querySelector('button.gs-buddy-travel');
      const t = b ? (b.innerText || '').replace(/\s+/g, ' ').trim() : '';
      return (t && !/领取/.test(t)) ? t : null;
    }, 20000, 500);
    if (changed) { log.push('r' + round + ':ok=' + changed); return { ok: true, txt: changed, log }; }

    // 兜底 1：关掉弹窗再看一次
    log.push('r' + round + ':notChangedAfterClaim');
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(1500);
    const afterEsc = await readBtnText(page);
    if (afterEsc && !/领取/.test(afterEsc)) { log.push('r' + round + ':okAfterEsc=' + afterEsc); return { ok: true, txt: afterEsc, log }; }

    // 兜底 2：整页刷新重读（此时领取请求早已结束，不会再被打断）
    try { await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {}
    const s = await getTravelBtn(page, 25000);
    if (s && !/领取/.test(s.txt)) { log.push('r' + round + ':okAfterReload=' + s.txt); return { ok: true, txt: s.txt, log }; }
    log.push('r' + round + ':stillGift=' + (s ? s.txt : 'no-btn'));
  }
  return { ok: false, log };
}

// ---- 单轮流程：进成长中心 → 验登录（必要时静默换会话）→ 判定猫的状态并执行动作 ----
// 抽成函数是为了外层能整流程重试；每轮开头都会重新 goto，天然完成「重载再试」。
// 返回 { login, catTravel, note, giftLog }
async function runOnce(page) {
  const r = { login: null, catTravel: null, note: '', giftLog: null };

  // ---- 进入成长中心（验证登录态）----
  // 冷启动兜底：常驻 Edge 当天首次拉起时，进程虽已监听 CDP 端口，但渲染/网络栈
  // 尚未就绪，首次真实导航可能吃掉 30s 预算而超时（2026-09-10 19:00 复现，login:null）。
  // 故做「最多 2 次」导航：首次超时则等 4s 让浏览器热身后重试，第二次基本必过。
  let navOk = false;
  for (let attempt = 0; attempt < 2 && !navOk; attempt++) {
    try {
      await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 });
      navOk = true;
    } catch (e) {
      if (attempt === 0) {
        console.error('[i] 首次导航超时（疑似冷启动），等待浏览器热身后重试…');
        await sleep(4000);
      } else {
        throw e;
      }
    }
  }
  await sleep(4000);

  if (page.url().includes('/login')) {
    // ---- v3 零扫码：会话失效时静默续期，不打断任务 ----
    // 会话 cookie 是会话级的，Edge 进程重启即失效；桌面端自己也是每次续一份新的。
    // 这里走同一条路（wb_session_bridge.js，2026-09-15 实测通过），端点与参数见该文件。
    try {
      console.error('[i] SSO 会话失效，静默续期会话（零扫码）…');
      const loginUrl = await bridge.getClientLoginUrl('/profile/growth-center');
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(4000);
    } catch (e) {
      console.error('[i] 静默换会话失败: ' + String(e.message || e).split('\n')[0]);
    }
  }

  if (page.url().includes('/login')) {
    r.login = false;
    r.catTravel = 'skipped: not logged in';
    r.note = '静默换会话失败（桌面端令牌可能过期，请打开 WorkBuddy 桌面端刷新）→ 落回扫码兜底：运行 wb_login_once.js 重新扫码';
    return r;
  }

  r.login = true;
  const state = await getTravelBtn(page);
  if (!state) {
    r.catTravel = 'no-travel-button';
    return r;
  }

  let { btn, txt } = state;

  // ---- 领礼物态：猫已回家并带回奖励 → 必须真正领取成功，按钮才会回到「派猫猫旅行」----
  let giftBlocked = false;
  if (/领取|礼物/.test(txt)) {
    const giftEnabled = await btn.isEnabled().catch(() => false);
    if (!giftEnabled) {
      r.catTravel = 'gift-claim-disabled:' + txt;
      giftBlocked = true;
    } else {
      const g = await claimGift(page);
      r.giftLog = g.log;
      const s2 = await getTravelBtn(page, 20000);   // 领完重读按钮态
      if (s2) { btn = s2.btn; txt = s2.txt; }
      if (!g.ok) {
        giftBlocked = true;
        r.catTravel = 'gift-claim-failed:' + txt;
        r.note = '领取礼物未完成，已中止派遣（详见 giftLog）';
      } else {
        r.note = '已领取回流礼物奖励（服务端已结算，按钮离开领取态）';
      }
    }
  }

  // ---- 状态机 ----
  if (giftBlocked) {
    // 上面已给出明确结论，不再往下走（旧版会继续落到 unknown-state 并谎报已领礼物）
  } else if (/倒计时|回家|采风|旅行中|距离/.test(txt)) {
    r.catTravel = 'already-traveling:' + txt; // 猫在旅行中，等自动回家即可
  } else if (/派|去旅行|派遣|出发|立即/.test(txt)) {
    const enabled = await btn.isEnabled().catch(() => false);
    if (!enabled) {
      r.catTravel = 'already-dispatched-today:' + txt;
      r.note = '今日已派猫猫旅行（按钮 disabled），明天 0 点重置';
    } else {
      try {
        await btn.click({ timeout: 6000 });
        // 轮询等确认弹窗（渲染耗时波动，固定 sleep 会漏）
        await waitUntil(page, () => !!document.querySelector('.gs-modal-overlay'), 8000, 250);
        const scope = (await page.locator('.gs-modal-overlay').count())
          ? page.locator('.gs-modal-overlay') : page;
        const confirmBtn = scope.locator('button,[role=button],a.btn,div.btn')
          .filter({ hasText: /确定派出|确定|确认|出发|去吧|开始旅行|立即出发|去旅行/ }).first();
        let confirmed = false;
        const cfEnd = Date.now() + 8000;
        while (Date.now() < cfEnd) {
          if (await confirmBtn.count() && await confirmBtn.isEnabled().catch(() => false)) {
            await confirmBtn.click({ timeout: 5000 }).catch(() => {});
            confirmed = true;
            break;
          }
          await sleep(250);
        }
        // 派遣同样是异步请求，等到按钮真的切到旅行态再判定（最长 20s）
        const afterTxt = await waitUntil(page, () => {
          const b = document.querySelector('button.gs-buddy-travel');
          const t = b ? (b.innerText || '').replace(/\s+/g, ' ').trim() : '';
          return /倒计时|回家|采风|旅行中|距离/.test(t) ? t : null;
        }, 20000, 500) || (await readBtnText(page) || '');
        if (/倒计时|回家|采风|旅行中|距离/.test(afterTxt)) {
          r.catTravel = 'dispatched:' + afterTxt;
          const tail = confirmed ? '主按钮+确认框完成派遣' : '点主按钮后自动进入旅行态';
          r.note = r.note ? r.note + ' → ' + tail : tail;
        } else if (confirmed) {
          r.catTravel = 'dispatched-unverified:' + afterTxt;
          r.note = '已点确认框但状态未切到旅行态，请人工核对';
        } else {
          r.catTravel = 'dispatched-unverified:' + afterTxt;
          r.note = '点了主按钮但未出现确认弹窗，请人工核对';
        }
      } catch (e) {
        r.catTravel = 'click-failed:' + txt + ' (' + e.message.split('\n')[0] + ')';
      }
    }
  } else {
    r.catTravel = 'unknown-state:' + txt;
  }

  return r;
}

(async () => {
  const res = { login: null, catTravel: null, note: '', attempts: 0, error: null };
  let browser, page;
  const history = [];
  try {
    browser = await getBrowser();
    const context = browser.contexts()[0] || await browser.newContext();
    page = await context.newPage();          // 新开一个 tab，跑完只关 tab

    // ---- v4 整流程重试：最多 MAX_ROUNDS 轮 ----
    // 已达成（dispatched / already-traveling / already-dispatched-today）→ 收工
    // 登录不通（login:false）→ 重试无意义，收工（等用户扫码）
    // 瞬时失败（no-travel-button / click-failed / dispatched-unverified / 礼物相关）→ 重载再来一轮
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (round > 1) console.error('[i] 第 ' + round + ' 轮重试（上一轮：' + history[history.length - 1] + '）…');
      const r = await runOnce(page);
      history.push(r.catTravel);
      res.attempts = round;
      res.login = r.login;
      res.catTravel = r.catTravel;
      if (r.giftLog) res.giftLog = r.giftLog;
      if (r.note) res.note = r.note;

      if (r.login === false) break;                       // 登录不通，重试无意义
      if (SETTLED.test(r.catTravel || '')) break;         // 已达成目的
      if (!RETRYABLE.test(r.catTravel || '')) break;      // 非瞬时失败，重试无意义
      if (round < MAX_ROUNDS) await sleep(3000);          // 稍等再重载，给服务端/渲染一点缓冲
    }

    if (history.length > 1) {
      res.note = (res.note ? res.note + ' → ' : '') + '整流程共 ' + history.length + ' 轮（' + history.join(' / ') + '）';
    }
    if (res.catTravel && !SETTLED.test(res.catTravel)) {
      res.note = (res.note ? res.note + ' → ' : '') + '已用尽 ' + MAX_ROUNDS + ' 轮重试仍未达成，建议人工核对';
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
