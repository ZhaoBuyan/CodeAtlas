/**
 * 重扫「本仓库自己的图」→ dist/ —— `npm test` 的自检（mcp-selftest）就是拿它当输入。
 *
 *   npm run scan:self        （`npm test` 会通过 pretest 自动跑这一步）
 *
 * 为什么要固化成一个脚本、而不是在 package.json 里直接写一行命令：
 *   排除项里那个 `工作文档`（本地样本库 + 验证产物，好几个 GB）是**中文路径**，
 *   而 Windows 上经 cmd.exe / PowerShell 传非 ASCII 参数会被按 ANSI 代码页转一道
 *   （2026-09-25 真踩过：路径里的中文变乱码 → node 报 Cannot find module）。
 *   这里用 Node 直接 spawn，参数走 UTF-16，不受代码页影响。
 *
 * 为什么**必须**排除它：`.gitignore` 里没有它（它靠 `.git/info/exclude` 本地忽略），
 *   而引擎只认 `.gitignore` —— 不显式排除就会把 67 个真样本库一起扫进这张图。
 *
 * 为什么要有这一步：dist 以前是**手工**扫的（上一次是 2026-09-23），于是它会悄悄过期 ——
 *   `npm test` 的"本地全绿"可能是在**旧代码**的图上跑出来的。2026-10-03 换新图时，
 *   立刻露出了一条被旧图藏住的红门（㉘ 的唯一性断言，见 tests/mcp-selftest.mjs）。
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const t0 = Date.now();
execFileSync(process.execPath, [
  path.join(ROOT, 'src', 'cli.mjs'),
  'scan', '.',
  '--out', 'dist',
  '--exclude', '工作文档',
], { stdio: 'inherit', cwd: ROOT });

console.log(`\n  ✓ dist/ 已按当前代码重扫（${((Date.now() - t0) / 1000).toFixed(1)}s）—— 自检读的就是这张图\n`);
