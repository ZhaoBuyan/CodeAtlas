/**
 * 语言 profile 的"死节点名"审计：profile 里声明的每个节点名，**语法包里必须真的存在**。
 *   node tests/probe-profile-nodes.mjs
 *
 * 为什么需要它：profile 是**手写**的节点名表（从语法树实测抄下来的）。语法包一升级改名，
 * 或者当初就抄错了，那条声明就**永远不会命中** —— 而它不会报错、不会让测试变红，
 * 只会让一个功能静默失效。2026-09-24 第一次跑这个审计就查出 **13 个**：
 *   · Lua：`function_definition_statement` / `local_function` / `local_variable_declaration`
 *     三个名字语法包里都没有 → fixture 里两个顶层函数**一个都没进成员表**
 *   · Kotlin：`constructor_declaration` 是 Java 的名字 → 构造器全丢（`Shape(ctor)` / `Circle(ctor)`）
 *   · Swift：`extension_declaration` / `actor_declaration` / `inheritance_clause` /
 *     `type_inheritance_clause` / `case_statement` 五个都没有 → 其中 `case_statement` 让每个
 *     case 都不计入复杂度（另四个已有等效条目兜住，属冗余噪声）
 *   · C#：`case_switch_label` → 每个 case 不计入复杂度；`record_struct_declaration` 冗余
 *   · Go：`case_clause` → 每个 case 不计入复杂度（真正的名字是 expression_case 等四个）
 *   · Scala：`binary_expression` → `&&` / `||` 从来没被计过（真名是 `infix_expression`）
 *
 * 怎么用：换了语法包来源 / 升了 tree-sitter-wasm 版本之后跑一次，输出应为 **0 个**。
 * 注意它**不在测试套件里**：这个脚本会一次加载全部语法包，而 run-fixtures.mjs 开头记过
 * "同一个进程里装多了语法包会崩" 的老问题 —— 审计归审计，别把风险塞进回归门。
 */
import { Parser, Language } from 'web-tree-sitter';
import { LANGUAGES, resolveWasm } from '../src/languages.mjs';

await Parser.init();

/** profile 里所有"值应当是语法包节点名"的位置（钩子函数、字段名、运算符不在内） */
const SLOTS = [
  ['types', (p) => Object.keys(p.types || {})],
  ['members', (p) => Object.keys(p.members || {})],
  ['namespaces', (p) => Object.keys(p.namespaces || {})],
  ['imports', (p) => Object.keys(p.imports || {})],
  ['onDemandTypes', (p) => Object.keys(p.onDemandTypes || {})],
  ['refTypes', (p) => p.refTypes || []],
  ['baseNodes', (p) => p.baseNodes || []],
  ['decisions', (p) => p.decisions || []],
  ['decisionOpNodes', (p) => p.decisionOpNodes || []],
  ['fileScopedNamespaces', (p) => p.fileScopedNamespaces || []],
  ['typeGuards', (p) => Object.keys(p.typeGuards || {})],
  ['memberGuards', (p) => Object.keys(p.memberGuards || {})],
  ['typeSkipParent', (p) => Object.keys(p.typeSkipParent || {}).concat(Object.values(p.typeSkipParent || {}).flat())],
];

let checked = 0, badLangs = 0, failedLoad = 0;
const allMiss = [];
for (const [id, prof] of Object.entries(LANGUAGES)) {
  if (!prof.wasm) continue;
  let names;
  try {
    const language = await Language.load(resolveWasm(prof));
    names = new Set();
    for (let i = 0; i < language.nodeTypeCount; i++) {
      try { names.add(language.nodeTypeForId(i)); } catch { /* 个别 id 取不到名字，跳过 */ }
    }
  } catch (e) {
    failedLoad++;
    console.log(`⚠ ${id}：语法包加载失败（${String(e && e.message || e).slice(0, 60)}）—— 这门没查`);
    continue;
  }
  checked++;
  const miss = [];
  for (const [slot, get] of SLOTS) {
    for (const nm of get(prof)) {
      if (!nm || typeof nm !== 'string') continue;
      if (!names.has(nm)) miss.push(`${slot}:${nm}`);
    }
  }
  if (miss.length) {
    badLangs++;
    console.log(`✗ ${id}（语法包 ${names.size} 个节点名）查无此名 ${miss.length} 个：`);
    for (const m of miss) console.log(`      ${m}`);
    allMiss.push(...miss.map((m) => `${id}/${m}`));
  }
}

console.log(`\n查了 ${checked} 门语言${failedLoad ? `（另有 ${failedLoad} 门语法包没加载起来）` : ''}；` +
  (badLangs ? `**${badLangs} 门有查无此名的声明**（共 ${allMiss.length} 处）` : '**全部节点名都在语法包里** ✓'));
process.exitCode = badLangs ? 1 : 0;
