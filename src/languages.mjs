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
/**
 * **一条 import 把哪些名字引进了当前作用域**（2026-10-05 第 8 轮）。
 *
 * 为什么需要：以前只记 import 的**模块路径**（`@testing-library/react`、`./alpha`），
 * 于是"名字已被 import 绑定 → 不许回落到同名匹配"那条闸（第 1 轮）对 JS/TS/Python **完全不生效** ——
 * 实测 ant-design 上 `Table.filter.test.tsx → scripts/check-site.ts::render`（×92）、
 * `uploadlist.test.tsx → delay-timer.test.tsx::button`（×68）这类错边全留着：
 * 源码里 `render` / `button` 都是 **import 进来的符号名**（或本地函数），不是跨文件的类型名。
 *
 * 返回**绑定后的本地名**（别名优先）：`import { A as B } from 'x'` → `B`；
 * `import X from 'x'` / `import * as X` → `X`；Python 的 `from x import A as B` → `B`。
 * 只影响"绑定"判断（砍错边），**不改变**已记录的 import 路径。
 */
const jsImportedBindings = (node) => {
  if (node.type !== 'import_statement') return [];
  const out = [];
  const clause = node.namedChildren.find((c) => c.type === 'import_clause');
  if (!clause) return [];
  for (const c of clause.namedChildren) {
    if (c.type === 'identifier') { out.push(c.text); continue; }               // 默认导入
    if (c.type === 'namespace_import') {                                      // `import * as X`
      const id = c.namedChildren.find((x) => x.type === 'identifier');
      if (id) out.push(id.text);
      continue;
    }
    if (c.type === 'named_imports') {                                         // `import { A, B as C }`
      for (const s of c.namedChildren) {
        if (s.type !== 'import_specifier') continue;
        const use = s.childForFieldName('alias') || s.childForFieldName('name') || s.namedChildren[0];
        if (use?.text) out.push(use.text);
      }
    }
  }
  return out;
};

/** Python 的同名钩子：`from x import A, B as C` → A / C；`import a.b as c` → c */
const pyImportedBindings = (node) => {
  const out = [];
  if (node.type === 'import_from_statement') {
    for (const c of node.childrenForFieldName?.('name') || []) {
      if (c.type === 'aliased_import') {
        const a = c.childForFieldName('alias');
        if (a?.text) out.push(a.text);
      } else if (c.text && c.text !== '*') {
        out.push(c.text.split('.').pop());
      }
    }
  } else if (node.type === 'import_statement') {
    for (const c of node.namedChildren) {
      if (c.type === 'aliased_import') {
        const a = c.childForFieldName('alias');
        if (a?.text) out.push(a.text);
      } else if (c.type === 'dotted_name') {
        out.push(c.text.split('.')[0]);                                       // `import a.b` 绑的是 a
      }
    }
  }
  return out;
};

/** Python 的 `from x import *`：它把**所有**名字引进来了 → 那一档不能按"符号名要对得上"卡（见 scan.mjs） */
const pyImportBindsAll = (node) => node.type === 'import_from_statement'
  && node.namedChildren.some((c) => c.type === 'wildcard_import');

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

/**
 * `val x = …`（Kotlin / Swift / Scala）**既可能是类的属性、也可能是函数里的局部变量**。
 * 只有后者才该登记进局部绑定表（`file.locals` = 文件顶层、`file.localOwners` = 类型/函数内，见 scan.mjs 的 localByOwner）——
 * 类属性的裸名引用是**合法**的跨文件引用，
 * 登记了会把真边一起砍掉（"宁缺勿错"要的是别接错，不是尽量少接）。
 * 判据（2026-09-25 实测祖先链）：从父节点往上走，**先撞到函数体算局部、先撞到类型体算成员**；
 * 两头都没撞到（文件顶层那种）按**成员**处理 —— 猜错的代价是少砍一条边，比砍错真边轻。
 */
const localNotMember = (funcTypes, typeBodyTypes) => (node) => {
  for (let p = node.parent; p; p = p.parent) {
    if (funcTypes.includes(p.type)) return true;
    if (typeBodyTypes.includes(p.type)) return false;
  }
  return false;
};

/** 祖先链里有没有某个类型的节点（`only` 闸用） */
const hasAncestorType = (node, type) => {
  for (let p = node.parent; p; p = p.parent) if (p.type === type) return true;
  return false;
};

/**
 * **JS 绑定位置取名字**（参数 / `const x = …` / `for (const x of …)` / 解构）：
 * JS 语法里这些位置**都没有"名字"字段** —— 直接是 `identifier` / `assignment_pattern`（默认值，名字在 `left`）/
 * `pair_pattern`（`{k: v}`，名字在 `value`）/ `rest_pattern` / `object_pattern` / `array_pattern`。
 * 所以只能按绑定位置逐个挑（形状实测见 `工作文档\验证\_smoke\js-locals-probe.js` + `npm run probe:tree`）。
 * ⚠ 别照 TS 写 `required_parameter` / `optional_parameter` —— 那是 TS 语法的节点名，
 *   在 JS 语法包里**根本不存在**（`probe:profile` 会报"查无此名"，但功能是**静默失效**的）。
 */
const jsBindingNames = (node) => {
  const out = [];
  const take = (n) => {
    if (!n || out.length > 64) return;
    if (n.type === 'identifier' || n.type === 'shorthand_property_identifier_pattern') { out.push(n.text); return; }
    if (n.type === 'assignment_pattern') { take(n.childForFieldName('left')); return; }   // `b = 1` → 名字在 left
    if (n.type === 'pair_pattern') { take(n.childForFieldName('value')); return; }         // `{ k: v }` → 名字在 value
    if (n.type === 'rest_pattern' || n.type === 'object_pattern' || n.type === 'array_pattern' || n.type === 'formal_parameters') {
      for (const c of n.namedChildren) take(c);
    }
  };
  take(node);
  return out;
};

/**
 * **CommonJS 的 `require` 绑定不是局部变量**（2026-10-03 实测踩到）。
 *
 * Babel 编译出来的 JS 满地都是这个形状：
 *   `var _require = require('../core/CompilerError'), createCompilerError = _require.createCompilerError;`
 * 这里的 `createCompilerError` 在语法上是 `variable_declarator`，但语义上是**导入绑定** ——
 * 它指向 `CompilerError.js` 里那个函数，是**真依赖**。要是按局部变量登记（A3 的局部名过滤），
 * 这些真边会被整片砍掉：实测 oss4-graphql-tools 一个样本上被砍的 202 条里有 **166 条**是这种
 * （`createUserError` 31 · `createCompilerError` 15 · `resolvers` 7 …）。
 *
 * 判据：同一条声明语句里只要有**任何一个** declarator 的值是 `require(...)`（或它的成员访问
 * `require('x').y`），这条语句里的名字就都算导入绑定。这是 Babel 输出里固定的形状；
 * 判宽了只会"少砍几条边"（保守方向），不会砍错。
 * ESM 的 `import { a } from '…'` 本来就不是 `variable_declarator`，不受这里影响。
 */
const isRequireDeclaration = (decl) => Boolean(decl) && (decl.namedChildren || []).some((d) => {
  if (d.type !== 'variable_declarator') return false;
  const v = d.childForFieldName('value');
  if (!v) return false;
  const isRequireCall = (n) => Boolean(n) && n.type === 'call_expression'
    && (n.childForFieldName('function') || {}).text === 'require';
  if (isRequireCall(v)) return true;
  return v.type === 'member_expression' && isRequireCall(v.childForFieldName('object'));
});

