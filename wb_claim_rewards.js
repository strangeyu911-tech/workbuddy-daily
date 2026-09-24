// 活跃地图 · 连登奖励自动领取 v1
//
// 目的：把「9月活跃地图」里的连登里程碑奖励（入门档 7 天 / 进阶档 14 天 / 巅峰档 28 天）
//       自动领掉 —— 打开「兑换奖励」弹窗 → 点每个**可领**档位的「兑换」按钮。
//
// ── 边界（刻意如此，勿为省事改掉）────────────────────────────────────────
// 本脚本只做**真实 UI 点击**。它不会：
//   · 向 /v2/report 发送任何合成"行为事件"（不编造你没做过的事）
//   · 伪造设备标识 / 客户端 UA（不冒充不存在的设备）
//   · 直调 POST /activity/growth/redeem 绕过 UI（口径已摸清，但刻意走点击，见下）
//   · 用「补登卡」回填缺卡日来人工拔高连登（那是另一种动作，见下方「补登」）
// 效果就是"有个手很快的人在浏览器里帮你点了一下兑换"，服务端记的是真实发生的领取。
//
// ── ⚠️ 关键实测坑（决定成败）────────────────────────────────────────────
// 1) 档位按钮的**文案不可信**：巅峰档（28 天）在连登不足时文案就已经是「兑换」，
//    但它 `disabled=true` 且 class 含 `is-locked`。若按文案「兑换」判定可领，
//    会去点一个点不动的按钮并误报成功。（与成长任务 `claimed_button_text` 同类陷阱）
//    → 判定一律看 `disabled` / `is-locked`，文案只用于区分「已兑换」。
// 2) `.gs-streak-days` 的天数在子元素 `<b>` 里，**只取直接文本节点会漏掉数字**
//    （会得到"当前连续登录  天"）→ 必须用 innerText。
// 3) 里程碑是否达成有机器可读标记：`.gs-streak-dot.is-reached`，不用去解析文案。
// 4) 只读接口 `GET /activity/growth/streak` / `/activity/growth/redeem/summary` **不稳定**：
//    曾实测 `TypeError: Failed to fetch`（同页的 heatmap 却 200 OK），后来**又都返回 200**。
//    → 正因为"通不通不确定"，本脚本**以 DOM 为准**，接口只当可选佐证，失败不影响流程。
//    （两者口径一致时可交叉验证：实测 redeem/summary 返回
//      starter_count/advanced_count/legendary_count = 1/1/0，
//      与 DOM 的「入门/进阶已兑换、巅峰未解锁」吻合。）
//
// ── 用法 ────────────────────────────────────────────────────────────────
//   node wb_claim_rewards.js            # 干跑：报连登状态 + 打开弹窗列出各档位（不点）
//   node wb_claim_rewards.js --apply    # 真领：打开弹窗，点掉所有可领档位
//   node wb_claim_rewards.js --status   # 极简只读：只读连登 DOM，连弹窗都不开
//   node wb_claim_rewards.js --probe    # 点击链路自检：验证能否定位/点到档位按钮（不点）
//
// ── 补登（本脚本不碰，留给你自己决定）────────────────────────────────────
// 日历上「未打卡（可补登）」的格子可用补登卡回填（端点 /activity/growth/makeup-cards/use），
// 从而把连登天数顶上去、提前解锁高阶档位。这**属于可用功能**，但它改变的是"打卡记录"
// 本身而非"领取奖励"，语义与领奖不同，所以本脚本默认不做。要顺手补登请明确说。
// ⚠️ 该活动规则：**完成一次对话才能被记录** —— 只有真实对话才算当天活跃。

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
const STATUS_ONLY = ARGV.includes('--status');
const PROBE = ARGV.includes('--probe');

// 中文宽度对齐（CJK 占 2 列）
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
function pad(s, n) {
  s = String(s);
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
}

