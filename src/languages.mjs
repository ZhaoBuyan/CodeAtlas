/**
 * 语言配置表 —— 引擎通用，语言在这里描述。
 *
 * 每加一门语言只需要在这里加一份 profile：
 *   exts        文件后缀
 *   wasm        tree-sitter 语法（相对 WASM_ROOTS 的路径，如 'ruby/tree-sitter-ruby.wasm'）；用 resolveWasm() 解析
 *   namespaces  命名空间/包 节点类型
 *   fileScopedNamespaces  其中"作用到文件后续全部声明"的那几种（C# 10 的 `namespace X;`）——
 *               新版 C# 语法里 file_scoped_namespace_declaration 只包住名字，
 *               后面的类型声明是它的**兄弟节点**，不能当普通块来处理
 *   types       类型声明节点类型 -> 类别名
 *   members     成员声明节点类型 -> 类别名
 *   imports     导入语句节点类型
 *   baseFields  继承信息所在字段名
 *   baseNodes   继承信息所在子节点类型
 *   decisions   复杂度估算要数的分支节点
 *   decisionOps 只有这些运算符的 binary_expression 才算分支
 *
 * 可选钩子（节点名表达不了的写法才用得上）：nameOf / kindOf / typeKindFn / memberKindOf /
 *   membersOf（一个节点→多个成员，如 Ruby 的 attr_accessor :a, :b）/ importKindOf / importTextOf /
 *   isDecision / skipNameNodes / docstring。注意：memberKindOf 一旦存在就**完全接管**成员判定，
 *   不再回退静态表（踩过这个坑）——需要两者兼得就用 membersOf 自己兜底。
 *
 * 成员/类型签名（参数表 + 返回类型，就是 `symbol` 里那个 `foo(int, string): bool`）：扫描器有一套
 * 通用规则（见 scan.mjs 的 declSignature），绝大多数语言不用配。配不出来的才用这几个钩子——
 *   paramsOf(node)       → 参数表**节点**（不是文本）；如 Elixir 的参数藏在内层 call 里
 *   paramFields          → 改字段名单（默认 parameters / parameter_list / params）
 *   paramNodes           → 额外认的"参数表节点名"
 *   returnTypeOf(node)   → 返回类型节点；returnFields → 改字段名单（默认 returns / return_type / result / type）
 * 钩子一律返回节点，没找到返回 null（"没找到"与"没有"是两回事，宁可空着）。
 *
 * status: 'ok' 已实测过 / 'wip' 配置写好但未验证
 * 注意：每种语言的语法节点名要以实际语法为准（tests/fixtures 会跑回归）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ENGINE_ROOT = path.join(HERE, '..');

/**
 * 语法包目录（按顺序找）：
 *   ① node_modules/tree-sitter-wasm/out —— 主来源（105 个语法包；布局是 <语言>/tree-sitter-<语言>.wasm）
 *   ② vendor/wasm                       —— 上游没有现成 wasm 的，自己编或从别的包取（目前：TLA+ / SystemRDL）
 * 换了运行时（web-tree-sitter 0.27）之后，旧的 tree-sitter-wasms@0.1.13（ABI 14）已不能加载，不再使用。
 */
export const WASM_ROOTS = [
  path.join(ENGINE_ROOT, 'node_modules', 'tree-sitter-wasm', 'out'),
  path.join(ENGINE_ROOT, 'vendor', 'wasm'),
];

/** profile.wasm → 绝对路径（打包脚本用同一套规则，别在两处各写一份） */
export function resolveWasm(profile, roots = WASM_ROOTS) {
  const cands = roots.map((root) => path.join(root, profile.wasm));
  return cands.find((p) => fs.existsSync(p)) || cands[0];
}

/** const foo = () => {} / const bar = function () {} —— 是不是"函数赋值" */
// ---------- Elixir 专用：defmodule / def / alias 在语法树里全是 call 节点，只能按“调用的名字”判断 ----------
function elixirCallee(node) {
  if (!node || node.type !== 'call') return null;
  const target = node.childForFieldName('target') || node.namedChildren[0];
  return target && target.type === 'identifier' ? target.text : null;
}
function elixirName(node) {
  const callee = elixirCallee(node);
  if (!callee) return null;
  const args = node.namedChildren.find((c) => c.type === 'arguments');
  const first = args && args.namedChildren[0];
  if (!first) return null;
  if (callee === 'defmodule') {
    // 取最后一段当名字（Shape.Utils → Utils）：解析器是按名字/全名匹配的，带前缀会匹配不上
    if (first.type !== 'alias') return null;
    const t = first.text;
    const dot = t.lastIndexOf('.');
    return dot >= 0 ? t.slice(dot + 1) : t;
  }
  if (callee.startsWith('def')) {
    if (first.type === 'identifier') return first.text;
    if (first.type === 'call') return elixirCallee(first);   // def area(x) → 名字在里层的 call 上
    return null;
  }
  return null;
}
const elixirKind = (node) => (elixirCallee(node) === 'defmodule' ? 'module' : null);
function elixirMemberKind(node) {
  const c = elixirCallee(node);
  if (!c) return null;
  if (['def', 'defp', 'defmacro', 'defmacrop', 'defdelegate'].includes(c)) return 'function';
  if (c === 'defstruct') return 'struct';
  if (c === 'defprotocol' || c === 'defimpl') return 'protocol';
  return null;
}
const elixirImportKind = (node) => (['alias', 'import', 'use', 'require'].includes(elixirCallee(node)) ? 'import' : null);
/** `use` / `import` 树按**顶层**逗号切（嵌套花括号里的逗号不算分隔符） */
export function splitTopLevel(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * 展开 `a::{b, c::{d, e}, f as g, self}` / `a.{b, c}` 这类**花括号树** → 每条完整路径。
 * 别名（`as x`）去掉（匹配用的是路径）、`self` 与通配 `*` 归到模块前缀本身。
 * 谁在用：Rust 的 `use`、PHP 的分组 use、Scala 的 `import a.{b, c}`、Elixir 的 `alias Foo.{A, B}`。
 * 为什么：ripgrep 实测里 `use crate::flags::{Category, …}` 被按逗号切成了碎片（404 条 import 里 191 条坏的）；
 * akka 实测里 Scala 的 `import a.{b, c}` 也是一样（30,341 条里 1,859 条坏）。
 */
export function expandUseTree(body) {
  const out = [];
  // **先剥注释**：Rust 的 use 树常常跨几十行、中间还夹着 `//` 注释（rust-analyzer 实测）：
  //   use hir_def::{
  //       import_map,
  //       // FIXME: This is here since some queries take it as input
  //       {GenericParamId, ModuleDefId, TraitId},
  //   },
  // 不剥的话，注释行会和后面那行路径**粘成一段**（`// FIXME…{GenericParamId`），
  // expandUseTree 就会把这堆垃圾当路径吐出去 —— 整条 import 永远对不上任何目标。
  // 剥在这里而不是 parseImports 里：Elixir 的 `alias` 走的是**直达** expandUseTree 的路径，
  // 只在 parseImports 里剥会漏掉它（我第一版就错在那儿）。
  // 只切"行首或前面是空白"的 `//` —— `https://` 这种前面是标识符字符，不动；块注释整段删。
  const cleaned = String(body)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/(^|\s)\/\//);
      return m ? line.slice(0, m.index + m[1].length) : line;
    })
    .join(' ')
    // 折成单行：多行 use 树里的缩进/换行留着只会混进路径
    .replace(/\s+/g, ' ');
  const walk = (part, prefix) => {
    let s = String(part).trim();
    if (!s) return;
    const brace = s.indexOf('{');
    if (brace < 0) {
      s = s.replace(/\s+as\s+\S+$/, '').replace(/\s*=>\s*\S+$/, '').trim();   // `a::b as c` / Scala 的 `a => c`
      const bare = prefix.replace(/[:\/.]+$/, '');
      if (s === 'self' || s === '*') { if (bare) out.push(bare); return; }
      if (!s) return;
      out.push((prefix + s).trim());
      return;
    }
    const close = s.lastIndexOf('}');
    if (close < brace) { out.push((prefix + s).trim()); return; }   // 括号不配对的残句：原样留一条，绝不静默丢
    const head = s.slice(0, brace);
    for (const piece of splitTopLevel(s.slice(brace + 1, close))) walk(piece, prefix + head);
  };
  walk(cleaned, '');
  return out;
}