// TS 与 TSX 的语法节点名完全一致（tsx 只是多了 JSX），共用一份
const TS_SHAPE = {
  importKindOf: jsImportKind,
  // 被 import 引进来的**名字**（见 jsImportedBindings 的说明）：让"名字已被 import 绑定"那条闸对 TS/TSX/Vue 生效
  importedBindingsOf: jsImportedBindings,
  /**
   * **裸名跨文件必须有 `import`**（TS / TSX / Vue，2026-10-05 第 14 轮，用户政策"猜的边不要"）。
   *
   * 依据：ES 模块里一个裸名要么是本文件声明的，要么是 `import` 进来的（全局只能来自 ambient 声明）。
   * 所以"跨文件 + 零 import 依据"的裸名匹配只能是同名巧合 ✗ —— 实测 ant-design 上剩下的 873 条 `unique`
   * 就是这个形状（`render` / `button` 这类被当作跨文件类型名，撞上别处的同名声明）。
   *
   * **风险面量过**：TS/JS/Vue 的 2,248 条 `unique` 里，目标落在 `.d.ts`（ambient 声明文件）的是 **0 条** ✓
   * —— 也就是"砍到合法 ambient 全局引用"这个担心在这批样本上不存在。
   * ⚠ `.js`（`javascript` profile）**故意不一起上**：非模块脚本之间共享全局是常见写法，风险另行量。
   */
  bareNameScope: 'import-only',
  // 语言"族"：族**内**按名字互相解析（见 scan.mjs 的 langFamily）。JS / TS / TSX / Vue 是同一套
  // 模块系统里的东西 —— `.vue` 的 script 就是 TS、`.tsx` 只是带 JSX 的 TS，同一个项目里互相引用
  // 是常态。实测（ant-design，3,012 文件）不认这条会丢 **3,086 条**跨文件边：
  // `tsx→ts` 2,701、`ts→tsx` 669、`tsx→js` 42 …… 全是真依赖。
  family: 'js',
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
  /**
   * 局部绑定（"参数 / `const x = …`"这类名字）—— 规则与保守边界见 Go profile 里的同一项。
   * `ts` / `tsx` / `vue` 三个 profile 直接从这里共享；
   * ⚠ **`javascript` 是独立 profile（没有 `...TS_SHAPE`），必须自己再写一份** ——
   *   2026-10-03 抓到过这个漏：那句"四个 profile 都会带上"其实不成立，JS 的局部名一个都没登记，
   *   仓库自扫里 `web/app.js → src/i18n.mjs` 漏出 52 条单字母错边（`t`/`n`/`c`…）。
   *   现在由夹具 `tests/fixtures/a3-locals-javascript/` 钉住（`shadowed` 不该成边、`genuine` 必须成边）。
   */
  localBindings: {
      // 泛型（类型）参数：`class Foo[T]` / `fn f<T>()` 里的那个 T —— 它是**类型**参数，
      // 不是别处那个同名类型（不登记的话，`Flow[In, Out, Mat]` 的 `Out` 会接到另一个文件的 `Out`）。
      // ⚠ 用 `auto` 而不是 `'name'`：实测 **Java 的 `type_parameter` 没有 name 字段**（名字是直接子节点
      //   `type_identifier`），而 **Rust 有**（`type_parameter [name="T"]`）—— `auto` 两种形状都收。
      //   这类声明 `probe:profile` 查不出来（它只问"这门语法里有没有这个字段名"、不查"这个节点上有没有"），
      //   必须靠夹具钉：tests/fixtures/typeparam-java/。
      type_parameter: 'auto',
    variable_declarator: 'name',
    required_parameter: 'pattern',
    optional_parameter: 'pattern',
    rest_pattern: 'name',
    assignment_pattern: 'left',
    shorthand_property_identifier_pattern: 'name',
  },
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

/**
 * PowerShell（2026-09-25 新加）。
 *
 * 结构（实测 probe，见 `工作文档\样本库\probe-pwsh.mjs`）：
 *   · 类型：`class_statement`（class）/ `function_statement`（function）——
 *     **注意参数是 `script_parameter`、不是通用名单里的 `parameter`**，不声明就一个成员都列不出来；
 *   · 成员：`class_property_definition` / `class_method_definition`；
 *   · 名字：class / 属性 / 方法直接给 `simple_name` / `variable` / 返回类型 + `simple_name`，
 *     函数给 `function_name`；属性名带 `$`，要剥掉（`$Name` → `Name`，与源码里 `$this.Name` 一致）。
 */
const pwshNameOf = (node) => {
  const named = (t) => {
    const c = node.namedChildren.find((x) => x.type === t);
    return c ? c.text : null;
  };
  if (node.type === 'function_statement') return named('function_name');
  if (node.type === 'class_statement') return named('simple_name');
  if (node.type === 'class_property_definition') {
    const v = named('variable');
    return v ? v.replace(/^\$/, '') : null;
  }
  if (node.type === 'class_method_definition') {
    // 返回类型在前、名字在后：取**最后一个** simple_name（构造函数那个就是类名）
    const names = node.namedChildren.filter((c) => c.type === 'simple_name');
    return names.length ? names[names.length - 1].text : null;
  }
  /**
   * 参数：`[Parameter(Mandatory=$true)] [string] $Name` —— 通用兜底会把这**整串**当名字
   * （实测成员列表里是 `[Parameter(Mandatory = $true)],[int]$Size = 3` 这种）。
   * 剥掉类型注解与 `$` 前缀，只留变量名。
   */
  if (node.type === 'script_parameter' || node.type === 'class_method_parameter') {
    const v = node.namedChildren.find((c) => c.type === 'variable');
    return v ? v.text.replace(/^\$/, '') : null;
  }
  return null;
};

/**
 * PowerShell 的依赖：`using namespace System.Text` 与 `Import-Module -Name Pester` /
 * `Import-Module ./helpers.psm1`。点源 `. ./helpers.ps1` 也算（与 bash 的 `source` 同义）。
 * 只认**字面量**：变量拼接（`Import-Module "$PSScriptRoot/x.psm1"`）一律不碰 —— 路径是动态的。
 *
 * ⚠ 实测：`using namespace …` 在这门语法里**不是** `using_statement`，而是一个 `command`
 *   （command_name = `using`，参数是 `generic_token` 序列）—— 按 `using_statement` 判会一条都采不到。
 *   参数也不是 `simple_name` / `bareword`，是 `generic_token`；`-Name` 是 `command_parameter`。
 */
const pwshImportKind = (node) => {
  if (node.type !== 'command') return null;
  const cmd = node.namedChildren.find((c) => c.type === 'command_name');
  if (!cmd) return null;
  const t = cmd.text.replace(/^['"]|['"]$/g, '');
  if (t === 'using') return 'using';
  if (t === 'Import-Module') return 'import';
  if (t === '.') return 'source';
  return null;
};
const pwshImportText = (node) => {
  const cmd = node.namedChildren.find((c) => c.type === 'command_name');
  const name = cmd ? cmd.text.replace(/^['"]|['"]$/g, '') : '';
  const els = node.namedChildren.filter((c) => c.type === 'command_elements');
  const toks = els.flatMap((el) => el.namedChildren).filter((c) => c.type === 'generic_token');
  if (name === 'using') {
    // `using namespace System.Text` → 第二个 token（第一个是 `namespace`）
    return toks.length >= 2 ? toks[1].text : '';
  }
  // Import-Module / 点源：取**最后一个** token（`-Name Pester` → Pester；`. ./x.ps1` → ./x.ps1）
  const last = toks[toks.length - 1];
  if (!last) return '';
  const v = last.text.replace(/^['"]|['"]$/g, '');
  // 引号里含变量（`"$PSScriptRoot/x.psm1"`）→ 动态路径，不认
  return /\$/.test(v) ? '' : v;
};

/**
 * R（2026-09-25 新加）。
 *
 * 这门语法**没有**专门的函数/类声明节点：`make_widget <- function(...) {...}` 是
 * `binary_operator`（`<-`）左边一个 identifier、右边一个 `function_definition`
 * （而那个 `function_definition` 的 `name` 字段是**字面量 `function`**，不能当名字）。
 * 参考类（R5/R6 风格）是 `Widget <- setRefClass("Widget", …)` / `setClass("Widget", …)`。
 *
 * 所以三类钩子都要：
 *   · `rKindOf`：把这两形状的 `binary_operator` 认成类型声明（function / class）；
 *   · `rNameOf`：名字取**左边**那个 identifier；
 *   · `rMembersOf`：块里的 `foo <- function(...)` / `describe = function(...)` 是成员（函数），
 *     其余 `identifier <- value` 是字段。
 * 实测零 ERROR（`工作文档\样本库\probe-any.mjs` 跑 `r-sample.R`）。
 */
const rAssign = (node) => {
  if (node.type !== 'binary_operator') return null;
  const op = node.childForFieldName('operator') || node.namedChildren.find((c) => c.type === '<-' || c.type === '=' || c.type === '<<-');
  if (!op || !['<-', '=', '<<-'].includes(op.text)) return null;
  const lhs = node.namedChildren.find((c) => c.type === 'identifier');
  const rhs = node.namedChildren.find((c) => c.type === 'function_definition' || c.type === 'call');
  return lhs && rhs ? { lhs, rhs } : null;
};
const rKindOf = (node) => {
  const a = rAssign(node);
  if (!a) return null;
  if (a.rhs.type === 'function_definition') return 'function';
  if (a.rhs.type === 'call') {
    const fn = a.rhs.namedChildren.find((c) => c.type === 'identifier');
    if (fn && ['setRefClass', 'setClass', 'setGeneric', 'R6Class'].includes(fn.text)) return 'class';
  }
  return null;
};
const rNameOf = (node) => {
  if (node.type === 'binary_operator') {
    const a = rAssign(node);
    if (a) return a.lhs.text;
  }
  return null;
};
const rMembersOf = (node) => {
  if (node.type === 'binary_operator') {
    // ⚠ 只有**块级的 `名字 <- function(...)`** 才是成员：
    //   R 里到处是 `w <- 值`，把它们都记成成员会灌一堆假成员（实测 `make_widget` 的成员里混进 `w`）。
    //   类里的**方法**用 R5/R6 的 `methods = list(describe = function()…)` 那种写法，
    //   或者 `名字 <- function(...)` —— 两者都覆盖到了；纯数据字段（`fields = list(name = "character")`）
    //   不是函数，暂不发成员（要发得先想清楚"字段类型"怎么表达）。
    const a = rAssign(node);
    if (!a || a.rhs.type !== 'function_definition') return null;
    const par = node.parent ? node.parent.type : '';
    if (!['program', 'braced_expression', 'call', 'arguments'].includes(par)) return null;
    return [{ kind: 'function', name: a.lhs.text }];
  }
  // R5/R6 风格：`list(describe = function() …)` 里的 `argument`
  if (node.type === 'argument') {
    const nm = node.childForFieldName('name');
    const val = node.childForFieldName('value');
    if (nm && val && val.type === 'function_definition') return [{ kind: 'function', name: nm.text }];
  }
  return null;
};

/** R 的依赖：`library(dplyr)` / `require(x)` / `source("helpers.R")` —— 只认字面量参数 */
const rImportKind = (node) => {
  if (node.type !== 'call') return null;
  const fn = node.namedChildren.find((c) => c.type === 'identifier');
  if (!fn) return null;
  if (fn.text === 'library' || fn.text === 'require') return 'library';
  if (fn.text === 'source') return 'source';
  return null;
};
const rImportText = (node) => {
  const args = node.namedChildren.find((c) => c.type === 'arguments');
  const first = args && args.namedChildren.find((c) => c.type === 'argument');
  if (!first) return '';
  const v = first.childForFieldName('value') || first.namedChildren[0];
  if (!v) return '';
  if (v.type === 'string') {
    const content = v.namedChildren.find((c) => c.type === 'string_content');
    return content ? content.text : '';                 // source("helpers.R") → helpers.R
  }
  if (v.type === 'identifier') return v.text;           // library(dplyr) → dplyr
  return '';                                            // 动态（library(pkg, character.only=TRUE)）→ 不认
};

/**
 * Protobuf（2026-09-25 新加）。实测（`工作文档\样本库\probe-any.mjs`，零 ERROR）：
 *   · 类型：`message`（含嵌套 message）/ `enum` / `service`；名字在 `message_name` / `enum_name` /
 *     `service_name` 上（没有 `name` 字段，所以要 `pwshNameOf` 式的钩子）；
 *   · 成员：message 里的 `field`（字段）、enum 里的 `enum_field`、service 里的 `rpc`；
 *   · 命名空间：`package atlas.widget.v1;`（`package` 节点的文本是整串，要取 `full_ident`）；
 *   · 依赖：`import "atlas/common.proto";` → import（引号里的路径直接可用）；
 *     类型引用是 `message_or_enum_type`（`atlas.common.Meta` / `google.protobuf.Timestamp`）。
 */
const protoNameOf = (node) => {
  const suffixes = { message: 'message_name', enum: 'enum_name', service: 'service_name' };
  const want = suffixes[node.type];
  if (want) {
    const c = node.namedChildren.find((x) => x.type === want);
    // `message_name` 包着一层 identifier；取不到就退回它自己的文本
    if (c) return (c.namedChildren.find((x) => x.type === 'identifier') || c).text;
  }
  if (node.type === 'field' || node.type === 'enum_field') {
    const n = node.namedChildren.find((x) => x.type === 'identifier');
    return n ? n.text : null;
  }
  if (node.type === 'rpc') {
    const c = node.namedChildren.find((x) => x.type === 'rpc_name');
    return c ? c.text : null;
  }
  return null;
};
const protoImports = {
  import: 'import',
};
const protoImportText = (node) => {
  const s = node.namedChildren.find((x) => x.type === 'string');
  return s ? s.text.replace(/^"|"$/g, '') : '';
};
/** package 节点的文本是 `package a.b.c;`，命名空间只取 full_ident */
const protoNamespace = (node) => {
  const f = node.namedChildren.find((c) => c.type === 'full_ident');
  return f ? f.text : null;
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
    // 局部绑定（规则与保守边界见 Go profile 的同一项）：参数 + 本地变量声明
    localBindings: {
      // 泛型（类型）参数：`class Foo[T]` / `fn f<T>()` 里的那个 T —— 它是**类型**参数，
      // 不是别处那个同名类型（不登记的话，`Flow[In, Out, Mat]` 的 `Out` 会接到另一个文件的 `Out`）。
      // ⚠ 用 `auto` 而不是 `'name'`：实测 **Java 的 `type_parameter` 没有 name 字段**（名字是直接子节点
      //   `type_identifier`），而 **Rust 有**（`type_parameter [name="T"]`）—— `auto` 两种形状都收。
      //   这类声明 `probe:profile` 查不出来（它只问"这门语法里有没有这个字段名"、不查"这个节点上有没有"），
      //   必须靠夹具钉：tests/fixtures/typeparam-java/。
      type_parameter: 'auto',
      parameter: 'name',
      variable_declarator: 'name',
      foreach_statement: 'left',
    },
    namespaces: { namespace_declaration: 1, file_scoped_namespace_declaration: 1 },
    // C# 10 的 `namespace Foo;`：整份文件都属于它。新版语法里它只包住名字，
    // 后面的类型是兄弟节点（旧语法是包在里面的）——不声明这条，所有类型都会落到 (global)。
    fileScopedNamespaces: ['file_scoped_namespace_declaration'],
    types: {
      class_declaration: 'class',
      interface_declaration: 'interface',
      struct_declaration: 'struct',
      // `record` 与 `record struct` 都走 `record_declaration`（实测：语法包里**没有**
      // `record_struct_declaration` 这个节点名，此前那条声明是死配置；`record struct` 照样被这一条收到）
      record_declaration: 'record',
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
    /**
     * **裸名必须在作用域里才认**（C#，2026-10-05 精度轮）：不带限定的类型名要么在当前命名空间、
     * 要么被 `using`（含 csproj 的项目级 `<Using Include>`，见 scan.mjs 的 projectUsingsFor）引进来、
     * 要么在**外层命名空间**里 —— 否则编译器解析不到。`'ns+ancestors'` 就是"再加上外层命名空间"那一档。
     * 实测：efcore/aspnetcore 上"跨命名空间 + 无 import 覆盖"的裸名边有 9 千多条，抽样**全是错边**
     * （别的命名空间里的同名测试类）；而 13,133 条被项目级 using 覆盖的**真边**因为有依据而不受影响。
     * ⚠ 已知没覆盖：`using static X;` / 别名 `using A = B.C;`（efcore 里没有这两种）。
     */
    bareNameScope: 'ns+ancestors',
    // 旧语法包把继承列表放在 base_list 字段里；换成 tree-sitter-wasm@2.0.1 的 C# 语法后
    // base_list 变成普通子节点（childForFieldName('bases') 取不到了），改走 baseNodes。
    baseFields: [],
    baseNodes: ['base_list'],
    decisions: [
      'if_statement', 'switch_statement', 'for_statement', 'foreach_statement',
      'while_statement', 'do_statement', 'catch_clause', 'conditional_expression',
      'switch_expression', 'switch_section', 'binary_expression',
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
    family: 'js',       // 与 TS / TSX / Vue 同族：同一个项目里互相引用是常态（见 TS_SHAPE 的说明）
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
    // 局部绑定（`const x = …` / 参数 / `for (const x of …)` / `catch (e)`）—— **JS 语法自己的形状**，
    // 与 `TS_SHAPE` 那份**不能互抄**（TS 有 `required_parameter` / `optional_parameter`，JS 语法里没有这两个节点名）。
    // 实测（probe:tree + probe:profile，见 工作文档\验证\_smoke\js-locals-probe.js）：
    //   · `formal_parameters` 下直接是 identifier / assignment_pattern / rest_pattern / object_pattern / array_pattern（没有"参数名"字段）→ 函数规格；
    //   · `x => …` 的**单个裸参数**直接是 `arrow_function` 的孩子（没有 parameters 字段）→ 单独一条；
    //   · `for (const t of xs)` / `for (const k in o)` → `for_in_statement.left`；
    //   · `catch (e)` 没有 parameter 字段，是直接孩子 → `auto`；
    //   · `const x = require('…')` / Babel 的 `var _r = require('…'), y = _r.y` → **导入绑定，不是局部变量**（见 isRequireDeclaration）。
    localBindings: {
      variable_declarator: (node) => (isRequireDeclaration(node.parent) ? [] : jsBindingNames(node.childForFieldName('name'))),
      formal_parameters: jsBindingNames,
      arrow_function: (node) => {
        const body = node.childForFieldName('body');
        const out = [];
        for (const c of node.namedChildren) { if (c === body) break; if (c.type === 'identifier') out.push(c.text); }
        return out;
      },
      for_in_statement: (node) => jsBindingNames(node.childForFieldName('left')),
      catch_clause: 'auto',
    },
    members: {
      method_definition: 'method',
      field_definition: 'field',
    },
    imports: { import_statement: 1 },
    importKindOf: jsImportKind,
    // 被 import 引进来的**名字**（见 jsImportedBindings 的说明）：让"名字已被 import 绑定"那条闸对 JS 生效
    importedBindingsOf: jsImportedBindings,
    /**
     * **裸名跨文件必须有 `import` —— 但只对"是模块"的文件**（`.js`，2026-10-05 第 16 轮）。
     *
     * 与 TS/TSX/Vue 的 `'import-only'` 差在一个字：JS 里**没有 import 的文件是全局脚本**（`<script>` 那类），
     * 脚本之间共享全局是**真语义**（jQuery 插件、`window.foo = …`、老式多文件脚本）——
     * 对它上"必须有 import"的闸就是砍真边 ✗。所以这一档只判**有 import 的文件**（即模块）。
     *
     * **风险面量过**：`.js` 的跨文件 `unique` 边 375 条里，**171 条在"有 import 的模块"里**（上闸安全 ✓）、
     * **204 条在"没有 import 的脚本"里**（有风险 ⇒ 一律不判 ✓）。
     * 同一把尺子量过 TS 组（typescript/tsx/vue）：模块 0 · 脚本 0 —— 第 14 轮的 TS 上闸**零风险** ✓。
     */
    bareNameScope: 'import-only-module',
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
    // JVM 同族：Java / Kotlin / Scala 编到同一个类路径，混合工程里互相按名字引用是**真的**
    // （Kotlin 官方支持与 Java 互操作）。实测不认这条会丢：akka `java↔scala` 6,517 条、
    // kotlin 工程 `kotlin↔java` 487/233 条。
    family: 'jvm',
    namespaces: { package_declaration: 1 },
    namespaceScope: 'file',
    // 局部绑定（规则与保守边界见 Go profile 的同一项）：参数 + 本地变量声明 + 增强 for 的变量
    localBindings: {
      // 泛型（类型）参数：`class Foo[T]` / `fn f<T>()` 里的那个 T —— 它是**类型**参数，
      // 不是别处那个同名类型（不登记的话，`Flow[In, Out, Mat]` 的 `Out` 会接到另一个文件的 `Out`）。
      // ⚠ 用 `auto` 而不是 `'name'`：实测 **Java 的 `type_parameter` 没有 name 字段**（名字是直接子节点
      //   `type_identifier`），而 **Rust 有**（`type_parameter [name="T"]`）—— `auto` 两种形状都收。
      //   这类声明 `probe:profile` 查不出来（它只问"这门语法里有没有这个字段名"、不查"这个节点上有没有"），
      //   必须靠夹具钉：tests/fixtures/typeparam-java/。
      type_parameter: 'auto',
      formal_parameter: 'name',
      spread_parameter: 'name',
      variable_declarator: 'name',
      enhanced_for_statement: 'name',
      catch_formal_parameter: 'name',
    },
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
    /**
     * **裸名必须在作用域里才认**（Java）：不带限定的类型名要么在**同一个包**里、要么被
     * `import a.b.C;` 引进来 —— Java 没有"外层包自动可见"这回事，所以**不带 ancestors 那一档**
     * （同包与 import 覆盖两条已在 hasImportBacking 里）。实测 netty 23 条 / spring-boot 471 条越界裸名边。
     */
    bareNameScope: 'ns',
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
    // 局部绑定（见 Go profile 里同一项的说明）：`x = …` 的左边、参数的名字
    localBindings: {
      assignment: 'left',
      named_expression: 'name',
      parameters: 'name',
      default_parameter: 'name',
      typed_parameter: 'name',
      typed_default_parameter: 'name',
    },
    imports: { import_statement: 1, import_from_statement: 1 },
    // 被 import 引进来的**名字**（见 jsImportedBindings / pyImportedBindings 的说明）：
    // 实测 django 上 `class DateFunctionTests → tests/db_functions/models.py::DTModel`（×142）这类
    // 真引用其实来自 `from .models import DTModel` —— 以前只记路径、不记符号名，于是既没依据、也挡不住同名巧合。
    importedBindingsOf: pyImportedBindings,
    importBindsAllOf: pyImportBindsAll,
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
    family: 'jvm',      // 与 Java / Scala 同族（见 java profile 的说明）
    namespaces: { package_header: 1 },
    namespaceScope: 'file',
    types: {
      class_declaration: 'class',
      object_declaration: 'object',
    },
    members: {
      function_declaration: 'function',
      property_declaration: 'property',
      primary_constructor: 'ctor',
      secondary_constructor: 'ctor',
      // `class_parameter`：只有带 `val` / `var` 的才是属性（`val name: String`），
      // 裸参数（`radius: Double`）只是构造参数、外面访问不到 —— 那道闸在 memberGuards 里。
      // 实测：`abstract class Shape(val name: String)` 的属性 `name` 此前**整个没进成员表**，
      // 而 `data class Foo(val a: Int)` 这类常见写法会一个成员都没有。
      class_parameter: 'property',
      enum_entry: 'enumValue',
    },
    memberGuards: {
      class_parameter: (node) => node.namedChildren.some((c) => c.type === 'binding_pattern_kind'),
    },
    imports: { import_header: 1 },
    /**
     * **裸名必须在作用域里**（Kotlin，2026-10-05 第 10 轮）：Kotlin 没有 Java 那种"外层包自动可见" ——
     * 裸名只能指**同包**或 **import 进来**的（外加 `kotlin.*` / `kotlin.collections.*` 这些**默认导入**，
     * 真身都在图外）。所以档位与 Java 相同（`ns`，不带 ancestors）。
     */
    bareNameScope: 'ns',
    /**
     * 局部绑定（A3，2026-09-25 实测）—— 规则与保守边界见 Go profile 的同一项。
     *
     * Kotlin 的坑：**参数与 `val` / `var` 都没有 `name` 字段**（`probe-fields` 实测）——
     *   · `fun render(radius: Double)` 的 `radius` 是 `parameter` 的第一个孩子 `simple_identifier`；
     *   · `val tmp = …` 是 `property_declaration` → `variable_declaration` → `simple_identifier`；
     *   · `val (a, b) = …` 走 `multi_variable_declaration`；`for ((k, v) in m)` 同理；
     *   · `catch (e: Exception)` 是 `catch_block` 的第一个孩子；lambda 参数是
     *     `lambda_parameters` → `variable_declaration`。
     * 所以这几项都用 `'auto'`（按声明位置找），不用字段名。
     *
     * `property_declaration` / `variable_declaration` **既是类属性、又是函数里的局部变量**：
     * 类属性的裸名引用是**合法**的跨文件引用，所以只认"在函数体里"的那种（`only` 闸）。
     */
    localBindings: {
      // Kotlin 的 `type_parameter` **没有 name 字段**（实测：语法包 359 个节点名里没有这个字段）→ 用 `auto`
      type_parameter: 'auto',
      parameter: 'auto',
      catch_block: 'auto',
      lambda_parameters: 'auto',
      property_declaration: { auto: true, only: localNotMember(['function_body', 'lambda_literal'], ['class_body', 'enum_class_body']) },
      variable_declaration: { auto: true, only: localNotMember(['function_body', 'lambda_literal'], ['class_body', 'enum_class_body']) },
    },
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
    /**
     * **裸名跨文件必须有 `import`**（Dart，2026-10-05 第 11 轮）：Dart 没有"同包自动可见"——
     * 用别的文件里的东西必须 `import`（或它是同一个库的 `part`，那条由 `hasImportBacking` 的
     * lib 组判定放行 ✓）。所以"跨文件 + 零依据"的裸名匹配只能是同名巧合 ✗（与 Rust 同档）。
     * 实测：riverpod 上 843 条 unique、bloc 上 484 条，抽样都是跨库的同名 ✗。
     */
    bareNameScope: 'import-only',
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
      // ⚠ 2026-09-24 实测修正：这段以前写的是 `function_definition_statement` / `local_function` /
      //   `local_variable_declaration` —— **这三个名字语法包里根本没有**（多半是旧语法包的名字），
      //   于是 Lua fixture 里两个函数 `M.greet` / `M.count` **一个都没进成员表**（只剩两个变量）。
      //   实际产出：`local function f()` 与 `function M.h()` → `function_declaration`；
      //   `local f = function() end` → `variable_declaration` 里套 `function_definition`（下面两条都在）。
      function_declaration: 'function',
      function_definition: 'function',
      variable_declaration: 'field',
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

  r: {
    id: 'r',
    label: 'R',
    status: 'ok',
    exts: ['.r', '.R', '.rmd'],
    wasm: 'r/tree-sitter-r.wasm',
    namespaces: {},
    types: {},
    members: {},
    kindOf: rKindOf,
    nameOf: rNameOf,
    membersOf: rMembersOf,
    imports: {},
    importKindOf: rImportKind,
    importTextOf: rImportText,
    baseFields: [],
    baseNodes: [],
    decisions: ['if_statement', 'for_statement', 'while_statement', 'repeat_statement'],
    decisionOps: [],
  },

  proto: {
    id: 'proto',
    label: 'Protobuf',
    status: 'ok',
    exts: ['.proto'],
    wasm: 'proto/tree-sitter-proto.wasm',
    namespaces: { package: 1 },
    namespaceScope: 'file',
    // `package atlas.widget.v1;` 的节点文本是**整串**，`full_ident` 才是命名空间本身
    namespaceNameOf: (node) => {
      const f = node.namedChildren.find((c) => c.type === 'full_ident');
      return f ? f.text : null;
    },
    nameOf: protoNameOf,                        // 类型与成员的名字都在这一个钩子里（见上）
    types: {
      message: 'message',
      enum: 'enum',
      service: 'service',
    },
    members: {
      field: 'field',
      enum_field: 'enumValue',
      rpc: 'method',
    },
    imports: protoImports,
    importKindOf: (node) => (node.type === 'import' ? 'import' : null),
    importTextOf: protoImportText,
    refTypes: ['message_or_enum_type'],
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: [],
  },

  powershell: {    id: 'powershell',
    label: 'PowerShell',
    status: 'ok',
    exts: ['.ps1', '.psm1', '.psd1'],
    wasm: 'powershell/tree-sitter-powershell.wasm',
    namespaces: {},
    // 类型：class / function（实测节点名，见 pwshNameOf 上方的说明）
    types: {
      class_statement: 'class',
      function_statement: 'function',
    },
    members: {
      class_property_definition: 'field',
      class_method_definition: 'method',
      // 函数体里的参数是 script_parameter（**不在通用参数表名单里**），不声明的话
      // 成员签名会缺参数表
      script_parameter: 'parameter',
    },
    nameOf: pwshNameOf,
    imports: {},
    importKindOf: pwshImportKind,
    importTextOf: pwshImportText,
    // `Get-Widget` 这类命令名算引用：PowerShell 的跨文件函数调用就长这样
    refTypes: ['command_name', 'type_identifier'],
    baseFields: [],
    baseNodes: [],
    decisions: ['if_statement', 'elseif_clause', 'else_clause', 'foreach_statement', 'for_statement', 'while_statement', 'switch_statement', 'comparison_expression', 'logical_expression'],
    decisionOps: [],
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
    /**
     * **裸名跨文件必须有 `@import` 依据**（Zig，2026-10-05 第 18 轮）。
     *
     * Zig 里跨文件引用**只能**先 `@import("x.zig")` 拿到容器、再写限定名（`alpha.ScopeWidget`，走限定名那条路）；
     * 光秃秃的裸名跨文件**根本编不过** ⇒ "跨文件 + 零 import 依据"的裸名匹配只能是同名巧合 ✗。
     * ⚠ 唯一例外是老的 `usingnamespace`（把别的容器名字引进当前作用域）—— 现代 Zig 已移除、样本里也没量到；
     *   真出现时会表现为"有 @import 但名字裸用"，属于要单独补依据的情形（记这里备查）。
     *
     * 先把"是不是没提取 import"查清了：**不是** —— profile 走 `importKindOf: zigImportKind` 抓 `@import(…)`，
     * 实测 zls 样本 102 个 zig 文件里 **78 个有 imports** ✓（探针量到的 610/30 分布成立）。
     */
    bareNameScope: 'import-only',
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

  // OCaml：引用采集**已开**，但限定名解析仍有已知残留（下面数字都是 2026-09-24 在真项目上复测的）。
  //
  // 语法树里没有 `identifier` / `type_identifier`（提取器的默认引用节点），所以 refTypes 得另指：
  // `value_path`（值引用）+ `type_constructor_path`（类型引用），再挂 `refFilter` 只收"带模块前缀"的路径。
  // 结果：某真 OCaml 项目（3,514 文件）跨文件 ref 边 13,805 条、**跨语言边 0 条**；
  // `List.map` 全图 1 个节点、384 条边**全部**指向 `stdlib/list.ml`。
  //
  // 试过并**放弃**的路（都因为造出错误边；数字是实测，留在这里免得下次白试一遍）：
  //   ① 只按节点类型加 refTypes、不挂 refFilter →
  //      · 只加 `value_path`：边 1,942→13,006，其中 7,959 条落"名字全图唯一"档；出现
  //        `scanf.ml → ib`、`bytegen.ml → cont`（都是函数参数）、`unit` 撞 stdlib/unit.ml 单点 345 条。
  //      · 只加 `type_constructor_path`：被内置类型撞（`main_args.ml → stdlib/unit.ml` 345 条、
  //        `odoc_messages.mli → stdlib/string.ml` 338 条）。
  //   ② 挂上 refFilter 之后，假阳性全消失、边 1,942→2,039，**但暴露出下一层问题**：
  //      那时限定名还解析不了 —— `type t = X.t` 里的 `X` 是**文件内局部模块**，而引擎只按简单名
  //      建表，图里有 121 个叫 `X` 的类型 → 91 条边全接到其中任意一个（宁缺勿错，当时只能不开）。
  //
  // 真正解决它的是 scan.mjs 的 `resolveName` **三档优先级**（① 同文件 → ② 全名 → ③ 后缀）
  // 加上 `fileModuleNamespace`（`foo.ml` 的顶层定义挂在模块 `Foo` 下）。原因与实测见那两处注释。
  //
  // **已知残留**（是缺陷，不是取舍）：真源码 → testsuite 的接错边 36 → **16** 条，共 6 个目标，
  // 全都属于"引用的前缀根本不是编译单元"：
  //   · `Ord.t` → `Functors.Ord.t`（10 条）、`W.t` → `Opt_variants.W.t`、`M.iter` → `Pr7636.M.iter`
  //     —— 前缀是**函子参数 / 局部模块名**，全图没有以它开头的编译单元，后缀档于是把它粘到
  //        "尾巴相同"的候选上（`Ord` 模块全图只有 1 个且是嵌套的，唯一性也救不了）
  //   · `D.t` / `Printer.t` / `Names.obj` —— 测试文件恰好叫 `d.mli` / `printer.ml` / `names.ml`，
  //     属于根名撞车
  //   这两类都**不是名字匹配能解决的**，要真正的作用域 / 模块别名分析。
  // 另一个更大的坑**修了一半**：`.ml` 与 `.mli` 是**同一个编译单元**，图上却是两个节点 ——
  //   实测 1,558 个 fqn 同时出现在同名的 .ml 与 .mli 里（共 3,116 个节点）。**解析期**已经把
  //   它们当成同一个符号（见 scan.mjs 的 collapseUnits）：跨文件边 13,805 → 15,102、放弃的引用
  //   44,784 → 43,347，而接错边仍是 16 条。但**图上仍是两个节点**（`search` 给两条、fanIn 摊成
  //   两份）—— 真要合并得先解决"`.mli` 的类型清单会变空"，所以本版只动了这一半。
  //   另外同名的 `arch.ml` 分布在 5 个 arch 目录 → 10 个 `Arch.*` 节点共用同一个 fqn（fqn 不含目录），
  //   这类 125 个 fqn / 611 个节点是**不同的编译单元，绝不能合**（collapseUnits 的紧判定正是为此）。
  ocaml: {
    id: 'ocaml',
    label: 'OCaml',
    status: 'ok',
    exts: ['.ml', '.mli'],
    wasm: 'ocaml/tree-sitter-ocaml.wasm',
    namespaces: { module_definition: 1 },
    namespaceIsType: true,   // module 既是作用域又是节点（少了它图上就没有"模块"）
    // **函子参数**：`module Make (Ord : OrderedType) = …` 里的 `Ord` 是**抽象**的（调用方传进来的
    // 模块，源码里没有实现）。`Make` 的整棵子树上，`Ord.t` 这种限定名**无从解析** —— 必须放弃，
    // 不能让它掉进后缀档去黏"尾巴相同"的候选：实测真源码 → 测试目录的 16 条错边全是这么来的
    // （`stdlib/map.ml` 的 `Ord.t` → `testsuite/…/functors.ml` 的 `Functors.Ord.t`）。
    // 语法树形状（实测 probe，两种都见过）：
    //   ① `module Make (Ord : OrderedType) = struct … end`  → module_parameter 直接在 module_binding 下
    //   ② `module Make : functor (Ord : OrderedType) -> S`  → 包在 module_binding 的 functor_type 下
    // 两种都得认（`.mli` 里第 ② 种很常见）。
    moduleParameterOf: (node) => {
      const binding = node.namedChildren.find((c) => c.type === 'module_binding');
      if (!binding) return null;
      const out = [];
      const collect = (n) => {
        for (const c of n.namedChildren) {
          if (c.type === 'module_parameter') {
            const nm = c.namedChildren.find((x) => x.type === 'module_name');
            if (nm && nm.text && nm.text !== '_') out.push(nm.text);
          } else if (c.type === 'functor_type') collect(c);
        }
      };
      collect(binding);
      return out.length ? out : null;
    },
    /**
     * **模块别名**：`module B = Bytes` → `{name:'B', target:'Bytes'}`。
     *
     * 别名右边**没有定义**，`B.create` 指的是右边那个模块的 create。不认这条，限定名就掉进
     * 后缀档去撞同名嵌套模块（实测 `stdlib/string.ml:30 module B = Bytes`，第 70 行的
     * `B.create` 接到了 `testsuite/tests/parallel/mctest.ml` 的 `Mctest.B.create`）。
     *
     * 判定要**紧**，下面几种都不算别名：
     *   · `module M = struct … end`（右边是结构体：这是定义）
     *   · 函子参数（`module Make (Ord : T)` —— 走上面的 moduleParameterOf）
     *   · `module Make : functor … -> S` / `module T : sig … end`（右边是约束，不是路径）
     * 只认"右边是一个模块路径（`module_path` / `extended_module_path`）"这一种。
     */
    moduleAliasOf: (node) => {
      const binding = node.namedChildren.find((c) => c.type === 'module_binding');
      if (!binding) return null;
      if (binding.namedChildren.some((c) => c.type === 'module_parameter' || c.type === 'functor_type')) return null;
      const nm = binding.namedChildren.find((c) => c.type === 'module_name');
      if (!nm || !nm.text) return null;
      const rhs = binding.namedChildren.find((c) => c.type === 'module_path' || c.type === 'extended_module_path');
      if (!rhs || !rhs.text) return null;
      return { name: nm.text, target: rhs.text };
    },
    refTypes: ['value_path', 'type_constructor_path'],
    refFilter: (node) => node.namedChildren.some((c) => c.type === 'module_path' || c.type === 'extended_module_path'),
    types: {
      type_definition: 'type',
      module_definition: 'module',
      exception_definition: 'exception',
    },
    members: {
      value_definition: 'value',
      // `.mli` 的 `val` 也要走"成员分支" —— `emitOnDemandValue` 只在那条分支里被调用，
      // 不上这张表就永远走不到（2026-09-25 之前这里确实没有它，于是整个"只有 .mli"的
      // 接口文件在图上隐形）。**发不发节点**由 scan.mjs 的 ifaceOnly 决定：
      // 有同名 `.ml` 时不发（否则同一个 fqn 两个节点），没有时才发。
      value_specification: 'value',
      // **`external` 声明**（`external length : 'a array -> int = "%array_length"`）——
      // 语法树上是独立节点类型 `external`（子节点：value_name / function_type / string）。
      // 标准库里一大批最常用的函数就是这么声明的（`Array.length` / `Array.make` / `Array.get`…），
      // 不认它们，这些引用**成批**接不上：实测某真项目 `Array.length` 511 条、`String.length` 346 条、
      // `Array.make` 253 条全落在 unknown。它们和 `let` 一样是模块成员，节点按需发（见 onDemandTypes）。
      external: 'value',
      constructor_declaration: 'enumValue',
      field_declaration: 'field',
    },
    // 模块里的**值**要能当限定名引用的目标（`Env.normalize`、`List.iter`）—— 实测某真项目里
    // 限定名引用中"值"占 1,668 条、"类型"只占 164 条，值才是函数级跨模块依赖的主体。
    // 但不给它们**全量**发节点：实测会多 53,074 个节点（图 3.6 倍）、其中 90% 没有任何边指向它、
    // 还混着 8.5% 的模式解构垃圾名（`(n', b)`、`()`）。所以走**按需候选**：
    // 标 onDemand + hasModulePrefix，父进程只保留真被限定名指到的（见 pruneOnDemandTypes）。
    //
    // ⚠ 这里**只有 `value_definition`（`.ml` 的 `let`）**，曾经还写着 `value_specification`
    // ⚠ `value_specification`（`.mli` 的 `val`）曾经挂在这里、却**永远走不到** ——
    //   `emitOnDemandValue` 只在"成员分支"里被调用，而它当时**不在上面的 `members` 表**里
    //   （实测：只有 `a.mli`（`val f`）的目录扫出来图上根本没有 `A.f` 节点，引用 `A.f` 直接
    //   unresolved）。2026-09-25 把它补进 `members`，并按"同名 `.ml` 不在本次图里"设了条件 ——
    //   见 scan.mjs 的 ifaceOnly 与下面 onDemandTypes 那两条注释。
    onDemandTypes: {
      value_definition: 'value',
      // `.mli` 的 `val`：**只有**在"这个 .mli 没有同名 .ml 在本次扫描里"时才发节点
      // （判据在 scan.mjs 的 ifaceOnly）。有实现时发它会让同一个 fqn 出现两个节点，
      // 解析器反而挑不出唯一、把已经接对的边丢掉 —— 见上面那段说明。
      value_specification: 'value',
      // `external` 声明同样按需发节点（标准库的 `Array.length` / `Array.make` 就是它）。
      // 它没有"`.ml` / `.mli` 同名重复"的问题（同一个名字不可能既 external 又 let）。
      external: 'value',
    },
    // `foo.ml` 本身就是一个模块 `Foo`：它的**顶层定义就是 Foo 的成员**。
    // 不认这条，`stdlib/list.ml` 顶层的 `let map` 会登记成裸名 `map`，而别的文件写 `List.map`
    // 永远对不上 —— 实测 `List.map` 唯一能精确命中的只有某个测试文件里显式写的局部 `module List`，
    // 于是 783 条跨文件边接到了 testsuite/。
    // ⚠ 文件顶层**已经**有同名模块时不加前缀（`stdlib/stdlib.ml` 里有 `module List = List`）——
    //   那时 List 已是根层名字，加前缀会变成 `Stdlib.List`，反而错。这条例外写在 scan.mjs 的 fileModuleNs()。
    fileModuleNamespace: true,
    // 下面是**调查记录**（2026-09-24），免得下次白试：
    // 我一度以为 ocaml 的边里有 ~41% 是 ppx `[%%expect {| … |}]` 引号块被当代码解析产生的"幽灵"，
    // 还写了个"不往里看"的节点机制（opaqueNodes）想清掉它们。**判断是错的**，机制已撤：
    //   · 语法包**没有**把引号块内容提升成顶层定义 —— 实测 disambiguation.ml 的 66 个 type/module
    //     定义里，落在 `[%%expect]` 行范围内的 = **0 个**；内容老实包在 `attribute_payload` 里
    //   · 那些同名 `X` 是**真代码**（OCaml 测试里 `module X = struct end` 合法且常见，一个文件 16 个）
    //   · 真实属性（`[@@deprecated …]` / `[@@@warning …]`）也不会被误抽成节点（实测开/关结果一模一样）
    // 当时判断真正待解决的是**限定名的解析歧义**：`X.t` 里的 `X` 属于哪个作用域 ——
    // 同名模块在图上有很多个，那时候"精确匹配"会从里面挑中一个（宁缺勿错还没落地）。
    // **这一条后来落地了**：resolveName 的三档优先级 + fileModuleNamespace，残留见上面"已知残留"。
    /**
     * **`open M` 就是 OCaml 的 import**（2026-10-04 精度轮补的）。
     *
     * 以前这里是 `imports: {}` —— 结果 OCaml **一个 import 都记不到**，于是它 34,000+ 条跨文件边
     * 全部落在 `unique` 档（0% import 口径，见 `工作文档\成员名-2026-10-04.md` 第 1.1 节）：
     * 档位分不出"有 `open` 撑着"和"纯按名字猜"，读侧（impact / refs）也就无从判断可信度。
     * 而 `open M` 的语义正是"把 M 的成员引进当前作用域" —— 与 Java 的 `import` 同级。
     * 加完之后 ocaml 样本上 **930 → 2,835 条边**从 unique 升到 import（有据）。
     *
     * ⚠ **`include` 故意不认**（2026-10-04 实测踩到）：OCaml 的 `include Identifiable.Make (struct … end)`
     * 也是 `include_module` 节点，而识别成 import 后 walk 会**早退、不走进它的子树** ——
     * 于是 `struct … end` 里的 `let compare/equal/print/output/hash` **全部消失**
     * （实测 ocaml 样本掉了 64 个值节点，`Compilation_unit.print` 那 27 条入边整批没）。
     * `open` 没这个风险（右边只能是模块路径），而且是更常见的形态。
     *
     * 语法树（probe 实测）：`open_module → module_path → module_name`；
     * `open Stdlib.List` 是 `extended_module_path`。`importTextOf` 取**模块路径那一段**，
     * 不能直接用 `node.text`（那会带上 `open` 关键字）。
     */
    imports: { open_module: 1 },
    // 防御式再一道闸：只有 `open_module` 且"右边是模块路径"才算 import —— 将来语法包若把
    // `open struct … end` 之类也认成同一个节点，也不会把子树整块跳过。
    // ⚠ `importKindOf` 是**对每个节点**都会调用的（不是只对 imports 表里那些）—— 忘了判 `node.type`
    //   就会把 `module_definition` / 整个 compilation_unit 都当 import 早退，图直接崩（实测踩过）。
    importKindOf: (node) => (
      node.type === 'open_module'
      && node.namedChildren.some((c) => c.type === 'module_path' || c.type === 'extended_module_path') ? 1 : null
    ),
    importTextOf: (node) => {
      const p = node.namedChildren.find((c) => c.type === 'module_path' || c.type === 'extended_module_path');
      return p ? p.text : node.text;
    },
    /**
     * 局部绑定（A3，2026-09-25 实测）—— 规则与保守边界见 Go profile 的同一项。
     *   · `parameter`：`let render radius label = …` 与 `fun item -> …` 的参数（`pattern` 字段，
     *     节点类型是 `value_pattern`）；`let use () = …` 的 `()` 是 `unit`，裸名正则挡掉；
     *   · `let_binding`：**只有 `let … in` 里的才是局部变量**。顶层 `let helper x = …` 是**模块成员**
     *     （别的文件写 `Spec.helper` 指的就是它），登记成局部会把真边砍掉 —— 闸就是"祖先里有
     *     `let_expression`"。
     * ⚠ `let a, b = (1, 2)` 的 pattern 是 `tuple_pattern`（**叶子**，下面没有标识符）—— 收不到就不收。
     */
    localBindings: {
      let_binding: { field: 'pattern', only: (node) => hasAncestorType(node, 'let_expression') },
      parameter: 'pattern',
    },
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
    // ⚠ `package_clause` 的文本是**整串** `package cobra` —— 不取里面的 `package_identifier`，
    // 命名空间就会记成 `"package cobra"`（实测：某真 Go 项目里所有候选的 ns 都是这个形状，
    // 于是"同包"这一档**一次都没匹配上**，同一包内的裸名引用只能去撞同名的别包符号）。
    nameOf: (node) => (node.namedChildren.find((c) => c.type === 'package_identifier') || {}).text || null,
    types: { type_declaration: 'type' },
    // 局部绑定（参数 / `x := …` / `var x …`）：这些名字在当前作用域里是**变量**，
    // 不该当成"别处那个同名类型/函数"的引用（见 localBindings 的说明）
    localBindings: {
      parameter_declaration: 'name',
      short_var_declaration: 'left',
      var_spec: 'name',
      range_clause: 'left',
      type_parameter_declaration: 'name',
    },
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
    /**
     * **裸名必须在作用域里**（Go，2026-10-05 第 11 轮）：Go 里**跨包必须写限定名**（`pkg.Name`）——
     * 一个光秃秃的裸名只可能指**同包**的声明（或内建 / `import . "pkg"` 那种点导入，它也有 import 依据）。
     * 所以"跨包 + 零依据"的裸名匹配只能是同名巧合 ✗（与 Java/Kotlin 同档：`ns`，Go 没有包嵌套）。
     * 实测：etcd 上 `Message`（引用方 `etcdserverpb` → 目标 `snap`）、grpc-go 上 `Listener`
     * （`xdsresource` → `bufconn`）这类边全是跨包的 ✗。
     */
    bareNameScope: 'ns',
    baseFields: [],
    baseNodes: [],
    decisions: ['if_statement', 'for_statement', 'expression_switch_statement', 'type_switch_statement', 'select_statement', 'expression_case', 'type_case', 'communication_case', 'default_case', 'binary_expression'],
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
    /**
     * **裸名跨文件必须有 `use`**（Rust，2026-10-05 第 7 轮）：Rust 2018 起，一个模块里的裸名
     * 只能指"本文件里声明的"或"`use` 进来的"（祖先模块的项要写 `super::` / `crate::`，那是**限定名**，
     * 走另一条路）。所以"跨文件 + 零 import 依据"的裸名匹配**只能是名字巧合**。
     * 实测：`rust-analyzer` 一个样本 9,049 条 unique 里 **7,218 条（80%）指向
     * `crates/test-utils/src/minicore.rs`**（那个文件里是**假的标准库**），名字全是
     * `Option`(1834) · `Formatter` · `Debug` · `From` · `Clone` · `PartialEq` · `Hash` · `Iterator` …
     * —— 真身是 `std` 的 prelude 项，图里没有，也不该接到测试夹具上。
     */
    bareNameScope: 'import-only',
    baseFields: [],
    baseNodes: [],
    // impl_item 的名字取它实现的类型（field 'type'），这样方法就挂在同名节点下
    nameFromField: { impl_item: 'type' },
    // 局部绑定（规则与保守边界见 Go profile 的同一项）：参数 / `let x` / 闭包参数 / 匹配绑定
    localBindings: {
      // 泛型（类型）参数：`class Foo[T]` / `fn f<T>()` 里的那个 T —— 它是**类型**参数，
      // 不是别处那个同名类型（不登记的话，`Flow[In, Out, Mat]` 的 `Out` 会接到另一个文件的 `Out`）。
      // ⚠ 用 `auto` 而不是 `'name'`：实测 **Java 的 `type_parameter` 没有 name 字段**（名字是直接子节点
      //   `type_identifier`），而 **Rust 有**（`type_parameter [name="T"]`）—— `auto` 两种形状都收。
      //   这类声明 `probe:profile` 查不出来（它只问"这门语法里有没有这个字段名"、不查"这个节点上有没有"），
      //   必须靠夹具钉：tests/fixtures/typeparam-java/。
      type_parameter: 'auto',
      parameter: 'pattern',
      let_declaration: 'pattern',
      closure_parameters: 'pattern',
      for_expression: 'pattern',
      // `if let x = …` / `while let x = …`：真正的节点是 **`let_condition`**（`if_expression` 的
      // `condition` 孩子）。⚠ 2026-09-25 的 profile 审计查出这里原本写的是 `if_let_expression` /
      // `while_let_expression` —— **语法包里根本没有这两个名字**，等于一条也没生效（静默失效）。
      // 也不能直接挂 `if_expression` 的 `condition` 字段：普通 `if flag` 的 `flag` 是**引用**，
      // 挂上去会把引用当成声明（见 Swift profile 里同一类取舍）。
      // ⚠ `if let Some(x) = …` 的 `x` 仍收不到（`pattern` 是 `tuple_struct_pattern`）—— 不猜。
      let_condition: 'pattern',
      match_arm: 'pattern',
    },
    decisions: ['if_expression', 'match_expression', 'match_arm', 'for_expression', 'while_expression', 'loop_expression', 'binary_expression'],
    decisionOps: ['&&', '||'],
  },

  c: {
    id: 'c',
    label: 'C',
    status: 'ok',
    exts: ['.c', '.h'],
    wasm: 'c/tree-sitter-c.wasm',
    // 与 C++ 同族：`.h` 会被按内容嗅探成 C 或 C++（同一个头文件两个语言都能看见），
    // 实测（abseil / leveldb）不认这条会丢 `cpp→c` 106 条、`c→cpp` 30+3 条真依赖。
    family: 'c',
    namespaces: {},
    types: { type_definition: 'type', struct_specifier: 'struct', enum_specifier: 'enum', union_specifier: 'union' },
    // typedef struct X {...} X; 会让 struct_specifier 成为 type_definition 的子节点，别重复记
    typeSkipParent: { struct_specifier: ['type_definition'], enum_specifier: ['type_definition'], union_specifier: ['type_definition'] },
    members: { function_definition: 'function', declaration: 'field', field_declaration: 'field', enumerator: 'enumValue' },
    // 局部绑定（规则与保守边界见 Go profile 的同一项）：参数与**块内**变量声明。
    // 名字在 `declarator` 字段上（`const char *path` 的 declarator 是 `*path`），
    // 取值时走 declaratorName() 剥掉指针/数组。
    localBindings: {
      parameter_declaration: 'declarator',
      init_declarator: 'declarator',
      declaration: 'declarator',
    },
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
    family: 'c',        // 与 C 同族（见 c profile 的说明）
    namespaces: { namespace_definition: 1 },
    types: { class_specifier: 'class', struct_specifier: 'struct', enum_specifier: 'enum', union_specifier: 'union' },
    typeSkipParent: { struct_specifier: ['type_definition', 'class_specifier'], enum_specifier: ['type_definition'], union_specifier: ['type_definition'] },
    members: { function_definition: 'function', field_declaration: 'field', declaration: 'field', enumerator: 'enumValue' },
    // 局部绑定：与 C 同形（见 c profile 里那份说明）
    // ⚠ C++ **不登记泛型参数**：实测这门语法包在本仓库的 C++ 样本上**解析不出模板结构** ——
    //   `template <class InputIt1, …>` 整段落在 `expression_statement` 里（abseil 一个样本 4,042 个异常），
    //   没有 `type_parameter*` 节点可挂。等 C++ 语法包换新了再说（见"已知局限"里那条 C/C++ 不做名字解析）。
    localBindings: {
      parameter_declaration: 'declarator',
      init_declarator: 'declarator',
      declaration: 'declarator',
    },
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
    /**
     * **裸名必须在作用域里**（PHP，2026-10-05 第 17 轮）：PHP 的裸**类名**只解析到**当前命名空间**
     * （没有 Java 那种"外层命名空间自动可见"，PHP 的命名空间**不可嵌套**）—— 用别的命名空间的类必须
     * `use` 进来或写全限定名（那是限定名，走另一条路）⇒ 档位与 Java / Kotlin 相同（`ns`）。
     *
     * ⚠ 为什么 PHP 可以、而它的"函数回落全局"不是问题：本 profile 的 `types` 只发
     * `class / interface / trait / enum`（**没有函数节点**）—— 所以图上的节点全是类语义的，
     * "裸函数名回落全局"那个坑在这张图上不存在 ✓。（实测 php 样本：跨文件 unique 边
     * 306 条在"有 use 的文件"里、41 条在没有 use 的文件里 ✗。）
     *
     * 同一轮**量过但决定不做**的语言（理由见各 profile 的注释 / 报告）：
     *   · **Zig** —— 它的 `imports: {}`（根本没提取 import）⇒ 上闸会把所有跨文件裸名当"无据"砍掉 ✗；
     *   · **Swift** —— 同一模块内文件互相可见（`import` 只指框架）⇒ 上闸砍真边 ✗；
     *   · **Ruby** —— 常量按词法作用域 + 祖先链解析（Rails 那类）✗；
     *   · **OCaml** —— `include` / 函子生成的名字不是 import 依据（只把 `open` 记成 import）✗。
     */
    bareNameScope: 'ns',
    /**
     * 局部绑定（A3，2026-09-25 实测）。PHP 的名字都在 `variable_name` 里，而它的**文本带 `$`**、
     * 真正的名字在它自己的 `name` 字段（`$radius` → `radius`）—— 取值层会自动走进去。
     *   · `int $radius`（`simple_parameter`）/ `...$rest`（`variadic_parameter`）/ `static $c`；
     *   · `$tmp = …`（`assignment_expression`）与 `$acc += …`、`$ref = &$a`；
     *     `$this->x = …` 是 `member_access_expression`、`$a[0] = …` 是 `subscript_expression`，
     *     都不是 `variable_name`，天然被排除；
     *   · `list($a, $b) = …` / `[$a, $b] = …` 左值是 `list_literal`（解构，算一组局部绑定）；
     *   · `global $db;` 没有字段，按声明位置取。
     */
    localBindings: {
      simple_parameter: 'name',
      variadic_parameter: 'name',
      static_variable_declaration: 'name',
      assignment_expression: 'left',
      augmented_assignment_expression: 'left',
      reference_assignment_expression: 'left',
      global_declaration: 'auto',
      /**
       * `foreach ($arr as $k => $v)`：`as` 后面的那（几）个变量**没有字段**，而且排在**第二个**孩子
       * 之后 —— 用 `'auto'`（取第一个能取到名字的孩子）会把被遍历的那个表达式 `$arr` 当成绑定。
       * 所以自己取：跳过第一个孩子，其余 `variable_name` / `pair` 里的 `variable_name` 都是绑定。
       */
      foreach_statement: (node) => {
        const out = [];
        const visit = (c) => {
          if (c.type === 'variable_name') out.push(c.text);
          else if (c.type === 'pair') c.namedChildren.forEach(visit);
        };
        for (const c of node.namedChildren.slice(1)) visit(c);
        return out;
      },
    },
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
      // `class` / `struct` / `enum` / `protocol` / `extension` / `actor` 在语法树里**都是**
      // `class_declaration`，靠 `typeKindFn` 看第一个关键字区分（见下）。语法包里并没有
      // `extension_declaration` / `actor_declaration` 这两个节点名 —— 以前那两条是死配置。
      class_declaration: 'class',
      protocol_declaration: 'protocol',
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
    /**
     * 局部绑定（A3，2026-09-25 实测）—— 规则与保守边界见 Go profile 的同一项。
     *   · `func render(radius: Double, …)` 的参数与闭包参数 `{ (x: Int) in … }` 都有 `name` 字段；
     *   · `let tmp = …` / `var acc = …` 的名字在 `name` 字段（节点类型是 `pattern`），
     *     **类体里的属性不算**（`only` 闸）—— 属性的裸名引用是合法跨文件引用；
     *   · `for i in …` / `for (idx, value) in …`：绑定就是 `item` 字段（元组模式可递归取到两个名字）；
     *   · `if let first = …` / `guard let last = …` / `while let top = …` 都绑在 `bound_identifier` 字段上。
     * ⚠ `if case let .some(v) = …` 的 `v` **收不到**：它不在任何字段上（是 `condition` 字段的第 3 个孩子，
     *   `childForFieldName('condition')` 只返回第一个）—— 按名字取 `condition` 会把普通 `if flag` 的
     *   **引用** `flag` 当成本地声明（更坏），所以宁可不收。
     */
    localBindings: {
      // 泛型（类型）参数：`class Foo[T]` / `fn f<T>()` 里的那个 T —— 它是**类型**参数，
      // 不是别处那个同名类型（不登记的话，`Flow[In, Out, Mat]` 的 `Out` 会接到另一个文件的 `Out`）。
      // ⚠ 用 `auto` 而不是 `'name'`：实测 **Java 的 `type_parameter` 没有 name 字段**（名字是直接子节点
      //   `type_identifier`），而 **Rust 有**（`type_parameter [name="T"]`）—— `auto` 两种形状都收。
      //   这类声明 `probe:profile` 查不出来（它只问"这门语法里有没有这个字段名"、不查"这个节点上有没有"），
      //   必须靠夹具钉：tests/fixtures/typeparam-java/。
      type_parameter: 'auto',
      parameter: 'name',
      lambda_parameter: 'name',
      property_declaration: { field: 'name', only: localNotMember(['function_body', 'lambda_literal'], ['class_body', 'protocol_body']) },
      for_statement: 'item',
      if_statement: 'bound_identifier',
      guard_statement: 'bound_identifier',
      while_statement: 'bound_identifier',
    },
    baseFields: [],
    // 继承列表：实测只有 `inheritance_specifier` 这一个节点名是真的（另两个名字语法包里没有）。
    baseNodes: ['inheritance_specifier'],
    // `switch_entry`（不是 `case_statement` —— 那个名字 Swift 语法包里没有，等于每个 case
    // 都没被计进复杂度）。实测 `case 1: break` 产出的是 `switch_entry`。
    decisions: ['if_statement', 'guard_statement', 'for_statement', 'while_statement', 'repeat_while_statement', 'switch_statement', 'switch_entry', 'catch_block', 'ternary_expression', 'conjunction_expression', 'disjunction_expression'],
    decisionOps: [],
  },

  scala: {
    id: 'scala',
    label: 'Scala',
    status: 'ok',
    exts: ['.scala', '.sc'],
    wasm: 'scala/tree-sitter-scala.wasm',
    family: 'jvm',      // 与 Java / Kotlin 同族（见 java profile 的说明）
    namespaces: { package_clause: 1 },
    namespaceScope: 'file',
    /**
     * 局部绑定（A3，2026-09-25 实测）—— 规则与保守边界见 Go profile 的同一项。
     *   · `def f(xs: List[Int])` 的参数有 `name` 字段；
     *   · `val tmp = …` / `var acc = …` 的名字在 `pattern` 字段（`val (p, q) = …` 是 `tuple_pattern`，
     *     它是**叶子**、下面没有标识符可走 —— 收不到就不收，宁缺勿错）；
     *   · `for (i <- xs; j = i * 2)` 的枚举变量没有字段，第一个标识符就是它（第二个是来源，不能收）；
     *   · `catch { case e: Exception => … }` 是 `typed_pattern`（`pattern` 字段）。
     * `val` / `var` 在**类体**里是属性（成员），在函数里才是局部变量 —— 靠 `only` 闸区分，
     * `typed_pattern` 同理（`val x: Int = …` 的 pattern 就是它）。
     */
    localBindings: {
      /**
       * Scala 的泛型参数形状（`probe:tree` 实测）：`type_parameters` 这个**容器自己带 `name`**
       * （`[T]` → name="T"），多个 / 带型变时其余在子节点里
       * （`[In, Out, Mat]` → 两个 `identifier`；`[+Mat]` → `covariant_type_parameter` 带 name）。
       * 没有单独的 `type_parameter` 节点（语法包里查无此名）→ 只能按容器写函数规格。
       */
      type_parameters: (node) => {
        const out = [];
        const first = node.childForFieldName('name');
        if (first && first.text) out.push(first.text);
        for (const c of node.namedChildren) {
          if (c.type === 'identifier' || c.type === 'type_identifier') { out.push(c.text); continue; }
          const nm = c.childForFieldName('name');
          if (nm && nm.text) out.push(nm.text);
        }
        return out;
      },
      parameter: 'name',
      enumerator: 'auto',
      val_definition: { field: 'pattern', only: localNotMember(['function_definition', 'lambda_expression', 'block'], ['template_body']) },
      var_definition: { field: 'pattern', only: localNotMember(['function_definition', 'lambda_expression', 'block'], ['template_body']) },
      typed_pattern: { field: 'pattern', only: localNotMember(['function_definition', 'lambda_expression', 'block'], ['template_body']) },
    },
    types: { class_definition: 'class', object_definition: 'object', trait_definition: 'trait', enum_definition: 'enum' },
    members: {
      function_definition: 'function',
      val_definition: 'field',
      var_definition: 'field',
    },
    imports: { import_declaration: 1 },
    /**
     * **裸名必须在作用域里**（Scala，2026-10-05 第 10 轮）：Scala 的包**嵌套可见** ——
     * 在 `package a.b.c` 里，`a.b.c.X` 与外层包 `a.b.X` / `a.X` 都直接可见，别的包必须 `import`；
     * 所以档位与 C# 相同（`ns+ancestors`）。
     * 实测依据：`oss3-akka` 的 `unique` 档 2,171 条里，目标是 `Throwable` 574 · `System` 221 ·
     * `Deprecated` 200 · `Exception` 134 这类 **JDK / Scala 标准库名**（真身在图外的默认导入里），
     * 却接到了图内同名的 Scala 类上 ✗。
     * ⚠ Swift **不能**加这一档：它 `namespaces: {}`（模块内文件互相可见、不靠 import），加了会误砍真边。
     */
    bareNameScope: 'ns+ancestors',
    baseFields: [],
    baseNodes: ['extends_clause'],
    decisions: ['if_expression', 'match_expression', 'case_clause', 'for_expression', 'while_expression', 'try_expression', 'infix_expression'],
    // `infix_expression`（不是 `binary_expression` —— 那个名字 Scala 语法包没有，等于 `&&`/`||`
    // 从来没被计过）。实测它有 `operator` 字段，文本就是 `&&` / `||`。
    // ⚠ 同时要声明 `decisionOpNodes`：不声明的话 `infix_expression` 会落进"一律计数"，
    //   把 `+`、`>` 也算成分支（实测 Circle 复杂度 2 → 5）。
    decisionOpNodes: ['infix_expression'],
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
    /**
     * 局部绑定（A3，2026-09-25 实测）—— 规则与保守边界见 Go profile 的同一项。
     *   · 参数表：`def f(a, b = 1, *rest, key:, opt: 2, **opts, &blk)` 是 `method_parameters`，
     *     里面每个参数（含 `optional_parameter` / `splat_parameter` / `keyword_parameter` /
     *     `hash_splat_parameter` / `block_parameter`）**各自带 name 字段**；块参数 `|a, b|` 是
     *     `block_parameters`，lambda 的是 `lambda_parameters`；
     *   · `x = …` / `x += …`：左值是裸 `identifier`；`x, y = 1, 2` 是 `left_assignment_list`。
     *     `@x = …`（instance_variable）/ `$x`（global_variable）/ `A.x = …`（call）都不是 identifier，天然排除；
     *   · `for i in 1..3` 的循环变量在 `pattern` 字段；`rescue StandardError => e` 是 `exception_variable`。
     */
    localBindings: {
      method_parameters: 'auto',
      block_parameters: 'auto',
      lambda_parameters: 'auto',
      assignment: 'left',
      operator_assignment: 'left',
      for: 'pattern',
      exception_variable: 'auto',
    },
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

  /**
   * Markdown：**把标题层级变成可查的节点**。
   *
   * 为什么值得单开一门：AI 实测反馈里说得很直白 —— 定向阶段最常问的是"README 里哪一节讲这个"，
   * 而 `.md` 不进图时只能**整份读**（那个 README 645 行），它把这条列为"最大的现成增量"。
   * 进了图之后，"读文档"变成"查文档"：`search('发布')` 直接给到 `README_CN.md` 里的那一节 + 行号。
   *
   * 结构（实测 tree-sitter-markdown）：`section` 是**嵌套**的 —— 每个 section 的
   * `atx_heading` 是它的标题，子 section 是更低一级的标题。所以直接把 `section` 当"类型"、
   * 标题文本当名字，层级天然就对了（h1 → h2 → h3）。
   *
   * ⚠ `optIn`：和 json/yaml/toml/css/html 一样**默认不扫** —— 不然一堆文档会把代码地图淹了。
   *   要扫就 `--lang auto,markdown`（或启动器里勾上）。
   * ⚠ 不抽链接当引用：`[x](url)` 指向的是网址或别的文档，不是代码依赖，硬接会造噪声。
   */
  markdown: {
    id: 'markdown',
    label: 'Markdown',
    status: 'ok',
    optIn: true,
    exts: ['.md', '.markdown'],
    wasm: 'markdown/tree-sitter-markdown.wasm',
    namespaces: {},
    types: { section: 'section' },
    members: {},
    imports: {},
    nameOf: markdownSectionName,
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: [],
  },
};

/**
 * Markdown 的 `section` 取名：取它自己那个 `atx_heading` 的文本当名字。
 * 剥掉反引号与强调符（`` `CodeAtlas.exe` `` → `CodeAtlas.exe`）—— 名字要能被人和 agent 直接读、
 * 也要能当 search 的关键词。
 */
export function markdownSectionName(node) {
  const head = (node.namedChildren || []).find((c) => c.type === 'atx_heading');
  // 没有 `atx_heading` 的 section 是**解析产物**（最典型：文件开头的 YAML frontmatter `---…---`
  // 会被包成一个无标题 section）—— 不是"文档的一节"，不造节点。
  if (!head) return null;
  const inline = (head.namedChildren || []).find((c) => c.type === 'inline');
  const raw = String(inline ? inline.text : head.text);
  const clean = raw
    .replace(/^#+\s*/, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || null;
}

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
