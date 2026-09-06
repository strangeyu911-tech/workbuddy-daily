// 路线2 · 一次性登录引导器（Edge 版）
// 用「专用自动化 profile」启动真实 Edge（有界面），打开登录页，
// 你扫码/输密码登录一次 www.workbuddy.cn 后，直接关闭该窗口即可。
// 登录态会落入 wb_auto_profile_edge，之后每日任务自动复用，无需再登录。
// 注：本机网络需经梯子/系统代理才能访问外网，故不强制 --no-proxy-server，
//     让 Edge 沿用系统默认代理即可联网。若日后想直连，可加 '--no-proxy-server'。
const { spawn } = require('child_process');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = 'C:/Users/23159/WorkBuddy/2026-08-15-22-57-14/wb_auto_profile_edge';
const LOGIN = 'https://www.workbuddy.cn/login/?platform=usercenter&redirect_uri=https%3A%2F%2Fwww.workbuddy.cn%2Fprofile%2Fgrowth-center';

const child = spawn(EDGE, ['--user-data-dir=' + PROFILE, '--no-first-run', '--new-window', LOGIN], {
  detached: true, stdio: 'ignore'
});
child.unref();

console.log('✅ 已用「专用自动化 profile」启动 Edge，请完成 www.workbuddy.cn 登录：');
console.log('   1) 在打开的窗口里扫码 / 输手机号邮箱登录');
console.log('   2) 登录成功后，直接关闭这个 Edge 窗口即可');
console.log('   3) 登录态已保存到：');
console.log('      ' + PROFILE);
console.log('   之后每天 19:00 的自动化会用同一 profile 自动签到 + 派猫，无需再手动登录。');
console.log('   （会话过期后自动化会再次提示未登录，届时重跑本脚本登录一次即可。）');
