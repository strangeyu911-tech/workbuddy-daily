#!/usr/bin/env node
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

"use strict";
/**
 * wb_tasks.js —— Buddy 成长中心「任务清单」（**只读**）
 *
 * 这个脚本只做一件事：把成长中心的任务清单拉下来，算清楚「每个任务还差多少」。
 * 它**不产生任何写操作** —— 只有 GET，没有 POST。领奖请走网页/桌面端 UI 点击。
 *
 * 为什么单独做成只读清单（合规边界）：
 *   成长任务的进度由服务端按**真实行为事件**点亮（真实对话、真实点击、真实连登）。
 *   本脚本只读取进度，绝不构造/补报任何行为事件，也绝不伪造客户端身份标识 ——
 *   即「不编造证据」。这样它与 wb_checkin.js 的 --status 同档：
 *   用你自己的登录态、访问官方端点、只读不写。
 *   任务怎么完成，由你本人在 UI 里真实操作（或交给 wb_auto_task.js 那套真实点击）。
 *
 * 安全约定（同 wb_checkin.js / wb_session_bridge.js）：
 *   - accessToken 仅本进程内存使用，绝不打印/落盘/日志（只输出长度与 uid 前 6 位）
 *   - 仅请求 copilot.tencent.com 官方域名，不请求任何第三方
 *   - 只读本机登录态文件，绝不修改 WorkBuddy 本体或登录态
 *
 * 用法：
 *   node wb_tasks.js            # 人类可读清单（按状态分组 + 还差多少）
 *   node wb_tasks.js --json     # 结构化输出（供自动化/面板消费）
 *   node wb_tasks.js --raw      # 打印原始响应（排障用；排查上游字段变化用）
 *   node wb_tasks.js --all      # 连已领取/已锁定的也列出（默认折叠）
 *
 * 退出码：0 成功 / 1 读登录态或网络失败 / 2 令牌过期
 */

const API = "https://copilot.tencent.com";
const TASKS_PATH = "/v2/activity/growth/tasks";

// 登录态读取复用 wb_session_bridge 已验证的逻辑，避免第三份副本
const { loadAuth } = require("./wb_session_bridge");

const ARGV = process.argv.slice(2);
const AS_JSON = ARGV.includes("--json");
const AS_RAW = ARGV.includes("--raw");
const SHOW_ALL = ARGV.includes("--all");

function mask(s, n = 6) {
  if (!s) return "(empty)";
  return s.slice(0, n) + "…(len=" + s.length + ")";
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 终端对齐：CJK 字符占 2 列，padEnd 会按 1 算导致列错位
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += WIDE.test(ch) ? 2 : 1;
  return w;
}
function pad(s, n) {
  s = String(s);
  return s + " ".repeat(Math.max(0, n - dispWidth(s)));
}

// 请求头：Bearer + 本机登录态里的身份/租户标识（与 wb_checkin.js 同一套）
function authHeaders(a) {
  const h = {
    Accept: "application/json",
    Authorization: "Bearer " + a.token,
    // 官方客户端会带这个静态标记（非指纹，仅标识"来自客户端请求"）
    "X-CodeBuddy-Request": "1",
  };
  if (a.uid) h["X-User-Id"] = a.uid;
  if (a.domain) h["X-Domain"] = a.domain;
  if (a.enterpriseId) {
    h["X-Enterprise-Id"] = a.enterpriseId;
    h["X-Tenant-Id"] = a.enterpriseId;
  }
  return h;
}

async function getJSON(url, a) {
  const maxTry = 3;
  let lastErr = null;
  for (let i = 1; i <= maxTry; i++) {
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: authHeaders(a),
        signal: AbortSignal.timeout(20000),
      });
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* keep text */ }
      return { status: resp.status, json, text };
    } catch (e) {
      lastErr = e;
      if (i < maxTry) {
        if (!AS_JSON) console.error("  ⚠️ 网络抖动（" + e.message + "），第 " + i + " 次重试…");
        await new Promise((r) => setTimeout(r, 2000 * i));
      }
    }
  }
  throw lastErr || new Error("未知网络错误");
}

// 宽松解析单条任务：progress 可能是 {current,target} 对象，也可能是平铺字段
function normalize(t) {
  const raw = t || {};
  let current = num(raw.current);
  let target = num(raw.target);
  const p = raw.progress;
  if (p && typeof p === "object") {
    const pc = num(p.current);
    const pt = num(p.target);
    if (pt > 0 || pc > 0) { current = pc; target = pt; }
  }
  const claimed = raw.accept_status === "claimed";
  const locked = !!raw.locked;
  // 有效期：上游只给部分任务（如 Expert_Philanthropy / Buddy_App_QQ）
  const validEnd = raw.valid_end || "";
  let daysLeft = null;
  if (validEnd) {
    const ms = Date.parse(validEnd) - Date.now();
    if (Number.isFinite(ms)) daysLeft = Math.ceil(ms / 86400000);
  }
  return {
    code: raw.task_code || "",
    validEnd,
    daysLeft,
    title: raw.title || "",
    taskDesc: raw.task_desc || "",
    description: raw.description || "",
    credit: num(raw.reward_credit),
    energy: num(raw.reward_energy),
    hasReward: !!raw.has_reward,
    taskType: raw.task_type || "",
    tag: raw.tag || "",
    jumpUrl: raw.jump_url || "",
    acceptStatus: raw.accept_status || "",
    status: raw.status || "",
    current,
    target,
    need: target > 0 ? Math.max(0, target - current) : 0,
    claimable: !claimed && !locked && target > 0 && current >= target,
    claimed,
    locked,
  };
}

