/**
 * 扫描器：源码目录 -> bundle（中间数据）
 *
 * 流程：遍历文件 -> tree-sitter 解析 -> 提取（命名空间/类型/成员/导入/引用/复杂度/LOC）
 *      -> 建索引（符号表、继承图、引用图）-> 汇总（包树、扇入扇出）-> 写出 bundle.json
 *
 * bundle 里每一项都带来源（file/line），方便前端跳转、也方便 AI 溯源。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Parser from 'web-tree-sitter';
import { WASM_DIR, LANGUAGES, languageForExt, resolveLanguages } from './languages.mjs';
import { preprocess } from './preprocess.mjs';

export const SCHEMA = 'code-atlas/1';
export const VERSION = '0.1.0';

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 起子进程时用它调回自己（__extract 内部命令） */
const CLI_PATH = path.join(PROJECT_ROOT, 'src', 'cli.mjs');

/** 默认跳过的目录：依赖、构建产物、版本库元数据 */
const IGNORE_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bin', 'obj', 'dist', 'build', 'out', 'target',
  'vendor', 'packages', '.vs', '.vscode', '.idea', '.venv', 'venv', '__pycache__',
  'coverage', '.next', '.nuxt', '.cache', 'publish', 'publish-sc', 'publish-lite',
]);

/** 默认跳过的文件：压缩产物、自动生成的代码 */
const IGNORE_FILE_RE = /(\.min\.(js|css)|\.d\.ts|\.g\.cs|\.designer\.cs|\.generated\.(cs|ts)|\.freezed\.dart)$/i;

/** 还没支持的语言的后缀（只用于报告"漏了多少"，不会去解析） */
const UNSUPPORTED_SRC_EXTS = new Set([
  '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.cxx', '.m', '.mm',
  '.php', '.rb', '.swift', '.scala', '.gradle', '.dart',
  '.fs', '.fsx', '.vb', '.pl', '.pm', '.r', '.jl', '.ex', '.exs', '.erl', '.groovy',
  '.vue', '.svelte', '.el', '.clj', '.cljs', '.hs', '.ml', '.nim', '.zig', '.sol',
]);

/**
 * 编译器 / 生成器产出的类型名（反编译产物里最常见）：
 *   <PrivateImplementationDetails>、<>c、<>c__DisplayClass0_0、<Foo>d__12
 *   ILSpy 会把尖括号转义成 _003C / _003E，所以两种写法都要认；
 *   还有 __InlineArray、源生成器的 __XxxConfig 这类。
 */
const GENERATED_NAME_RE = /(^<|^_003C)|(__InlineArray|__DisplayClass|PrivateImplementationDetails|_003E__|\$Lambda\$|^_003CModule_003E)/;

// ---------------------------------------------------------------------------
// 文件收集
// ---------------------------------------------------------------------------

function collectFiles(roots, { languages, maxKb, excludes }) {
  const exts = new Map();
  for (const lang of languages) for (const e of lang.exts) exts.set(e, lang);
  // 全量语言表：用来区分"这次没勾"和"我们根本不支持"——两者混在一起会误导人
  const allExts = new Map();
  for (const lang of Object.values(LANGUAGES)) for (const e of lang.exts) if (!allExts.has(e)) allExts.set(e, lang.id);

  const ignoreDirs = new Set(IGNORE_DIRS);
  for (const d of excludes || []) ignoreDirs.add(d);

  const files = [];
  const skipped = { ignored: 0, tooBig: 0, unknown: 0, unsupported: new Map(), outOfScope: new Map() };

  for (const root of roots) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (ignoreDirs.has(e.name) || e.name.startsWith('.git')) { skipped.ignored++; continue; }
          stack.push(abs);
          continue;
        }
        if (!e.isFile()) continue;
        if (IGNORE_FILE_RE.test(e.name)) { skipped.ignored++; continue; }
        const ext = path.extname(e.name).toLowerCase();
        const lang = exts.get(ext);
        if (!lang) {
          const owner = allExts.get(ext);
          if (owner) {
            // 这门语言我们支持，只是这次没在扫描范围内（没勾 / 文件级格式默认不扫）
            skipped.outOfScope.set(owner, (skipped.outOfScope.get(owner) || 0) + 1);
            continue;
          }
          skipped.unknown++;
          // 记下"是源码但我们还不支持的语言"，报告里能看出漏了什么（而不是静静吞掉）
          if (UNSUPPORTED_SRC_EXTS.has(ext)) skipped.unsupported.set(ext, (skipped.unsupported.get(ext) || 0) + 1);
          continue;
        }
        let stat;
        try { stat = fs.statSync(abs); } catch { continue; }
        if (stat.size > maxKb * 1024) { skipped.tooBig++; continue; }
        files.push({
          abs,
          rel: path.relative(root, abs).split(path.sep).join('/'),
          root,
          lang,
          bytes: stat.size,
          mtime: stat.mtimeMs,
        });
      }
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, skipped };
}

// ---------------------------------------------------------------------------
// AST 提取
// ---------------------------------------------------------------------------

/** 把 [startRow, endRow] 标进掩码（用于统计注释行） */
function markRows(mask, startRow, endRow) {
  for (let r = startRow; r <= endRow && r < mask.length; r++) mask[r] = 1;
}

