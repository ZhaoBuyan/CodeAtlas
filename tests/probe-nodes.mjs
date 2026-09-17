/**
 * 语法探针：打印 tree-sitter 实际解析出的节点名，用来核对 languages.mjs 的配置。
 *   node tests/probe-nodes.mjs [语言或文件名片段]
 *
 * 加语言、或者某语言抽不出东西时，先跑这个看真实节点名，别猜。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from 'web-tree-sitter';
import { LANGUAGES, resolveWasm } from '../src/languages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];
const FIXTURES = path.join(HERE, 'fixtures');

await Parser.init();

// 直接指定语法探一个文件（加新语言时用：先看真实节点名，再写 profile）
//   node tests/probe-nodes.mjs --wasm tree-sitter-go.wasm tests/fixtures/go/sample.go
const wi = process.argv.indexOf('--wasm');
if (wi >= 0) {
  const wasm = process.argv[wi + 1];
  const file = process.argv[wi + 2];
  const p2 = new Parser();
  p2.setLanguage(await Language.load(resolveWasm({ wasm })));
  const tree = p2.parse(fs.readFileSync(file, 'utf8'));
  const hist = new Map();
  const walk = (n) => { hist.set(n.type, (hist.get(n.type) || 0) + 1); for (const c of n.namedChildren) walk(c); };
  walk(tree.rootNode);
  console.log(`\n=== ${wasm}  ${path.basename(file)} ===`);
  console.log('  节点：' + [...hist].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([t, n]) => `${t}×${n}`).join('  '));
  console.log('  顶层结构：');
  for (const c of tree.rootNode.namedChildren.slice(0, 14)) {
    const nm = c.childForFieldName('name')?.text || c.namedChildren.find((x) => /identifier|name|spec/i.test(x.type))?.text || '-';
    console.log(`    ${c.type}  name=${nm}`);
  }
  process.exit(0);
}

for (const lang of Object.values(LANGUAGES)) {
  if (filter && !lang.id.includes(filter) && !lang.exts.some((e) => e.includes(filter))) continue;
  const file = findFirst(FIXTURES, lang.exts);
  if (!file) continue;
  const parser = new Parser();
  parser.setLanguage(await Language.load(resolveWasm(lang)));
  const src = fs.readFileSync(file, 'utf8');
  const tree = parser.parse(src);

  const hist = new Map();
  const walk = (n) => {
    hist.set(n.type, (hist.get(n.type) || 0) + 1);
    for (const c of n.namedChildren) walk(c);
  };
  walk(tree.rootNode);
  const top = [...hist].sort((a, b) => b[1] - a[1]).slice(0, 18);
  console.log(`\n=== ${lang.id}  ${path.relative(FIXTURES, file)} ===`);
  console.log('  顶部节点：' + top.map(([t, n]) => `${t}×${n}`).join('  '));
  console.log('  根的前两层：' + tree.rootNode.namedChildren.slice(0, 6).map((c) => `${c.type}(${c.childForFieldName('name')?.text ?? '-'})`).join('  '));
  tree.delete();
}
console.log('');

function findFirst(dir, exts) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (exts.includes(path.extname(e.name).toLowerCase())) return p;
    }
  }
  return null;
}