/** 导入名要剥掉关键字：alias Shape.Utils → Shape.Utils（否则解析器拿着 "alias Shape.Utils" 匹配不上） */
const elixirImportText = (node) => {
  const args = node.namedChildren.find((c) => c.type === 'arguments');
  const first = args && args.namedChildren[0];
  if (!first) return '';
  const t = first.text;
  const lastSeg = (s) => { const d = s.lastIndexOf('.'); return d >= 0 ? s.slice(d + 1) : s; };
  // 花括号（`alias Foo.{Bar, Baz}`）逐条展开 —— 不展开的话第一条是碎片 `{Bar`（phoenix 实测）
  if (t.includes('{')) {
    const parts = expandUseTree(t).map((p) => lastSeg(p.trim())).filter(Boolean);
    return parts.length ? parts : '';
  }
  // 只取最后一段（Shape.Utils → Utils）：跟类型名字保持一致，解析器才匹配得上
  return lastSeg(t);
};

const elixirIsDecision = (node) => {
  const c = elixirCallee(node);
  if (!c || !/^[a-z]/.test(c)) return false;   // 模块属性等（@doc）不要算进来
  return ['if', 'unless', 'case', 'cond', 'with', 'for', 'try', 'receive'].includes(c);
};
/**
 * Elixir 的参数表藏在内层：`def area(x)` 的语法树是 call(def, arguments(call(area, arguments(x))))。
 * 不带括号的 `def speak do … end` 拿不到参数表 → null（"没抽到"，不假装它没参数）。
 */
const elixirParams = (node) => {
  const outer = node.namedChildren.find((c) => c.type === 'arguments');
  const inner = outer && outer.namedChildren.find((c) => c.type === 'call');
  const args = inner && inner.namedChildren.find((c) => c.type === 'arguments');
  return args || null;
};
/** Emacs Lisp 的参数表是函数声明里**第一个** list 子节点（第二个 list 才是函数体） */
const elispParams = (node) => node.namedChildren.find((c) => c.type === 'list') || null;

/**
 * Lua：依赖都在 `require("a.b")` / `require "a.b"` 调用里 —— 不认的话一个 import 也采不到
 *（kong 实测：1,308 个 Lua 文件、5,905 条跨文件引用，有支撑 0%）。只认函数名就是 `require`、实参是字符串字面量的调用。
 */
const luaImportKind = (node) => {
  if (node.type !== 'function_call') return null;
  const callee = node.namedChildren[0];
  const args = node.namedChildren.find((c) => c.type === 'arguments');
  const first = args && args.namedChildren[0];
  return callee && callee.type === 'identifier' && callee.text === 'require' && first && first.type === 'string' ? 'require' : null;
};

/**
 * Zig：依赖都在 `@import("…")` 里（`@import("std")` 是外部 / `@import("util.zig")` 是仓库内）。
 * zls 实测：102 个文件、1,282 条跨文件引用，有支撑 0%（一条 import 都没采）。
 */
const zigImportKind = (node) => {
  if (node.type !== 'builtin_function') return null;
  const bi = node.namedChildren.find((c) => c.type === 'builtin_identifier');
  const args = node.namedChildren.find((c) => c.type === 'arguments');
  const first = args && args.namedChildren[0];
  return bi && bi.text === '@import' && first && first.type === 'string' ? 'import' : null;
};

/** Elisp：`(require 'foo)` / `(require 'foo "path")` / `(load "foo")` —— 头是 symbol、参数是引用的 symbol 或字符串 */
const elispImportKind = (node) => {
  if (node.type !== 'list') return null;
  const head = node.namedChildren[0];
  if (!head || head.type !== 'symbol') return null;
  return ['require', 'load', 'load-file'].includes(head.text) ? 'require' : null;
};
const elispImportText = (node) => {
  const arg = node.namedChildren[1];
  if (!arg) return '';
  if (arg.type === 'quote') {                          // (require 'foo) → foo
    const s = arg.namedChildren.find((c) => c.type === 'symbol');
    return s ? s.text : '';
  }
  if (arg.type === 'string') {                         // (load "foo.el") → foo.el
    const s = arg.namedChildren.find((c) => c.type === 'string_content');
    return s ? s.text : '';
  }
  return '';
};

function isFunctionAssignment(node) {
  const decl = node.namedChildren.find((c) => c.type === 'variable_declarator');
  if (!decl) return false;
  const value = decl.childForFieldName('value');
  return Boolean(value && ['arrow_function', 'function_expression', 'function'].includes(value.type));
}

/**
 * JS / TS 的 import：除了 `import_statement`，还认 **CommonJS 的 require 调用**
 *（`const x = require('y')` / TS 的 `import x = require('y')`）—— 老 JS 仓库里到处都是。
 * 只认“函数名就是 `require`、且首个实参是字符串字面量”的调用，别的同名调用不碰
 *（实测 axios：不认这一档时 lib/ 里一堆 require 一条也进不来）。
 */
const jsImportKind = (node) => {
  if (node.type === 'import_statement') return 'import';
  if (node.type === 'call_expression') {
    const fn = node.childForFieldName('function');
    const args = node.childForFieldName('arguments');
    const first = args && args.namedChildren[0];
    if (fn && fn.type === 'identifier' && fn.text === 'require' && first && first.type === 'string') return 'require';
  }
  return null;
};

// TS 与 TSX 的语法节点名完全一致（tsx 只是多了 JSX），共用一份
const TS_SHAPE = {
  importKindOf: jsImportKind,
  namespaces: { internal_module: 1 },
  types: {
    class_declaration: 'class',
    abstract_class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    type_alias_declaration: 'type',
    function_declaration: 'function',
    // export const foo = () => {} —— 箭头函数也算"函数"（只在值确实是函数时才算，见 typeGuards）
    lexical_declaration: 'function',
    variable_declaration: 'function',
  },
  typeGuards: {
    lexical_declaration: (node) => isFunctionAssignment(node),
    variable_declaration: (node) => isFunctionAssignment(node),
  },
  skipNameNodes: { required_parameter: 'pattern', optional_parameter: 'pattern', assignment_pattern: 'left', formal_parameters: 'identifier' },
  members: {
    method_definition: 'method',
    method_signature: 'method',
    abstract_method_signature: 'method',
    public_field_definition: 'field',
    property_signature: 'property',
    enum_assignment: 'enumValue',
  },
  imports: { import_statement: 1 },
  baseFields: [],
  baseNodes: ['extends_clause', 'implements_clause'],
  decisions: [
    'if_statement', 'switch_case', 'for_statement', 'for_in_statement',
    'while_statement', 'do_statement', 'catch_clause', 'ternary_expression',
    'binary_expression',
  ],
  decisionOps: ['&&', '||', '??'],
};