/** 取节点名：优先 name/declarator 字段，没有字段就找第一个标识符子节点（Kotlin 等语法不给 name 字段） */
const ID_TYPES = ['type_identifier', 'simple_identifier', 'scoped_identifier', 'identifier', 'dotted_name', 'qualified_name', 'name', 'value_name', 'constructor_name', 'module_name', 'type_constructor', 'value_identifier', 'module_identifier', 'symbol', 'id'];
function nameOf(node, lang) {
  // Rust impl 块：名字取它实现的类型（field 'type'），让方法挂到同名节点上
  const namedField = lang && lang.nameFromField && lang.nameFromField[node.type];
  if (namedField) {
    const f = node.childForFieldName(namedField);
    if (f) return f.text;
  }
  for (const f of ['name', 'declarator']) {
    const n = node.childForFieldName(f);
    if (n) return n.text;
  }
  // const foo = () => {}：名字在 variable_declarator 上
  // 名字可能包在外层绑定里：Zig 的 struct 在 variable_declaration、OCaml 的在 type_binding
  const WRAPPERS = ['variable_declarator', 'type_spec', 'type_binding', 'let_binding', 'module_binding'];
  const group = node.namedChildren.find((c) => WRAPPERS.includes(c.type));
  if (group) {
    const g = group.childForFieldName('name') || group.childForFieldName('pattern')
      || group.namedChildren.find((c) => ID_TYPES.includes(c.type));
    if (g) return g.text;
    if (group.type === 'type_binding') {
      const t = group.namedChildren.find((c) => c.type === 'type_constructor');
      if (t) return t.text;
    }
  }
  // 名字挂在父节点上（Zig：const Point = struct {...}）
  const par = node.parent;
  if (par) {
    const pn = par.childForFieldName('name');
    if (pn) return pn.text;
    const pb = par.namedChildren.find((c) => WRAPPERS.includes(c.type));
    if (pb) {
      const g = pb.childForFieldName('name');
      if (g) return g.text;
    }
    // Zig：const Point = struct {}，名字是父节点里第一个 identifier
    const pid = par.namedChildren.find((c) => ID_TYPES.includes(c.type));
    if (pid) return pid.text;
  }
  for (const t of ID_TYPES) {
    const hit = node.namedChildren.find((c) => c.type === t);
    if (hit) return hit.text;
  }
  return null;
}

/** 取类型引用里最深的一个标识符（Foo.Bar<Baz> -> Baz? 不对，是取最外层类型名） */
function lastIdentifier(node) {
  let n = node;
  for (let guard = 0; guard < 8; guard++) {
    const ids = n.namedChildren.filter((c) =>
      c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'property_identifier'
      || c.type === 'name' || c.type === 'simple_identifier');
    if (!ids.length) return String(n.text || '').replace(/^[:\s]+/, '').replace(/[^\w$.]+$/, '');
    n = ids[ids.length - 1];
  }
  return String(n.text || '');
}

/** 从泛型 / 限定名 / 包装节点里取基类型名（Kotlin 的 user_type / constructor_invocation 都要剥一层） */
function baseNameOf(node) {
  const unwrap = ['generic_name', 'generic_type', 'user_type', 'constructor_invocation', 'delegation_specifier', 'superclass', 'super_interfaces', 'extends_clause', 'implements_clause'];
  // Swift：inheritance_specifier 的基类在 inherits_from 字段里
  if (node.type === 'inheritance_specifier') {
    const f = node.childForFieldName('inherits_from');
    return f ? baseNameOf(f) : lastIdentifier(node);
  }
  if (unwrap.includes(node.type)) {
    const t = node.childForFieldName('name') || node.namedChildren[0];
    return t ? baseNameOf(t) : node.text;
  }
  return lastIdentifier(node);
}

/** 收集一组基类/接口名 */
function collectBaseNames(node, out) {
  const listTypes = new Set(['base_list', 'super_interfaces', 'interface_type_list', 'type_list', 'extends_clause', 'implements_clause', 'delegation_specifiers']);
  const items = listTypes.has(node.type) ? node.namedChildren : [node];
  for (const item of items) {
    if (item.type === 'type_arguments' || item.type === 'type_parameter') continue;
    const name = baseNameOf(item);
    if (name && /^[A-Za-z_$][\w$.]*$/.test(name)) out.push(name.split('.').pop());
  }
}

