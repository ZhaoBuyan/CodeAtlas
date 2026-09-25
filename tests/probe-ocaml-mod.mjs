// 探针：打印指定行所在的 module_definition / module_declaration 子树（含全部字段名）。
//   node tests/probe-ocaml-mod.mjs <文件> <行号>
//
// 为什么单独有一个：OCaml 的 `module` 在语法树上有**两种**函子参数写法，配置里两处都要认
// （2026-09-25 写"函子参数当抽象前缀"时实测出来的）：
//   ① `module Make (Ord : OrderedType) = struct … end`  → module_parameter 直接在 module_binding 下
//   ② `module Make : functor (Ord : OrderedType) -> S`  → 包在 module_binding 的 functor_type 下
// 只按 ① 找会漏掉 `.mli` 里的第 ② 种（实测 `stdlib/moreLabels.mli` 就是这种）。
import fs from 'node:fs';
import { Parser, Language } from 'web-tree-sitter';
import { LANGUAGES, resolveWasm } from '../src/languages.mjs';

const file = process.argv[2];
const want = Number(process.argv[3] || 1);
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(resolveWasm(LANGUAGES.ocaml)));
const tree = parser.parse(fs.readFileSync(file, 'utf8'));

const FIELDS = ['name', 'parameter', 'body', 'pattern', 'type', 'kind', 'module', 'alias'];
const dump = (n, depth) => {
  if (depth > 5) return;
  const fs2 = [];
  for (const f of FIELDS) {
    const c = n.childForFieldName(f);
    if (c) fs2.push(`${f}=${JSON.stringify(c.text.slice(0, 48).replace(/\s+/g, ' '))}`);
  }
  console.log(`${'  '.repeat(depth)}${n.type}${fs2.length ? ' [' + fs2.join(' ') + ']' : ''}`);
  for (const c of n.namedChildren) dump(c, depth + 1);
};

let printed = 0;
const walk = (n) => {
  if (n.startPosition.row + 1 === want && /^module_(definition|declaration)$/.test(n.type)) { dump(n, 0); printed++; }
  for (const c of n.namedChildren) walk(c);
};
walk(tree.rootNode);
if (!printed) console.log('该行没有 module_definition / module_declaration');
