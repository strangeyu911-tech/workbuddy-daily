// 拉起常驻 Edge（detached，脚本退出后窗口继续活着）
// 单独成文件是为了避开 shell 里的引号地狱，也便于复用
const { spawn } = require('child_process');
const fs = require('fs');
const P = require('./wb_paths');


// ── TCP 直连探活（比 fetch 少一层不确定性）────────────────────────────
// 见 wb_run_tasks.js 的详细注释。注意：实测本机代理**能**正确转发环回请求
// （在听=200 / 没听=502），并非"假阴性" —— 这里用 TCP 是刻意让探活只依赖端口本身，
// 不受代理端口变更/消失与 HTTP 层语义影响。给 fetch 传 {proxy:undefined} 则确实无效。
function _tcpAlive(host, port, timeoutMs) {
  const net = require('net');
  return new Promise((resolve) => {
    const s = net.connect({ host: host, port: port });
    const done = (v) => { try { s.destroy(); } catch (e) {} resolve(v); };
    s.setTimeout(timeoutMs || 2500);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

const EDGE = P.edge();
const PROFILE = P.profile();
const CDP_PORT = 9223;

// ── [本机补丁] 让 undici 别把环回请求送进系统代理 ────────────────────
// 事实（2026-09-17 实测，勿再凭印象改）：
//   · undici 的全局 fetch 从**环境变量**读代理；给 fetch 传 `{proxy:undefined}` 无效。
//   · 本机 HTTP_PROXY 指向一个本地代理端口，实测它**能正确转发**环回请求：
//     9223 在听 → HTTP 200；没人听 → 代理回 502（直连则是 ECONNREFUSED）。
//   · 所以 502 == "确实没在听"，**不是**代理误路由造成的假阴性。
//     （曾误判成"代理把环回送错地方"，白查两轮；真因是 Edge 冷启动太慢。）
//   · 保留本块只是让环回请求少绕一层；出网不受影响（清/不清代理实测都通）。
if (!globalThis.__loopbackNoProxy) {
  globalThis.__loopbackNoProxy = true;
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    if (process.env[k]) delete process.env[k];
  }
  process.env.NO_PROXY = "127.0.0.1,localhost,::1";
  process.env.no_proxy = process.env.NO_PROXY;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function alive() { return _tcpAlive("127.0.0.1", CDP_PORT, 2500); }

(async () => {
  if (await alive()) { console.log('✓ 常驻 Edge 已在运行（端口 ' + CDP_PORT + '），无需拉起'); return; }
  if (!fs.existsSync(EDGE)) { console.error('✗ 找不到 msedge.exe: ' + EDGE); process.exit(1); }
  console.log('拉起 Edge…');
  console.log('  exe     : ' + EDGE);
  console.log('  profile : ' + PROFILE + (fs.existsSync(PROFILE) ? '  (已存在)' : '  (将创建)'));
  const child = spawn(EDGE, [
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-session-crashed-bubble',
    '--window-size=1200,800',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  console.log('  pid     : ' + child.pid);
  // 冷启动实测可能 > 30s（首次加载大量扩展），等满 90s
  let up = false;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    if (await alive()) { up = true; console.log('✓ 调试端口 ' + CDP_PORT + ' 已就绪（' + (i + 1) + 's）'); break; }
    if (i % 10 === 9) console.log('  …仍在启动（' + (i + 1) + 's）');
  }
  if (!up) { console.error('✗ 90s 内端口未就绪。试试 --kill 清理后重跑，或手动开一次 Edge 看是否有弹窗拦截'); process.exit(1); }
  console.log('浏览器保持常驻。之后跑 wb_run_tasks.js / wb_auto_task.js 会直接复用它。');
})().catch((e) => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
