/**
 * 运行时路径自检（2026-09-25）：本地服务 / 路径穿越 / 监控模式 / 增量缓存。
 *   node tests/probe-runtime.mjs
 *
 * 为什么单列一条：这三条是**用户能直接碰到**的路径，却不在 fixtures 回归与 MCP 自检的覆盖里
 * （那两条只走"扫描 + bundle 读取"）。发版前跑一次，跑法是**真的起服务、真的改文件**：
 *   · `serve`：首页 / 静态文件 / bundle 三个 200；三种路径穿越必须 404（`insideDir` 的回归门）；
 *     非法百分号编码必须 400 且**服务还活着**（以前 URIError 会把进程带走）；
 *   · `--incremental`：第二趟必须复用缓存（日志里有"复用 N 个没变的文件"）；
 *   · `--watch`：新增一个文件后必须**自己重扫**（这条曾经静默失效过：`--watch` 只认 scan 子命令那条路）。
 * 端口是**现找一个空闲的**：CI 上固定端口撞车会变成假红。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const NODE = process.env.NODE_BIN || process.execPath;
const CLI = path.join(repo, 'src', 'cli.mjs');
const work = path.join(here, '.out', 'runtime');
let bad = 0;
const check = (ok, what) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) bad++; };

/** 现找一个空闲端口（listen(0) 拿系统分配的，然后关掉） */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

const sample = path.join(repo, 'tests', 'fixtures', 'lua');
const out = path.join(work, 'out');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// ---------- ① 扫描 + 增量缓存 ----------
const r1 = spawnSync(NODE, [CLI, 'scan', sample, '--out', out, '--lang', 'lua'], { cwd: repo, encoding: 'utf8' });
check(r1.status === 0 && fs.existsSync(path.join(out, 'bundle.json')), '第一次扫描成功');
const r2 = spawnSync(NODE, [CLI, 'scan', sample, '--out', out, '--lang', 'lua', '--incremental'], { cwd: repo, encoding: 'utf8' });
const incLine = (r2.stdout || '').split(/\r?\n/).find((l) => l.includes('复用'));
check(r2.status === 0, '第二次扫描（--incremental）成功');
check(fs.existsSync(path.join(out, '.scan-cache.json')), '增量缓存文件写出来了');
check(/复用\s*\d+\s*个/.test(incLine || '') && /重新解析\s*0\s*个/.test(incLine || ''),
  `第二趟真的走了缓存（${(incLine || '没找到"复用 N 个"那行').trim().slice(0, 70)}）`);

// ---------- ② 本地服务 + 路径穿越 ----------
const port = await freePort();
const srv = spawn(NODE, [CLI, 'serve', '--out', out, '--port', String(port), '--no-open'], { cwd: repo });
const base = `http://127.0.0.1:${port}`;
const get = async (p) => {
  try { const res = await fetch(base + p); return { status: res.status, text: await res.text() }; }
  catch (e) { return { status: 0, text: String(e && e.message) }; }
};
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await new Promise((s) => setTimeout(s, 250));
  up = (await get('/data/bundle.meta')).status === 200;
}
check(up, `本地服务起来了（${base}）`);
if (up) {
  const idx = await get('/');
  check(idx.status === 200 && idx.text.includes('CODEATLAS_LANG'), '首页 200 且注入了语言');
  const app = await get('/web/app.js');
  check(app.status === 200 && app.text.length > 1000, '静态文件 /web/app.js 200');
  const bundle = await get('/data/bundle.json');
  check(bundle.status === 200 && bundle.text.includes('"edges"'), '/data/bundle.json 200');
  for (const p of ['/..%2Fpackage.json', '/../package.json', '/web/../../package.json']) {
    const got = await get(p);
    check(got.status === 404 || got.status === 400, `穿越 ${p} → ${got.status}（不许 200）`);
  }
  const badpct = await get('/%zz');
  check(badpct.status === 400, `非法百分号编码 /%zz → ${badpct.status}（400，服务没崩）`);
  check((await get('/data/bundle.meta')).status === 200, '非法请求之后服务还活着');
}
srv.kill();

// ---------- ③ 监控模式：新增文件后自动重扫 ----------
const watchDir = path.join(work, 'watch');
fs.mkdirSync(watchDir, { recursive: true });
fs.writeFileSync(path.join(watchDir, 'a.lua'), 'local t = {}\nreturn t\n', 'utf8');
const outW = path.join(work, 'out-watch');
const w = spawn(NODE, [CLI, 'scan', watchDir, '--out', outW, '--lang', 'lua', '--watch', '--no-open', '--port', String(await freePort())], { cwd: repo });
let wLog = '';
w.stdout.on('data', (d) => { wLog += d; });
w.stderr.on('data', (d) => { wLog += d; });
for (let i = 0; i < 40 && !fs.existsSync(path.join(outW, 'bundle.json')); i++) await new Promise((s) => setTimeout(s, 500));
check(fs.existsSync(path.join(outW, 'bundle.json')), '监控模式第一趟扫出来了');
fs.writeFileSync(path.join(watchDir, 'b.lua'), 'local u = {}\nreturn u\n', 'utf8');
let grew = false;
for (let i = 0; i < 60 && !grew; i++) {
  await new Promise((s) => setTimeout(s, 500));
  try { grew = JSON.parse(fs.readFileSync(path.join(outW, 'bundle.json'), 'utf8')).files.length >= 2; } catch { /* 正在写 */ }
}
check(grew, '监控模式：新增文件后自己重扫（bundle 里文件数 ≥ 2）');
w.kill();

fs.rmSync(work, { recursive: true, force: true });
console.log(bad ? `\n${bad} 处不通过` : '\n✓ 全部通过');
process.exitCode = bad ? 1 : 0;
