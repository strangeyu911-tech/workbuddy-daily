// 成长任务 · 网页端执行器 v1
//
// 目的：把「能靠网页端真实操作完成」的任务，用真实浏览器 UI 点击做完，然后点真实领奖按钮。
//
// ── 边界（刻意如此，勿为省事改掉）────────────────────────────────────────
// 本脚本**只做真实点击**。它不会：
//   · 向 /v2/report 发送任何"行为事件"（不编造你没做过的事）
//   · 伪造设备标识 / 客户端 UA（不冒充不存在的设备）
//   · 代你完成需要真人的动作（Expert_Philanthropy 捐款类：跳过，不碰）
// 效果就是"有个手很快的人在浏览器里帮你点"，服务端记的是真实发生的操作。
//
// ── 任务分类（依据：jump_url + 实测 jump_url 协议）──────────────────────
//   WEB_OK      网页端点击即可完成 → 本脚本代做（auto）
//   DESKTOP_ONLY 跳 workbuddy:// 指向桌面端专属界面（模板库/专家/设置/资料库等）
//                → **本脚本不碰**，请在客户端里手动点一次
//   HUMAN_ONLY  必须真人（捐款、夜间活动、价格敏感）
//                → **本脚本不碰**
//   CLAIM       状态已足、只差点领奖按钮 → 点按钮（真实点击，非 API）
//
// ── 用法 ────────────────────────────────────────────────────────────────
//   node wb_run_tasks.js              # 干跑：只报告，不点任何东西（默认）
//   node wb_run_tasks.js --apply      # 真执行：做能做的 + 领能领的
//   node wb_run_tasks.js --apply --only=chat_5,expert_5    # 只做指定任务
//   node wb_run_tasks.js --claim-only # 只领奖，不执行任务
//   node wb_run_tasks.js --all        # 含已完成的（默认只列待办）
//
//   ⚠️ 派猫（buddy travel）不在这里 —— 已由 wb_auto_task.js v4 负责，勿重复点。

// ── [本机补丁] 让 undici 别把环回请求送进系统代理 ────────────────────
// 事实（2026-09-17 实测，勿再凭印象改）：
//   · undici 的全局 fetch 从**环境变量**读代理；给 fetch 传 `{proxy:undefined}` 无效。
//   · 本机 HTTP_PROXY 指向一个本地代理端口，实测它**能正确转发**环回请求：
//     9223 在听 → HTTP 200；没人听 → 代理回 502（直连则是 ECONNREFUSED）。
//   · 所以 502 == "确实没在听"，**不是**代理误路由造成的假阴性。
//     （曾误判成"代理把环回送错地方"，白查两轮；真因是 Edge 冷启动太慢。）
//   · 保留本块只是让环回请求少绕一层；出网不受影响（清/不清代理实测都通）。
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
const CDP_PORT = 9223;
const CDP_URL = 'http://127.0.0.1:' + CDP_PORT;
const GROWTH = 'https://www.workbuddy.cn/profile/growth-center';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ARGV = process.argv.slice(2);
const APPLY = ARGV.includes('--apply');
const CLAIM_ONLY = ARGV.includes('--claim-only');
const SHOW_ALL = ARGV.includes('--all');
const ONLY = (() => {
  const a = ARGV.find((x) => x.startsWith('--only='));
  return a ? a.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean) : null;
})();