// ---------- HCL / Terraform ----------
// 实测结构（2026-09-17）：
//   block = [identifier(块类型) string_lit(标签…) block_start body block_end]
//   attribute = [identifier(属性名) expression]
// 注意 terraform 与 hcl 两个语法包对同一份 .tf 产出的树**一模一样**，选了 hcl（覆盖面更广：.tf/.tfvars/.hcl/.nomad）。
const HCL_KINDS = { resource: 'resource', data: 'data', module: 'module', variable: 'variable', output: 'output', locals: 'locals', terraform: 'terraform' };

/** 只有 block 算类型；块类型（resource / variable / locals …）作为类别 */
const hclKind = (node) => {
  if (node.type !== 'block') return null;
  const head = node.namedChildren[0];
  return (head && head.type === 'identifier' && HCL_KINDS[head.text]) || 'block';
};

/**
 * 取名：block 用**最后一个标签**，attribute 用它自己的标识符。
 *
 * 为什么不用 `aws_instance.web` 这种全地址：引用侧（`data.aws_ami.ubuntu.id` / `aws_instance.web[0]`）
 * 能拆出来的记号只有 `data` `aws_ami` `ubuntu` `id` 这种单段，名字带点就永远对不上 ——
 * 实测：用全地址时 7 个块 0 条边、29 处引用没匹配；改成最后一段后边就出来了（代价：同一份配置里
 * 如果两个块最后一个标签撞名，会算进 ambiguous 计数——那正是这个计数存在的意义）。
 */
const hclName = (node) => {
  if (node.type === 'attribute') {
    const id = node.namedChildren.find((c) => c.type === 'identifier');
    return id ? id.text : null;
  }
  if (node.type !== 'block') return null;
  const labels = node.namedChildren
    .filter((c) => c.type === 'string_lit')
    .map((s) => s.text.replace(/^"|"$/g, ''))
    .filter(Boolean);
  if (labels.length) return labels[labels.length - 1];
  const head = node.namedChildren[0];
  return head && head.type === 'identifier' ? head.text : null;
};

// ---------- GraphQL（SDL）----------
// 实测结构（2026-09-17）：节点在 document → definition → type_system_definition 下面，
// 但走 namedChildren 遍历会自然穿透；**注意 name 是子节点不是字段**（childForFieldName('name') 拿不到），
// 所以取名必须用 nameOf 钩子；"""说明""" 是 description 节点（不是注释）→ 用 docstring 钩子。
const gqlName = (node) => {
  // enum 值的名字深一层：enum_value_definition → enum_value → name（实测，不特殊处理会一个都抽不到）
  if (node.type === 'enum_value_definition') {
    const v = node.namedChildren.find((c) => c.type === 'enum_value');
    const n = v && v.namedChildren.find((c) => c.type === 'name');
    return n ? n.text : null;
  }
  const n = node.namedChildren.find((c) => c.type === 'name');
  if (n) return n.text;
  if (node.type === 'schema_definition') return 'schema';   // 它没有名字，但它是块真正的根声明
  return null;
};

/** """这是说明""" → description 节点 → 取里面的字符串并压成一行 */
const gqlDescription = (node) => {
  const d = node.namedChildren.find((c) => c.type === 'description');
  if (!d) return null;
  return d.text.replace(/^"""|"""$/g, '').replace(/"([^"]*)"/g, '$1');
};

/**
 * 参数与字段在语法树里是同一个节点类型（input_value_definition），靠父节点分：
 *   `latest(limit: Int)` → arguments_definition 下的是**参数**；
 *   `input PostInput { title: String! }` → input_fields_definition 下的是**字段**。
 * 不分的话 Query 的成员表里会出现 limit / after / text 这些参数，看着像字段（实测踩到）。
 */
const gqlMembersOf = (node) => {
  if (node.type !== 'input_value_definition') return null;
  const kind = node.parent && node.parent.type === 'arguments_definition' ? 'argument' : 'field';
  const name = gqlName(node);
  return name ? [{ kind, name }] : null;
};

// ---------- Ruby ----------
// 节点名都是实测出来的（2026-09-17，tests/probe-nodes.mjs + 一份特意写全各种写法的样本）：
//   class / module / method / singleton_method / superclass / call / if / unless / case / while / until / for
// Ruby 的“钩子”只需要两处：属性（attr_* 是一句 call）和导入（require / include 也都是 call）。

/**
 * 一个节点 → 多个成员。为什么需要它：`attr_accessor :a, :b` 在语法树里**一句 call 带两个符号**，
 * 而成员路径上是“一个节点一个成员”，不特殊处理就会只记到第一个（2026-09-17 复查时实测到：b 丢了）。
 * （Ruby 里 attr_accessor 一次声明好几个属性是很常见的写法。）
 */
const rubyMembersOf = (node) => {
  if (node.type === 'call') {
    const m = node.childForFieldName('method');
    if (!m || !/^attr_(reader|writer|accessor)$/.test(m.text)) return null;
    const args = node.childForFieldName('arguments');
    const names = (args ? args.namedChildren : [])
      .filter((a) => a.type === 'simple_symbol')
      .map((a) => a.text.replace(/^:/, ''));
    return names.length ? names.map((n) => ({ kind: 'property', name: n })) : null;
  }
  const kind = { method: 'method', singleton_method: 'method' }[node.type];
  return kind ? [{ kind, name: rubyName(node) }] : null;
};

/** 属性名在参数里（不是 name 字段），所以得单独取：attr_accessor :size → size */
const rubyName = (node) => {
  if (node.type === 'call') {
    const args = node.childForFieldName('arguments');
    const first = args && args.namedChildren.find((a) => a.type === 'simple_symbol');
    return first ? first.text.replace(/^:/, '') : null;
  }
  const n = node.childForFieldName('name');
  return n ? n.text : null;
};

/** require 'json' / require_relative './x' / load 'y' → 依赖；include / extend / prepend → 混入 */
const rubyImportKind = (node) => {
  if (node.type !== 'call') return null;
  const m = node.childForFieldName('method');
  if (!m) return null;
  if (['require', 'require_relative', 'load'].includes(m.text)) return 'require';
  if (['include', 'extend', 'prepend'].includes(m.text)) return 'mixin';
  return null;
};

/**
 * 取第一个参数当目标：`require 'json'` → json；`include Walkable` → Walkable。
 * ⚠ `include` 在 RSpec 里是**同名 matcher**（`expect(x).to include('path=/foo')`）——
 * 实参不是常量就一律不认（实测 sinatra 的 spec 上会采到 18 条 '/foo' '...' 这样的坏串）；
 * `require` 只认字符串字面量（`require "#{x}"` 这种插值不认：路径是动态的）。
 */
const rubyImportText = (node) => {
  const args = node.childForFieldName('arguments');
  const first = args && args.namedChildren[0];
  if (!first) return '';
  const m = node.childForFieldName('method');
  if (m && ['include', 'extend', 'prepend'].includes(m.text)) {
    return first.type === 'constant' || first.type === 'scope_resolution' ? first.text : '';
  }
  if (first.type !== 'string') return '';
  const inner = first.namedChildren.find((c) => c.type === 'string_content');
  return inner ? inner.text : '';
};

