/**
 * 机械核对：把"新增的边"逐条拿回**源码**去验证，而不是靠眼看。
 *
 * 判据（按语言分档，只认**显式依据**）：
 *   · Java / Kotlin / C# / Scala：源码里必须有一条 `import [static] <目标全名>[.成员];`
 *   · Python / JS / TS / Vue：源码里必须有 `import … <目标叶子>` 或 `from … import <叶子>` /
 *     `require('…<叶子>…')`
 *   · C / C++：必须有 `#include "<目标路径或文件名>"`
 *   · OCaml：必须有 `open <目标模块>` / 文件模块名出现在源码（弱：只报"没找到"供人工看）
 *   · 其他语言：只做"目标叶子出现在源码里"的最弱核对，并明确标注是弱判据
 *
 * 用法：
 *   node tools/verify-edges.mjs <旧扫描目录> <新扫描目录> <源码根> [--lang java,kotlin] [--top 8]
 *
 * 输出：✓/✗ 计数 + 前若干条 ✗ 的明细（✗ 不一定是错边 —— 但**必须逐条看过**才能说没问题）。
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const [dirA, dirB, root] = args.filter((a, i) => !a.startsWith('--') && !['--lang', '--top'].includes(args[i - 1]));
const wantLangs = String(flag('lang', '')).split(',').map((s) => s.trim()).filter(Boolean);
const topN = Number(flag('top', 8));

if (!dirA || !dirB || !root) {
  console.error('用法：node tools/verify-edges.mjs <旧目录> <新目录> <源码根> [--lang java] [--top 8]');
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
const oldKeys = new Set(A.edges.filter((e) => e.kind === 'ref').map((e) => keyOf(A, TA, e)).filter(Boolean));
const added = [];
for (const e of B.edges) {
  if (e.kind !== 'ref') continue;
  const k = keyOf(B, TB, e);
  if (!k || oldKeys.has(k)) continue;
  const from = TB.get(e.from), to = TB.get(e.to);
  const lang = B.files[from.file].lang;
  if (wantLangs.length && !wantLangs.includes(lang)) continue;
  added.push({ lang, fromPath: B.files[from.file].path, toFqn: to.fqn || to.name, toPath: B.files[to.file].path });
}

const cache = new Map();
const read = (p) => {
  if (!cache.has(p)) {
    try { cache.set(p, fs.readFileSync(path.join(root, p), 'utf8')); } catch { cache.set(p, null); }
  }
  return cache.get(p);
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 每种语言的"显式依据"判据；返回 true = 源码里确实有那条依据 */
const CHECKS = {
  java: (src, to) => new RegExp(`^\\s*import\\s+(?:static\\s+)?${esc(to)}(?:[.;\\s]|\\.)`, 'm').test(src),
  kotlin: (src, to) => new RegExp(`^\\s*import\\s+${esc(to)}(?:[.\\s]|$)`, 'm').test(src),
  csharp: (src, to) => new RegExp(`^\\s*using\\s+(?:static\\s+)?${esc(to)}(?:[.;\\s]|$)`, 'm').test(src),
  scala: (src, to) => new RegExp(`^\\s*import\\s+${esc(to)}(?:[.\\s]|$)`, 'm').test(src),
  python: (src, to) => {
    const leaf = to.split('.').pop();
    const dotted = to.replace(/\./g, '.');
    return new RegExp(`^\\s*(?:from\\s+[\\w.]+\\s+)?import\\s+[^\\n]*\\b${esc(leaf)}\\b`, 'm').test(src)
      || new RegExp(`^\\s*from\\s+${esc(dotted)}(?:[.\\s]|$)`, 'm').test(src);
  },
  javascript: (src, to) => new RegExp(`(?:import|require\\s*\\()\\s*[^\\n]*${esc(to.split('.').pop())}`, 'm').test(src),
  typescript: (src, to) => new RegExp(`(?:import|require\\s*\\()\\s*[^\\n]*${esc(to.split('.').pop())}`, 'm').test(src),
  tsx: (src, to) => new RegExp(`(?:import|require\\s*\\()\\s*[^\\n]*${esc(to.split('.').pop())}`, 'm').test(src),
  c: (src, to) => new RegExp(`#\\s*include\\s*[<"][^>"]*${esc(path.basename(to))}[>"]`).test(src),
  cpp: (src, to) => new RegExp(`#\\s*include\\s*[<"][^>"]*${esc(path.basename(to))}[>"]`).test(src),
};

let ok = 0, bad = 0;
const badSamples = [];
const byLang = new Map();
for (const a of added) {
  const src = read(a.fromPath);
  const check = CHECKS[a.lang];
  let pass;
  if (src == null) pass = false;
  else if (check) pass = check(src, a.toFqn);
  else pass = new RegExp(`\\b${esc(a.toFqn.split('.').pop())}\\b`).test(src);   // 弱判据
  byLang.set(a.lang, byLang.get(a.lang) || { n: 0, ok: 0, weak: !check });
  const g = byLang.get(a.lang);
  g.n++;
  if (pass) { ok++; g.ok++; } else { bad++; if (badSamples.length < topN) badSamples.push(a); }
}

console.log(`新增跨文件 ref 边 ${added.length} 条`);
console.log(`  ✓ 源码里找到依据：${ok} · ✗ 没找到：${bad}`);
for (const [lang, g] of byLang) {
  console.log(`    ${lang.padEnd(12)} ${String(g.n).padStart(5)} 条 · ✓ ${g.ok}${g.weak ? '  ⚠ 这门语言用的是**弱判据**（只看目标叶子是否出现在源码里）' : ''}`);
}
if (badSamples.length) {
  console.log('\n✗ 明细（每一条都要人工看过才能说没问题）：');
  for (const a of badSamples) console.log(`  ${a.fromPath}\n      → ${a.toFqn}（${a.toPath}）`);
}