// CDP 端口存活探测：TCP 直连，只回答"端口在不在听" —— 绕开代理与 HTTP 层的不确定性。
// （实测本机代理能正确转发环回请求，旧的 fetch 版并非失效；见文件头"不要凭印象改"。）
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

// 轮询等待 evaluate 返回真值
async function waitUntil(page, fn, arg, timeout = 20000, interval = 500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    let v = null;
    try { v = await page.evaluate(fn, arg); } catch (e) { v = null; }
    if (v) return v;
    await sleep(interval);
  }
  return null;
}

// 进页面：网络与冷启动都会抖（实测有整轮 goto 都超时的时候），故 3 次 + 递增退避。
async function gotoGrowth(page) {
  let lastErr = null;
  for (let a = 0; a < 3; a++) {
    try {
      await page.goto(GROWTH, { waitUntil: 'domcontentloaded', timeout: 30000 });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      console.error('[i] 打开页面第 ' + (a + 1) + '/3 次失败：' + String(e.message || e).split('\n')[0]);
      if (a < 2) await sleep(5000 * (a + 1));
    }
  }
  if (lastErr) throw lastErr;
  if (page.url().includes('/login')) {
    console.error('❌ 未登录。请先跑 node wb_login_once.js 扫码登录（之后浏览器保持常驻即可）。');
    process.exit(2);
  }
}

// 真实点击：Playwright 的 click 走 CDP 输入事件（isTrusted=true），
// 与「页面内 element.click() 合成事件」不是一回事。本脚本一律用它 —— 对齐 wb_auto_task.js。
async function realClick(page, locator, timeout = 8000) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ timeout });
}

// 关弹窗（真实点击关闭钮；没有就按 Esc）
async function closeModal(page) {
  const btn = page.locator('.gs-modal-close').first();
  if (await btn.count()) { await btn.click({ timeout: 5000 }).catch(() => {}); return; }
  await page.keyboard.press('Escape').catch(() => {});
}

// ── DOM 读取 ────────────────────────────────────────────────────────────
// 连登概览：天数 / 下一档提示 / 本月已兑 / 补登卡余额 / 里程碑达成情况
// ⚠️ 天数在 <b> 里 → 用 innerText；里程碑看 .is-reached
const READ_STREAK = () => {
  const q = (s) => document.querySelector(s);
  const txt = (e) => ((e && e.innerText) || '').replace(/\s+/g, ' ').trim();
  const daysEl = q('.gs-streak-days');
  const days = txt(daysEl);
  const legend = txt(q('.gs-cal-legend'));
  const mRedeem = legend.match(/已兑\s*(\d+)\s*次/);
  const mCard = legend.match(/补登卡\s*[×x]\s*(\d+)/);
  const fill = q('.gs-streak-fill');
  const milestones = [...document.querySelectorAll('.gs-streak-milestone')].map((m) => {
    const dot = m.querySelector('.gs-streak-dot');
    const lab = m.querySelector('.gs-streak-label');
    return {
      label: txt(lab),
      reached: /is-reached/.test((dot && dot.className) || '') || /is-reached/.test((lab && lab.className) || ''),
    };
  }).filter((x) => x.label);
  return {
    // ⚠️ .gs-section-title 页面里有多个（第一个是「任务」）→ 必须锚定到连登所在区块
    title: (() => {
      const row = q('.gs-streak-row');
      const sec = row && row.closest('section');
      const el = (sec && sec.querySelector('.gs-section-title')) || q('.gs-cal-headbtns .gs-section-title');
      return txt(el);
    })(),
    daysText: days,
    daysNum: (days.match(/(\d+)/) || [])[1] || null,
    sub: txt(q('.gs-streak-sub')),
    legend,
    monthRedeemed: mRedeem ? +mRedeem[1] : null,
    makeupCards: mCard ? +mCard[1] : null,
    fillPct: fill ? (fill.style.width || '') : '',
    milestones,
    hasRedeemBtn: !!q('.gs-streak-redeem'),
  };
};

