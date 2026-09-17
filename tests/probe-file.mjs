/**
 * 单文件解析探针：某个文件抽不出东西、或者报解析异常时，用它看语法树到底怎么了。
 *   node tests/probe-file.mjs <文件路径> [--lang csharp] [--lines 20]
 *
 * 会打印：前几行源码、根节点的子节点、所有 ERROR 节点的位置与片段。
 * （走的是和扫描器一样的预处理，所以看到的就是扫描器看到的东西。）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from 'web-tree-sitter';
import { LANGUAGES, resolveWasm, languageForExt } from '../src/languages.mjs';
import { preprocess } from '../src/preprocess.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const langFlag = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : null;
const head = args.includes('--lines') ? Number(args[args.indexOf('--lines') + 1]) : 18;

if (!file) {
  console.error('用法：node tests/probe-file.mjs <文件路径> [--lang csharp] [--lines 18]');
  process.exit(1);
}
const abs = path.resolve(file);
const lang = langFlag ? Object.values(LANGUAGES).find((l) => l.id === langFlag) : languageForExt(path.extname(abs).toLowerCase());
if (!lang) { console.error(`认不出这个后缀的语言，用 --lang 指定（可用：${Object.keys(LANGUAGES).join(', ')}）`); process.exit(1); }

const raw = fs.readFileSync(abs, 'utf8');
const src = lang.preprocess ? preprocess(raw, lang.preprocess) : raw;
const lines = src.split(/\r?\n/);
console.log(`文件 ${abs}`);
console.log(`语言 ${lang.id}${lang.preprocess ? `（预处理：${lang.preprocess}）` : ''}   行数 ${lines.length}   预处理改动 ${src === raw ? '无' : `${raw.length - src.length} 字符`}`);
console.log(`--- 前 ${head} 行 ---`);
for (let i = 0; i < Math.min(head, lines.length); i++) console.log(String(i + 1).padStart(4) + ' | ' + lines[i]);

await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(resolveWasm(lang)));
const tree = parser.parse(src);

console.log('--- 根节点的子节点 ---');
for (const c of tree.rootNode.namedChildren.slice(0, 10)) {
  console.log(`  ${c.type} @${c.startPosition.row + 1}-${c.endPosition.row + 1}  name=${c.childForFieldName('name')?.text ?? '-'}`);
}
const errs = [];
const hit = new Map();
const walk = (n) => {
  if (n.type === 'ERROR') errs.push(n);
  // 顺带统计扫描器真正认得的声明，方便定位"明明有类却没抽到"
  for (const [type, kind] of Object.entries(lang.types || {})) if (n.type === type) hit.set(n.type + '→' + kind, (hit.get(n.type + '→' + kind) || 0) + 1);
  for (const c of n.namedChildren) walk(c);
};
walk(tree.rootNode);

console.log('--- 认得出来的类型声明 ---');
console.log(hit.size ? [...hit].map(([k, v]) => `${k}×${v}`).join('  ') : '（一个都没认出来）');
console.log(`--- ERROR ${errs.length} 处 ---`);
for (const e of errs.slice(0, 5)) {
  console.log(`  行 ${e.startPosition.row + 1}-${e.endPosition.row + 1} :: ${JSON.stringify(e.text.replace(/\s+/g, ' ').slice(0, 140))}`);
}
if (!errs.length) console.log('  （没有 ERROR，语法树是干净的）');
