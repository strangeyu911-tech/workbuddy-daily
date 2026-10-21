# INSTALL.md — 给安装者的 WorkBuddy 的操作手册

> 本文件写给**正在帮忙安装的 AI 助手（WorkBuddy）**，不是写给人的说明书。
> 人类只需要做一件事：在自动弹出的 Edge 窗口里登录一次。其余全部由你完成。
> **不要**让用户手动敲命令、**不要**让用户双击 `.bat`、**不要**替用户扫码。

---

## 0. 拿到代码，放到稳定目录

仓库地址（国内直连，免梯）：<https://gitee.com/strange_touchannel/workbuddy-daily>
GitHub 镜像：<https://github.com/strangeyu911-tech/workbuddy-daily>

**这一步由你（AI）完成，不要让用户碰 git、也不要让用户去网页点下载。** 优先 clone：

```bash
git clone https://gitee.com/strange_touchannel/workbuddy-daily.git workbuddy-daily
cd workbuddy-daily
```

环境里没有 git，就你自己下载 ZIP 并解压（同样不麻烦用户）：

```bash
curl -L -o wbd.zip "https://gitee.com/strange_touchannel/workbuddy-daily/repository/archive/main.zip"
tar -xf wbd.zip          # Windows 10+ 自带 tar；或用 PowerShell: Expand-Archive wbd.zip -DestinationPath .
cd workbuddy-daily       # 解压出的目录名以实际为准
```

⚠️ **不要放临时目录**（如 `%TEMP%`、下载文件夹）—— 登录态要长期留在 `wb_auto_profile_edge/` 里，
放临时目录迟早被清理。记住最终的**绝对路径**，第 5 步建自动化要用。

## 1. 环境检测

```bash
node -v
```

- 需要 **Node ≥ 22**（脚本依赖原生 `fetch`）。版本不够或没装 → **由你执行安装**
  （`winget install OpenJS.NodeJS.LTS`，或官网 <https://nodejs.org> 下 LTS）；
  需要管理员确认（UAC）时，明确指示用户运行哪一条命令，不要让他自己琢磨。
  **装完必须新开终端**再验证一次 `node -v`。
- 确认路径解析：`node wb_paths.js`。它会打印 edge / profile / playwright / node 的解析结果。
  此时 playwright 一栏显示「✗ 未找到」是正常的，下一步装。
- Edge 浏览器：脚本会自动探测，Windows 上通常已预装。

## 2. 装依赖

在仓库目录执行：

```bash
npm i playwright-core
```

- 国内下载慢可先切镜像：`npm config set registry https://registry.npmmirror.com`
- **只装 `playwright-core`**（CDP 客户端，不下载浏览器）。不要装完整的 `playwright`
  （会顺带下载一整套 Chromium/Firefox/WebKit，几百 MB，本项目用不上——浏览器用的是 Edge）。

## 3. 登录（唯一需要用户动手的一步）

```bash
node wb_login_once.js --timeout=15
```

- 脚本会拉起一个**独立的 Edge 窗口**（专用 profile，端口 9223）并打开 WorkBuddy 登录页，最多等 15 分钟。
- **你要做的**：告诉用户「独立 Edge 窗口已弹出，请在窗口里的登录页完成登录
  （微信扫码，或账号密码——以页面实际支持的方式为准）」，然后等待脚本输出登录成功。
- **不要替用户扫码，也不要把这步改成静默/跳过**：workbuddy.cn 的登录 cookie 受
  App-Bound Encryption（ABE）保护，只能由这个 Edge 实例自己生成，任何拷贝、注入、
  复用其他浏览器登录态的做法都实测无效（详见 README「为什么不复用你已有的浏览器登录态」）。
- 登录成功后**不要关闭这个 Edge 窗口**：SSO 会话是浏览器会话级的，进程一关就焚。
  脚本本身也不会关它（保持常驻，供每日任务复用）。

