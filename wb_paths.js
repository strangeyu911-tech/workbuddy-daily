"use strict";
/**
 * 路径自动探测（wb_paths.js）
 *
 * 目标：仓库里的代码不写死任何机器专属路径，clone 下来就能跑；
 *      同时本机可以保留自己的写死路径（放在 gitignore 的 local.config.js 里）。
 *
 * 优先级（高 → 低）：
 *   1. 环境变量        WB_EDGE / WB_PROFILE / WB_PLAYWRIGHT / WB_NODE
 *   2. 本地覆盖        local.config.js（**不提交**，见 local.config.example.js）
 *   3. 自动探测        按平台枚举常见安装位置
 *   4. PATH 兜底       交给系统自己找
 *
 * 用法：
 *   const P = require('./wb_paths');
 *   const EDGE      = P.edge();          // msedge.exe 绝对路径
 *   const PROFILE   = P.profile();       // 浏览器专用 profile 目录
 *   const { chromium } = P.playwright(); // playwright-core 模块
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = __dirname;
const HOME = os.homedir();
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// ---------------------------------------------------------------- 本地覆盖
// local.config.js 只在开发者本机存在（已 gitignore），用于钉死本机路径。
// 仓库里提交的是 local.config.example.js 模板。
function loadLocalOverride() {
  const f = path.join(ROOT, "local.config.js");
  try {
    if (fs.existsSync(f)) {
      const cfg = require(f);
      if (cfg && typeof cfg === "object") return cfg;
    }
  } catch (e) {
    console.error("[paths] local.config.js 加载失败，忽略: " + e.message);
  }
  return {};
}

const LOCAL = loadLocalOverride();
const env = (k) => (process.env[k] || "").trim();
const exists = (p) => {
  try {
    return !!p && fs.existsSync(p);
  } catch (e) {
    return false;
  }
};

// ---------------------------------------------------------------- Edge
function edgeCandidates() {
  if (IS_WIN) {
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const pf64 = process.env.ProgramFiles || "C:\\Program Files";
    const la = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
    return [
      path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf64, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(la, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
  }
  if (IS_MAC) {
    return [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      path.join(HOME, "Applications", "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"),
    ];
  }
  return [
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/microsoft-edge",
    "/opt/microsoft/msedge/msedge",
  ];
}

function edge() {
  const cands = [env("WB_EDGE"), LOCAL.edge].concat(edgeCandidates()).filter(Boolean);
  for (const c of cands) if (exists(c)) return c;
  // 全都没命中：返回第一个候选（报错信息更好读），Windows 上再退到裸命令交给 PATH
  return IS_WIN ? "msedge" : cands[0] || "microsoft-edge";
}

// ---------------------------------------------------------------- Profile
// 默认就放在仓库目录下的 wb_auto_profile_edge（已被 .gitignore 排除）
function profile() {
  return env("WB_PROFILE") || LOCAL.profile || path.join(ROOT, "wb_auto_profile_edge");
}

// ---------------------------------------------------------------- Playwright
// 返回可用的模块标识（绝对路径 / 包名），找不到返回 null
function playwrightId() {
  // 1) 显式指定（环境变量 / local.config.js）
  const custom = [env("WB_PLAYWRIGHT"), LOCAL.playwright].filter(Boolean);
  for (const id of custom) {
    if (exists(id)) return id;
    try {
      require.resolve(id);
      return id;
    } catch (e) {
      /* 继续往下找 */
    }
  }
  // 2) 常规依赖（npm i playwright-core）
  try {
    require.resolve("playwright-core");
    return "playwright-core";
  } catch (e) {
    /* 继续 */
  }
  // 3) WorkBuddy 托管 node 的全局 workspace（本机常见装法）
  const wsp = path.join(HOME, ".workbuddy", "binaries", "node", "workspace", "node_modules", "playwright-core");
  if (exists(wsp)) return wsp;
  return null;
}

function playwright() {
  const id = playwrightId();
  if (!id) {
    throw new Error(
      "找不到 playwright-core。请先在项目目录执行 `npm i playwright-core`，" +
        "或用 WB_PLAYWRIGHT=<模块绝对路径> 指定（local.config.js 里配 playwright 亦可）。"
    );
  }
  return require(id);
}

// ---------------------------------------------------------------- Node
// 给 .bat 之类的外部脚本用：返回建议的 node.exe 路径（可能为空）
function node() {
  const cands = [env("WB_NODE"), LOCAL.node].filter(Boolean);
  for (const c of cands) if (exists(c)) return c;
  if (exists(process.execPath) && process.execPath.toLowerCase().endsWith("node.exe")) return process.execPath;
  return "";
}

// ---------------------------------------------------------------- 自检
// node wb_paths.js  → 打印解析结果，方便换机器后排查
function describe() {
  const id = playwrightId();
  let pw;
  if (!id) {
    pw = "✗ 未找到 —— 执行 npm i playwright-core";
  } else {
    try {
      pw = require.resolve(id);
    } catch (e) {
      pw = "✗ " + id + " 解析失败: " + e.message;
    }
  }
  return {
    platform: process.platform,
    edge: edge() + (exists(edge()) ? "" : "   ⚠️ 文件不存在"),
    profile: profile() + (exists(profile()) ? "  (已存在)" : "  (尚未创建)"),
    playwright: pw,
    node: node() || "(未在配置中指定，将使用 PATH 里的 node)",
    override: fs.existsSync(path.join(ROOT, "local.config.js")) ? "local.config.js 已生效" : "无 local.config.js，走自动探测",
  };
}

module.exports = { edge, profile, playwright, playwrightId, node, describe, ROOT, LOCAL };

if (require.main === module) {
  console.log(JSON.stringify(describe(), null, 2));
}