// ---------- Dart ----------
/** Dart 的成员：declaration（字段 / 构造函数）、method_signature（方法 / getter / setter）、enum_constant */
const dartMembersOf = (node) => {
  const idOf = (n) => {
    if (!n) return null;
    const hit = n.namedChildren.find((c) => c.type === 'identifier');
    return hit ? hit.text : null;
  };
  if (node.type === 'declaration') {
    // 构造函数（`Circle(this.radius) : super('circle')`）和**抽象方法**（`double area();`）
    // 都是 declaration 里包着一个 *_signature 节点（实测：tests/.probe-dart3.mjs）
    const sig = node.namedChildren.find((c) => /_signature$/.test(c.type));
    if (sig) {
      const name = idOf(sig);
      if (!name) return null;
      return [{ kind: /constructor_signature$/.test(sig.type) ? 'ctor' : 'method', name }];
    }
    const list = node.namedChildren.find((c) => /identifier_list$/.test(c.type));
    if (list) {
      const names = list.namedChildren
        .map((c) => (c.type === 'initialized_identifier' ? idOf(c) : c.type === 'identifier' ? c.text : null))
        .filter(Boolean);
      return names.length ? names.map((n) => ({ kind: 'field', name: n })) : null;
    }
    return null;
  }
  if (node.type === 'method_signature') {
    const sig = node.namedChildren.find((c) => /_signature$/.test(c.type)) || node;
    const name = idOf(sig);
    return name ? [{ kind: 'method', name }] : null;
  }
  if (node.type === 'function_signature') {
    // 只有**顶层**的 function_signature 才算成员（实测：它的父节点是 program）——
    // 方法里 / 抽象方法（declaration 里）的那个已经由 method_signature / declaration 分支记过了
    if (!node.parent || node.parent.type !== 'program') return null;
    const name = idOf(node);
    return name ? [{ kind: 'function', name }] : null;
  }
  if (node.type === 'enum_constant') {
    const name = idOf(node);
    return name ? [{ kind: 'enumValue', name }] : null;
  }
  return null;
};

/** Dart 的类名不是 `name` 字段：class/mixin/extension/enum 取裸 identifier，type_alias 取 type_identifier */
const dartNameOf = (node) => {
  const pick = (t) => {
    const hit = node.namedChildren.find((c) => c.type === t);
    return hit ? hit.text : null;
  };
  switch (node.type) {
    case 'class_definition':
    case 'mixin_declaration':
    case 'extension_declaration':
    case 'enum_declaration':
      return pick('identifier');
    case 'type_alias':
      return pick('type_identifier');
    default:
      return null;
  }
};