// ── 任务分类表 ──────────────────────────────────────────────────────────
// 依据 jump_url 实测：workbuddy:// 协议指向的是**桌面客户端**界面。
// 网页端点「进行中」只是"去客户端做"，网页本身给不了那个界面。
const TASKS = {
  chat_5:           { mode: 'auto',         todo: '在网页对话里发 5 条（进度按条数累计）' },
  expert_5:         { mode: 'auto',         todo: '点开 5 个专家详情页' },
  create_canvas:    { mode: 'auto',         todo: '进「设计创意」模式建 1 个画布' },
  playbook_prompt:  { mode: 'auto',         todo: '进「灵感」点「+ 做同款」并对话 1 次' },
  skill_1:          { mode: 'desktop_only', todo: '在客户端「技能」里尝鲜 1 个' },
  template_5:       { mode: 'desktop_only', todo: '在客户端用 5 个模板（网页端无模板库）' },
  Expert_team_use_3:{ mode: 'desktop_only', todo: '在客户端召唤 3 次专家团' },
  'Expert_lighthouse':{ mode: 'desktop_only', todo: '体验「腾讯轻量云」专家（客户端）' },
  Expert_Philanthropy:{ mode: 'human_only', todo: '⚠️ 需真实捐款 —— 不代做，本脚本跳过' },
  Hp_Appearance:    { mode: 'desktop_only', todo: '在客户端「设置 → 外观」切该主题（网页端「领取更多」只是个跳转钮）' },
  Library_read:     { mode: 'desktop_only', todo: '在客户端「资料库」读完介绍文档' },
  'Model_chat_GLM5.2':{ mode: 'desktop_only', todo: '在客户端选 GLM-5.2 模型对话 1 次' },
  RichMeow_Chat:    { mode: 'desktop_only', todo: '在客户端对话 1 次（限定款盲盒）' },
  first_buddy:      { mode: 'desktop_only', todo: '在客户端领取一只 Buddy' },
  automation_1:     { mode: 'desktop_only', todo: '在客户端设置 1 个自动化任务' },
  black_cat:        { mode: 'human_only',   todo: '⚠️ 夜间折扣活动（与消费相关）—— 不代做' },
  Buddy_App:        { mode: 'desktop_only', todo: '在客户端「发现应用」进入任一应用' },
  Buddy_App_QQ:     { mode: 'desktop_only', todo: '在客户端进入「企鹅教师助手」应用' },
};

// 中文宽度对齐
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
function pad(s, n) {
  s = String(s);
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
}