// 弹窗内各档位：**只认 disabled / is-locked，不认文案**
const READ_TIERS = () => {
  const NAMES = ['入门档', '进阶档', '巅峰档'];
  return [...document.querySelectorAll('button.gs-reward-btn')].map((b, i) => {
    const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
    const cls = (typeof b.className === 'string' ? b.className : '');
    const locked = !!b.disabled || /is-locked/.test(cls);
    const claimed = /已兑换|已领取/.test(t);
    // 向上找一层拿到「档位名 + 奖励内容」作为行文本
    // 找「最紧的、只含本档一个按钮」的容器作为行元素（比按文本长度猜更稳）
    let rowEl = null, p = b.parentElement;
    while (p && p !== document.body) {
      if (p.querySelectorAll('button.gs-reward-btn').length > 1) break;
      rowEl = p;
      p = p.parentElement;
    }
    const row = rowEl ? (rowEl.innerText || '').replace(/\s+/g, ' ').trim() : '';
    const nm = row.match(/(入门档|进阶档|巅峰档)/);
    return {
      i,
      name: nm ? nm[1] : (NAMES[i] || '第' + (i + 1) + '档'),
      buttonText: t, cls: cls.slice(0, 40), disabled: !!b.disabled, locked, claimed,
      claimable: !locked && !claimed,
      // 去掉行容器里混进来的提示语（如「连登 28 天解锁奖励」），只留奖励内容
      rewards: row.replace(/(入门档|进阶档|巅峰档)/, '').replace(t, '')
        .replace(/连登\s*\d+\s*天解锁奖励/g, '').trim().slice(0, 90),
    };
  });
};

// 弹窗是否已出现（读取用，非点击）
const MODAL_OPEN = () => !!document.querySelector('.gs-modal-overlay');

// 可选佐证：同源只读接口（实测 streak / redeem-summary 可能 Failed to fetch，失败不致命）
const FETCH_STATE = async () => {
  const out = {};
  for (const [k, p] of [['streak', '/activity/growth/streak'], ['redeem', '/activity/growth/redeem/summary']]) {
    try {
      const r = await fetch(p, { credentials: 'include', headers: { 'x-client-platform': 'web' } });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      out[k] = { status: r.status, json: j, raw: j ? undefined : t.slice(0, 300) };
    } catch (e) { out[k] = { err: String(e).slice(0, 120) }; }
  }
  return out;
};

