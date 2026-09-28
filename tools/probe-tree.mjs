/**
 * 语法探针（通用版）：打印任意语言的**真实节点名**，加语言 / 改 profile 之前先跑它。
 *
 * 为什么必须"实测而不是猜"（2026-09-25 加三门语言的教训）：
 *   · PowerShell 的 `using namespace X` **不是** `using_statement`，而是 `command`；
 *   · R 的 `f <- function(...)` 里 `function_definition` 的 `name` 字段是**字面量 `function`**；
 *   · Protobuf 的 `message` 没有 `name` 字段，名字在 `message_name` 里。
 *   三条都是"按文档/直觉写"必错、跑一次探针就看清的东西。
 *
 * 用法：
 *   node tools/probe-tree.mjs <文件> [最大深度]               —— 按扩展名自动匹配语言
 *   node tools/probe-tree.mjs <文件> [深度] --wasm <grammar>  —— 指定语法包（还没进语言表时用）
 *   node tools/probe-tree.mjs <文件> [深度] --hist            —— 只打节点直方图
 *   node tools/probe-tree.mjs <文件> [深度] --types <a,b>      —— 只打这些节点类型的子树
 *
 * `--wasm` 的相对路径与 `src/languages.mjs` 的 `WASM_ROOTS` 一致（如 `r/tree-sitter-r.wasm`、`proto/tree-sitter-proto.wasm`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Parser, Language } from 'web-tree-sitter';
import { LANGUAGES, resolveWasm } from '../src/languages.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const file = args.find((a, i) => !a.startsWith('--') && !['--wasm', '--types'].includes(args[i - 1]));
const maxDepth = Number(args.find((a, i) => /^\d+$/.test(a) && !['--wasm', '--types'].includes(args[i - 1])) || 3);
const wasm = flag('wasm', null);
const onlyTypes = String(flag('types', '')).split(',').map((s) => s.trim()).filter(Boolean);
const histOnly = Boolean(flag('hist', false));

if (!file) {
  console.error('用法：node tools/probe-tree.mjs <文件> [最大深度] [--wasm 语法包] [--types a,b] [--hist]');
  process.exit(2);
}

let profile = wasm ? { wasm } : null;
if (!profile) {
  const ext = path.extname(file).toLowerCase();
  const lang = Object.values(LANGUAGES).find((l) => (l.exts || []).map((e) => e.toLowerCase()).includes(ext));
  if (!lang) {
    console.error(`认不出语言（扩展名 ${ext}）—— 用 --wasm <语法包相对路径> 指定，例如 --wasm r/tree-sitter-r.wasm`);
    process.exit(2);
  }
  profile = lang;
}

await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(resolveWasm(profile)));
const tree = parser.parse(fs.readFileSync(file, 'utf8'));

const hist = new Map();
let errors = 0;
const FIELDS = ['name', 'type', 'body', 'parameters', 'value', 'left', 'right', 'declarator', 'superclass', 'operator'];
const walk = (n, d) => {
  hist.set(n.type, (hist.get(n.type) || 0) + 1);
  if (n.type === 'ERROR' || n.isMissing) errors++;
  const show = d <= maxDepth && (!onlyTypes.length || onlyTypes.includes(n.type));
  if (show) {
    const fields = [];
    for (const f of FIELDS) {
      const c = n.childForFieldName(f);
      if (c) fields.push(`${f}=${JSON.stringify(c.text.slice(0, 22))}`);
    }
    console.log(`${'  '.repeat(d)}${n.type}${fields.length ? ' [' + fields.join(' ') + ']' : ''}  ${JSON.stringify(n.text.slice(0, 46).replace(/\s+/g, ' '))}`);
  }
  for (const c of n.namedChildren) walk(c, d + 1);
};
walk(tree.rootNode, 0);

if (!histOnly) console.log('');
console.log(`ERROR / missing 节点：${errors}`);
console.log('节点直方图（Top 30）：');
console.log([...hist].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([t, n]) => `${t}×${n}`).join('  '));
console.log('\n下一步：把要用的节点名写进 src/languages.mjs 的 profile，然后 `npm run probe:profile` 审计'
  + '（它会检查你写的节点名是否真的存在于语法包里 —— 写错不报错、只是功能静默失效，所以必须审）。');