// CDP 端口存活探测。
// ⚠️ 用 TCP 而不是 fetch：只想回答"端口在不在听"这一件事，不经过代理、不经过 HTTP 层。
// 实测本机代理其实能正确转发环回请求（在听=200 / 没听=502），所以旧的 fetch 版并非失效
// —— 这里是刻意收敛不确定性（代理端口每次会话会变、代理可能消失）。
function portAlive() {
  const net = require('net');
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: CDP_PORT });
    const done = (v) => { try { s.destroy(); } catch (e) {} resolve(v); };
    s.setTimeout(2500);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function getBrowser() {
  if (!(await portAlive())) {
    console.error('[i] 常驻 Edge 不在运行，拉起中（之后保持常驻）…');
    const child = spawn(EDGE, [
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + PROFILE,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--disable-session-crashed-bubble', '--window-size=1200,800',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    let up = false;
    for (let i = 0; i < 30; i++) { await sleep(1000); if (await portAlive()) { up = true; break; } }
    if (!up) throw new Error('Edge 已拉起但调试端口 ' + CDP_PORT + ' 30s 内未就绪');
  } else {
    console.error('[i] 复用已打开的常驻 Edge 窗口');
  }
  return chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
}

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

// 读任务行：taskCode + 按钮文案 + 是否 disabled + 进度
const READ_ROWS = () => {
  const txt = (e) => (e.innerText || '').replace(/\s+/g, ' ').trim();
  return [...document.querySelectorAll('.gs-task-row')].map((row) => {
    const btn = row.querySelector('.gs-task-action');
    let code = '', title = '', buttonText = '';
    if (btn) {
      const rm = btn.getAttribute('dt-remark') || '';
      try { const j = JSON.parse(rm); code = j.taskCode || ''; title = j.title || ''; buttonText = j.buttonText || ''; } catch (e) {}
      if (!buttonText) buttonText = txt(btn);
    }
    const t = txt(row);
    // 进度形如 1/5 或 5/5
    const m = t.match(/(\d+)\s*\/\s*(\d+)/);
    const progress = m ? { current: +m[1], target: +m[2] } : null;
    return {
      code, title: title || txt(row.querySelector('.gs-task-title-row') || row).slice(0, 40),
      buttonText, disabled: btn ? !!btn.disabled : true, progress, text: t.slice(0, 160),
    };
  }).filter((r) => r.code);
};

// 点操作按钮（真实 UI 点击）
const CLICK_ACTION = (code) => {
  const rows = [...document.querySelectorAll('.gs-task-row')];
  for (const row of rows) {
    const btn = row.querySelector('.gs-task-action');
    if (!btn) continue;
    let c = '';
    try { c = (JSON.parse(btn.getAttribute('dt-remark') || '{}').taskCode) || ''; } catch (e) {}
    if (c === code) {
      if (btn.disabled) return 'disabled';
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return 'clicked:' + (btn.innerText || '').replace(/\s+/g, ' ').trim();
    }
  }
  return 'not-found';
};

// 把「全部任务」逐步展开到全量。
// ⚠️ 实测坑：SPA 冷启动渲染 .gs-task-row 需 ~9s，固定 sleep(4000) 会读到 0 行，
//    进而让 expandAll 第一轮就 break（且一条日志都不打，看起来像「页面没数据」）。
//    故先轮询等首行出现 —— 与 wb_auto_task.js 的 getTravelBtn 同一套思路。
async function waitRows(page, timeoutMs = 30000) {
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < timeoutMs) {
    n = await page.locator('.gs-task-row').count();
    if (n > 0) return n;
    // 超时到一半时，若仍未渲染，顺手判一次是否被踢到登录页
    if (Date.now() - t0 > timeoutMs / 2 && page.url().includes('/login')) return 0;
    await sleep(600);
  }
  return n;
}

// 实测：gs-load-more 是**分页/累加**的，点一次只多渲染几行，需循环点到不再增长。
// 每层再渲染有延迟，所以「点一次 → 等行数稳定」为一个循环。
async function expandAll(page, maxRound = 6) {
  // 先等首行渲染出来再开始点，否则第一轮 n=0 会误判成「已到顶」
  const first = await waitRows(page);
  if (first === 0) {
    console.error('⚠️ 等 ' + 30 + 's 仍无 .gs-task-row：页面可能未登录 / 未渲染 / 选择器变了。');
    console.error('  当前 URL: ' + page.url());
    return 0;
  }
  console.log('  [expand] 首行已渲染（' + first + ' 行），开始展开…');
  let last = -1;
  for (let round = 0; round < maxRound; round++) {
    const n = await page.locator('.gs-task-row').count();
    if (n === last) break;               // 上一轮没再增长 → 已到顶
    last = n;
    const all = page.locator('button.gs-load-more').first();
    if (!(await all.count())) break;     // 没有「全部任务」按钮了 → 已展开
    await all.scrollIntoViewIfNeeded().catch(() => {});
    await all.click({ timeout: 6000 }).catch(() => {});
    console.log('  [expand] 第 ' + (round + 1) + ' 次点「全部任务」，当前 ' + n + ' 行…');
    // 等行数不再变化（渲染有延迟，固定 sleep 会漏判）
    let prev = -1;
    for (let i = 0; i < 10; i++) {
      await sleep(700);
      const cur = await page.locator('.gs-task-row').count();
      if (cur === prev) break;
      prev = cur;
    }
  }
  return page.locator('.gs-task-row').count();
}

(async () => {
  const browser = await getBrowser();
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
  let rows = [];
  try {
    // 进入成长中心（冷启动最多 2 次导航，对齐 wb_auto_task.js 的处理）
    let ok = false;
    for (let a = 0; a < 2 && !ok; a++) {
      try { await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 }); ok = true; }
      catch (e) { if (a === 0) await sleep(4000); else throw e; }
    }
    // 不再用固定 sleep：改由 expandAll 内部轮询等 .gs-task-row 出现（SPA 冷启动实测 ~9s）
    if (page.url().includes('/login')) {
      console.error('❌ 未登录。请先跑 node wb_login_once.js 扫码登录（之后浏览器保持常驻即可）。');
      process.exit(2);
    }
    // 展开「全部任务」到完整 18 行（分页式，需循环点，见 expandAll 注释）
    const rowCount = await expandAll(page);
    if (rowCount < 10) {
      console.error('⚠️ 只渲染出 ' + rowCount + ' 行，任务列表可能未完全展开（继续按已见行处理）');
    }
    rows = await page.evaluate(READ_ROWS);

    // ── 分类 ──
    // 领奖判定：只看**真正领取**的按钮文案。
    // ⚠️ 实测坑：「领取更多」不是领奖 —— 点了不弹窗、不发请求、按钮不变，
    //    它只是个跳去「主题/更多奖励」的入口（如 Hp_Appearance）。
    //    把它当领奖点会白点一次还误报成功，故显式排除。
    const CLAIM_RE = /^(收下奖励|领取奖励|领取\s*\d+\s*积分|领取)$/;
    const NAV_RE = /领取更多|查看详情|去看看|立即前往/;
    const claimable = [];
    const canAuto = [];
    const manual = [];
    for (const r of rows) {
      const meta = TASKS[r.code] || { mode: 'unknown', todo: '（未收录，请在客户端手动确认）' };
      r.mode = meta.mode;
      r.todo = meta.todo;
      const done = /已完成/.test(r.buttonText);
      if (done) continue;
      if (CLAIM_RE.test(r.buttonText.trim())) claimable.push(r);
      else if (meta.mode === 'auto') canAuto.push(r);
      else manual.push(r);
      if (NAV_RE.test(r.buttonText)) r.navOnly = true;
    }

    console.log('\n共扫描 ' + rows.length + ' 个任务：'
      + '可领奖 ' + claimable.length + ' · 可网页代做 ' + canAuto.length
      + ' · 需客户端/真人 ' + manual.length);

    if (claimable.length) {
      console.log('\n── 🟢 可领奖（真实点击领奖按钮）──');
      for (const r of claimable) console.log('  ' + pad(r.code, 24) + r.buttonText);
    }
    if (canAuto.length) {
      console.log('\n── 🤖 可网页代做 ──');
      for (const r of canAuto) console.log('  ' + pad(r.code, 24) + pad(r.progress ? r.progress.current + '/' + r.progress.target : '—', 10) + r.todo);
    }
    if (manual.length) {
      console.log('\n── 🙋 需你在客户端手动点（本脚本不动）──');
      for (const r of manual) {
        const mark = r.navOnly ? '→' : ' ';
        console.log('  ' + pad(r.code, 24) + pad(r.mode, 15) + r.todo + (r.navOnly ? '  [按钮:' + r.buttonText + ' 是跳转,非领奖]' : ''));
      }
    }
    if (SHOW_ALL) {
      const done = rows.filter((r) => /已完成/.test(r.buttonText));
      console.log('\n── ✅ 已完成 (' + done.length + ') ──');
      for (const r of done) console.log('  ' + pad(r.code, 24) + r.title);
    }

    // ── 执行 ──
    if (!APPLY && !CLAIM_ONLY) {
      console.log('\n[干跑] 未点击任何按钮。加 --apply 才会真实执行。');
      console.log('提示：需客户端操作的项（模板库/专家/主题等）请自己在 WorkBuddy 客户端里做一次。');
      return;
    }

    const allow = (r) => !ONLY || ONLY.includes(r.code);
    let claimedN = 0;
    if (claimable.length) {
      console.log('\n▶ 开始领奖（真实点击）…');
      for (const r of claimable) {
        if (!allow(r)) continue;
        const res = await page.evaluate(CLICK_ACTION, r.code);
        console.log('  ' + pad(r.code, 24) + res);
        if (res.startsWith('clicked')) {
          await sleep(2500);
          // 真实点击后复核：按钮是否离开「领取」态
          const after = await page.evaluate(() => {
            const out = {};
            for (const row of document.querySelectorAll('.gs-task-row')) {
              const btn = row.querySelector('.gs-task-action');
              if (!btn) continue;
              let c = '';
              try { c = (JSON.parse(btn.getAttribute('dt-remark') || '{}').taskCode) || ''; } catch (e) {}
              out[c] = (btn.innerText || '').replace(/\s+/g, ' ').trim();
            }
            return out;
          });
          const now = after[r.code] || '';
          if (/已完成/.test(now)) { console.log('      ✓ 已领到（按钮转为已完成）'); claimedN++; }
          else console.log('      ⚠️ 按钮现为「' + now + '」—— 可能弹窗需确认，请看一眼浏览器窗口');
        }
      }
    }

    if (canAuto.length && !CLAIM_ONLY) {
      console.log('\n▶ 网页代做（真实点击）…');
      for (const r of canAuto) {
        if (!allow(r)) continue;
        const res = await page.evaluate(CLICK_ACTION, r.code);
        console.log('  ' + pad(r.code, 24) + res + '   —— ' + r.todo);
        if (res.startsWith('clicked')) {
          console.log('      已点开入口，后续动作（发消息/建画布）请在此窗口完成；或改由集成步骤处理');
          await sleep(1500);
        }
      }
    }

    console.log('\n完成。领奖成功 ' + claimedN + ' 项。');
    console.log('未代做的项请看上面的「需你在客户端手动点」清单 —— 那是刻意的边界，不是遗漏。');
  } finally {
    try { await page.close(); } catch (e) {}
  }
})().catch((e) => {
  console.error('ERR', (e && e.stack) || e);
  process.exit(1);
});
