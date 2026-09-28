/**
 * 复扫日志对账：把两次「全量复扫」的逐样本指标比出来。
 *
 * 为什么需要：66+ 个样本的全量复扫要十几分钟，而结论只该是"哪几个样本变了、变在哪"。
 * 本会话每轮都靠这张表验收（"只有 3 个含 OCaml 的样本变了，其余逐项一致"）。
 *
 * 用法：
 *   node tools/diff-rescan-logs.mjs <基线日志> <新日志>
 *
 * 日志由样本库的 `复扫.mjs` 产出（PowerShell 的 Tee-Object 默认写 UTF-16LE，本脚本按 BOM 自动判）。
 * 输出：有差异的样本逐行对照（边 / 文件 / 异常 / 坏 import），无差异的样本数汇总。
 */
import fs from 'node:fs';

const [basePath, newPath] = process.argv.slice(2);
if (!basePath || !newPath) {
  console.error('用法：node tools/diff-rescan-logs.mjs <基线日志> <新日志>');
  process.exit(2);
}
const readLog = (p) => {
  const buf = fs.readFileSync(p);
  const enc = buf[0] === 0xff && buf[1] === 0xfe ? 'utf16le' : 'utf8';
  return buf.toString(enc).split(/\r?\n/);
};
const parse = (p) => {
  const out = new Map();
  for (const l of readLog(p)) {
    const m = /^(\S+)\s+跨文件\s+([\d,]+)\s+·\s+import\s+(\d+)%\s+·\s+引擎\s+(\d+)%\s+·\s+老口径\s+(\d+)%\s+·\s+异常\s+([\d,]+)\s+·\s+坏import\s+(\d+)\s+·\s+([\d,]+)\s+文件/.exec(l);
    if (!m) continue;
    out.set(m[1], {
      cross: +m[2].replace(/,/g, ''), imp: +m[3], eng: +m[4], old: +m[5],
      err: +m[6].replace(/,/g, ''), bad: +m[7], files: +m[8].replace(/,/g, ''),
    });
  }
  return out;
};
const A = parse(basePath), B = parse(newPath);
console.log(`基线样本 ${A.size} · 新样本 ${B.size}\n`);
const diffs = [];
const newOnly = [];
for (const [k, b] of B) {
  const a = A.get(k);
  if (!a) { newOnly.push(k); continue; }
  if (b.cross !== a.cross || b.files !== a.files || b.err !== a.err || b.bad !== a.bad) diffs.push({ k, a, b });
}
console.log(`有差异的样本 ${diffs.length} / ${B.size}`);
for (const x of diffs) {
  console.log(`${x.k.padEnd(22)} 边 ${x.a.cross} → ${x.b.cross} （${x.b.cross - x.a.cross >= 0 ? '+' : ''}${x.b.cross - x.a.cross}）· `
    + `文件 ${x.a.files}→${x.b.files} · 异常 ${x.a.err}→${x.b.err} · 坏import ${x.a.bad}→${x.b.bad}`);
}
if (newOnly.length) console.log(`\n只在新日志里的样本（新加的）：${newOnly.join(', ')}`);
console.log('\n口径提醒：文件数变了 = 这次扫进了新的文件类型（例如新加了一门语言）——'
  + '那**不是**引擎回归。要区分两者，用 `tools/diff-bundles.mjs <旧bundle> <新bundle> --by-lang`'
  + '（按引用方语言比，能看出是"新语言的文件进来了"还是"已有语言被弄坏"）。');
