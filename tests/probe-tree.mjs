// 探针：打印一个文件的**完整**节点树（可选最大深度），用来核"某个节点到底长什么样"（2026-09-25）
//   node probe-tree.mjs <文件> [最大深度=6]
import fs from 'node:fs';
import path from 'node:path';
import { Parser, Language } from 'web-tree-sitter';
import { LANGUAGES, resolveWasm } from '../src/languages.mjs';

const file = process.argv[2];
const maxDepth = Number(process.argv[3] || 6);
const ext = path.extname(file).toLowerCase();
const lang = Object.values(LANGUAGES).find((l) => (l.exts || []).includes(ext));
if (!lang) { console.error(`认不出语言：${ext}`); process.exit(1); }
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(resolveWasm(lang)));
const tree = parser.parse(fs.readFileSync(file, 'utf8'));
const dump = (n, d) => {
  console.log(`${'  '.repeat(d)}${n.type}  [${JSON.stringify(n.text.slice(0, 50).replace(/\s+/g, ' '))}]`);
  if (d >= maxDepth) return;
  for (const c of n.namedChildren) dump(c, d + 1);
};
dump(tree.rootNode, 0);
