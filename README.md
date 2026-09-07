# WorkBuddy Daily 🐱

每天 19:00 自动完成两件事：**Buddy 加油站签到** + **派猫猫去旅行**。

## 两个任务

| 步骤 | 脚本 | 原理 | 稳定性 |
| --- | --- | --- | --- |
| ① 加油站签到 | `wb_checkin.js --checkin` | 纯 API。读取本机桌面端登录态，直接调腾讯官方签到接口 | 稳定，免维护，幂等 |
| ② 派猫猫旅行 | `wb_auto_task.js` | Playwright 驱动 Edge（专用 profile）点击成长中心的「派猫猫旅行」 | 登录态会过期，过期需重登 |

## 用法

> ### ⭐ 推荐用法：让 WorkBuddy 自己搞定
>
> 不用你记命令、也不用手动配调度。把这段话直接甩给 WorkBuddy：
>
> > 帮我装上 WorkBuddy Daily（这个仓库），把 **WorkBuddy 客户端设置为开机自启**，
> > 并把 **自动签到**（`wb_checkin.js --checkin`）和 **自动派猫**（`wb_auto_task.js`）
> > **设置为定时自动化任务**，每天到点自己跑。
>
> 它会替你完成：装依赖 → 导入 `disable_edge_abe.reg` → 登录一次 → 建自动化任务。
> 配完之后唯一要你自己做的事就是**保持客户端开机自启**，剩下的每天全自动：到点签到领积分、派猫猫去旅行。
> 中途登录态过期了，就再跟它说一句「猫派不出去了，重新登录一下」。

### 手动运行

```bash
# ① 签到（--status 只查询不领取，--checkin 才真正领取）
node wb_checkin.js --checkin

# ② 派猫猫旅行（输出 JSON）
node wb_auto_task.js
```

不想敲命令可以双击（会自动切到脚本目录并调用正确的 node）：

| 双击 | 作用 |
| --- | --- |
| `run_login.bat` | 登录一次 —— 登录态过期、派猫报 `login:false` 时用它 |
| `run_cat.bat` | 派猫猫旅行 |

### 签到结果判定
- `code=0` 且出现 `credit` / `streak_days` → 领取成功
- `code=10001`（今天已签到）→ 幂等，无需重复，视为成功
- `401/403` 或连续网络失败 → 登录态过期，打开 WorkBuddy 桌面端刷新即可

### 派猫结果判定
- `login:true` + `catTravel` 以 `dispatched` 开头 → 派遣成功
- `already-traveling` → 猫还在旅行中，跳过
- `login:false` → Edge 专用 profile 登录态过期 → 跑一次 `node wb_login_once.js` 重新登录

## 首次部署

> 走了上面的「推荐用法」的话，这三步 WorkBuddy 已经替你跑完了，这里只是留档说明每一步在做什么。

1. 装依赖（Playwright core，走本地 playwright-core，无需下载浏览器）：
   ```bash
   npm i playwright-core
   ```
2. 关闭 Edge 的 App-Bound Encryption（否则自动化读不到 cookie）：
   双击导入 `disable_edge_abe.reg`，重启电脑。
3. 登录一次：
   ```bash
   node wb_login_once.js
   ```
   在弹出的 Edge 窗口里登录 www.workbuddy.cn，然后关掉窗口。登录态会落到 `wb_auto_profile_edge/`。

## 设计要点 / 踩过的坑

- **派猫必须点二次确认框**。主按钮点完会弹「确定派出」，不点这个确认框服务端不会真正派遣 —— 早期版本漏了这步导致"假成功"。脚本现在会点击后复核按钮是否切到「旅行中/倒计时」才算真成功。
- **礼物态要先领再派**。猫回家后按钮变成「领取礼物」，需先领奖励、刷新页面，按钮才会回到「派猫猫旅行」。
- **SPA 渲染会延迟**。`getTravelBtn` 轮询最多 25s 等按钮出现，否则会误判 `no-travel-button`。
- **加油站签到是桌面端专属 + 服务端门控**，web 自动化和客户端 CDP 都够不着，所以拆成独立的纯 API 脚本。

## 安全说明 🔒

- `accessToken` 等同账号密码。脚本只在内存里使用、直接通过 `fetch` 消费，**绝不打印原文、绝不落盘**（日志只输出 token 长度和 uid 前 6 位）。
- 只请求 `copilot.tencent.com` 官方域名，无第三方。
- `wb_auto_profile_edge/` 是浏览器 profile，**含真实登录 cookie，已在 `.gitignore` 中排除，切勿提交**。
- 只读本机登录态文件，不修改 WorkBuddy 本体。

## 环境

- Windows + Edge（macOS / Linux 也能跑，路径会自动探测）
- Node 22+（`fetch` 原生可用）
- `playwright-core`（`npm i playwright-core`）

### 路径是自动探测的

机器相关的路径 —— Edge 可执行文件、浏览器 profile、playwright-core、node.exe ——
全部由 [`wb_paths.js`](wb_paths.js) 自动探测，**仓库里不写死任何本机路径**，clone 下来就能跑。

优先级（高 → 低）：

| 级别 | 方式 | 说明 |
| --- | --- | --- |
| 1 | 环境变量 `WB_EDGE` / `WB_PROFILE` / `WB_PLAYWRIGHT` / `WB_NODE` | 临时改一次用 |
| 2 | `local.config.js` | **不提交**（已 gitignore），从 `local.config.example.js` 复制。想永久钉死自己的路径就写这儿 |
| 3 | 自动探测 | 按平台枚举常见安装位置，找不到再退到 PATH |

换机器后想确认探测得对不对：

```bash
node wb_paths.js     # 打印 edge / profile / playwright / node 的最终解析结果
```
