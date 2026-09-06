#!/usr/bin/env node
"use strict";
/**
 * WorkBuddy Buddy 加油站 每日签到（自包含版，复用官方 workbuddy-checkin 已验证逻辑）
 *
 * 安全约定（务必遵守）：
 *   - accessToken 等同账号密码。仅本进程内存中使用，通过 fetch 直接消费，绝不打印/落盘/日志。
 *   - 日志只输出：token 长度、uid 前 6 位、HTTP 状态码、积分/连续天数。绝不输出 token 原文。
 *   - 仅请求 copilot.tencent.com 官方域名，不请求任何第三方。
 *   - 只读本机登录态文件，绝不修改 WorkBuddy 本体或登录态。
 *
 * 用法：
 *   node wb_checkin.js --status     # 只读：验证 token 可读 + 接口可达 + 今日是否已签
 *   node wb_checkin.js --checkin    # 领取（幂等：已签过返回 10001，不会重复领）
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const API = "https://copilot.tencent.com";

function mask(s, n = 6) {
  if (!s) return "(empty)";
  return s.slice(0, n) + "…(len=" + s.length + ")";
}

// 解析登录态文件候选路径（对齐官方 decrypt-token.js 的候选逻辑，主路径 LOCALAPPDATA）
function findAuthFile() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || "";
  const roaming = process.env.APPDATA || "";
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const cands = [
    local && path.join(local, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"),
    roaming && path.join(roaming, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"),
    path.join(xdg, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"),
    path.join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"),
  ].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function loadAuth() {
  const file = findAuthFile();
  if (!file) {
    return { error: "未找到登录态文件 workbuddy-desktop.info（请确认已登录 WorkBuddy 桌面端）" };
  }
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { error: "读取登录态文件失败: " + e.message };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { error: "登录态文件 JSON 解析失败: " + e.message };
  }
  // 新版明文结构：{ account, auth: { accessToken, ... }, accounts }
  const auth = json.auth || {};
  const token = auth.accessToken;
  const account = json.account || {};
  const uid = account.uid;
  if (!token) {
    return { error: "登录态中未找到 auth.accessToken（可能是旧版 state.vscdb 账户，需 Electron 解密分支）" };
  }
  return {
    file,
    token,
    uid: uid || "",
    domain: auth.domain || "",
    enterpriseId: account.enterpriseId || "",
  };
}

function authHeaders(token, uid, domain, enterpriseId) {
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: "Bearer " + token,
  };
  if (uid) h["X-User-Id"] = uid;
  if (domain) h["X-Domain"] = domain;
  if (enterpriseId) h["X-Enterprise-Id"] = enterpriseId;
  return h;
}

async function postJSON(url, token, uid, domain, enterpriseId) {
  const maxTry = 3;
  let lastErr = null;
  for (let i = 1; i <= maxTry; i++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: authHeaders(token, uid, domain, enterpriseId),
        body: "{}",
      });
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* keep text */ }
      return { status: resp.status, json, text };
    } catch (e) {
      lastErr = e;
      if (i < maxTry) {
        console.log("  ⚠️ 网络抖动（" + e.message + "），第 " + i + " 次重试…");
        await new Promise(r => setTimeout(r, 2000 * i));
      }
    }
  }
  throw lastErr || new Error("未知网络错误");
}

async function main() {
  const mode = process.argv.includes("--checkin") ? "checkin" : "status";

  const auth = loadAuth();
  if (auth.error) {
    console.log("❌ " + auth.error);
    process.exit(1);
  }
  // 仅输出脱敏信息
  console.log("✓ 登录态文件: " + auth.file);
  console.log("✓ token: " + mask(auth.token));
  console.log("✓ uid: " + mask(auth.uid));
  if (auth.domain) console.log("  domain: " + auth.domain);
  if (auth.enterpriseId) console.log("  enterpriseId: " + mask(auth.enterpriseId));

  // 1) 查状态（只读，安全）—— 用官方 checkin.sh 已验证的非 /v2/ 端点
  console.log("\n→ POST " + API + "/billing/meter/checkin-status");
  let r;
  try {
    r = await postJSON(API + "/billing/meter/checkin-status", auth.token, auth.uid, auth.domain, auth.enterpriseId);
  } catch (e) {
    console.log("❌ 状态查询网络异常: " + e.message);
    process.exit(1);
  }
  console.log("  HTTP " + r.status);
  if (r.json) {
    console.log("  body: " + JSON.stringify(r.json).slice(0, 300));
  } else {
    console.log("  body(raw): " + r.text.slice(0, 300));
  }
  if (r.status === 401 || r.status === 403) {
    console.log("❌ 令牌过期/无权限，请打开 WorkBuddy 桌面端刷新登录态后重试");
    process.exit(1);
  }
  if (r.status !== 200) {
    console.log("❌ 状态查询失败（HTTP " + r.status + "）");
    process.exit(1);
  }
  const todayCheckedIn = r.json && r.json.data && r.json.data.today_checked_in;
  console.log("  ⚠️ today_checked_in 字段在 v5.3.8 实测不可靠，仅供参考: " + todayCheckedIn);

  if (mode === "status") {
    console.log("\n[只读校验完成] 未执行领取。确认无误后加 --checkin 参数执行领取。");
    process.exit(0);
  }

  // 2) 执行领取（幂等）
  console.log("\n→ POST " + API + "/billing/meter/daily-checkin");
  let r2;
  try {
    r2 = await postJSON(API + "/billing/meter/daily-checkin", auth.token, auth.uid, auth.domain, auth.enterpriseId);
  } catch (e) {
    console.log("❌ 领取网络异常: " + e.message);
    process.exit(1);
  }
  console.log("  HTTP " + r2.status);
  if (r2.json) {
    const d = r2.json;
    if (d.code === 0) {
      const data = d.data || {};
      console.log("🎉 签到成功！credit=" + data.credit + " streak_days=" + data.streak_days);
    } else if (d.code === 10001) {
      // 服务器对"已签到"返回 HTTP 400 + code=10001，属正常幂等结果，非失败
      console.log("✅ 今日已签到（code=10001：" + (d.msg || "已签过") + "），无需重复领取");
    } else if (r2.status === 401 || r2.status === 403) {
      console.log("❌ 令牌过期/无权限（HTTP " + r2.status + "），请打开 WorkBuddy 桌面端刷新登录态后重试");
    } else {
      console.log("⚠️ 领取未成功: HTTP " + r2.status + " code=" + d.code + " msg=" + d.msg);
    }
  } else {
    console.log("  body(raw): " + (r2.text || "").slice(0, 500));
    if (r2.status === 401 || r2.status === 403) {
      console.log("❌ 令牌过期/无权限（HTTP " + r2.status + "），请打开 WorkBuddy 桌面端刷新登录态后重试");
    } else {
      console.log("⚠️ 领取请求已提交，但响应解析失败，请打开 WorkBuddy 确认结果");
    }
  }
}

main();