/** 从 import 语句里抠出目标名（C# using / Java import / JS-TS import / Python from-import / C-C++ #include / PHP use 都吃） */
function parseImport(text) {
  const raw = String(text).trim();
  // C/C++：#include <stdio.h> / #include "x.h"
  const inc = raw.match(/^#\s*include\s*[<"]([^>"]+)[>"]/);
  if (inc) return inc[1];
  const py = raw.match(/^from\s+([^\s]+)\s+import/i);
  if (py) return py[1];
  let t = raw.replace(/;+$/, '').replace(/^global\s+/, '');
  t = t.replace(/^(using|import|package|require|from|use|namespace)\s+/, '');
  t = t.replace(/^(static|type)\s+/, '');
  const eq = t.indexOf('=');
  if (eq >= 0) t = t.slice(eq + 1);
  t = t.trim();
  const m = t.match(/from\s+['"]([^'"]+)['"]/) || t.match(/^['"]([^'"]+)['"]$/);
  if (m) t = m[1];
  return t.split(',')[0].trim().replace(/\s+as\s+\S+$/i, '');
}

/** 从注释里抽出人能读的“说明”（C# 的 /// summary、Java/TS 的块注释都吃） */
function cleanDoc(text) {
  let t = text
    .replace(/^\/\*\*?/, '').replace(/\*\/$/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\/\/\/?/, '').replace(/^\s*\*\/?/, '').trim())
    .join(' ')
    .replace(/<summary>([\s\S]*?)<\/summary>/i, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  // 排除分节线这类装饰性注释（===== Win32 =====），它们不是“说明”
  if (/[=\-*_~#]{4,}/.test(t)) return null;
  return t.length > 300 ? `${t.slice(0, 297)}…` : t;
}

/** Python 的 docstring：声明体内第一条语句如果是字符串，那就是它的说明 */
function docstringOf(node) {
  const body = node.childForFieldName('body');
  const first = body && body.namedChildren[0];
  if (!first) return null;
  let str = first;
  if (first.type === 'expression_statement' && first.namedChildren[0]) str = first.namedChildren[0];
  if (str.type !== 'string') return null;
  const text = str.text.replace(/^[rbfuRBFU]*('''|"""|'|")/, '').replace(/('''|"""|'|")$/, '');
  const t = text.replace(/\s+/g, ' ').trim();
  return t ? (t.length > 300 ? `${t.slice(0, 297)}…` : t) : null;
}

/**
 * 声明上方紧挨着的注释就是这个声明的说明。
 * 关键：注释与声明之间的行必须全是空行——否则说明那段注释其实属于上面那个声明
 * （否则会“串行”：没注释的成员检到上一个成员的说明）。
 */
function docFor(comments, startRow, lines) {
  let best = null;
  for (const c of comments) {
    if (c.endRow >= startRow) continue;
    if (startRow - c.endRow - 1 > 3) continue;
    if (!best || c.endRow > best.endRow) best = c;
  }
  if (!best) return null;
  for (let r = best.endRow + 1; r < startRow; r++) {
    if ((lines[r] ?? '').trim() !== '') return null;
  }
  return cleanDoc(best.text);
}

/**
 * 提取一个文件的全部事实。
 * @returns {{types: object[], imports: string[], refs: object[], namespaces: string[], commentRows: number, decisions: number}}
 */
function extractFile(source, tree, lang) {
  const lines = source.split(/\r?\n/);
  const mask = new Uint8Array(lines.length);
  const types = [];
  const imports = [];
  const refs = [];
  const comments = [];
  const refSeen = new Set();
  // 参数名所在的标识符节点（这些不当"引用"算）
  const skipIds = new Set();
  const namespaces = new Set();
  const nsStack = [];
  let fileNamespace = '';
  const typeStack = [];
  let errors = 0;
  // 文件级（没有类型归属）的成员/分支/引用：给"没有类型声明的文件"合成模块节点用
  const fileScope = { members: {}, memberList: [], complexity: 1, refs: [] };
  const fileRefSeen = new Set();

  const currentType = () => (typeStack.length ? typeStack[typeStack.length - 1] : null);

  function bumpMember(kind, name, line, doc) {
    const t = currentType();
    const entry = doc ? { k: kind, n: name, l: line, d: doc } : { k: kind, n: name, l: line };
    if (t) {
      t.members[kind] = (t.members[kind] || 0) + 1;
      if (name) t.memberList.push(entry);
      return;
    }
    fileScope.members[kind] = (fileScope.members[kind] || 0) + 1;
    if (name) fileScope.memberList.push(entry);
  }

  function addRef(node) {
    if (skipIds.has(node.id)) return;
    const name = node.text;
    const t = currentType();
    if (!t) {
      if (fileRefSeen.has(name)) return;
      fileRefSeen.add(name);
      fileScope.refs.push({ name });
      return;
    }
    const key = `${t.index}|${name}`;
    if (refSeen.has(key)) return;
    refSeen.add(key);
    refs.push({ owner: t.index, name });
  }

  // 有些语法会把注释挂在 import / namespace 节点里面（Kotlin 就是），收 import 时顺手把它们捞出来，别漏掉注释
  const sweepComments = (node) => {
    for (const c of node.namedChildren) if (c.type.includes('comment')) walk(c);
  };

  function walk(node) {
    const type = node.type;

    // 只数真正的 ERROR（语法树里放不下的部分）。
    // 不数 isMissing：那种零宽节点很常见（比如 using 后面），无害，数它只会把信号淹了。
    if (type === 'ERROR') errors++;

    // 注释：不同语法叫 comment / line_comment / block_comment / multiline_comment
    if (type.includes('comment')) {
      markRows(mask, node.startPosition.row, node.endPosition.row);
      comments.push({ startRow: node.startPosition.row, endRow: node.endPosition.row, text: node.text });
      return;
    }

    if (lang.imports[type]) {
      const target = parseImport(node.text);
      if (target) imports.push(target);
      sweepComments(node);
      return;
    }

    if (lang.namespaces[type]) {
      const name = nameOf(node, lang);
      if (name) {
        namespaces.add(name);
        if (lang.namespaceScope === 'file') {
          // Java / Kotlin 的 package 语句是文件级兄弟节点，作用于整份文件
          fileNamespace = name;
          sweepComments(node);
          return;
        }
        nsStack.push(name);
        for (const c of node.namedChildren) walk(c);
        nsStack.pop();
        return;
      }
    }

    const kind = lang.types[type];
    // typedef struct X{} X; 这类写法会让内外两层都命中，内层就不再重复记（但仍会进去收成员）
    const skipParents = lang.typeSkipParent && lang.typeSkipParent[type];
    const parentType = node.parent ? node.parent.type : null;
    if (kind && !(skipParents && parentType && skipParents.includes(parentType)) && (!lang.typeGuards?.[type] || lang.typeGuards[type](node))) {
      const bases = [];
      for (const field of lang.baseFields || []) {
        const b = node.childForFieldName(field);
        if (b) collectBaseNames(b, bases);
      }
      if (lang.baseNodes?.length) {
        const findBaseNodes = (n) => {
          for (const c of n.namedChildren) {
            if (lang.baseNodes.includes(c.type)) collectBaseNames(c, bases);
            else if (!lang.types[c.type]) findBaseNodes(c);
          }
        };
        for (const c of node.namedChildren) {
          if (lang.baseNodes.includes(c.type)) collectBaseNames(c, bases);
          else if (!lang.types[c.type] && !lang.members[c.type]) findBaseNodes(c);
        }
      }
      const rec = {
        index: types.length,
        name: nameOf(node, lang) || '(anonymous)',
        kind: (lang.typeKindFn && lang.typeKindFn(node)) || kind,
        ns: nsStack.join('.') || fileNamespace,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startRow: node.startPosition.row,
        endRow: node.endPosition.row,
        bases,
        doc: docFor(comments, node.startPosition.row, lines) || (lang.docstring ? docstringOf(node) : null),
        members: {},
        memberList: [],
        complexity: 1,
        parent: currentType() ? currentType().index : null,
      };
      types.push(rec);
      // 基类子树不再当引用重复统计
      const baseChildren = new Set();
      for (const field of lang.baseFields || []) {
        const b = node.childForFieldName(field);
        if (b) baseChildren.add(b.id);
      }
      typeStack.push(rec);
      for (const c of node.namedChildren) {
        if (baseChildren.has(c.id)) continue;
        walk(c);
      }
      typeStack.pop();
      return;
    }

    const memberKind = lang.members[type];
    if (memberKind) {
      const name = nameOf(node, lang);
      const mdoc = docFor(comments, node.startPosition.row, lines) || (lang.docstring ? docstringOf(node) : null);
      bumpMember(memberKind, name, node.startPosition.row + 1, mdoc);
      for (const c of node.namedChildren) walk(c);
      return;
    }

    if (lang.decisions.includes(type)) {
      const t = currentType();
      const target = t || fileScope;
      if (type === 'binary_expression') {
        const op = node.childForFieldName('operator');
        if (op && (lang.decisionOps || []).includes(op.text)) target.complexity++;
      } else {
        target.complexity++;
      }
    }

    // 参数名不算引用：把参数声明里那个标识符记下来，后面 addRef 跳过它
    const skipField = lang.skipNameNodes?.[type];
    if (skipField) {
      if (skipField === 'identifier') {
        for (const c of node.namedChildren) if (c.type === 'identifier') skipIds.add(c.id);
      } else {
        const n = node.childForFieldName(skipField);
        if (n) skipIds.add(n.id);
      }
    }

    if (type === 'identifier' || type === 'type_identifier') addRef(node);

    for (const c of node.namedChildren) walk(c);
  }

  walk(tree.rootNode);
  return { types, imports, refs, namespaces: [...namespaces], mask, lines, errors, fileScope };
}

// ---------------------------------------------------------------------------
// 版本戳
// ---------------------------------------------------------------------------

function gitInfo(root) {
  const run = (args) => {
    try {
      return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim();
    } catch { return null; }
  };
  const commit = run(['rev-parse', '--short', 'HEAD']);
  if (!commit) return null;
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = run(['status', '--porcelain']);
  return { commit, branch, dirty: Boolean(status) };
}

// ---------------------------------------------------------------------------
// facets：把"系统 / 模块"这类领域分组做成规则
//
//   {
//     "exclude": ["third_party"],
//     "systems": [
//       { "name": "播放器接入", "color": "#58a6ff", "paths": ["Players/**"] },
//       { "name": "界面层",     "color": "#f778ba", "files": ["*Form.cs"] }
//     ]
//   }
//
// 规则按顺序匹配，第一条命中生效；paths / files / namespaces 都是 glob，
// 匹配对象是：文件相对路径、文件名、命名空间、完整限定名。
// ---------------------------------------------------------------------------

function globToRe(pattern) {
  const esc = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

/** 草拟分组规则时用的颜色列（和示例文件同一套） */
const DRAFT_COLORS = ['#58a6ff', '#f778ba', '#3fb950', '#d29922', '#bc8cff', '#39c5cf', '#f0883e', '#d29922'];
const DRAFT_GREY = '#8b949e';
/** 这些目录名一看就是人家拿来的代码/依赖，草拟时直接建议排除 */
const DRAFT_EXCLUDE_HINTS = new Set(['vendor', 'third_party', 'thirdparty', 'third-party', 'external', 'reference', 'references', 'deps', 'submodules']);

/**
 * 草拟分组规则：**只看目录结构，不解析代码**，所以是秒出。
 * 给"首次运行向导"和 `atlas draft-facets` 命令用。
 *
 * @param {{roots: string|string[], lang?: string, maxKb?: number}} opts
 * @returns {{config: object, notes: string[], preview: {name: string, files: number}[], files: number}}
 */
export function draftFacets(opts) {
  const roots = Array.isArray(opts.roots) ? opts.roots : [opts.roots];
  const languages = resolveLanguages(opts.lang || 'auto');
  const { files } = collectFiles(roots, { languages, maxKb: Number(opts.maxKb || 1024), excludes: [] });
  const notes = [];

  /** 文件在第 level 层归到哪个 key（直接躺在这一层的文件归到上一层） */
  const keyOf = (rel, level) => {
    const segs = rel.split('/');
    if (segs.length <= level) return level <= 1 ? '(根目录)' : keyOf(rel, level - 1);
    return segs.slice(0, level).join('/');
  };
  const groupAt = (level) => {
    const m = new Map();
    for (const f of files) {
      const k = keyOf(f.rel, level);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(f);
    }
    return m;
  };

  let level = 1;
  let groups = groupAt(1);
  const bigAt = (m) => [...m.entries()].filter(([k, fs]) => k !== '(根目录)' && fs.length >= 3);
  if (bigAt(groups).length < 3) {
    const g2 = groupAt(2);
    if (bigAt(g2).length > bigAt(groups).length) {
      groups = g2;
      level = 2;
      notes.push('顶层目录太集中（大目录不够 3 个），改按第 2 层目录草拟');
    }
  }

  const excluded = [];
  const systems = [];
  const small = [];
  const rootFiles = [];
  for (const [key, fs] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (key === '(根目录)') { rootFiles.push(...fs); continue; }
    const dirName = key.split('/').pop();
    // 目录名以这些词开头就算“拿来的代码”（reference-yySync / vendor_js / third_party…）
    if ([...DRAFT_EXCLUDE_HINTS].some((h) => dirName.toLowerCase().startsWith(h))) { excluded.push(dirName); continue; }
    if (fs.length >= 3 && systems.length < 8) systems.push({ key, name: dirName, files: fs.length });
    else small.push({ key, files: fs.length });
  }

  const out = [];
  systems.forEach((s, i) => out.push({ name: s.name, color: DRAFT_COLORS[i % DRAFT_COLORS.length], paths: [`${s.key}/**`], _files: s.files }));
  if (small.length) out.push({ name: '其他', color: DRAFT_GREY, paths: small.map((s) => `${s.key}/**`), _files: small.reduce((a, s) => a + s.files, 0) });
  // 根目录放最后：`files: ["*"]` 会按“文件名”命中，所以只能当兜底规则（规则是第一条命中生效）
  if (rootFiles.length) out.push({ name: '根目录', color: DRAFT_GREY, files: ['*'], _files: rootFiles.length });

  if (excluded.length) notes.push(`建议排除：${excluded.join(', ')}（一看就是第三方/参考代码的目录名）`);
  if (!systems.length) notes.push('没找到够大的目录（>=3 个文件）——草案可能不好用，建议手动写规则');

  const config = {
    _comment: 'Code Atlas 系统分组规则（由首次运行向导按目录结构草拟，可直接改）。规则按顺序匹配，第一条命中生效；匹配对象 = 文件相对路径 / 文件名 / 命名空间 / 完整限定名（glob，** 表示任意层级）。exclude 是额外忽略的目录名。',
    ...(excluded.length ? { exclude: excluded } : {}),
    systems: out.map(({ name, color, paths, files }) => ({ name, color, ...(paths ? { paths } : {}), ...(files ? { files } : {}) })),
  };
  return {
    config,
    notes,
    files: files.length,
    preview: out.map((s) => ({ name: s.name, files: s._files })),
  };
}

/** 找分组配置：--facets 指定 > 扫描根下的 atlas.facets.json > 项目 configs/<目录名>.facets.json */
function loadFacets(opts, roots) {
  const tries = [];
  if (opts.facets) tries.push(path.resolve(opts.facets));
  else {
    for (const r of roots) tries.push(path.join(r, 'atlas.facets.json'));
    for (const r of roots) tries.push(path.join(PROJECT_ROOT, 'configs', `${path.basename(r)}.facets.json`));
  }
  for (const f of tries) {
    if (!fs.existsSync(f)) continue;
    try {
      return { file: f, config: JSON.parse(fs.readFileSync(f, 'utf8')) };
    } catch (err) {
      throw new Error(`facets 分组配置解析失败：${f}\n${err.message}`);
    }
  }
  return null;
}

/** 给每个类型打上 system，并汇总各系统体量 */
function applyFacets(facetsDoc, allTypes, fileRecs) {
  const rules = (facetsDoc?.config?.systems || []).map((r) => ({
    name: r.name,
    color: r.color || null,
    mats: [...(r.paths || []), ...(r.files || []), ...(r.namespaces || [])]
      .map((p) => ({ re: globToRe(p), src: p })),
  }));
  if (!rules.length) {
    // 没有规则文件：不算分组，让前端退回按目录看（别拿一个"(未分类)"分组占着位）
    for (const t of allTypes) { t.system = null; t.systemRule = null; }
    return { configFile: null, configPath: null, systems: [], unclassified: { types: allTypes.length, loc: allTypes.reduce((a, t) => a + t.loc, 0) } };
  }
  const groups = new Map();
  for (const t of allTypes) {
    const f = fileRecs[t.file];
    const cands = [f.path, path.posix.basename(f.path), t.ns || '', t.fqn];
    let hit = null;
    let rule = null;
    for (const r of rules) {
      const m = r.mats.find((mm) => cands.some((c) => mm.re.test(c)));
      if (m) { hit = r; rule = m.src; break; }
    }
    t.system = hit ? hit.name : null;
    t.systemRule = rule;
    const key = hit ? hit.name : '(未分类)';
    const g = groups.get(key) || { name: key, color: (hit && hit.color) || '#6e7681', types: 0, loc: 0, files: new Set() };
    g.types++; g.loc += t.loc; g.files.add(t.file);
    groups.set(key, g);
  }
  const order = [...rules.map((r) => r.name), '(未分类)'];
  const systems = [...groups.values()]
    .map((g) => ({ name: g.name, color: g.color, types: g.types, files: g.files.size, loc: g.loc }))
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return {
    configFile: facetsDoc ? path.basename(facetsDoc.file) : null,
    configPath: facetsDoc ? facetsDoc.file : null,
    systems,
    unclassified: groups.get('(未分类)') ? { types: groups.get('(未分类)').types, loc: groups.get('(未分类)').loc } : { types: 0, loc: 0 },
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string[]} opts.roots     要扫描的目录
 * @param {string}   opts.outDir    输出目录（默认 dist）
 * @param {string}   opts.lang      auto | 逗号列表
 * @param {number}   opts.maxKb     单文件上限
 * @param {string[]} opts.excludes  额外跳过的目录名
 * @param {string}   opts.facets    系统分组配置（json）
 */
/**
 * 解析 + 提取：这是"真正吃内存"的活，只在**子进程**里跑。
 * 产出的 id 是局部 id（fileRecs 下标 / allTypes 下标），父进程合并时统一加偏移。
 */
async function extractFiles(files) {
  await Parser.init();
  const parsers = new Map();
  const getParser = async (lang) => {
    if (parsers.has(lang.id)) return parsers.get(lang.id);
    const p = new Parser();
    const language = await Parser.Language.load(path.join(WASM_DIR, lang.wasm));
    p.setLanguage(language);
    parsers.set(lang.id, p);
    return p;
  };

  // 按文件收集（父进程负责拼全局 id；也是增量缓存的基本单位）
  const parts = [];
  const failures = [];

  // 进度：让"跑的过程"也能看见（大仓库才有感，小项目就两行）
  const totalFiles = files.length;
  const startedAt = Date.now();
  let parsedFiles = 0;
  let lastReportAt = startedAt;
  const langsUsed = [...new Set(files.map((f) => f.lang.id))];
  console.log(`  开始解析：${totalFiles} 个文件（${langsUsed.join(', ')}）`);

  for (const f of files) {
    let rawSource;
    try {
      rawSource = fs.readFileSync(f.abs, 'utf8');
    } catch (err) {
      failures.push({ path: f.rel, error: String(err.message || err) });
      continue;
    }
    // 本文件的结果：id 都是**文件内局部**的，父进程合并时统一平移到全局
    const part = { rel: f.rel, lang: f.lang.id, ns: null, types: [], refs: [], file: null };
    const parser = await getParser(f.lang);
    const source = f.lang.preprocess ? preprocess(rawSource, f.lang.preprocess) : rawSource;
    const tree = parser.parse(source);
    const facts = extractFile(source, tree, f.lang);
    tree.delete?.();

    const fileId = 0;   // 文件内局部（父进程合并时换成全局 file id）
    const lineCount = facts.lines.length;
    let blank = 0, comment = 0;
    for (let i = 0; i < lineCount; i++) {
      if (facts.lines[i].trim() === '') blank++;
      else if (facts.mask[i]) comment++;
    }
    const loc = lineCount;
    const code = loc - blank - comment;

    const typeIds = [];
    for (const t of facts.types) {
      const spanRows = t.endRow - t.startRow + 1;
      let tb = 0, tc = 0;
      for (let r = t.startRow; r <= t.endRow; r++) {
        if ((facts.lines[r] ?? '').trim() === '') tb++;
        else if (facts.mask[r]) tc++;
      }
      const id = part.types.length;
      typeIds.push(id);
      part.types.push({
        id,
        name: t.name,
        kind: t.kind,
        ns: t.ns,
        fqn: t.ns ? `${t.ns}.${t.name}` : t.name,
        file: fileId,
        line: t.line,
        endLine: t.endLine,
        loc: spanRows,
        code: spanRows - tb - tc,
        comment: tc,
        blank: tb,
        parent: t.parent == null ? null : typeIds[t.parent] ?? null,
        dir: path.posix.dirname(f.rel) === '.' ? '' : path.posix.dirname(f.rel),
        system: null,
        systemRule: null,
        bases: t.bases,
        doc: t.doc,
        members: t.members,
        memberList: t.memberList,
        complexity: t.complexity,
        fanIn: 0,
        fanOut: 0,
        tags: GENERATED_NAME_RE.test(t.name) ? ['compiler-generated'] : [],
      });
      for (const r of facts.refs) {
        if (r.owner === t.index) part.refs.push({ t: id, name: r.name });
      }
    }

    // 文件里没有类型声明（脚本 / 顶层函数 / Lua）→ 合成一个"模块"节点，别让整份文件在图上消失
    // 文件级成员（Go/C/Rust/Scala 的顶层函数、Python 的模块级函数…）也要能看见：
    // 合成一个 module 节点把它们挂上。有类型时只覆盖成员所在行段，免得和类型的行数重复计。
    const fmLines = facts.fileScope.memberList.map((m) => m.l);
    const wholeFile = !typeIds.length && !fmLines.length;
    if ((!typeIds.length && facts.lines.length >= 4) || fmLines.length) {
      const mStart = fmLines.length ? Math.max(1, Math.min(...fmLines)) : 1;
      const mEnd = fmLines.length ? Math.max(...fmLines) : facts.lines.length;
      const id = part.types.length;
      typeIds.push(id);
      part.types.push({
        id,
        name: f.rel.replace(/\.[^.]+$/, '').split('/').pop(),
        kind: 'module',
        ns: '',
        fqn: f.rel,
        file: fileId,
        line: mStart,
        endLine: mEnd,
        loc: wholeFile ? loc : mEnd - mStart + 1,
        code: wholeFile ? code : mEnd - mStart + 1,
        comment: wholeFile ? comment : 0,
        blank: wholeFile ? blank : 0,
        dir: path.posix.dirname(f.rel) === '.' ? '' : path.posix.dirname(f.rel),
        parent: null,
        bases: [],
        doc: null,
        members: facts.fileScope.members,
        memberList: facts.fileScope.memberList,
        complexity: facts.fileScope.complexity,
        fanIn: 0,
        fanOut: 0,
        tags: [],
        system: null,
        systemRule: null,
      });
      for (const r of facts.fileScope.refs) part.refs.push({ t: id, name: r.name });
    }

    // 进度提示：文件多的时候每 150 个或每 2.5 秒报一次（小项目只有开始那一行）
    parsedFiles++;
    if (totalFiles > 150 && (parsedFiles % 150 === 0 || Date.now() - lastReportAt > 2500)) {
      lastReportAt = Date.now();
      console.log(`  解析中… ${parsedFiles}/${totalFiles} 文件（${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
    }

    part.file = {
      path: f.rel,
      lang: f.lang.id,
      loc, code, comment, blank,
      bytes: f.bytes,
      mtime: Math.round(f.mtime),
      errors: facts.errors,
      namespaces: facts.namespaces,
      imports: facts.imports,
      types: typeIds,
    };
    part.ns = facts.namespaces;
    parts.push(part);
  }
  return { files: parts, failures };
}

/** 合并各子进程/缓存的产出：把局部 id 平移到全局 id（文件、类型、parent、refs.owner 都要移） */
function mergeParts(parts) {
  const out = { fileRecs: [], allTypes: [], allRefs: [], fileNamespaces: [], failures: [] };
  for (const p of parts || []) {
    for (const pf of p.files || []) {
      if (!pf) continue;
      const fileId = out.fileRecs.length;
      const tOff = out.allTypes.length;
      if (pf.file) out.fileRecs.push({ ...pf.file, id: fileId, types: (pf.file.types || []).map((t) => t + tOff) });
      for (const t of pf.types || []) {
        out.allTypes.push({ ...t, id: t.id + tOff, file: fileId, parent: t.parent == null ? null : t.parent + tOff });
      }
      for (const r of pf.refs || []) out.allRefs.push({ owner: r.t + tOff, name: r.name });
      out.fileNamespaces.push(pf.ns || {});
    }
    out.failures.push(...(p.failures || []));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 增量扫描缓存：按文件存上一次的解析结果，没变的文件就不再解析
// ---------------------------------------------------------------------------

const CACHE_NAME = '.scan-cache.json';

/** 引擎指纹：代码/语言表/预处理改了，缓存就不能再用（不然会拿旧规则的结果） */
function engineStamp() {
  const files = ['scan.mjs', 'languages.mjs', 'preprocess.mjs'];
  const stamps = files.map((n) => {
    try { return String(Math.round(fs.statSync(path.join(PROJECT_ROOT, 'src', n)).mtimeMs)); } catch { return '0'; }
  });
  return [VERSION, ...stamps].join('-');
}

function readScanCache(cacheFile, langSpec, maxKb) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (c.schema !== 1) return null;
    if (c.engine !== engineStamp()) return null;
    if (c.lang !== langSpec) return null;
    if (c.maxKb !== maxKb) return null;
    return c;
  } catch { return null; }
}

function writeScanCache(cacheFile, langSpec, maxKb, files, byRel) {
  const out = { schema: 1, engine: engineStamp(), lang: langSpec, maxKb, at: new Date().toISOString(), files: {} };
  for (const f of files) {
    const pf = byRel.get(f.rel);
    if (!pf) continue;                        // 读失败之类的，不缓存（下次重试）
    out.files[f.rel] = { mtime: Math.round(f.mtime), bytes: f.bytes, lang: f.lang.id, part: pf };
  }
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(out));
}

/**
 * 内部命令 __extract：解析**一门**语言，把原始数据写进 emit 文件。父进程调它。
 * work 文件里有全部待扫文件（父进程收集好的），这里只挑出本语言那部分。
 */
export async function workerExtract({ work, lang, emit }) {
  const w = JSON.parse(fs.readFileSync(work, 'utf8'));
  const profile = resolveLanguages(lang)[0];
  const files = (w.files || [])
    .filter((f) => f.lang === lang)
    .map((f) => ({ abs: f.abs, rel: f.rel, root: f.root, bytes: f.bytes, mtime: f.mtime, lang: profile }));
  const parts = await extractFiles(files);
  fs.writeFileSync(emit, JSON.stringify(parts));
}

export async function scan(opts) {
  const t0 = Date.now();
  const roots = (opts.roots?.length ? opts.roots : ['.']).map((r) => path.resolve(r));
  const languages = resolveLanguages(opts.lang);
  const outDir = path.resolve(opts.outDir || 'dist');
  const maxKb = opts.maxKb || 1024;

  for (const r of roots) {
    if (!fs.existsSync(r) || !fs.statSync(r).isDirectory()) {
      throw new Error(`目录不存在：${r}`);
    }
  }

  const facetsDoc = loadFacets(opts, roots);
  const excludes = [...(opts.excludes || []), ...(facetsDoc?.config?.exclude || [])];
  const { files, skipped } = collectFiles(roots, { languages, maxKb, excludes });

  const langById = new Map(languages.map((l) => [l.id, l]));
  const byLang = new Map();
  for (const f of files) {
    if (!byLang.has(f.lang.id)) byLang.set(f.lang.id, []);
    byLang.get(f.lang.id).push(f);
  }

  // 解析：**每门语言起一个子进程**（父进程自己一律不装语法包）
  //
  // 为什么必须分进程：每门语法包一加载就常驻约 150~180 MB，而且 web-tree-sitter 0.20.8
  // 没提供释放接口（Parser.delete() 无效、Language.delete 不存在、手动 GC 也没用——都实测过）。
  // 同进程装 24 门峰值能到 4 GB 以上：扫描中途会 OOM，退出阶段（V8 析构）必崩。
  // 分进程之后：每个子进程只装一门（峰值就一门），父进程不装 wasm → 退出干净、退出码正确；
  // 某个子进程就算崩了，也只是"那一门没进地图"，其余照常，并且会明说。
  // ---------- 增量：先看缓存，没变的文件直接复用上次的解析结果 ----------
  const cacheFile = path.join(outDir, CACHE_NAME);
  const langSpec = opts.lang || 'auto';
  const cache = opts.incremental ? readScanCache(cacheFile, langSpec, maxKb) : null;
  const reused = new Map();          // rel -> 上次的解析结果
  const freshFiles = [];             // 需要重新解析的
  for (const f of files) {
    const hit = cache && cache.files[f.rel];
    if (hit && hit.mtime === Math.round(f.mtime) && hit.bytes === f.bytes && hit.lang === f.lang.id && hit.part) {
      reused.set(f.rel, hit.part);
    } else freshFiles.push(f);
  }
  if (opts.incremental) {
    console.log(`  增量扫描：复用 ${reused.size} 个没变的文件，重新解析 ${freshFiles.length} 个` + (cache ? '' : '（没有可用缓存，本次算全量）'));
  }

  const freshParts = [];
  if (freshFiles.length) {
    const langsWithFiles = [...new Set(freshFiles.map((f) => f.lang.id))];
    console.log(`  开始解析：${freshFiles.length} 个文件（${langsWithFiles.join(', ')}）`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-atlas-'));
    const work = path.join(tmp, 'files.json');
    fs.writeFileSync(work, JSON.stringify({
      files: freshFiles.map((f) => ({ abs: f.abs, rel: f.rel, root: f.root, bytes: f.bytes, mtime: f.mtime, lang: f.lang.id })),
    }));
    const NODE = process.env.NODE_BIN || process.execPath;   // 一般就是 node.exe；特殊情况可用 NODE_BIN 指定
    let n = 0;
    for (const langId of langsWithFiles) {
      const emit = path.join(tmp, `part-${n++}.json`);
      const r = spawnSync(NODE, [CLI_PATH, '__extract', '--work', work, '--lang', langId, '--emit', emit], {
        stdio: ['ignore', 'inherit', 'pipe'],   // 进度直接透传，stderr 收起来（免得崩溃刷屏）
        timeout: 30 * 60 * 1000,
        windowsHide: true,
      });
      let ok = false;
      if (fs.existsSync(emit)) {
        try { freshParts.push(JSON.parse(fs.readFileSync(emit, 'utf8'))); ok = true; } catch (e) { console.log(`  ⚠ ${langId} 的结果读不出来：${e.message}`); }
      }
      if (!ok) {
        const tail = String(r.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
        console.log(`  ⚠ ${langId} 没解析成功（子进程退出码 ${r.status}）—— 这门语言这次不进地图。${tail ? `子进程最后一句：${tail.slice(0, 200)}` : ''}`);
      }
      try { fs.rmSync(emit, { force: true }); } catch { }
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  }

  // 按 collectFiles 的顺序合并（缓存命中的 + 新解析的）：顺序稳定，只改几个文件时 id 不会乱跳
  const byRel = new Map(reused);
  for (const p of freshParts) for (const pf of p.files || []) byRel.set(pf.rel, pf);
  const { fileRecs, allTypes, allRefs, fileNamespaces, failures } = mergeParts([{ files: files.map((f) => byRel.get(f.rel)).filter(Boolean), failures: freshParts.flatMap((p) => p.failures || []) }]);

  // ---- 建索引：符号表 ----
  const bySimpleName = new Map();
  for (const t of allTypes) {
    if (!bySimpleName.has(t.name)) bySimpleName.set(t.name, []);
    bySimpleName.get(t.name).push(t.id);
  }

  /** 名字解析：唯一命中就用；多个命中优先同命名空间；否则放弃（计入歧义） */
  const unresolved = { ambiguous: 0, unknown: 0 };
  const resolveName = (name, fromTypeId) => {
    const hit = bySimpleName.get(name);
    if (!hit || !hit.length) { unresolved.unknown++; return null; }
    if (hit.length === 1) return hit[0];
    const from = allTypes[fromTypeId];
    const sameNs = hit.filter((id) => allTypes[id].ns === from.ns);
    if (sameNs.length === 1) return sameNs[0];
    const sameRoot = hit.filter((id) => {
      const a = allTypes[id].ns.split('.')[0];
      const b = from.ns.split('.')[0];
      return a && a === b;
    });
    if (sameRoot.length === 1) return sameRoot[0];
    unresolved.ambiguous++;
    return null;
  };

  // ---- 建图：引用 + 继承 ----
  const edgeMap = new Map();
  const addEdge = (from, to, kind) => {
    if (from == null || to == null || from === to) return;
    const key = `${from}|${to}|${kind}`;
    edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
  };

  for (const r of allRefs) {
    const to = resolveName(r.name, r.owner);
    if (to != null) addEdge(r.owner, to, 'ref');
  }
  for (const t of allTypes) {
    for (const b of t.bases) {
      const to = resolveName(b, t.id);
      if (to != null) addEdge(t.id, to, 'inherit');
    }
  }

  const edges = [];
  for (const [key, w] of edgeMap) {
    const [f, t, k] = key.split('|');
    const from = Number(f), to = Number(t);
    edges.push({ from, to, kind: k, w });
    allTypes[from].fanOut += w;
    allTypes[to].fanIn += w;
  }
  edges.sort((a, b) => b.w - a.w);

  // ---- 命名空间（包）树 ----
  const rootNs = { name: '', path: '', children: [], files: [], types: [], loc: 0, code: 0, comment: 0, blank: 0 };
  const nsByPath = new Map([['', rootNs]]);
  const ensureNs = (p) => {
    if (nsByPath.has(p)) return nsByPath.get(p);
    const i = p.lastIndexOf('.');
    const parent = ensureNs(i < 0 ? '' : p.slice(0, i));
    const node = { name: i < 0 ? p : p.slice(i + 1), path: p, children: [], files: [], types: [], loc: 0, code: 0, comment: 0, blank: 0 };
    parent.children.push(node);
    nsByPath.set(p, node);
    return node;
  };

  for (const f of fileRecs) {
    const seen = new Set();
    for (const ns of f.namespaces) {
      if (seen.has(ns)) continue;
      seen.add(ns);
      ensureNs(ns).files.push(f.id);
    }
  }
  for (const t of allTypes) {
    const node = ensureNs(t.ns || '(global)');
    node.types.push(t.id);
    node.loc += t.loc; node.code += t.code; node.comment += t.comment; node.blank += t.blank;
  }
  // 自底向上汇总
  const rollup = (node) => {
    let loc = node.loc, code = node.code, comment = node.comment, blank = node.blank;
    let nFiles = node.files.length, nTypes = node.types.length;
    for (const c of node.children) {
      const r = rollup(c);
      loc += r.loc; code += r.code; comment += r.comment; blank += r.blank;
      nFiles += r.files; nTypes += r.types;
    }
    node.allLoc = loc; node.allCode = code; node.allComment = comment; node.allBlank = blank;
    node.allFiles = nFiles; node.allTypes = nTypes;
    node.children.sort((a, b) => b.allLoc - a.allLoc);
    return { loc, code, comment, blank, files: nFiles, types: nTypes };
  };
  rollup(rootNs);

  // ---- 命名空间级依赖边（给包依赖图用）----
  const nsEdgeMap = new Map();
  for (const e of edges) {
    const a = allTypes[e.from].ns || '(global)';
    const b = allTypes[e.to].ns || '(global)';
    if (a === b) continue;
    const key = `${a}|${b}`;
    nsEdgeMap.set(key, (nsEdgeMap.get(key) || 0) + e.w);
  }
  const nsEdges = [...nsEdgeMap].map(([k, w]) => {
    const [from, to] = k.split('|');
    return { from, to, w };
  }).sort((x, y) => y.w - x.w);

  // ---- 汇总统计 ----
  const newestMtime = files.reduce((m, f) => Math.max(m, f.mtime), 0);
  const langStats = {};
  for (const f of fileRecs) {
    // label 一起写进 bundle：界面要显示"C# 12 文件"，不该在前端另抄一份 id -> 名字的表
    const s = langStats[f.lang] || { label: LANGUAGES[f.lang]?.label || f.lang, files: 0, loc: 0, code: 0, comment: 0, blank: 0, types: 0 };
    s.files++; s.loc += f.loc; s.code += f.code; s.comment += f.comment; s.blank += f.blank;
    s.types += f.types.length;
    langStats[f.lang] = s;
  }

  const totals = {
    files: fileRecs.length,
    types: allTypes.length,
    edges: edges.length,
    loc: fileRecs.reduce((a, f) => a + f.loc, 0),
    code: fileRecs.reduce((a, f) => a + f.code, 0),
    comment: fileRecs.reduce((a, f) => a + f.comment, 0),
    blank: fileRecs.reduce((a, f) => a + f.blank, 0),
    bytes: files.reduce((a, f) => a + f.bytes, 0),
    parseErrors: fileRecs.reduce((a, f) => a + (f.errors || 0), 0),
    parseErrorFiles: fileRecs.filter((f) => f.errors > 0).length,
    compilerGenerated: allTypes.filter((t) => t.tags.includes('compiler-generated')).length,
  };

  // ---- 系统 / 模块分组（facets 规则）----
  const facets = applyFacets(facetsDoc, allTypes, fileRecs);

  // ---- 版本戳 ----
  const git = roots.map(gitInfo).find(Boolean) || null;
  const bundle = {
    schema: SCHEMA,
    generator: { name: 'code-atlas', version: VERSION },
    generated: new Date().toISOString(),
    source: {
      roots: roots.map((r) => path.resolve(r)),
      labels: roots.map((r) => path.basename(r)),
      files: totals.files,
      bytes: totals.bytes,
      newestMtime: newestMtime ? new Date(newestMtime).toISOString() : null,
      git,
      scanMs: 0,
      scanOptions: {
        lang: opts.lang || 'auto', maxKb, excludes, facets: facets.configPath,
        // 增量：这次用了没、复用了多少（写进 bundle，报告和界面都能看出来）
        incremental: opts.incremental ? { reused: reused.size, reparsed: freshFiles.length } : null,
      },
      skipped,
      failures,
      ingest: opts.ingest || null,
    },
    languages: langStats,
    totals,
    files: fileRecs,
    types: allTypes,
    namespaces: rootNs,
    edges,
    nsEdges,
    unresolved,
    facets,
    stats: {},
  };

  bundle.source.scanMs = Date.now() - t0;
  bundle.stats = {
    ...totals,
    namespaces: nsByPath.size - 1,
    edgeKinds: edges.reduce((acc, e) => { acc[e.kind] = (acc[e.kind] || 0) + 1; return acc; }, {}),
    // 被跳过的文件：默认忽略目录 / 生成物、超限大小、以及“还不支持的语言”（后者要能看见，不能静静吞掉）
    skipped: {
      ignored: skipped.ignored || 0,
      tooBig: skipped.tooBig || 0,
      unknown: skipped.unknown || 0,
      unsupported: Object.fromEntries(skipped.unsupported || []),
      outOfScope: Object.fromEntries(skipped.outOfScope || []),
    },
  };

  // （原来这里有个"释放解析器"的循环：解析已经挪到子进程里，父进程不再持有解析器，所以删掉了）

  // 写回增量缓存（下次没变的文件就不用再解析了）
  if (freshFiles.length || reused.size) {
    try { writeScanCache(cacheFile, langSpec, maxKb, files, byRel); } catch (e) { console.log(`  （增量缓存没写成功：${e.message}；不影响这次扫描）`); }
  }

  return { bundle, outDir, files, skipped, roots };
}

/** 扫描并写出 bundle.json */
export async function scanToDisk(opts) {
  const result = await scan(opts);
  fs.mkdirSync(result.outDir, { recursive: true });
  const out = path.join(result.outDir, 'bundle.json');
  fs.writeFileSync(out, JSON.stringify(result.bundle));
  return { ...result, out };
}
