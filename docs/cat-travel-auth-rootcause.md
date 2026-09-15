# 派猫登录态根因（已用 cookie 数据证实）

> 结论先行：你说得对——「关浏览器/重启都不用重新扫码」是真实存在的，但不是靠 cookie 持久化，
> 而是桌面端**每次打开成长计划时，用自己存的长期 token 静默换了一份网站会话**。我们的脚本绕开了
> 这步，所以只能靠保活进程，进程一死就要重扫。

## 证据（node:sqlite 实读两个 profile 的 Cookies）

决定登录状态的是 Keycloak 会话 cookie：`AUTH_SESSION_ID`、`KEYCLOAK_IDENTITY`、`KEYCLOAK_SESSION` 等。

- 桌面端自己的 Electron profile：`AppData\Roaming\WorkBuddy\Default\Network\Cookies`
  - `AUTH_SESSION_ID` → `has_expires=0`、**httpOnly**、secure → **会话级 cookie**，只活在浏览器进程内存里
- 我们自动化的专用 profile：`wb_auto_profile_edge\Default\Network\Cookies`
  - `AUTH_SESSION_ID` → 同样 `has_expires=0`、`httpOnly`

会话级 cookie 的特性：**浏览器进程一关就被焚掉**。所以「登录态」本质是「进程在不在」：
- 进程在 → 永不过期（之前连续多天成功，正是因为那个专用 Edge 一直开着没被关）
- 进程没（关窗/重启/崩溃）→ 立刻 `login:false`

这推翻了「cookie 落盘持久」的假设——**两个 profile 的鉴权 cookie 都是会话级，磁盘上没有长期登录态**。

## 那桌面端为什么能免扫码

桌面端持有长期 token（就是 `workbuddy-desktop.info` 里的 `auth.accessToken`，和每日签到用的是同一个），
打开成长计划时用它在后台**静默换出**一份 workbuddy.cn 网站会话（同源 Keycloak IdP 的 SSO）。
对你而言这步无感，所以你从没看到登录页、也从不扫码。重启电脑后桌面端重新静默换一次，依旧无感。

## 为什么我们的脚本每次重启要扫码

`wb_auto_task.js` 走的是：专用 Edge profile + 手动 Keycloak 扫码登录，**没有接入桌面端的「token 静默换会话」通道**。
所以只能靠「让专用 Edge 一直开着」来保活；一旦关窗/重启，会话随进程消失，下次就只能再扫。

## 真正能「永不扫码」的修法

复刻桌面端的静默换会话，写进 `wb_auto_task.js`：
导航成长中心之前，先用 `workbuddy-desktop.info` 的 token 调桌面端内部那个「换网站会话」的端点，
拿到会话 cookie 再 `goto` → 任意重启都自动恢复，零扫码。

- **难点**：那个端点藏在桌面端 minified 主程序里（本机 asar 抽取还卡在一个无关的 `OpenConsole.exe` 上），
  需要再抓一次（网络抓包看桌面端打开成长计划时的请求，或读 `main` 包）才能拿到准确的 URL/参数。
- **备选稳健方案**：直接 attach 到桌面端常驻的那个浏览器（它自己维持会话）；
  但桌面端默认不开 CDP 调试口，需要另想办法拉起/挂载。

## 现状（已落地）

自动化已升级为：19:00 发现 `login:false` → 自动开登录窗 + 发消息提醒扫码 → 19:25 补派兜底。
即「重启后最多扫一次」，不用手动记着去派。

## 下一步（待拍板）

1. **抓端点彻底修**（推荐）：定位桌面端「token→session」端点，写进脚本，做到真正零扫码；
2. **接受现状**：保留「登录失败自动开窗+提醒扫一次」的兜底。

---

## ✅ 已修复（2026-09-15，方案 1 落地：彻底零扫码）

不用抓包——直接从本机桌面端 asar（`AppData\Local\Programs\WorkBuddy\resources\app.asar`，297MB）
把主进程（main/）和 renderer 抽出来逆向，端点全找到了：

### 端点链路（全部实测验证）

1. **签发一次性 deviceCode**（有效期 300s）：
   `POST https://copilot.tencent.com/v2/plugin/device/auth/code`
   头必须带 `Authorization: Bearer <accessToken>` **+ `X-Refresh-Token: <refreshToken>`**
   （漏 X-Refresh-Token 会 401；这就是 `buildAuthHeaders(true,true,true)` 第三参的用途）
   响应：`{ code:0, data:{ deviceCode, expiresIn } }`
2. **浏览器访问桥 URL 换会话**（302 种 cookie，关键一步必须在浏览器里做）：
   `https://www.workbuddy.cn/console/client-login?code=<deviceCode>&target=/profile/growth-center`
   → 302（Set-Cookie: `session`）→ 200 回到成长中心

来源依据（asar 内）：
- `renderer/assets/ui-docs-viewer-*.js` → `open-web-with-login.ts`：
  `CLIENT_LOGIN_PATH="/console/client-login"`、`getWebsiteOrigin()="https://www.workbuddy.cn"`、
  `buildClientLoginUrl`: `?code=<deviceCode>&target=<target>`
- `main/server.js` → `ClawService.wechatMpCreateDeviceAuthCode`：deviceCode 签发端点
- `main/common.js` → `AuthenticationManager.buildAuthHeaders`：头集合
  （X-User-Id / Authorization / X-Enterprise-Id / X-Tenant-Id / X-Domain / X-Refresh-Token）

### 落地改动

- 新增 `wb_session_bridge.js`：token 读取（同 wb_checkin.js 路径）+ deviceCode 签发 + 桥 URL 构造，
  带 `--test`（HTTP 层验证重定向链）和 `--url` 自测模式；token/refreshToken 全程不落日志。
- `wb_auto_task.js` 升级 v3：进入成长中心若落到 `/login`，先走桥静默换会话再继续任务；
  桥失败才落回 `wb_login_once.js` 扫码兜底。

### 验证（2026-09-15 00:50，真实环境）

`test_bridge_repair.js`：拉起常驻 Edge → `clearCookies()` 把会话 cookie 清到 0（比重启更彻底）
→ 跑 `wb_auto_task.js` → 日志确认「SSO 会话失效，走 client-login 桥静默换会话」→
deviceCode 签发（len=36, expiresIn=300）→ `login:true` → 任务正常执行（猫旅行倒计时中）。
**全程零扫码、零人工。**

### 遗留边界

- 桥依赖桌面端令牌（accessToken 有效期约 60 天，refreshToken 约 90 天）。
  若长期不开桌面端导致两者都过期，桥会报 401 → 仍落回扫码兜底（登录一次即恢复）。
- 今日 19:00 的自动化无需改动：`wb_auto_task.js` 内部已自带修复，`login:false` 分支不会再走到。
