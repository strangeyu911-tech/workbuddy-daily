"use strict";
/**
 * 本地路径覆盖模板 —— 复制为 local.config.js 后生效（local.config.js 已 gitignore）
 *
 * 一般情况下**不需要**这个文件：wb_paths.js 会自动探测 Edge / profile / playwright。
 * 只有自动探测猜错、或你想把 profile 放到仓库目录以外时，才需要它。
 *
 *   cp local.config.example.js local.config.js
 *
 * 优先级：环境变量（WB_EDGE / WB_PROFILE / WB_PLAYWRIGHT / WB_NODE）> 本文件 > 自动探测
 */
module.exports = {
  // Edge 可执行文件（不填则自动探测）
  // edge: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",

  // 浏览器专用 profile 目录（不填则用仓库目录下的 wb_auto_profile_edge）
  // profile: "C:/path/to/wb_auto_profile_edge",

  // playwright-core 模块路径（不填则先找 node_modules，再找 WorkBuddy 托管 workspace）
  // playwright: "C:/path/to/node_modules/playwright-core",

  // node.exe 路径（仅供 .bat 参考，不填则用 PATH 里的 node）
  // node: "C:/Program Files/nodejs/node.exe",
};