## 4. 立即验证

```bash
node wb_login_then_run.js
```

单进程编排器：确保常驻 Edge → 检查/建立登录态 → 在同一个常驻会话里依次跑
「派猫 → 签到」，打印结果。

判据：

- `login:true` 且 `catTravel` 以 `dispatched` 开头 → 派遣成功
- `catTravel` 以 `already-traveling` / `already-dispatched-today` 开头 → 猫在旅行中 / 今日已派，跳过（合理）
- 签到输出含 `code=0` 且出现 `credit` / `streak_days` → 领取成功
- 签到输出含 `code=10001`（今天已签到）→ 幂等，算成功
- 任一失败 → 查第 6 节兜底表，**不要反复重跑**（脚本自带最多 3 轮重试，复跑不会解决登录态问题）

## 5. 设为每日自动化

**优先由你直接为用户创建定时自动化**（把 `<HH:MM>`、`<仓库绝对路径>` 替换成实际值）。
若你的环境不支持代建自动化，再把下面的话术交给用户，让他复制给自己的 WorkBuddy：

> 每天 <HH:MM> 依次执行两步：① `cd <仓库绝对路径> && node wb_checkin.js --checkin`
> （Buddy 加油站签到）；② `cd <仓库绝对路径> && node wb_auto_task.js`（派猫猫旅行，输出 JSON）。
> 判定：签到含 code=0 且出现 credit/streak_days → 成功；code=10001 → 今日已签（算成功）；
> 页面跳 /login、401/403、连续网络失败 → 登录态失效，运行
> `node wb_login_once.js --timeout=15` 打开登录窗并提醒我扫码，检测到登录成功后自动补跑两步。
> 派猫 login:true 且 catTravel 以 dispatched 开头 → 成功；
> already-traveling / already-dispatched-today → 跳过（合理）；
> login:false → 同上，开登录窗等我扫码。
> 汇报时严禁输出任何 token / accessToken。

脚本本身**不含任何定时逻辑**——几点跑完全由用户的自动化配置决定，这是刻意设计。

## 6. 故障兜底

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `找不到 playwright-core` | 依赖没装 | 回第 2 步 `npm i playwright-core` |
| `login:false` / 签到跳 `/login` | 常驻 Edge 被关过（重启 / 手动关窗），会话 cookie 焚毁 | `node wb_login_once.js --timeout=15` 重新扫码；成功后 `node wb_login_then_run.js` 验证 |
| 9223 端口被异常占用 | 上次异常退出留了僵局 | `node wb_login_once.js --kill` 关掉常驻 Edge 后重来 |
| 派猫连续 3 轮 `no-travel-button` / `click-failed` | SPA 渲染抖动叠加页面扰动（罕见） | 空闲时手动复跑一次 `node wb_auto_task.js`；仍不行则保留现场反馈给维护者 |
| 想彻底重来 | —— | `node wb_login_once.js --fresh`（自动备份旧 profile 后全新登录） |

## 7. 给 AI 的纪律（必读）

- **不要替用户扫码**，也不要把登录改成"静默"或"跳过验证"——ABE 决定了这是唯一可行且唯一诚实的路径。
- **不要把 `wb_auto_profile_edge/` 目录拷贝、打包、外发**：里面是真实登录 cookie，等同账号密码；
  且受 ABE 保护，拷给别人也无法解密，没有任何意义。
- **不要修改脚本的判定逻辑**。尤其是「结果强校验」「轮询等元素代替固定 sleep」「异常不吞」
  这些是踩坑换来的，改坏了会出现"假成功"。
- 所有脚本只请求 `www.workbuddy.cn` 官方域名，日志不允许出现 token。
- 改动仓库文件前先 `git status`；`local.config.js` 是用户本机路径覆盖（已 gitignore），不要动它。
- 完成后向用户汇报时**严禁输出任何 token / accessToken 原文**。
