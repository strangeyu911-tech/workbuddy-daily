// 每日自动化任务（派猫猫旅行）—— Edge 版 / 专用 profile
// 背景：
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
// 稳健性：SPA 渲染偶发延迟，getTravelBtn 轮询最长 25s 等待按钮出现，避免误判 no-travel-button。
const { chromium } = require('C:/Users/23159/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = 'C:/Users/23159/WorkBuddy/2026-08-15-22-57-14/wb_auto_profile_edge';
const GROWTH = 'https://www.workbuddy.cn/profile/growth-center';
const TRAVEL_SEL = 'button.gs-buddy-travel';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function killStaleEdge() {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*wb_auto_profile_edge*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try { require('child_process').spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' }); } catch (e) {}
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
  killStaleEdge();
  await sleep(1500);
  const context = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: true,
    args: ['--no-first-run', '--disable-gpu', '--disable-dev-shm-usage']
  });
  const page = await context.newPage();
  const res = { login: null, catTravel: null, note: '' };

  // ---- 进入成长中心（验证登录态）----
  await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(4000);

  if (page.url().includes('/login')) {
    res.login = false;
    res.catTravel = 'skipped: not logged in';
    res.note = '成长中心 302 到登录页，profile 无有效登录态 → 运行 wb_login_once.js 重新登录';
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

  console.log(JSON.stringify(res, null, 2));
  try { await context.close(); } catch (e) {}
  try { killStaleEdge(); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.stack || e); try { killStaleEdge(); } catch (_) {} process.exit(1); });