/** `import 'a/b.dart' show X;` / `export 'c.dart';` → 取 uri（去掉引号） */
const dartImportText = (node) => {
  let uri = null;
  const w = (n) => {
    if (!uri && n.type === 'uri') uri = n;
    for (const c of n.namedChildren) w(c);
  };
  w(node);
  if (!uri) return '';
  const text = uri.text.replace(/^['"]|['"]$/g, '');
  // mason 砖块模板（bloc 的 bricks/ 里到处是）里的 `{{name.snakeCase()}}` 是占位符、不是真 URI ——
  // 采进来只会变成坏 import（实测 bloc 上 3 条正是它们），模板文件本来就不是有效 Dart。
  return /\{\{|\}\}/.test(text) ? '' : text;
};

/** Dart 的 `export 'package:Y/…'` 要单独认：父进程据此建包级重导出图（多跳 barrel） */
const dartImportKind = (node) => {
  if (node.type !== 'import_or_export') return null;
  return /^\s*export\b/.test(node.text) ? 'export' : 'import';
};

/**
 * `part of '../framework.dart';` / `part of 'package:x/y.dart';` → 取库文件的 uri。
 * 父进程据此把 part 文件归到库：part 文件**不能写 import**，库的 imports 对全库可见；
 * 同一个库里的文件互相引用连 import 都不需要（实测 riverpod：67 个 part 文件、10 个库组，未支撑边的大头）。
 * 旧式 `part of lib.name;`（按库名）也收着 —— 返回名字，父进程按名字分组。
 */
const dartPartOfOf = (node) => {
  if (node.type !== 'part_of_directive') return null;
  const uri = node.namedChildren.find((c) => c.type === 'uri');
  const raw = uri
    ? uri.text.replace(/^['"]|['"]$/g, '')
    : node.text.replace(/^\s*part\s+of\s*/, '').replace(/;\s*$/, '').trim();
  return raw || null;
};

// ---------- Bash ----------
/**
 * Bash 的“import”就是 `source x.sh` / `. x.sh`（nvm 这类脚本仓库的依赖全靠它）。
 * 只认命令名是 source / . 的调用，实参只认**字面量**：变量展开（`source "$DIR/x.sh"`）
 * 与进程替换（`source <(…)`）一律不碰 —— 路径是动态的，猜不得。
 */
const bashImportKind = (node) => {
  if (node.type !== 'command') return null;
  const name = node.namedChildren.find((c) => c.type === 'command_name');
  const t = name ? name.text : '';
  return t === 'source' || t === '.' ? 'source' : null;
};
const bashImportText = (node) => {
  const first = node.namedChildren.find((c) => c.type !== 'command_name');
  if (!first) return '';
  if (first.type === 'word') return first.text;
  if (first.type === 'string') {
    if (first.namedChildren.some((c) => c.type !== 'string_content')) return '';   // 有插值 → 不认
    const inner = first.namedChildren.find((c) => c.type === 'string_content');
    return inner ? inner.text : '';
  }
  return '';
};

/** Dart 的签名都包在 *_signature 里（declaration 与 method_signature 都可能包着一层） */
const dartSigNode = (node) => {
  if (node.type === 'declaration' || node.type === 'method_signature') {
    return node.namedChildren.find((c) => /_signature$/.test(c.type)) || node;
  }
  return node;
};

/** Dart：参数表是 formal_parameter_list（通用参数表名单里没这个节点名） */
const dartParamsOf = (node) => dartSigNode(node).namedChildren.find((c) => c.type === 'formal_parameter_list') || null;

/** Dart：返回类型写在名字**前面**（通用现则③找的是参数表后面，够不着） */
const dartReturnTypeOf = (node) => {
  const sig = dartSigNode(node);
  const TYPEY = new Set(['type_identifier', 'void_type', 'function_type', 'nullable_type', 'record_type']);
  const kids = sig.namedChildren;
  const stop = kids.findIndex((c) => c.type === 'identifier' || /identifier_list$/.test(c.type));
  const upto = stop < 0 ? kids.length : stop;
  for (let i = 0; i < upto; i++) if (TYPEY.has(kids[i].type)) return kids[i];
  return null;
};

export const LANGUAGES = {
  csharp: {
    id: 'csharp',
    label: 'C#',
    status: 'ok',
    exts: ['.cs'],
    wasm: 'c_sharp/tree-sitter-c_sharp.wasm',
    // 2026-09-17 升级语法包后，五条改写里四条不再需要（新语法原生认得原始字符串 / 主构造函数 /
    // file 修饰符 / void* 等，12 项实测均 0 ERROR）。只剩「局部变量名叫 required」还必须改：
    // 新旧语法都会把 `required = 1;` 里的 required 当修饰符关键字 → 整句 ERROR（真项目实测 3 处）。
    // preprocess.mjs 里的 csharp() 已经收窄成只做这一条。
    preprocess: 'csharp',
    // 参数名的标识符不算"引用"（否则参数名与类型重名时会产生假依赖）
    skipNameNodes: { parameter: 'name' },
    namespaces: { namespace_declaration: 1, file_scoped_namespace_declaration: 1 },
    // C# 10 的 `namespace Foo;`：整份文件都属于它。新版语法里它只包住名字，
    // 后面的类型是兄弟节点（旧语法是包在里面的）——不声明这条，所有类型都会落到 (global)。
    fileScopedNamespaces: ['file_scoped_namespace_declaration'],
    types: {
      class_declaration: 'class',
      interface_declaration: 'interface',
      struct_declaration: 'struct',
      record_declaration: 'record',
      record_struct_declaration: 'record',
      enum_declaration: 'enum',
      delegate_declaration: 'delegate',
    },
    members: {
      method_declaration: 'method',
      constructor_declaration: 'ctor',
      destructor_declaration: 'dtor',
      property_declaration: 'property',
      field_declaration: 'field',
      event_declaration: 'event',
      indexer_declaration: 'indexer',
      operator_declaration: 'operator',
      enum_member_declaration: 'enumValue',
    },
    imports: { using_directive: 1 },
    // 旧语法包把继承列表放在 base_list 字段里；换成 tree-sitter-wasm@2.0.1 的 C# 语法后
    // base_list 变成普通子节点（childForFieldName('bases') 取不到了），改走 baseNodes。
    baseFields: [],
    baseNodes: ['base_list'],
    decisions: [
      'if_statement', 'switch_statement', 'for_statement', 'foreach_statement',
      'while_statement', 'do_statement', 'catch_clause', 'conditional_expression',
      'switch_expression', 'case_switch_label', 'binary_expression',
    ],
    decisionOps: ['&&', '||', '??'],
  },

  typescript: { id: 'typescript', label: 'TypeScript', status: 'ok', exts: ['.ts', '.mts', '.cts'], wasm: 'typescript/tree-sitter-typescript.wasm', ...TS_SHAPE },
  // .tsx 必须用 tsx 语法：typescript 语法不认 JSX
  tsx: { id: 'tsx', label: 'TSX', status: 'ok', exts: ['.tsx'], wasm: 'tsx/tree-sitter-tsx.wasm', ...TS_SHAPE },
  // .vue：只解析 <script> / <script setup>（模板、样式不看），语法借 TSX（TS + JSX 的超集，覆盖更全）；
  // 不引 vue 语法包 —— 它的 wasm 在本运行时里一解析就 abort。行号靠 preprocess 逐字节对齐。
  vue: { id: 'vue', label: 'Vue', status: 'ok', exts: ['.vue'], wasm: 'tsx/tree-sitter-tsx.wasm', preprocess: 'vue', ...TS_SHAPE },

  javascript: {
    id: 'javascript',
    label: 'JavaScript',
    status: 'ok',
    exts: ['.js', '.mjs', '.cjs', '.jsx'],
    wasm: 'javascript/tree-sitter-javascript.wasm',
    namespaces: {},
    types: {
      class_declaration: 'class',
      function_declaration: 'function',
      // export const foo = () => {} —— 箭头函数也算"函数"
      lexical_declaration: 'function',
      variable_declaration: 'function',
    },
    typeGuards: {
      lexical_declaration: (node) => isFunctionAssignment(node),
      variable_declaration: (node) => isFunctionAssignment(node),
    },
    skipNameNodes: { required_parameter: 'pattern', optional_parameter: 'pattern', assignment_pattern: 'left', formal_parameters: 'identifier' },
    members: {
      method_definition: 'method',
      field_definition: 'field',
    },
    imports: { import_statement: 1 },
    importKindOf: jsImportKind,
    baseFields: [],
    baseNodes: ['class_heritage'],
    decisions: [
      'if_statement', 'switch_case', 'for_statement', 'for_in_statement',
      'while_statement', 'do_statement', 'catch_clause', 'ternary_expression',
      'binary_expression',
    ],
    decisionOps: ['&&', '||', '??'],
  },

  java: {
    id: 'java',
    label: 'Java',
    status: 'ok',
    exts: ['.java'],
    wasm: 'java/tree-sitter-java.wasm',
    namespaces: { package_declaration: 1 },
    namespaceScope: 'file',
    types: {
      class_declaration: 'class',
      interface_declaration: 'interface',
      enum_declaration: 'enum',
      record_declaration: 'record',
      annotation_type_declaration: 'annotation',
    },
    members: {
      method_declaration: 'method',
      constructor_declaration: 'ctor',
      field_declaration: 'field',
      enum_constant: 'enumValue',
    },
    imports: { import_declaration: 1 },
    baseFields: ['superclass', 'interfaces'],
    baseNodes: [],
    skipNameNodes: { formal_parameter: 'name', spread_parameter: 'name' },
    decisions: [
      'if_statement', 'switch_expression', 'switch_label', 'for_statement',
      'enhanced_for_statement', 'while_statement', 'do_statement', 'catch_clause',
      'ternary_expression', 'binary_expression',
    ],
    decisionOps: ['&&', '||'],
  },

  python: {
    id: 'python',
    label: 'Python',
    status: 'ok',
    exts: ['.py'],
    wasm: 'python/tree-sitter-python.wasm',
    docstring: true,
    namespaces: {},
    types: { class_definition: 'class' },
    members: {
      function_definition: 'function',
      assignment: 'field',
    },
    imports: { import_statement: 1, import_from_statement: 1 },
    baseFields: ['superclasses'],
    baseNodes: [],
    skipNameNodes: { typed_parameter: 'name', default_parameter: 'name', parameters: 'identifier' },
    decisions: [
      'if_statement', 'elif_clause', 'for_statement', 'while_statement',
      'except_clause', 'conditional_expression', 'boolean_operator',
    ],
    decisionOps: [],
  },

  kotlin: {
    id: 'kotlin',
    label: 'Kotlin',
    status: 'ok',
    exts: ['.kt', '.kts'],
    wasm: 'kotlin/tree-sitter-kotlin.wasm',
    namespaces: { package_header: 1 },
    namespaceScope: 'file',
    types: {
      class_declaration: 'class',
      object_declaration: 'object',
    },
    members: {
      function_declaration: 'function',
      property_declaration: 'property',
      constructor_declaration: 'ctor',
      enum_entry: 'enumValue',
    },
    imports: { import_header: 1 },
    baseFields: [],
    baseNodes: ['delegation_specifier'],
    decisions: ['if_expression', 'when_expression', 'for_statement', 'while_statement', 'try_expression', 'catch_block'],
    decisionOps: [],
  },

  // ---------- Dart ----------
  // 节点名都是实测出来的（2026-09-23，tests/probe-nodes.mjs --wasm dart/…）：
  //   class_definition / mixin_declaration / extension_declaration / enum_declaration / type_alias
  //   class_body 里的成员：declaration（字段 / 构造函数）、method_signature（方法 / getter / setter）
  //   import_or_export → library_import → import_specification → configurable_uri → uri
  // 两个坑：① 类名不是 `name` 字段（是裸 identifier / type_identifier 子节点）；② 一句 declaration 可能声明多个字段。
  dart: {
    id: 'dart',
    label: 'Dart',
    status: 'ok',
    exts: ['.dart'],
    wasm: 'dart/tree-sitter-dart.wasm',
    namespaces: {},
    types: {
      class_definition: 'class',
      mixin_declaration: 'mixin',
      extension_declaration: 'extension',
      enum_declaration: 'enum',
      type_alias: 'typedef',
    },
    members: {
      method_signature: 'method',
      declaration: 'field',
      enum_constant: 'enumValue',
    },
    membersOf: dartMembersOf,
    nameOf: dartNameOf,
    paramsOf: dartParamsOf,
    returnTypeOf: dartReturnTypeOf,
    imports: { import_or_export: 1 },
    importKindOf: dartImportKind,
    importTextOf: dartImportText,
    partOfOf: dartPartOfOf,
    baseFields: ['superclass'],
    baseNodes: [],
    decisions: ['if_statement', 'switch_statement', 'for_statement', 'while_statement', 'do_statement', 'try_statement', 'catch_clause'],
    decisionOps: [],
  },

  lua: {    id: 'lua',
    label: 'Lua',
    status: 'ok',
    exts: ['.lua'],
    wasm: 'lua/tree-sitter-lua.wasm',
    namespaces: {},
    // Lua 没有类型系统，落到"函数"一级（文件会合成一个模块节点）
    types: {},
    members: {
      function_definition_statement: 'function',
      function_definition: 'function',
      local_function: 'function',
      variable_declaration: 'field',
      local_variable_declaration: 'field',
    },
    imports: {},
    importKindOf: luaImportKind,
    baseFields: [],
    baseNodes: [],
    decisions: ['if_statement', 'elseif_statement', 'for_statement', 'while_statement', 'repeat_statement'],
    decisionOps: [],
  },

  bash: {
    id: 'bash',
    label: 'Shell',
    status: 'ok',
    exts: ['.sh', '.bash', '.zsh'],
    wasm: 'bash/tree-sitter-bash.wasm',
    namespaces: {},
    types: {},
    members: {
      function_definition: 'function',
      variable_assignment: 'var',
      declaration_command: 'var',
    },
    imports: {},
    importKindOf: bashImportKind,
    importTextOf: bashImportText,
    // 命令名（`foo x` 里的 foo）算引用 —— bash 的函数调用就是命令，不认它跨文件一条边也没有
    refTypes: ['command_name'],
    baseFields: [],
    baseNodes: [],
    decisions: ['if_statement', 'for_statement', 'while_statement', 'case_statement', 'binary_expression'],
    decisionOps: ['&&', '||'],
  },

  zig: {
    id: 'zig',
    label: 'Zig',
    status: 'ok',
    exts: ['.zig'],
    wasm: 'zig/tree-sitter-zig.wasm',
    namespaces: {},
    // Zig 的类型写在 const X = struct/enum {...}，名称在父节点上（扫描器已支持）
    types: {
      struct_declaration: 'struct',
      enum_declaration: 'enum',
      union_declaration: 'union',
    },
    members: {
      function_declaration: 'function',
      container_field: 'field',
      variable_declaration: 'const',
      test_declaration: 'function',
    },
    imports: {},
    importKindOf: zigImportKind,
    baseFields: [],
    baseNodes: [],
    decisions: ['if_statement', 'while_statement', 'for_statement', 'switch_expression', 'binary_expression'],
    decisionOps: ['and', 'or'],
  },

  solidity: {
    id: 'solidity',
    label: 'Solidity',
    status: 'ok',
    exts: ['.sol'],
    wasm: 'solidity/tree-sitter-solidity.wasm',
    namespaces: {},
    types: {
      contract_declaration: 'contract',
      interface_declaration: 'interface',
      library_declaration: 'library',
    },
    members: {
      function_definition: 'function',
      constructor_definition: 'ctor',
      modifier_definition: 'modifier',
      state_variable_declaration: 'field',
      event_definition: 'event',
      struct_declaration: 'struct',
      enum_declaration: 'enum',
    },
    imports: { import_directive: 1 },
    baseFields: [],
    baseNodes: ['inheritance_specifier'],
    decisions: ['if_statement', 'for_statement', 'while_statement', 'do_while_statement', 'ternary_expression', 'binary_expression'],
    decisionOps: ['&&', '||'],
  },

  ocaml: {
    id: 'ocaml',
    label: 'OCaml',
    status: 'ok',
    exts: ['.ml', '.mli'],
    wasm: 'ocaml/tree-sitter-ocaml.wasm',
    namespaces: {},
    types: {
      type_definition: 'type',
      module_definition: 'module',
      exception_definition: 'exception',
    },
    members: {
      value_definition: 'value',
      constructor_declaration: 'enumValue',
      field_declaration: 'field',
    },
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: ['if_expression', 'match_expression', 'match_case', 'for_expression', 'while_expression', 'infix_expression'],
    decisionOps: ['&&', '||'],
  },

  // 下面四门的节点名都是从 tests/probe-nodes.mjs 实测出来的（不猜）
  rescript: {
    id: 'rescript',
    label: 'ReScript',
    status: 'ok',
    exts: ['.res'],
    wasm: 'rescript/tree-sitter-rescript.wasm',
    namespaces: {},
    types: {
      module_declaration: 'module',
      type_declaration: 'type',
    },
    members: {
      let_declaration: 'value',
      variant_declaration: 'enumValue',
    },
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: ['if_expression', 'switch_expression', 'switch_match', 'binary_expression'],
    decisionOps: ['&&', '||'],
  },

  tlaplus: {
    id: 'tlaplus',
    label: 'TLA+',
    status: 'ok',
    exts: ['.tla'],
    wasm: 'tree-sitter-tlaplus.wasm',
    namespaces: {},
    types: {
      module: 'module',
    },
    members: {
      operator_definition: 'operator',
      variable_declaration: 'variable',
      constant_declaration: 'constant',
    },
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: ['/\\', '\\/'],
  },

  // SystemRDL（2026-09-17 补回）：上游没有任何现成的 wasm（npm 包只有 C 源、GitHub 0 个 release），
  // 所以这份是**我们自己编的**（emsdk 预编译的 clang + wasm-ld，不需要 emcc/python），放在 `vendor/wasm/`。
  // 编法：clang --target=wasm32-unknown-emscripten -O3 -fPIC -mbulk-memory -c parser.c
  //   → wasm-ld --no-entry --experimental-pic --shared --import-memory --import-table --allow-undefined
  //     --export=tree_sitter_systemrdl --export=__wasm_apply_data_relocs
  // 编出来是 ABI 13；0.27 的 MIN_COMPATIBLE 就是 13（源码实证），已实测能加载能解析
  //（形状与包里那 105 门一致：导出 tree_sitter_X + __wasm_apply_data_relocs，只 import env 的内存/表）。
  systemrdl: {
    id: 'systemrdl',
    label: 'SystemRDL',
    status: 'ok',
    exts: ['.rdl'],
    wasm: 'tree-sitter-systemrdl.wasm',
    namespaces: {},
    types: { component_named_def: 'component', component_anon_def: 'component' },
    members: { component_inst: 'instance', property_assignment: 'property', explicit_prop_assignment: 'property' },
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: [],
  },

  // Emacs Lisp：没有“类型”这回事，顶层全是函数/变量 → 都挂到扫描器合成的 module 节点上
  elisp: {
    id: 'elisp',
    label: 'Emacs Lisp',
    status: 'ok',
    exts: ['.el'],
    wasm: 'elisp/tree-sitter-elisp.wasm',
    namespaces: {},
    types: {},
    members: {
      function_definition: 'function',
      special_form: 'value',
    },
    paramsOf: elispParams,
    imports: {},
    importKindOf: elispImportKind,
    importTextOf: elispImportText,
    // Elisp 的引用就是 symbol（`(helper x)` 里的 helper）；函数名本身不算（声明处）
    refTypes: ['symbol'],
    skipNameNodes: { function_definition: 'name' },
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: [],
  },

  // 说明：C / C++ / Go / Rust / Scala 的顶层函数走"文件作用域成员"，会归到
  //       扫描器自动合成的 module 节点上（这些语言本来就是以文件为单位组织的）。
  // ===========================================================================

  go: {
    id: 'go',
    label: 'Go',
    status: 'ok',
    exts: ['.go'],
    wasm: 'go/tree-sitter-go.wasm',
    namespaces: { package_clause: 1 },
    namespaceScope: 'file',
    types: { type_declaration: 'type' },
    // type_declaration 下面包着 type_spec，kind 要看 type_spec 的 type 字段
    typeKindFn: (node) => {
      const spec = node.namedChildren.find((c) => c.type === 'type_spec');
      const t = spec && spec.childForFieldName('type');
      if (t && t.type === 'struct_type') return 'struct';
      if (t && t.type === 'interface_type') return 'interface';
      return 'type';
    },
    members: {
      method_declaration: 'method',
      function_declaration: 'function',
      field_declaration: 'field',
      const_declaration: 'const',
      var_declaration: 'var',
    },
    imports: { import_declaration: 1 },
    baseFields: [],
    baseNodes: [],
    decisions: ['if_statement', 'for_statement', 'expression_switch_statement', 'type_switch_statement', 'select_statement', 'case_clause', 'binary_expression'],
    decisionOps: ['&&', '||'],
  },

  rust: {
    id: 'rust',
    label: 'Rust',
    status: 'ok',
    exts: ['.rs'],
    wasm: 'rust/tree-sitter-rust.wasm',
    namespaces: {},
    types: { struct_item: 'struct', enum_item: 'enum', trait_item: 'trait', impl_item: 'impl', union_item: 'union', type_item: 'type' },
    members: {
      function_item: 'function',
      function_signature_item: 'function',
      field_declaration: 'field',
      enum_variant: 'enumValue',
      const_item: 'const',
      static_item: 'static',
    },
    imports: { use_declaration: 1 },
    baseFields: [],
    baseNodes: [],
    // impl_item 的名字取它实现的类型（field 'type'），这样方法就挂在同名节点下
    nameFromField: { impl_item: 'type' },
    decisions: ['if_expression', 'match_expression', 'match_arm', 'for_expression', 'while_expression', 'loop_expression', 'binary_expression'],
    decisionOps: ['&&', '||'],
  },

  c: {
    id: 'c',
    label: 'C',
    status: 'ok',
    exts: ['.c', '.h'],
    wasm: 'c/tree-sitter-c.wasm',
    namespaces: {},
    types: { type_definition: 'type', struct_specifier: 'struct', enum_specifier: 'enum', union_specifier: 'union' },
    // typedef struct X {...} X; 会让 struct_specifier 成为 type_definition 的子节点，别重复记
    typeSkipParent: { struct_specifier: ['type_definition'], enum_specifier: ['type_definition'], union_specifier: ['type_definition'] },
    members: { function_definition: 'function', declaration: 'field', field_declaration: 'field', enumerator: 'enumValue' },
    imports: { preproc_include: 1 },
    baseFields: [],
    baseNodes: [],
    decisions: ['if_statement', 'for_statement', 'while_statement', 'do_statement', 'switch_statement', 'case_statement', 'binary_expression'],
    decisionOps: ['&&', '||'],
  },

  cpp: {
    id: 'cpp',
    label: 'C++',
    status: 'ok',
    exts: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx'],
    wasm: 'cpp/tree-sitter-cpp.wasm',
    namespaces: { namespace_definition: 1 },
    types: { class_specifier: 'class', struct_specifier: 'struct', enum_specifier: 'enum', union_specifier: 'union' },
    typeSkipParent: { struct_specifier: ['type_definition', 'class_specifier'], enum_specifier: ['type_definition'], union_specifier: ['type_definition'] },
    members: { function_definition: 'function', field_declaration: 'field', declaration: 'field', enumerator: 'enumValue' },
    imports: { preproc_include: 1 },
    baseFields: [],
    baseNodes: ['base_class_clause'],
    decisions: ['if_statement', 'for_statement', 'while_statement', 'do_statement', 'switch_statement', 'case_statement', 'catch_clause', 'conditional_expression', 'binary_expression'],
    decisionOps: ['&&', '||'],
  },

  php: {
    id: 'php',
    label: 'PHP',
    status: 'ok',
    exts: ['.php'],
    wasm: 'php/tree-sitter-php.wasm',
    namespaces: { namespace_definition: 1 },
    namespaceScope: 'file',
    types: { class_declaration: 'class', interface_declaration: 'interface', trait_declaration: 'trait', enum_declaration: 'enum' },
    members: {
      method_declaration: 'method',
      function_definition: 'function',
      property_declaration: 'property',
      const_declaration: 'const',
      enum_case: 'enumValue',
    },
    imports: { namespace_use_declaration: 1 },
    // 类型引用在这个语法里是 `name` / `qualified_name`（不像别的语言叫 identifier / type_identifier）——
    // 不加这两类就一个引用也采不到（实测 guzzle：132 个文件、0 条 ref 边）。
    refTypes: ['name', 'qualified_name'],
    // 但声明处的名字也是 `name` —— 那些不算引用
    skipNameNodes: {
      class_declaration: 'name', interface_declaration: 'name', trait_declaration: 'name', enum_declaration: 'name',
      method_declaration: 'name', function_definition: 'name', enum_case: 'name', const_element: 'name',
      namespace_definition: 'name',
    },
    baseFields: [],
    baseNodes: ['base_clause', 'class_interface_clause'],
    decisions: ['if_statement', 'for_statement', 'foreach_statement', 'while_statement', 'switch_statement', 'case_statement', 'match_expression', 'catch_clause', 'conditional_expression', 'binary_expression'],
    decisionOps: ['&&', '||', 'and', 'or', '??'],
  },

  swift: {
    id: 'swift',
    label: 'Swift',
    status: 'ok',
    exts: ['.swift'],
    wasm: 'swift/tree-sitter-swift.wasm',
    namespaces: {},
    types: {
      class_declaration: 'class',
      protocol_declaration: 'protocol',
      extension_declaration: 'extension',
      actor_declaration: 'class',
    },
    // Swift 语法把 class / struct / enum / protocol / extension 都归成 class_declaration，
    // 靠第一个子 token 的关键字区分
    typeKindFn: (node) => {
      const kw = node.child(0) && node.child(0).text;
      if (kw === 'struct') return 'struct';
      if (kw === 'enum') return 'enum';
      if (kw === 'protocol') return 'protocol';
      if (kw === 'extension') return 'extension';
      return 'class';
    },
    members: {
      function_declaration: 'function',
      property_declaration: 'property',
      init_declaration: 'ctor',
      enum_entry: 'enumValue',
      typealias_declaration: 'type',
    },
    imports: { import_declaration: 1 },
    baseFields: [],
    baseNodes: ['inheritance_specifier', 'inheritance_clause', 'type_inheritance_clause'],
    decisions: ['if_statement', 'guard_statement', 'for_statement', 'while_statement', 'repeat_while_statement', 'switch_statement', 'case_statement', 'catch_block', 'ternary_expression', 'conjunction_expression', 'disjunction_expression'],
    decisionOps: [],
  },

  scala: {
    id: 'scala',
    label: 'Scala',
    status: 'ok',
    exts: ['.scala', '.sc'],
    wasm: 'scala/tree-sitter-scala.wasm',
    namespaces: { package_clause: 1 },
    namespaceScope: 'file',
    types: { class_definition: 'class', object_definition: 'object', trait_definition: 'trait', enum_definition: 'enum' },
    members: {
      function_definition: 'function',
      val_definition: 'field',
      var_definition: 'field',
    },
    imports: { import_declaration: 1 },
    baseFields: [],
    baseNodes: ['extends_clause'],
    decisions: ['if_expression', 'match_expression', 'case_clause', 'for_expression', 'while_expression', 'try_expression', 'binary_expression'],
    decisionOps: ['&&', '||'],
  },

  // （旧的 zig / bash 占位配置已删：节点名是猜的，且重复键会覆盖前面的真配置）

  // -------- 文件级格式：默不开，--lang json,yaml 或 --lang auto,json 才扫 --------
  // Elixir：全靠上面那组 elixir* 钩子（节点类型在这里没用）
  elixir: {
    id: 'elixir',
    label: 'Elixir',
    status: 'ok',
    exts: ['.ex', '.exs'],
    wasm: 'elixir/tree-sitter-elixir.wasm',
    namespaces: {},
    types: {},
    members: {},
    imports: {},
    baseFields: [],
    baseNodes: [],
    nameOf: elixirName,
    kindOf: elixirKind,
    memberKindOf: elixirMemberKind,
    paramsOf: elixirParams,
    importKindOf: elixirImportKind,
    importTextOf: elixirImportText,
    isDecision: elixirIsDecision,
    decisions: ['call'],
    decisionOps: [],
  },

  // Ruby：module 当命名空间（真实代码里就是靠模块嵌套分层），class 当类型；
  // attr_* 、require / include 全靠上面那组 ruby* 钩子。
  ruby: {
    id: 'ruby',
    label: 'Ruby',
    status: 'ok',
    exts: ['.rb', '.rake', '.gemspec'],
    wasm: 'ruby/tree-sitter-ruby.wasm',
    namespaces: { module: 1 },
    types: { class: 'class' },
    // 这张表实际被 membersOf 接管（后者优先）；留着是为了看表就知道 Ruby 有哪些成员声明
    members: { method: 'method', singleton_method: 'method' },
    imports: {},
    baseFields: ['superclass'],
    baseNodes: [],
    membersOf: rubyMembersOf,
    nameOf: rubyName,
    importKindOf: rubyImportKind,
    importTextOf: rubyImportText,
    // Ruby 的类型引用是**常量**（`Base` / `Walkable` / `Helper`）；identifier 是方法名（默认那两类仍生效）
    refTypes: ['constant'],
    decisions: ['if', 'unless', 'if_modifier', 'unless_modifier', 'case', 'while', 'until', 'for', 'rescue', 'rescue_modifier', 'binary'],
    decisionOps: ['&&', '||'],
    isDecision: (node) => {
      if (node.type !== 'binary') return true;            // 上面列的那些都是分支
      const op = node.childForFieldName('operator');
      return !!op && ['&&', '||'].includes(op.text);      // 算数比较不算复杂度
    },
  },

  // HCL / Terraform：没有类概念，图上的节点是 block（resource / variable / module / output / locals…），
  // 成员是块里的 attribute；引用靠标识符名字匹配（`data.aws_ami.ubuntu.id` 里的 `ubuntu`
  // 会连到 `data "aws_ami" "ubuntu"` 那个块）。
  hcl: {
    id: 'hcl',
    label: 'HCL / Terraform',
    status: 'ok',
    exts: ['.tf', '.tfvars', '.hcl', '.nomad'],
    wasm: 'hcl/tree-sitter-hcl.wasm',
    namespaces: {},
    // 注意：kindOf 存在时 types 会被忽略（kindOf 全权决定类别）；这两项一起写只是为了
    // 万一将来给 HCL 加 baseNodes（基类搜索会用到 types 表）时不至于缺东西。
    types: { block: 'block' },
    members: { attribute: 'attribute' },
    imports: {},
    baseFields: [],
    baseNodes: [],
    kindOf: hclKind,
    nameOf: hclName,
    decisions: [],
    decisionOps: [],
  },

  // GraphQL（SDL）：type / interface / union / enum / scalar / input / schema / directive 都是图上的节点，
  // 成员是 field / input 字段 / enum 值；`implements` 与 union 成员连成继承边。
  graphql: {
    id: 'graphql',
    label: 'GraphQL',
    status: 'ok',
    exts: ['.graphql', '.graphqls', '.gql'],
    wasm: 'graphql/tree-sitter-graphql.wasm',
    namespaces: {},
    types: {
      object_type_definition: 'type',
      interface_type_definition: 'interface',
      union_type_definition: 'union',
      enum_type_definition: 'enum',
      scalar_type_definition: 'scalar',
      input_object_type_definition: 'input',
      schema_definition: 'schema',
      directive_definition: 'directive',
    },
    members: {
      field_definition: 'field',
      input_value_definition: 'field',
      enum_value_definition: 'value',
    },
    imports: {},
    baseNodes: ['implements_interfaces', 'union_member_types'],
    baseFields: [],
    nameOf: gqlName,
    membersOf: gqlMembersOf,
    docstring: gqlDescription,
    decisions: [],
    decisionOps: [],
  },

  json: {
    id: 'json',
    label: 'JSON',
    status: 'ok',
    optIn: true,
    exts: ['.json', '.jsonc'],
    wasm: 'json/tree-sitter-json.wasm',
    namespaces: {},
    types: {},
    members: {},
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: [],
  },

  yaml: {
    id: 'yaml',
    label: 'YAML',
    status: 'ok',
    optIn: true,
    exts: ['.yaml', '.yml'],
    wasm: 'yaml/tree-sitter-yaml.wasm',
    namespaces: {},
    types: {},
    members: {},
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: [],
  },

  toml: {
    id: 'toml',
    label: 'TOML',
    status: 'ok',
    optIn: true,
    exts: ['.toml'],
    wasm: 'toml/tree-sitter-toml.wasm',
    namespaces: {},
    types: {},
    members: {},
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: [],
  },

  css: {
    id: 'css',
    label: 'CSS',
    status: 'ok',
    optIn: true,
    exts: ['.css'],
    wasm: 'css/tree-sitter-css.wasm',
    namespaces: {},
    types: {},
    members: {},
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: [],
  },

  html: {
    id: 'html',
    label: 'HTML',
    status: 'ok',
    optIn: true,
    exts: ['.html', '.htm'],
    wasm: 'html/tree-sitter-html.wasm',
    namespaces: {},
    types: {},
    members: {},
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: [],
  },
};

/** 后缀 -> 语言 profile */
export function languageForExt(ext) {
  for (const lang of Object.values(LANGUAGES)) {
    if (lang.exts.includes(ext)) return lang;
  }
  return null;
}

/** 命令里 --lang 的值解析：auto / 逗号列表 / 全部 */
export function resolveLanguages(spec) {
  const all = Object.values(LANGUAGES);
  // 文件级格式（json/yaml/toml/css/html）默认不开：它们没有"类型"可言，一堆配置文件会把代码地图淹了。
  // 要扫就显式指定：--lang json,yaml   或者  --lang auto,json（auto = 所有代码语言）
  const defaultSet = all.filter((l) => !l.optIn);
  if (!spec || spec === 'auto') return defaultSet;
  if (spec === 'all') return all;
  const wanted = String(spec).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const picked = [];
  for (const id of wanted) {
    if (id === 'auto') { for (const l of defaultSet) if (!picked.includes(l)) picked.push(l); continue; }
    const hit = all.find((l) => l.id === id || l.exts.includes(id) || l.label.toLowerCase() === id);
    if (!hit) throw new Error(`未知语言：${id}（可用：${all.map((l) => l.id).join(', ')}）`);
    if (!picked.includes(hit)) picked.push(hit);
  }
  return picked;
}
