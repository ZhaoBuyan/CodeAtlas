/**
 * 诊断工具：把"引擎放弃解析的引用"按 **语言 × 原因 × 名字** 聚合出来。
 *
 * 为什么需要它（2026-09-25 一整天的教训）：`bundle.unresolved` 只有一个**总数**
 * （`unknown` / `ambiguous`），而那个总数没有诊断价值 —— 真 проекта里它一半是
 * `string` / `error` / `bool` 这类**内建类型**、`CAMLprim` / `#define` 这类**宏**、
 * `s` / `x` / `i` 这类**局部变量**，另一半才是真缺口。只有按名字聚合、再问一句
 * "这个名字在图上有定义吗"，才能把**噪声**与**真缺口**分开。
 * 实测战果：一次看出 Java 的静态导入成员名（`assertEquals`）是 3,193 条真可接的；
 * 也一次证明 C 侧名字解析"65,922 条里只有 1% 名字有定义"→ **不值得做**。
 *
 * 用法：
 *   node tools/unresolved-report.mjs <扫描目录> [--top 25] [--exclude a,b] [--json]
 *
 * `--exclude` 与 MCP 的 `exclude` 同义（按路径片段丢样本），只影响本次输出。
 * 引擎侧要落盘诊断需要 `CA_DEBUG_UNRESOLVED` —— 本脚本自己会处理（见下）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const topN = Number(flag('top', 25));
const asJson = Boolean(flag('json', false));
const excludes = String(flag('exclude', '')).split(',').map((s) => s.trim()).filter(Boolean);

if (!target) {
  console.error('用法：node tools/unresolved-report.mjs <扫描目录> [--top 25] [--exclude a,b] [--json]');
  process.exit(2);
}
const bundlePath = findBundle(target);
if (!bundlePath) {
  console.error(`没找到 bundle.json：${target}（先跑一次扫描，或指向扫描输出目录）`);
  process.exit(2);
}
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));

/**
 * 诊断数据从哪来：bundle 里**没有**"哪些引用被放弃了"的明细（只有计数），
 * 所以要么读引擎刚落盘的日志，要么自己重扫一遍拿。这里两条路都支持：
 *   · 同目录下有 `unresolved.tsv`（上次扫描时用 CA_DEBUG_UNRESOLVED 写的）→ 直接用；
 *   · 否则用 `src/cli.mjs scan` 重扫到临时目录（带上 CA_DEBUG_UNRESOLVED）。
 */
let lines = [];
const sidecar = path.join(path.dirname(bundlePath), 'unresolved.tsv');
if (fs.existsSync(sidecar)) {
  lines = fs.readFileSync(sidecar, 'utf8').split(/\r?\n/).filter(Boolean);
} else {
  const log = path.join(os.tmpdir(), `ca-unresolved-${Date.now()}.tsv`);
  const outDir = path.join(os.tmpdir(), `ca-unresolved-scan-${Date.now()}`);
  const sources = bundle.source?.roots || [target];
  if (!process.env.CA_UNRESOLVED_KEEP_SIDECAR) {
    console.error('（bundle 里没有明细 → 用当前引擎重扫一遍拿诊断；想跳过就先生成同目录下的 unresolved.tsv）');
  }
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'src', 'cli.mjs'), 'scan', ...sources, '--out', outDir], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CA_DEBUG_UNRESOLVED: log, NODE_BIN: process.env.NODE_BIN || process.execPath },
    });
  } catch { /* 退出码不管（解析子进程是硬退的），只看产物 */ }
  if (!fs.existsSync(log)) {
    console.error('引擎没有写下诊断文件 —— 可能没扫成功。先确认扫描能跑（见 src/cli.mjs）。');
    process.exit(1);
  }
  lines = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean);
  fs.copyFileSync(log, sidecar);
  console.error(`（明细已存到 ${path.relative(ROOT, sidecar)}，下次直接读它）`);
}

// 名字 → 图上有没有定义（按简单名比；限定名取叶子）
const hasDef = new Set(bundle.types.map((t) => t.name));
const rows = [];
for (const line of lines) {
  const [name, why, nCand, lang, file] = line.split('\t');
  if (!name) continue;
  if (excludes.length && excludes.some((x) => String(file).includes(x))) continue;
  rows.push({ name, why, lang: lang || '?', file, leaf: name.slice(name.lastIndexOf('.') + 1) });
}

const byLangWhy = new Map();
const byName = new Map();
let recoverable = 0;
for (const r of rows) {
  const k = `${r.lang} / ${r.why}`;
  if (!byLangWhy.has(k)) byLangWhy.set(k, { n: 0, has: 0 });
  const g = byLangWhy.get(k);
  g.n++;
  if (hasDef.has(r.leaf)) g.has++;
  if (hasDef.has(r.leaf)) recoverable++;
  const nk = `${r.lang}\t${r.name}`;
  byName.set(nk, (byName.get(nk) || 0) + 1);
}

if (asJson) {
  console.log(JSON.stringify({
    bundle: path.relative(ROOT, bundlePath),
    total: rows.length,
    recoverableNamed: recoverable,
    unresolved: bundle.unresolved,
    byLangWhy: Object.fromEntries([...byLangWhy].map(([k, v]) => [k, v])),
    top: [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([k, n]) => {
      const [lang, name] = k.split('\t');
      return { lang, name, n, defined: hasDef.has(name.slice(name.lastIndexOf('.') + 1)) };
    }),
  }, null, 2));
  process.exit(0);
}

console.log(`bundle：${path.relative(ROOT, bundlePath)}`);
console.log(`引擎计数：${JSON.stringify(bundle.unresolved)} · 明细 ${rows.length} 条`);
console.log('\n按（语言 × 原因）：总数 / 其中"名字在图上有定义"');
for (const [k, v] of [...byLangWhy].sort((a, b) => b[1].n - a[1].n)) {
  const pct = v.n ? Math.round((100 * v.has) / v.n) : 0;
  console.log(`  ${k.padEnd(34)} ${String(v.n).padStart(7)} ${String(v.has).padStart(8)}  (${pct}%)`);
}
console.log(`\nTop ${topN} 名字（n · 有定义=真缺口 / 无定义=噪声）：`);
for (const [k, n] of [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)) {
  const [lang, name] = k.split('\t');
  const defined = hasDef.has(name.slice(name.lastIndexOf('.') + 1));
  console.log(`  ${String(n).padStart(5)}  [${lang}] ${name}${defined ? '  ← 图上有定义（可能是真缺口）' : ''}`);
}
console.log('\n口径提醒：这里只统计**引擎放弃的引用**。"图上有定义"只是线索 —— 多数是'
  + '内建/宏/局部变量的同名巧合，判断值不值得做要看**同名前缀与 import 依据**，'
  + '别直接按名字接边。');

function findBundle(t) {
  const p = path.resolve(t);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  const direct = path.join(p, 'bundle.json');
  if (fs.existsSync(direct)) return direct;
  return null;
}
