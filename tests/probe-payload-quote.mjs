/**
 * 打包脚本的**路径引用**测试（安全，2026-09-25）。
 *   node tests/probe-payload-quote.mjs        （Windows / PowerShell）
 *
 * 背景：`tools/build-payload.mjs` 打 zip 那一步要把 `STAGE` / `OUT_ZIP` 拼进一条 PowerShell
 * `-Command` 字符串。之前的写法是直接插值（`'${STAGE}'`）—— 而这两个路径是从**仓库所在路径**
 * 推出来的：路径里只要有一个 `'`（Windows 上合法，`C:\Users\O'Brien\…`），单引号字符串就被截断，
 * 后面的内容变成**在构建机上执行的 PowerShell**。
 *
 * 这条测试用一个名字里带 `'` 的目录真跑一遍 `[IO.Compression.ZipFile]::CreateFromDirectory`
 * （与 build-payload.mjs 里 psQuote() 的写法逐字一致）：
 *   · 修好之后 → 路径被当成一段字面量，zip 正常生成；
 *   · 没修（旧写法）→ 命令被截断 → PowerShell 语法错误 → 没有 zip。
 * 顺带确认注入串**没有**被执行（输出里不出现 PWNED 单独一行）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'win32') {
  console.log('— 非 Windows：跳过（这一步只跟 PowerShell 有关）');
  process.exit(0);
}

/** 与 tools/build-payload.mjs 里逐字一致：PowerShell 单引号字符串里 `'` 写两遍 */
const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-quote-'));
// 目录名里塞一个 `'` 加一段"如果被当成代码就会执行"的片段
const stage = path.join(base, "stage'; Write-Output PWNED; '");
const zip = path.join(base, "out'.zip");
fs.mkdirSync(stage, { recursive: true });
fs.writeFileSync(path.join(stage, 'payload.json'), '{"ok":true}\n', 'utf8');

const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(stage)}, ${psQuote(zip)})`;
let out = '';
let err = '';
let ok = true;
try {
  out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
} catch (e) {
  ok = false;
  err = String((e && (e.stdout || '') + (e.stderr || '')) || e.message);
}

const checks = [
  [ok, `PowerShell 命令正常结束（路径里的 ' 没把命令截断）${ok ? '' : `：${err.slice(0, 200)}`}`],
  [fs.existsSync(zip), `zip 生成成功（${path.basename(zip)}）`],
  [fs.existsSync(zip) && fs.readFileSync(zip).length > 0, 'zip 非空'],
  [!/^\s*PWNED\s*$/m.test(out), '注入串没有被当成代码执行（输出里没有 PWNED）'],
];

// 反向对照：**旧写法**（直接插值）在同一条路径上必须失败 —— 否则上面的断言证明不了什么
const zipOld = path.join(base, "out-old'.zip");
const psOld = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${stage}', '${zipOld}')`;
let oldFailed = false;
try { execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psOld], { encoding: 'utf8', stdio: 'pipe' }); }
catch { oldFailed = true; }
checks.push([oldFailed && !fs.existsSync(zipOld), '反向对照：不转义的旧写法在同一条路径上失败（证明这道闸有意义）']);

for (const [good, what] of checks) console.log(`${good ? '✓' : '✗'} ${what}`);

fs.rmSync(base, { recursive: true, force: true });
const bad = checks.filter(([g]) => !g).length;
console.log(bad ? `\n${bad} 处不通过` : '\n✓ 全部通过');
process.exitCode = bad ? 1 : 0;
