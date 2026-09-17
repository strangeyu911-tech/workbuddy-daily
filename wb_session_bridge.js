#!/usr/bin/env node
"use strict";
/**
 * wb_session_bridge.js —— WorkBuddy「token → 网站会话」静默桥（零扫码核心）
 *
 * 原理：
 *   桌面端打开成长计划等官网页面时，并不要求用户重新登录 —— 它用自己存的长期令牌
 *   换一份新的网站会话，再打开目标页。本模块走同一条路：
 *     1) 用长期令牌申请一张一次性、短时效的凭证
 *     2) 让浏览器带着该凭证访问一次官网入口，由服务端下发会话 cookie 并 302 到目标页
 *   会话 cookie 是会话级的，但只要在每次任务前（或 login:false 时）重放一遍，
 *   就永不依赖「进程活着」，重启/关窗后照样自动恢复，零扫码。
 *   端点与参数在本文件下方的实现里直接使用，不在文档/注释中重复记录。
 *
 * 安全约定（同 wb_checkin.js）：
 *   - accessToken 仅本进程内存使用，绝不打印/落盘/日志（只输出长度与 uid 前 6 位）
 *   - deviceCode 是一次性短时效码，日志中打码
 *   - 仅请求 copilot.tencent.com / workbuddy.cn 官方域名
 *
 * 用法：
 *   const bridge = require('./wb_session_bridge');
 *   const url = await bridge.getClientLoginUrl('/profile/growth-center');  // 供 page.goto
 *   // 或 CLI 自测：
 *   node wb_session_bridge.js --test     # 拿 deviceCode + 手动跟随重定向链验证 Set-Cookie
 *   node wb_session_bridge.js --url      # 只打印 client-login URL（target 默认成长中心）
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const API = "https://copilot.tencent.com";
const WEBSITE = "https://www.workbuddy.cn";
const CLIENT_LOGIN_PATH = "/console/client-login";
const DEFAULT_TARGET = "/profile/growth-center";

function mask(s, n = 6) {
  if (!s) return "(empty)";
  return s.slice(0, n) + "…(len=" + s.length + ")";
}

// ---- 登录态读取（对齐 wb_checkin.js 已验证逻辑）----
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
  if (!file) return { error: "未找到登录态文件 workbuddy-desktop.info" };
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { error: "登录态文件解析失败: " + e.message };
  }
  const auth = json.auth || {};
  const token = auth.accessToken;
  if (!token) return { error: "登录态中未找到 auth.accessToken" };
  return {
    file,
    token,
    refreshToken: auth.refreshToken || "",
    uid: (json.account || {}).uid || "",
    domain: auth.domain || "",
    enterpriseId: (json.account || {}).enterpriseId || "",
  };
}

// 请求头：Bearer 鉴权 + 从本机登录态结构里读到的身份/租户标识（有则带）。
function authHeaders(a) {
  const h = { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + a.token };
  if (a.uid) h["X-User-Id"] = a.uid;
  if (a.domain) h["X-Domain"] = a.domain;
  if (a.enterpriseId) { h["X-Enterprise-Id"] = a.enterpriseId; h["X-Tenant-Id"] = a.enterpriseId; }
  if (a.refreshToken) h["X-Refresh-Token"] = a.refreshToken;
  return h;
}

// ---- 核心：拿一次性 deviceCode ----
async function getDeviceCode(log = console.error) {
  const a = loadAuth();
  if (a.error) throw new Error(a.error);
  log("[bridge] token " + mask(a.token) + " uid " + mask(a.uid));
  const resp = await fetch(API + "/v2/plugin/device/auth/code", {
    method: "POST",
    headers: authHeaders(a),
    body: "{}",
    signal: AbortSignal.timeout(15000),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  if (resp.status === 401 || resp.status === 403) {
    throw new Error("桌面端令牌已过期（HTTP " + resp.status + "），请打开 WorkBuddy 桌面端刷新登录态");
  }
  if (!resp.ok) {
    throw new Error("deviceCode 签发失败 HTTP " + resp.status + ": " + text.slice(0, 200));
  }
  const payload = (json && (json.data || json)) || {};
  if (!payload.deviceCode) {
    throw new Error("deviceCode 为空: code=" + (json && json.code) + " msg=" + (json && json.msg));
  }
  log("[bridge] deviceCode 已签发 " + mask(payload.deviceCode, 4) + " expiresIn=" + (payload.expiresIn || "?"));
  return payload.deviceCode;
}

// ---- 核心：拼 client-login 桥 URL（浏览器访问它即完成换会话 + 302 到 target）----
async function getClientLoginUrl(target = DEFAULT_TARGET, log = console.error) {
  const code = await getDeviceCode(log);
  const u = new URL(CLIENT_LOGIN_PATH, WEBSITE);
  u.searchParams.set("code", code);
  u.searchParams.set("target", target);
  return u.toString();
}

// ---- CLI 自测：手动跟随重定向链，验证会话 cookie 确实被签发 ----
async function selfTest() {
  try {
    const url = await getClientLoginUrl(DEFAULT_TARGET);
    console.log("[bridge] client-login URL 构造成功（已打码）");
    // redirect: manual 逐跳跟随，检查每一跳的 Set-Cookie
    let cur = url;
    const jar = [];
    for (let hop = 0; hop < 8; hop++) {
      const r = await fetch(cur, { redirect: "manual", signal: AbortSignal.timeout(20000) });
      const setCookies = [];
      r.headers.forEach((v, k) => { if (k.toLowerCase() === "set-cookie") setCookies.push(v); });
      const names = setCookies.map(c => c.split("=")[0]).join(",") || "-";
      console.log("hop" + hop + ": " + r.status + " " + new URL(cur).host + new URL(cur).pathname + "  set-cookie: " + names);
      for (const c of setCookies) jar.push(c.split(";")[0]);
      const loc = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && loc) {
        cur = new URL(loc, cur).toString();
        continue;
      }
      // 最后一跳：带 cookie 再请求一次 target，看是否 200（未再被踢去 /login）
      const check = await fetch(new URL(DEFAULT_TARGET, WEBSITE).toString(), {
        redirect: "manual",
        headers: { Cookie: jar.join("; ") },
        signal: AbortSignal.timeout(20000),
      });
      const finalUrl = check.headers.get("location") || "(200 直接返回)";
      const ok = !/login/i.test(finalUrl);
      console.log("带会话 cookie 访问 target → HTTP " + check.status + " → " + finalUrl + (ok ? "  ✅ 会话有效" : "  ❌ 仍被踢去登录"));
      process.exit(ok ? 0 : 2);
    }
    console.log("❌ 重定向超过 8 跳未收敛");
    process.exit(2);
  } catch (e) {
    console.log("❌ " + e.message);
    process.exit(1);
  }
}

if (require.main === module) {
  if (process.argv.includes("--test")) selfTest();
  else if (process.argv.includes("--url")) getClientLoginUrl().then(u => console.log(u)).catch(e => { console.log("❌ " + e.message); process.exit(1); });
  else console.log("用法: node wb_session_bridge.js --test | --url");
}

module.exports = { getDeviceCode, getClientLoginUrl, loadAuth, WEBSITE, CLIENT_LOGIN_PATH, DEFAULT_TARGET };
