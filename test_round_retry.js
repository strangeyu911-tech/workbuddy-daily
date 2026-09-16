// test_round_retry.js —— 回归测试：wb_auto_task.js v4「整流程重试」的判定分类
//
// 直接从源文件提取 SETTLED / RETRYABLE 两条正则（保证测的是脚本**本体**，不是副本），
// 再用 2026-09-15/16 真实日志里出现过的返回值断言分类是否正确。
//
// 分类语义（与主循环的 break 条件一一对应）：
//   settled → 已达成目的，收工（不再重试）
//   retry   → 瞬时失败，重载页面再来一轮
//   stop    → 重试无意义（如未登录），直接收工
//
// 用法：node test_round_retry.js

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/wb_auto_task.js', 'utf8');

function extract(name) {
  const m = src.match(new RegExp('^const ' + name + ' = ([^;]+);', 'm'));
  if (!m) throw new Error('未能从 wb_auto_task.js 提取 ' + name + '（文件结构变了？）');
  return eval(m[1]);
}

const SETTLED = extract('SETTLED');
const RETRYABLE = extract('RETRYABLE');
const MAX_ROUNDS = Number(extract('MAX_ROUNDS'));

// [真实返回值, 期望分类]
const cases = [
  // ---- 已达成：应一轮收工 ----
  ['dispatched:旅行倒计时 01:59:56', 'settled'],
  ['already-traveling:旅行倒计时 00:25:50', 'settled'],
  ['already-dispatched-today:派猫猫旅行', 'settled'],
  // ---- 瞬时失败：应重载重试（均取自 2026-09-15/16 真实日志）----
  ['no-travel-button', 'retry'],
  ['click-failed:派猫猫旅行 (locator.click: Timeout 6000ms exceeded)', 'retry'],
  ['dispatched-unverified:派猫猫旅行', 'retry'],
  ['gift-claim-failed:领取礼物', 'retry'],
  ['gift-claim-disabled:领取礼物', 'retry'],
  ['unknown-state:领取礼物', 'retry'],
  // ---- 重试无意义：应直接收工 ----
  ['skipped: not logged in', 'stop'],
];

let bad = 0;
for (const [v, want] of cases) {
  const got = SETTLED.test(v) ? 'settled' : (RETRYABLE.test(v) ? 'retry' : 'stop');
  const ok = got === want;
  if (!ok) bad++;
  console.log((ok ? 'OK  ' : 'FAIL') + '  expect=' + want.padEnd(7) + ' got=' + got.padEnd(7) + '  ' + JSON.stringify(v));
}

console.log('\nMAX_ROUNDS = ' + MAX_ROUNDS + '（含首次，硬上限 → 循环必然终止，无死循环风险）');
console.log(bad === 0 ? '\n全部通过 ✅（' + cases.length + ' 项）' : '\n有 ' + bad + ' 项不符 ❌');
process.exit(bad === 0 ? 0 : 1);