function extractTasks(json) {
  if (!json) return null;
  const d = json.data !== undefined ? json.data : json;
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.tasks)) return d.tasks;
  if (Array.isArray(json.tasks)) return json.tasks;
  return null;
}

function progressText(t) {
  if (t.target > 0) return t.current + "/" + t.target;
  // 上游对「无计数」的一次性任务给 progress:null（不是 0，别当成 0/target）
  return "—（无计数）";
}

// 有效期提示：有 valid_end 就显示，快到期标出来
function validText(t) {
  if (!t.validEnd) return "";
  const d = t.validEnd.slice(0, 10);
  if (t.daysLeft === null) return "有效期至 " + d;
  if (t.daysLeft < 0) return "有效期至 " + d + "（已过期）";
  return "有效期至 " + d + "（剩 " + t.daysLeft + " 天）";
}

function rewardText(t) {
  const parts = [];
  if (t.credit) parts.push(t.credit + " 积分");
  if (t.energy) parts.push(t.energy + " 能量");
  if (parts.length) return parts.join(" + ");
  // black_cat 这类：has_reward=true 但 credit/energy 都是 0，奖励是活动本身的折扣
  return t.hasReward ? "活动奖励" : "-";
}

(async () => {
  const a = loadAuth();
  if (a.error) {
    console.error("❌ " + a.error);
    process.exit(1);
  }

  if (!AS_JSON) {
    console.log("✓ 登录态文件: " + a.file);
    console.log("✓ token: " + mask(a.token));
    console.log("✓ uid: " + mask(a.uid));
    console.log("\n→ GET " + API + TASKS_PATH + "   （只读，无写操作）");
  }

  let r;
  try {
    r = await getJSON(API + TASKS_PATH, a);
  } catch (e) {
    console.error("❌ 请求失败: " + e.message);
    process.exit(1);
  }

  if (AS_RAW) {
    console.log("HTTP " + r.status);
    console.log(r.json ? JSON.stringify(r.json, null, 2) : r.text);
  }

  if (r.status === 401 || r.status === 403) {
    console.error("❌ 令牌过期/无权限（HTTP " + r.status + "），请打开 WorkBuddy 桌面端刷新登录态后重试");
    process.exit(2);
  }
  if (r.status !== 200) {
    console.error("❌ HTTP " + r.status + (r.json ? " body=" + JSON.stringify(r.json).slice(0, 300) : " body=" + (r.text || "").slice(0, 300)));
    process.exit(1);
  }
  if (r.json && r.json.code !== undefined && r.json.code !== 0) {
    console.error("❌ 业务错误 code=" + r.json.code + " msg=" + (r.json.msg || ""));
    process.exit(1);
  }

  const list = extractTasks(r.json);
  if (!list) {
    console.error("❌ 响应里找不到任务数组（用 --raw 看原始结构）");
    process.exit(1);
  }

  const tasks = list.map(normalize);
  const claimable = tasks.filter((t) => t.claimable);
  const inProgress = tasks.filter((t) => !t.claimable && !t.claimed && !t.locked && t.target > 0 && t.current < t.target);
  const oneShot = tasks.filter((t) => !t.claimable && !t.claimed && !t.locked && t.target <= 0);
  const claimed = tasks.filter((t) => t.claimed);
  const locked = tasks.filter((t) => t.locked);
  const creditPending = claimable.reduce((s, t) => s + t.credit, 0);

  if (AS_JSON) {
    console.log(JSON.stringify({
      ok: true,
      total: tasks.length,
      summary: {
        claimable: claimable.length,
        claimableCredit: creditPending,
        inProgress: inProgress.length,
        oneShot: oneShot.length,
        claimed: claimed.length,
        locked: locked.length,
      },
      tasks,
    }, null, 2));
    return;
  }

  console.log("\n共 " + tasks.length + " 个任务："
    + "可领奖 " + claimable.length + "（" + creditPending + " 积分）· "
    + "计次进行中 " + inProgress.length + " · "
    + "无计数待做 " + oneShot.length + " · "
    + "已领取 " + claimed.length + " · "
    + "未解锁 " + locked.length);

  function dump(title, arr, showNeed) {
    if (!arr.length) return;
    console.log("\n── " + title + " (" + arr.length + ") ──");
    for (const t of arr) {
      const bits = ["  " + pad(t.code, 24), pad(progressText(t), 13), pad(rewardText(t), 19)];
      let line = bits.join("");
      if (showNeed && t.need > 0) line += "还差 " + t.need + " 次";
      if (t.tag) line += "  [" + t.tag + "]";
      console.log(line.trimEnd());
      if (t.title) console.log("      " + t.title);
      const v = validText(t);
      if (v) console.log("      ⏳ " + v + (t.daysLeft !== null && t.daysLeft <= 7 ? "  ← 快到期" : ""));
    }
  }

  dump("🟢 可领奖（去成长中心点「收下奖励」）", claimable, false);
  dump("🔵 计次进行中（进度只认真实操作，本脚本不会推进它）", inProgress, true);
  dump("🟡 无计数待做（在客户端里真实操作即点亮）", oneShot, false);
  if (SHOW_ALL) {
    dump("✅ 已领取（上游 accept_status=claimed）", claimed, false);
    dump("🔒 未解锁", locked, false);
  } else if (claimed.length || locked.length) {
    console.log("\n（已领取 " + claimed.length + " · 未解锁 " + locked.length + " 项已折叠，加 --all 查看）");
  }

  console.log("\n提示：本脚本只读。进度不会因运行它而变化 —— 达标要去真实操作。");
})().catch((e) => {
  console.error("ERR " + ((e && e.stack) || e));
  process.exit(1);
});
