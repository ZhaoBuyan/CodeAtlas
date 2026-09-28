/**
 * 逐边对账：比较两份 bundle，列出**新增 / 消失 / 权重变化**的 ref 边，并可抽检新增边。
 *
 * 为什么要固化成工具（2026-09-25 实测教训）：改引擎之后只看"边数变了多少"会漏掉
 * **把一条边换了目标**这种更坏的情况（总数不变、依赖接错了）。逐边比 `(from,to)`
 * 才能一眼看出"新增 0 种、消失 N 种"= 纯减法，或者"新增 M 种、消失 N 种"= 有换目标。
 * 本会话几轮修复全靠它定"真依赖有没有丢"。
 *
 * 用法：
 *   node tools/diff-bundles.mjs <旧扫描目录> <新扫描目录> [--sample <源码根>] [--top 20] [--by-lang]
 *
 *   --sample <源码根>   逐条把新增边落到**源码那一行**（引用方首行）打印出来
 *   --by-lang           先给一张"按引用方语言"的边数对照（快速看出影响面）
 *   --top N             抽检 / 打印的条数上限（默认 12）
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--') && !isFlagValue(a));
function isFlagValue(a) {
  const i = args.indexOf(a);
  const prev = args[i - 1];
  return prev && ['--sample', '--top'].includes(prev);
}
const [dirA, dirB] = positional;
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const sampleRoot = flag('sample', null);
const topN = Number(flag('top', 12));
const byLang = Boolean(flag('by-lang', false));

if (!dirA || !dirB) {
  console.error('用法：node tools/diff-bundles.mjs <旧目录> <新目录> [--sample 源码根] [--by-lang] [--top N]');
  process.exit(2);
}
const load = (d) => JSON.parse(fs.readFileSync(path.join(d, 'bundle.json'), 'utf8'));
const A = load(dirA), B = load(dirB);
// 类型按 id 索引 —— bundle 的 types 数组下标**不等于** id（裁剪/合并会重编 id）
const at = (b) => new Map(b.types.map((t) => [t.id, t]));
const TA = at(A), TB = at(B);
const keyOf = (b, t, e) => {
  const s = t.get(e.from), d = t.get(e.to);
  if (!s || !d) return null;
  return `${b.files[s.file].path}::${s.fqn || s.name} -> ${b.files[d.file].path}::${d.fqn || d.name}`;
};

const mk = (b, t) => {
  const m = new Map();
  for (const e of b.edges) {
    if (e.kind !== 'ref') continue;
    const k = keyOf(b, t, e);
    if (k) m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
};
const EA = mk(A, TA), EB = mk(B, TB);
const added = [...EB.keys()].filter((k) => !EA.has(k));
const removed = [...EA.keys()].filter((k) => !EB.has(k));

console.log(`旧：${A.edges.length} 条边 / ${EA.size} 种 · 新：${B.edges.length} 条边 / ${EB.size} 种`);
console.log(`新增 ${added.length} 种 · 消失 ${removed.length} 种  `
  + (added.length === 0 ? '（纯减法：没把任何边换目标）' : removed.length === 0 ? '（纯增益：没丢边）' : '（⚠ 两边都有 → 可能有边被换了目标）'));

if (byLang) {
  const per = (b, t) => {
    const m = new Map();
    for (const e of b.edges) {
      if (e.kind !== 'ref') continue;
      const s = t.get(e.from);
      if (!s) continue;
      const l = b.files[s.file].lang;
      m.set(l, (m.get(l) || 0) + 1);
    }
    return m;
  };
  const LA = per(A, TA), LB = per(B, TB);
  console.log('\n按引用方语言：');
  for (const l of [...new Set([...LA.keys(), ...LB.keys()])].sort()) {
    const a = LA.get(l) || 0, b = LB.get(l) || 0;
    if (a === b) continue;
    console.log(`  ${l.padEnd(12)} ${String(a).padStart(6)} → ${String(b).padStart(6)}  (${b - a >= 0 ? '+' : ''}${b - a})`);
  }
}

const lines = new Map();
const srcOf = (p) => {
  if (!lines.has(p)) {
    try { lines.set(p, fs.readFileSync(path.join(sampleRoot, p), 'utf8').split(/\r?\n/)); }
    catch { lines.set(p, null); }
  }
  return lines.get(p);
};
if (sampleRoot) {
  console.log(`\n新增边抽检（最多 ${topN} 条，落到源码行）：`);
  for (const k of added.slice(0, topN)) {
    const [fromPart, toPart] = k.split(' -> ');
    const [fromPath, fromFqn] = fromPart.split('::');
    const t = B.types.find((x) => (x.fqn || x.name) === fromFqn && B.files[x.file].path === fromPath);
    const L = srcOf(fromPath);
    const line = L && t ? (L[t.line - 1] || '').trim() : '';
    console.log(`  ${fromPath}:${t ? t.line : '?'}  ${fromFqn}`);
    console.log(`      ${line.slice(0, 110)}`);
    console.log(`      → ${toPart.replace('::', '  ')}`);
  }
} else if (removed.length) {
  console.log(`\n消失的边（最多 ${topN} 条）：`);
  for (const k of removed.slice(0, topN)) console.log(`  - ${k}`);
}