function printStreak(s) {
  console.log('\n── 活跃地图 · 连登概览 ──');
  console.log('  标题      : ' + (s.title || '—'));
  console.log('  连登天数  : ' + (s.daysText || '—') + (s.fillPct ? '   (进度条 ' + s.fillPct + ')' : ''));
  console.log('  下一档    : ' + (s.sub || '—'));
  console.log('  本月已兑  : ' + (s.monthRedeemed === null ? '—' : s.monthRedeemed + ' 次')
    + '   · 补登卡: ' + (s.makeupCards === null ? '—' : '×' + s.makeupCards));
  if (s.milestones.length) {
    // 不用 emoji 做标记：emoji 宽度算不准会让对齐错位，纯中文更稳
    const parts = s.milestones.map((m) => pad(m.label, 6) + (m.reached ? '已达成' : '未达成'));
    console.log('  里程碑    : ' + parts.join(' · '));
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────
(async () => {
  const browser = await getBrowser();
  const page = await (browser.contexts()[0] || await browser.newContext()).newPage();
  try {
    await gotoGrowth(page);
    // 等页面就绪：沿用任务行作为"已渲染"信号，再等兑换按钮出现
    await waitUntil(page, () => document.querySelectorAll('.gs-task-row').length > 0, null, 30000);
    const hasBtn = await waitUntil(page, () => !!document.querySelector('.gs-streak-redeem'), null, 20000);
    if (!hasBtn) {
      console.error('⚠️ 等不到「兑换奖励」按钮。当前 URL: ' + page.url());
      console.error('   可能原因：活动已下线 / 页面结构变了 / 该账号无此活动。');
      process.exit(1);
    }
    // 活跃地图在页面下方，滚过去
    await page.locator('.gs-streak-row').first().scrollIntoViewIfNeeded().catch(() => {});
    await sleep(1200);

    const s = await page.evaluate(READ_STREAK);
    printStreak(s);

    if (STATUS_ONLY) {
      const api = await page.evaluate(FETCH_STATE);
      console.log('\n[只读佐证] streak: ' + JSON.stringify(api.streak).slice(0, 160));
      console.log('[只读佐证] redeem: ' + JSON.stringify(api.redeem).slice(0, 160));
      console.log('\n[--status] 只读完成，未打开弹窗、未点击任何东西。');
      return;
    }

    // 打开弹窗读档位（干跑也开，只为看清状态；不点任何档位）
    // 用真实鼠标点击，不用页面内 element.click() 合成事件
    const entry = page.locator('.gs-streak-redeem').first();
    if (!(await entry.count())) { console.error('❌ 找不到 .gs-streak-redeem'); process.exit(1); }
    if (await entry.isDisabled()) { console.error('❌ 「兑换奖励」按钮当前是 disabled'); process.exit(1); }
    try { await realClick(page, entry); }
    catch (e) { console.error('❌ 点「兑换奖励」失败: ' + e.message); process.exit(1); }
    const opened = await waitUntil(page, MODAL_OPEN, null, 10000);
    if (!opened) { console.error('❌ 点开了但「选择奖励」弹窗没出现（可能文案/结构变了）'); process.exit(1); }
    await sleep(800);

    const tiers = await page.evaluate(READ_TIERS);
    if (!tiers.length) {
      console.error('❌ 弹窗里没读到 button.gs-reward-btn（结构可能变了）');
      await closeModal(page);
      process.exit(1);
    }
    console.log('\n── 选择奖励 · 档位状态 ──');
    for (const t of tiers) {
      const state = t.claimed ? '已兑换' : t.claimable ? '可领取' : '未解锁';
      console.log('  ' + pad(t.name, 10) + pad(state, 12) + pad('[' + t.buttonText + ']', 12) + (t.rewards || ''));
    }

    const claimable = tiers.filter((t) => t.claimable);

    // --probe：只验「Playwright 能不能定位并点到这些按钮」，**不触发点击**。
    // 用途：在没有可领档位时（本月已兑完 / 未解锁），仍能证明领取链路的点击机制是通的，
    // 而不是一个"从没跑过"的纸面功能。它解析 locator、读可见性/可点性/包围盒。
    if (PROBE) {
      console.log('\n── --probe 点击链路自检（不点击）──');
      for (const t of tiers) {
        const btn = page.locator('button.gs-reward-btn').nth(t.i);
        const cnt = await btn.count().catch(() => 0);
        if (!cnt) { console.log('  ✗ ' + pad(t.name, 10) + '定位不到（nth(' + t.i + ')）'); continue; }
        const vis = await btn.isVisible().catch(() => false);
        const dis = await btn.isDisabled().catch(() => true);
        const box = await btn.boundingBox().catch(() => null);
        const ok = vis && !!box && box.width > 0 && box.height > 0;
        // ⚠️ boundingBox() 返回的其实是 {x, y, width, height} 四项：x/y = 元素左上角在
        //    视口里的坐标（位置），width/height = 元素自身尺寸。两者不要混为一谈。
        //    另外：**"尺寸相同"不等于"同一个元素"** —— 同款按钮 + 同样长度的文案必然尺寸一致。
        //    （实测入门档/进阶档都是「已兑换」3 个全角字 → 尺寸都是 70x32；
        //      巅峰档文案「兑换」2 个字 → 56x32。差值 14px 正好一个字宽。）
        //    真要区分元素，看**位置 (x,y)**。
        const size = box ? Math.round(box.width) + 'x' + Math.round(box.height) : '—';
        const pos = box ? '(' + Math.round(box.x) + ',' + Math.round(box.y) + ')' : '—';
        // ⚠️ 别把「定位成功」说成「能点」：Playwright 的 click() 对 disabled 元素会**等到超时**再抛错。
        const verdict = !ok ? '定位失败 → 真点击会失败'
          : dis ? '定位正常，但 locked → 点会等到超时（--apply 跳过）'
            : '可点 → --apply 能领到';
        console.log('  ' + (ok ? '✓' : '✗') + ' ' + pad(t.name, 10)
          + '位置=' + pad(pos, 13)
          + '尺寸=' + pad(size, 9)
          + '可见=' + (vis ? '是' : '否')
          + '  可点=' + (dis ? '否(locked)' : '是')
          + '  ' + verdict);
      }
      console.log('\n[--probe] 只验可达性，未点任何按钮。「可点=是」的档位才可能被 --apply 领到。');
      await closeModal(page);
      await sleep(300);
      return;
    }

    if (!claimable.length) {
      console.log('\n→ 没有可领的档位（未解锁 / 已兑换）。');
      const locked = tiers.filter((t) => t.locked && !t.claimed);
      if (locked.length) {
        console.log('  未解锁：' + locked.map((t) => t.name).join('、') + ' —— 需连登更多天才解锁'
          + (s.daysNum ? '（当前 ' + s.daysNum + ' 天' + (s.sub ? '，' + s.sub : '') + '）' : ''));
      }
    } else if (!APPLY) {
      console.log('\n→ 干跑：有 ' + claimable.length + ' 个档位可领，但未点击。加 --apply 才真领。');
    } else {
      console.log('\n── 开始领取（真实点击）──');
      let got = 0;
      for (const t of claimable) {
        const btn = page.locator('button.gs-reward-btn').nth(t.i);
        // 真实点击前的最后一道闸：再核一次锁态（防读取之后状态变了）
        // ⚠️ 必须**同时**看 disabled 与 is-locked：Playwright 对 disabled 元素的 click()
        //    不是立即失败，而是**等到超时**——真点下去会把整个循环卡 8 秒并误报"点击失败"。
        if (!(await btn.count())) { console.log('  ✗ ' + t.name + ' 找不到按钮'); continue; }
        const lockedNow = await btn.evaluate((b) =>
          !!b.disabled || /is-locked/.test(typeof b.className === 'string' ? b.className : '')
        ).catch(() => true);
        if (lockedNow) { console.log('  ✗ ' + pad(t.name, 10) + '已 locked（不可点），跳过'); continue; }
        try { await realClick(page, btn); }
        catch (e) { console.log('  ✗ ' + t.name + ' 点击失败: ' + e.message); continue; }
        // 等按钮转为「已兑换」
        const after = await waitUntil(page, (i) => {
          const b = [...document.querySelectorAll('button.gs-reward-btn')][i];
          if (!b) return null;
          const tx = (b.innerText || '').replace(/\s+/g, ' ').trim();
          return /已兑换|已领取/.test(tx) ? tx : null;
        }, t.i, 12000);
        if (after) { console.log('  ✓ ' + pad(t.name, 10) + '已领到（按钮转为「' + after + '」）'); got++; }
        else { console.log('  ⚠️ ' + pad(t.name, 10) + '点了但按钮没转「已兑换」——请到页面确认'); }
        await sleep(900);
      }
      console.log('\n共领取 ' + got + '/' + claimable.length + ' 个档位。');
      // 收尾复核：重读连登概览（本月已兑次数应增加）
      await closeModal(page);
      await sleep(800);
      const s2 = await page.evaluate(READ_STREAK).catch(() => null);
      if (s2) {
        console.log('  领取后「本月已兑」: ' + (s2.monthRedeemed === null ? '—' : s2.monthRedeemed + ' 次')
          + '（领取前 ' + (s.monthRedeemed === null ? '—' : s.monthRedeemed + ' 次') + '）');
      }
      return;
    }

    await closeModal(page);
    await sleep(400);
  } catch (e) {
    console.error('❌ 运行异常: ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  } finally {
    await page.close().catch(() => {});
  }
})();
