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
import { Parser, Language } from 'web-tree-sitter';
import { resolveWasm, LANGUAGES, languageForExt, resolveLanguages } from './languages.mjs';
import { t } from './i18n.mjs';
import { preprocess } from './preprocess.mjs';

export const SCHEMA = 'code-atlas/1';
export const VERSION = '1.3.0';

/**
 * 没归到任何系统规则的哨兵值：**中性固定值**，不带任何语言。
 * 显示层用 i18n.mjs 的 sysLabel() 映射成当前语言（bundle 中英共用、切语言不用重扫）。
 * 旧 bundle 里写的是「(未分类)」，那也一并认（见 isUnclassified）。
 */
export const UNCLASSIFIED = '(unclassified)';

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 起子进程时用它调回自己（__extract 内部命令） */
const CLI_PATH = path.join(PROJECT_ROOT, 'src', 'cli.mjs');

/** 默认跳过的目录：依赖、构建产物、版本库元数据 */
const IGNORE_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bin', 'obj', 'dist', 'build', 'out', 'target',
  'vendor', '.vs', '.vscode', '.idea', '.venv', 'venv', '__pycache__',
  'coverage', '.next', '.nuxt', '.cache', 'publish', 'publish-sc', 'publish-lite',
]);
// 这里只放“人人都认”的那几个（依赖 / 构建产物 / 版本库元数据）。
// 项目自己的产物目录（比如本工具的 ingest/）**故意不写死** —— 跳过规则一定要能自己选，
// 否则会把别人真源码目录静默干掉。待办：给出“自选跳过”（目录 + 文件）的入口。
// `packages` 故意不在这里：pnpm / yarn workspaces / lerna / Nx / Turborepo 的源码根都叫它，
// 跳过它会把这类 monorepo 扫成一张近乎空白的地图（而且不报错）。老式 NuGet 还原目录
// （packages/<id>/lib/*.dll）里本来就没有可解析的源码，扫到只是多遍历一瞬。

/** 默认跳过的文件：压缩产物、自动生成的代码 */
const IGNORE_FILE_RE = /(\.min\.(js|css)|\.d\.ts|\.g\.cs|\.designer\.cs|\.generated\.(cs|ts)|\.freezed\.dart)$/i;

/**
 * 机器生成的锁文件 —— 按名字显式列（`*.lock` 盖不住 gradle.lockfile / go.sum / packages.lock.json 这类），
 * 它们没有分析价值却动辄几千上万行（实测一个 pnpm-lock.yaml 吃掉整张图 97% 的“代码行”）。
 * `.pnp.cjs` 是 Yarn PnP 的产物、默认会被提交进仓库，JS 项目里尤其常见。
 */
const IGNORE_FILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'packages.lock.json',
  'yarn.lock', 'bun.lock', 'bun.lockb', 'go.sum', 'gradle.lockfile', '.terraform.lock.hcl',
  '.pnp.cjs', '.pnp.js', '.pnp.data.json',
]);

/** 机器生成的锁文件 / 快照 / sourcemap：按后缀 */
const IGNORE_FILE_EXT_RE = /(\.lock|\.g\.dart|\.snap|\.js\.map|\.css\.map)$/i;

/** 这个文件算不算“机器生成的、不值得扫” */
function isIgnoredFile(name) {
  return IGNORE_FILE_RE.test(name) || IGNORE_FILES.has(name) || IGNORE_FILE_EXT_RE.test(name);
}

/** 还没支持的语言的后缀（只用于报告"漏了多少"，不会去解析） */
const UNSUPPORTED_SRC_EXTS = new Set([
  '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.cxx', '.m', '.mm',
  '.php', '.rb', '.swift', '.scala', '.gradle', '.dart',
  '.fs', '.fsx', '.vb', '.pl', '.pm', '.r', '.jl', '.ex', '.exs', '.erl', '.groovy',
  '.svelte', '.el', '.clj', '.cljs', '.hs', '.ml', '.nim', '.zig', '.sol',
]);  // （.vue 已从这张表里拿掉：见 languages.mjs 的 vue profile —— 走 TSX 语法 + 空格化预处理）

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

// ---------------------------------------------------------------------------
// 项目自己的跳过规则（自选）
// ---------------------------------------------------------------------------
// `atlas.ignore`：放在扫描目标根，**存在才生效**（这就是「自选」）。
// 可选的 `.gitignore`：默认不读，传了 --gitignore 才读（启动器上有个勾选框）。
// 语法先做简单版：一行一条 · `#` 注释 · `名字`（目录名或文件名都算）· `名字/`（只当目录）·
// 含 `* ?` 或 `/` 的按相对路径 glob 匹配。**`!` 例外暂不支持**（遇到会计数、在报告里提示，不静默）。
//
// 嵌套（2026-09-20）：子目录自带的 `.gitignore` 也读，口径跟 git 一致——
//   · 每份规则只管**它所在目录及其子目录**（模式相对它自己那个目录解释）
//   · 越靠近文件的规则排在越后面（`!` 支持了以后这点才真起作用）
//   · 进不去的目录不再往下走：git 不会进被排除的目录，所以里面写的 `!` 也救不回来（如实上报）
//   · 每份 .gitignore 是在**进那一层目录时**读的（collectFiles 调 enterDir），
//     所以"外层规则先于内层规则"这个顺序天然成立，不用事后排序
//   · 扫描根**以上**的 .gitignore 不读（那是目标之外的东西）
function loadIgnoreRules(roots, { gitignore } = {}) {
  const rules = [];
  const sources = new Set();
  let files = 0;
  let negations = 0;

  /** 读一份规则文件；base 是它所在目录相对扫描根的路径（根 = ''），rootIdx 标明属于哪个根 */
  const addFile = (rootIdx, base, file, name) => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    sources.add(name);
    files++;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('!')) { negations++; continue; }   // 例外（!）暂不支持
      const body = line.replace(/^\//, '');
      const dirOnly = body.endsWith('/');
      const pat = dirOnly ? body.slice(0, -1) : body;
      if (!pat) continue;
      if (pat.includes('/') || /[*?]/.test(pat)) {
        // 带路径/通配：按相对路径匹配；不含 `/` 的（如 *.gen.ts）再按“任意层级的名字”匹配一次
        rules.push({ root: rootIdx, base, kind: 'glob', re: globToRe(pat), dirOnly, anyLevel: !pat.includes('/'), src: name });
      } else {
        rules.push({ root: rootIdx, base, kind: 'name', name: pat, dirOnly, src: name });
      }
    }
  };

  return {
    /**
     * 进一层目录时调一次：把这一层自带的规则收进来。
     * 必须在判断这一层的条目**之前**调用 —— 否则本层 .gitignore 写的规则管不到本层的文件。
     * `names` 是这层 readdir 出来的名字（用来判断文件在不在，省一次失败的系统调用）。
     */
    enterDir(rootIdx, base, absDir, names) {
      // 没勾 --gitignore 时 .gitignore 一份都不读；`atlas.ignore` 是本工具自己的约定，永远读（只有目标根那一份）
      if (gitignore && names.has('.gitignore')) addFile(rootIdx, base, path.join(absDir, '.gitignore'), '.gitignore');
      if (base === '' && names.has('atlas.ignore')) addFile(rootIdx, base, path.join(absDir, 'atlas.ignore'), 'atlas.ignore');
    },
    /** 命中就返回那条规则的来源（报告里要说清是谁干的） */
    hit(rootIdx, rel, name, isDir) {
      for (const r of rules) {
        if (r.root !== rootIdx) continue;
        if (r.dirOnly && !isDir) continue;
        // 规则只对自己那棵子树生效：拿它所在目录的相对路径来比
        if (r.base && !rel.startsWith(`${r.base}/`)) continue;
        const sub = r.base ? rel.slice(r.base.length + 1) : rel;
        if (r.kind === 'name') { if (name === r.name) return r.src; continue; }
        if (r.re.test(sub)) return r.src;
        if (r.anyLevel && r.re.test(name)) return r.src;
      }
      return null;
    },
    get sources() { return [...sources]; },
    get count() { return rules.length; },
    get fileCount() { return files; },
    // 注意：这里必须是 getter。写成普通属性就是把"建对象那一刻的 0"定死，后面读到的永远是 0
    // （踩过：`!` 例外计数一直报 0）
    get negations() { return negations; },
  };
}

function collectFiles(roots, { languages, maxKb, excludes, budget, ignoreRules }) {
  const exts = new Map();
  for (const lang of languages) for (const e of lang.exts) exts.set(e, lang);
  // 全量语言表：用来区分"这次没勾"和"我们根本不支持"——两者混在一起会误导人
  const allExts = new Map();
  for (const lang of Object.values(LANGUAGES)) for (const e of lang.exts) if (!allExts.has(e)) allExts.set(e, lang.id);

  const ignoreDirs = new Set(IGNORE_DIRS);
  for (const d of excludes || []) ignoreDirs.add(d);

  const files = [];
  // ignoredDirs：被默认跳过表命中的目录名 → 次数。它进 bundle、进扫描报告，
  // 让“图里少了东西”这件事可见（monorepo 的 packages/ 当年就是这么被发现的）。
  const skipped = { ignored: 0, ignoredDirs: new Map(), tooBig: 0, unknown: 0, unsupported: new Map(), outOfScope: new Map(),
    projectDirs: new Map(), projectFiles: 0 };

  for (let rootIdx = 0; rootIdx < roots.length; rootIdx++) {
    const root = roots[rootIdx];
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      // 本层自带的跳过规则（嵌套 .gitignore）先收进来，再判断本层的条目 ——
      // 顺序反了，本层 .gitignore 写的规则就管不到本层自己的文件
      if (ignoreRules) {
        const dirRel = dir === root ? '' : path.relative(root, dir).split(path.sep).join('/');
        ignoreRules.enterDir(rootIdx, dirRel, dir, new Set(entries.map((e) => e.name)));
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (e.isDirectory()) {
          if (ignoreDirs.has(e.name) || e.name.startsWith('.git')) { skipped.ignored++; skipped.ignoredDirs.set(e.name, (skipped.ignoredDirs.get(e.name) || 0) + 1); continue; }
          // 项目自己的规则（atlas.ignore / .gitignore）也走同一本账，好让“图里少了东西”始终可见
          if (ignoreRules && ignoreRules.hit(rootIdx, rel, e.name, true)) {
            skipped.ignored++;
            skipped.ignoredDirs.set(e.name, (skipped.ignoredDirs.get(e.name) || 0) + 1);
            skipped.projectDirs.set(e.name, (skipped.projectDirs.get(e.name) || 0) + 1);
            continue;
          }
          stack.push(abs);
          continue;
        }
        if (!e.isFile()) continue;
        if (isIgnoredFile(e.name)) { skipped.ignored++; continue; }
        if (ignoreRules && ignoreRules.hit(rootIdx, rel, e.name, false)) { skipped.ignored++; skipped.projectFiles++; continue; }
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
  // 文件预算：只取前 N 个（路径序稳定）。只有持续扫描会传它 —— 用来分趟把地图“长”出来；
  // 正常扫描不传，行为一字不变。
  if (budget && files.length > budget) files.length = budget;
  // 自选规则的来龙去脉（哪个文件生效了、多少条、读了几份、有几条 `!` 没支持）——进报告，免得“自己写的规则没生效”说不清
  skipped.ignoreSources = ignoreRules ? ignoreRules.sources : [];
  skipped.ignorePatterns = ignoreRules ? ignoreRules.count : 0;
  skipped.ignoreFiles = ignoreRules ? ignoreRules.fileCount : 0;
  skipped.ignoreNegations = ignoreRules ? ignoreRules.negations : 0;
  return { files, skipped };
}

// ---------------------------------------------------------------------------
// AST 提取
// ---------------------------------------------------------------------------

/** 把 [startRow, endRow] 标进掩码（用于统计注释行） */
function markRows(mask, startRow, endRow) {
  for (let r = startRow; r <= endRow && r < mask.length; r++) mask[r] = 1;
}

/**
 * 声明符（declarator）里的**真名字**。
 * C / C++ 的 `double shape_area(const Shape *s)` 里 declarator 是整段 `shape_area(const Shape *s)`，
 * 直接取文本会把参数表也算进名字（地图上就显示成"shape_area(const Shape *s)"，加签名后更会重复一遍）。
 * 顺着 declarator / name 字段往里走，拿到最里面的那个标识符。
 */
function declaratorName(node, depth = 0) {
  if (!node || depth > 8) return node ? node.text : null;
  if (ID_TYPES.includes(node.type)) return node.text;
  for (const f of ['declarator', 'name']) {
    const c = node.childForFieldName(f);
    if (c) return declaratorName(c, depth + 1);
  }
  const id = node.namedChildren.find((c) => ID_TYPES.includes(c.type));
  return id ? id.text : node.text;
}

/** 取节点名：优先 name/declarator 字段，没有字段就找第一个标识符子节点（Kotlin 等语法不给 name 字段） */
const ID_TYPES = ['type_identifier', 'simple_identifier', 'scoped_identifier', 'identifier', 'dotted_name', 'qualified_name', 'name', 'value_name', 'constructor_name', 'module_name', 'type_constructor', 'value_identifier', 'module_identifier', 'symbol', 'id'];
function nameOf(node, lang) {
  // Rust impl 块：名字取它实现的类型（field 'type'），让方法挂到同名节点上
  if (lang && lang.nameOf) return lang.nameOf(node);   // 有专用取名钩子的语言（例如 Elixir），以它为准（返回 null 就是真没名字）
  // Rust impl 块：名字取它实现的类型（field 'type'）；有 nameFromField 的语言按字段取（如 C# 的 namespace_declaration）
  const namedField = lang && lang.nameFromField && lang.nameFromField[node.type];
  if (namedField) {
    const f = node.childForFieldName(namedField);
    if (f) return f.text;
  }
  for (const f of ['name', 'declarator']) {
    const n = node.childForFieldName(f);
    if (n) return f === 'declarator' ? declaratorName(n) : n.text;
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
  const listTypes = new Set(['base_list', 'super_interfaces', 'interface_type_list', 'type_list', 'extends_clause', 'implements_clause', 'delegation_specifiers', 'superclass', 'implements_interfaces', 'union_member_types']);
  if (listTypes.has(node.type)) {
    // 列表型节点要**递归**：GraphQL 的 implements_interfaces / union_member_types 是左递归嵌套的
    //（`implements Node & Timestamped` 外层只直接挂着最后一个名字，只取一层就会漏掉前面的）。
    // 实测：不递归时 Query 的基类只剩 ["Timestamped"]，Node 丢了。
    for (const c of node.namedChildren) collectBaseNames(c, out);
    return;
  }
  if (node.type === 'type_arguments' || node.type === 'type_parameter') return;
  const name = baseNameOf(node);
  if (name && /^[A-Za-z_$][\w$.]*$/.test(name)) out.push(name.split('.').pop());
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

/**
 * 分节线这类装饰性注释不是“说明”，也不能并进说明里。实测（一个真实 monorepo 样本）有三种写法都要认：
 *   `// ===== Win32 =====`            ASCII 连号
 *   `// ── 工具函数 ──────────────`     框线连号（中文 / 终端风格，之前漏了 ─ ━ ═ ▬ 这些字符）
 *   `// ── 渲染器 / 进程限制 ──`       框线两两夹一个短标题（那份样本里真有文件这么写）
 */
const BOX_CHAR = '[\\u2500-\\u257F\\u2581\\u258F\\u2594\\u2595]'; // U+2500 区框线 + 块元素里的粗横/竖线
const DECORATION_RE = new RegExp(
  '[=\\-*_~#]{4,}' +
  `|${BOX_CHAR}{4,}` +
  `|${BOX_CHAR}{2,}[^\\n]{0,40}?${BOX_CHAR}{2,}`
);

/** 结尾是中日韩文字或全角/中文标点（含破折号、省略号、间隔号）：这种地方断行不该补空格 */
const CJK_TAIL_RE = /[\u00B7\u2013\u2014\u2018-\u201D\u2026\u3000-\u303F\u4E00-\u9FFF\uFF01-\uFF65]$/;

/** 从注释里抽出人能读的“说明”（C# 的 /// summary、Java/TS 的块注释都吃） */
function cleanDoc(text) {
  const parts = text
    .replace(/^\/\*\*?/, '').replace(/\*\/$/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\/\/\/?/, '').replace(/^\s*\*\/?/, '').trim())
    .filter((l) => l !== '');
  // 行间怎么接：中文 / 全角标点结尾处不插空格（“…推送。” + “显示优先级…” → “推送。显示优先级”），
  // 其余照旧一个空格 —— 中文说明里 “。 显示” 这种空档很扎眼
  let t = '';
  for (const l of parts) {
    if (t !== '' && !CJK_TAIL_RE.test(t)) t += ' ';
    t += l;
  }
  t = t
    .replace(/<summary>([\s\S]*?)<\/summary>/i, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  // 排除分节线这类装饰性注释（===== Win32 =====），它们不是“说明”
  if (DECORATION_RE.test(t)) return null;
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

/** 把一段可能的"说明"清一下：压空白、封顶 300 字 */
function normalizeDoc(text) {
  if (!text) return null;
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t ? (t.length > 300 ? `${t.slice(0, 297)}…` : t) : null;
}

// ---------- 成员 / 类型的签名（参数表 + 返回类型）----------
// 要的形态是 `area(int, int): double`。为什么值得有：只给成员名时**同名重载长得一模一样**，
// AI 分不清"谁调的是哪个"，问"谁调了它 / 它调了谁"就答不准。
// 规则全部按实际语法树实测（tests/run-fixtures.mjs 里每门语言都有签名回归门），没实测的不写：
//   参数表  ① 语言钩子 paramsOf ② 字段 parameters / parameter_list / params
//           ③ 往下找"参数表节点"（PARAM_TYPES）——深度 ≤3，撞见函数体 / 返回类型 / 类型注解就停
//   返回类型 ① 语言钩子 returnTypeOf ② 字段 returns / return_type / result / type
//           ③ 参数表后面紧跟的那个"类型节点"（Kotlin 的 `: Double`、TS 的 `: void` 都没有字段名）
// **取不到就什么都不写**（宁缺勿错）：读侧看到没有签名，含义是"没抽到"，不是"没有参数"。
const PARAM_TYPES = new Set([
  'formal_parameters', 'parameters', 'parameter_list', 'function_value_parameters',
  'parameter_clause', 'method_parameters', 'arguments_definition',
]);
// 这些子树里的参数表一定属于**别的**东西（嵌套函数），不能再往下找：
// 函数体、类型注解里的函数类型、返回类型容器（Solidity 的 `returns (uint256)` 也是 parameter_list 形状）、
// 以及各种 lambda / 匿名函数（否则"类里存了个箭头函数的字段"会被当成有参数的成员）
const SIG_STOP_TYPES = new Set([
  'block', 'statement_block', 'compound_statement', 'function_body', 'body_statement', 'class_body',
  'declaration_list', 'return_type_definition', 'type_annotation', 'function_type',
  'arrow_function', 'function_expression', 'function_literal', 'anonymous_function', 'closure_expression',
  'lambda', 'lambda_expression',
]);
// 认返回类型用的"类型节点"（名字太泛的如 identifier 一律不认——宁可空着）
const TYPE_TYPES = new Set(['user_type', 'nullable_type', 'generic_type', 'parameterized_type', 'type']);
const MAX_PARAM_CHARS = 60;
const MAX_RET_CHARS = 30;

/** 深度优先找第一个"参数表节点"（撞见 SIG_STOP_TYPES / 嵌套类型声明就不往下）
 *  为什么连嵌套类型也要停：`const X = struct { fn go(a) … }` 这种写法里，
 *  参数表属于**里面那个结构体**的方法，不是外层这个成员的（Zig 实测踩过）。 */
function findParamNode(node, depth, extra, lang) {
  for (const c of node.namedChildren) {
    if (PARAM_TYPES.has(c.type) || (extra && extra.includes(c.type))) return c;
    const isNestedType = Boolean(lang && lang.types && Object.hasOwn(lang.types, c.type));
    if (depth > 1 && !isNestedType && !SIG_STOP_TYPES.has(c.type)) {
      const hit = findParamNode(c, depth - 1, extra, lang);
      if (hit) return hit;
    }
  }
  return null;
}

/** 一段签名文本：压空白、去掉 TS 的 ": " 前缀和 Solidity 的 returns 关键字、封顶长度 */
function cleanSig(text, max) {
  if (!text) return null;
  let t = String(text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^:\s*/, '');        // TS 的 type_annotation 文本自带冒号
  // Solidity 的返回类型节点文本是 "returns (uint256)" —— 只留类型本身
  const wrapped = t.match(/^returns\s+\((.*)\)$/);
  if (wrapped) t = wrapped[1];
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * 一个声明节点的签名：`{ p: 参数表, r: 返回类型 }`；两者都取不到就返回 null。
 * 语言钩子返回的是**节点**（不是文本），这样"返回类型跟在参数表后面"这条兜底还能用上。
 * depth 是往下找参数表的层数：成员默认 3 层（C/C++ 的参数表在 function_declarator 里），
 * **类型只给 1 层**——接口/对象体里的方法参数不属于它自己（实测：TS interface、Java interface、
 * Scala object 都会被 3 层那套捞出一个假 `()`）。
 * forType 还管一件事：类型节点不认 `type` 字段——那里写的是**它自己**的类型
 * （C 的 `typedef struct … X`、Rust 的 `impl Circle`、SystemRDL 的 `addrmap` 都实测过是噪声），
 * 不是"返回类型"。
 */
function declSignature(lang, node, depth = 3, forType = false) {
  let pnode = lang.paramsOf ? lang.paramsOf(node) : null;
  if (!pnode) {
    for (const f of lang.paramFields || ['parameters', 'parameter_list', 'params']) {
      const c = node.childForFieldName(f);
      if (c) { pnode = c; break; }
    }
  }
  if (!pnode) pnode = findParamNode(node, depth, lang.paramNodes, lang);

  let rnode = lang.returnTypeOf ? lang.returnTypeOf(node) : null;
  if (!rnode) {
    const fields = lang.returnFields || (forType ? ['returns', 'return_type', 'result'] : ['returns', 'return_type', 'result', 'type']);
    for (const f of fields) {
      const c = node.childForFieldName(f);
      if (c) { rnode = c; break; }
    }
  }
  if (!rnode && pnode) {
    const sibs = node.namedChildren;
    for (let i = sibs.indexOf(pnode) + 1; i > 0 && i < sibs.length; i++) {
      if (TYPE_TYPES.has(sibs[i].type)) { rnode = sibs[i]; break; }
    }
  }

  const p = pnode ? cleanSig(pnode.text, MAX_PARAM_CHARS) : null;
  const r = rnode ? cleanSig(rnode.text, MAX_RET_CHARS) : null;
  return p || r ? { p, r } : null;
}

/**
 * 一个节点的"说明"从哪来：
 *   ① 上面的注释（所有语言通用）；
 *   ② 没有注释时看 lang.docstring——Python 写 true（用内置的声明体首句字符串规则），
 *      其它语言（如 GraphQL 的 description 节点）可以给一个函数，返回字符串或 null。
 */
function languageDoc(lang, node, comments, lines) {
  const fromComment = docFor(comments, node.startPosition.row, lines);
  if (fromComment) return fromComment;
  if (!lang.docstring) return null;
  return typeof lang.docstring === 'function' ? normalizeDoc(lang.docstring(node)) : docstringOf(node);
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
  // 多行文档块必须整块拿：tree-sitter 把 /// 的每一行（C#/Rust）——以及 // / # 的每一行——各算一个
  // 独立 comment 节点，只取离声明最近的那行时，以 </summary> 收尾的块就只剩空壳（实测 MuSync：
  // 106 个类型里 25 个因此丢了说明），末行有文字的块还会被静默截成“只剩最后一行”。
  // 所以从最近那行**向上合并连续注释行**；碰见分节线就停，累计过 1000 字也停（显示上限本来只有 300 字）。
  const byStart = new Map();
  for (const c of comments) byStart.set(c.startRow, c);
  let text = best.text;
  let top = best;
  while (text.length < 1000) {
    const prev = byStart.get(top.startRow - 1);
    if (!prev || DECORATION_RE.test(prev.text)) break;
    text = `${prev.text}\n${text}`;
    top = prev;
  }
  return cleanDoc(text);
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
  // 引用**次数**（2026-09-20）：每一个 (owner, 名字) 出现过几次就记几次。
  // 之前这里是两个 Set，只记"出现过没有" → 边的权重恒为 1（"A 引用了 B 3 次" 这个信息被去重丢了）。
  // 用 Map：既当计数器，又天然保持"首次出现顺序"（跟原来 push 的顺序一模一样）。
  const refCount = new Map();        // `${ownerIndex}|${name}` -> { owner, name, n }
  const fileRefCount = new Map();    // 文件级（没有类型归属）的那些：name -> n
  // 参数名所在的标识符节点（这些不当"引用"算）
  const skipIds = new Set();
  const namespaces = new Set();
  const nsStack = [];
  let fileNamespace = '';
  const typeStack = [];
  let errors = 0;
  // 文件级（没有类型归属）的成员/分支/引用：给"没有类型声明的文件"合成模块节点用
  const fileScope = { members: {}, memberList: [], complexity: 1, refs: [] };

  const currentType = () => (typeStack.length ? typeStack[typeStack.length - 1] : null);

  // 成员/类型都带签名（参数表 + 返回类型）：同名重载靠它才分得开。取不到就没这两个键。
  function bumpMember(kind, name, node, doc) {
    const sig = declSignature(lang, node);
    const t = currentType();
    const entry = { k: kind, n: name, l: node.startPosition.row + 1 };
    if (doc) entry.d = doc;
    if (sig) {
      if (sig.p) entry.p = sig.p;
      if (sig.r) entry.r = sig.r;
    }
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
      fileRefCount.set(name, (fileRefCount.get(name) || 0) + 1);
      return;
    }
    const key = `${t.index}|${name}`;
    const cur = refCount.get(key);
    if (cur) cur.n++;
    else refCount.set(key, { owner: t.index, name, n: 1 });
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

    const impKind = lang.importKindOf ? lang.importKindOf(node) : lang.imports[type];
    if (impKind) {
      const target = parseImport(lang.importTextOf ? lang.importTextOf(node) : node.text);
      if (target) imports.push(target);
      sweepComments(node);
      return;
    }

    if (lang.namespaces[type]) {
      const name = nameOf(node, lang);
      if (name) {
        namespaces.add(name);
        // 作用域=整份文件：Java/Kotlin 的 package 语句，以及 C# 10 的 `namespace X;`
        // （后者的类型声明在语法树里是它的兄弟节点，不是子节点，所以必须走这条）
        if (lang.namespaceScope === 'file' || (lang.fileScopedNamespaces || []).includes(type)) {
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

    const kind = lang.kindOf ? lang.kindOf(node) : lang.types[type];
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
        doc: languageDoc(lang, node, comments, lines),
        members: {},
        memberList: [],
        complexity: 1,
        parent: currentType() ? currentType().index : null,
      };
      // 类型本身也留一份签名：JS/TS 的顶层函数、C#/Java 的 record 主构造函数都算"类型"，
      // 它们的参数表不在任何成员上（不给的话 symbol 里就完全看不到它收什么参数）。
      // 只看直接子节点：接口体里的方法参数不是这个类型自己的参数。
      const tsig = declSignature(lang, node, 1, true);
      if (tsig) {
        if (tsig.p) rec.p = tsig.p;
        if (tsig.r) rec.r = tsig.r;
      }
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

    // 一个节点可能产出多个成员：Ruby 的 `attr_accessor :a, :b` 就是一句 call 带两个符号。
    // membersOf 钩子优先；返回空就继续往下走静态表。
    if (lang.membersOf) {
      const many = lang.membersOf(node);
      if (many && many.length) {
        const mdoc = languageDoc(lang, node, comments, lines);
        for (const m of many) bumpMember(m.kind, m.name, node, mdoc);
        for (const c of node.namedChildren) walk(c);
        return;
      }
    }

    const memberKind = lang.memberKindOf ? lang.memberKindOf(node) : lang.members[type];
    if (memberKind) {
      const name = nameOf(node, lang);
      const mdoc = languageDoc(lang, node, comments, lines);
      bumpMember(memberKind, name, node, mdoc);
      for (const c of node.namedChildren) walk(c);
      return;
    }

    if (lang.decisions.includes(type)) {
      const t = currentType();
      const target = t || fileScope;
      if (lang.isDecision) {
        if (lang.isDecision(node)) target.complexity++;
      } else if (type === 'binary_expression') {
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
  // 计数表 → 引用列表（顺序 = 首次出现顺序，跟改之前一致）
  for (const r of refCount.values()) refs.push(r);
  for (const [name, n] of fileRefCount) fileScope.refs.push({ name, n });
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

/**
 * git 热度：最近 200 次提交里每个文件被改了几次、最近一次是什么时候。
 * 给地图当“我该从哪读起”的着色维度用（见 web 的「git 热度」）。
 *
 * 三个坑：
 *  - `-c core.quotepath=false`：否则非 ASCII 路径会被 git 转义成 `"\346\226..."`，跟 bundle 里的相对路径对不上；
 *  - 扫描根是仓库的子目录时，git 给的路径是**仓库根**相对的 → 用 `rev-parse --show-prefix` 去掉那段前缀；
 *  - 非 git 仓库（或 git 不可用）返回 null，bundle 里就不带 git 字段（不是“全 0”，而是“不知道”）。
 */
function gitHeat(root) {
  const run = (args) => {
    try {
      return execFileSync('git', ['-c', 'core.quotepath=false', '-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString();
    } catch { return null; }
  };
  const log = run(['log', '--numstat', '--pretty=format:%ct', '-n', '200']);
  if (log == null) return null;
  const prefix = ((run(['rev-parse', '--show-prefix']) || '').trim());
  const rel = (p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : prefix ? null : p);
  const byPath = new Map();
  let commits = 0;
  let ts = 0;
  for (const line of log.split('\n')) {
    if (/^\d+$/.test(line)) { ts = Number(line) * 1000; commits++; continue; }
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);   // 二进制文件的行数是 "-"
    if (!m) continue;
    const p = rel(m[3]);
    if (!p) continue;
    const cur = byPath.get(p) || { changes: 0, lastTs: 0 };
    cur.changes++;
    if (ts > cur.lastTs) cur.lastTs = ts;
    byPath.set(p, cur);
  }
  // 跟踪清单：用来区分“在仓库里但一直没改”和“压根没提交过”（新增/未提交的文件要在图上单独看得到）
  const tracked = new Set();
  for (const p of (run(['ls-files', '-z']) || '').split('\0')) {
    const r = p && rel(p);
    if (r) tracked.add(r);
  }
  return { byPath, tracked, commits };
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
const DRAFT_COLORS = ['#58a6ff', '#f778ba', '#3fb950', '#d29922', '#bc8cff', '#39c5cf', '#f0883e', '#7ee787'];
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
/**
 * 按命名空间草拟系统规则。
 * 适合"所有文件堆在一个目录"的项目——那种情况下按目录草拟等于没分，而命名空间是代码作者自己划的模块边界。
 * 需要先扫过一遍（要用 bundle 里的类型全名）。
 */
export function draftFacetsByNamespace(opts) {
  const bundlePath = path.join(path.resolve(opts.bundle || opts.outDir || 'dist'), 'bundle.json');
  const b = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  const types = b.types || [];
  const rows = [];
  for (const ty of types) {
    const fqn = String(ty.fqn || ty.name || '');
    const segs = fqn.split('.');
    if (segs.length < 2) continue;                 // 没有命名空间（C/JS/Go 这类）
    rows.push({ t: ty, ns: segs.slice(0, -1).join('.'), segs });
  }
  if (!rows.length || rows.length < types.length * 0.5) {
    return {
      config: null, files: b.totals?.files || 0, preview: [],
      notes: [t('这个项目的类型大多没有命名空间（C / JS / Go 这类语言没有），按命名空间草拟用不上——用默认的"按目录"吧。', 'Most types here have no namespace (C / JS / Go and friends have none), so drafting by namespace does not apply — use the default "by directory" instead.')],
    };
  }
  // 公共根（MuSync.Players / MuSync.Utils → MuSync），按出现最多的第一段算
  const rootCount = new Map();
  for (const r of rows) rootCount.set(r.segs[0], (rootCount.get(r.segs[0]) || 0) + 1);
  const root = [...rootCount.entries()].sort((x, y) => y[1] - x[1])[0][0];
  // 按"根之后的下一段"分组
  const groups = new Map();
  for (const r of rows) {
    const nsSegs = r.segs.slice(0, -1);
    const key = nsSegs.length > 1 ? nsSegs[1] : '';   // 空 = 直接住在根命名空间下
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const topLevel = groups.get('') || [];
  groups.delete('');
  const big = [...groups.entries()].filter(([, v]) => v.length >= 3).sort((x, y) => y[1].length - x[1].length).slice(0, 8);
  const small = [...groups.entries()].filter(([, v]) => v.length < 3);
  const systems = [];
  big.forEach(([key, v], i) => {
    systems.push({ name: key, color: DRAFT_COLORS[i % DRAFT_COLORS.length], namespaces: [`${root}.${key}*`], _files: v.length });
  });
  const rest = [...small.flatMap(([, v]) => v), ...topLevel];
  if (rest.length) {
    systems.push({ name: topLevel.length && !small.length ? t('顶层', 'Top level') : t('其他', 'Other'), color: DRAFT_GREY, namespaces: [...new Set(rest.map((r) => r.ns))], _files: rest.length });
  }
  // 顺手建议排除"一看就是第三方的"目录（用 bundle 里的文件路径看；否则别人的命名空间根会全跑到"未分类"）
  const hintDirs = new Set();
  for (const f of b.files || []) {
    for (const seg of String(f.path || '').split('/')) {
      if ([...DRAFT_EXCLUDE_HINTS].some((h) => seg.toLowerCase().startsWith(h))) hintDirs.add(seg);
    }
  }
  const notes = [t(`按命名空间草拟（公共根：${root}${systems.length ? '' : '——但这个项目分不出系统'}）`, `Drafted by namespace (common root: ${root}${systems.length ? '' : ' — but this project cannot be split into systems'})`)];
  if (hintDirs.size) notes.push(t(`已建议排除：${[...hintDirs].join('、')}（一看就是第三方/参考代码的目录名）`, `Suggested exclusions: ${[...hintDirs].join(', ')} (directory names that look like third-party / reference code)`));
  if (systems.length < 3) notes.push(t('分出来的系统少于 3 个，可能这个项目的命名空间层级太平（都挤在同一个命名空间里）', 'Fewer than 3 systems came out — the namespace hierarchy may be too flat (everything sits in one namespace)'));
  return {
    config: {
      _comment: t('系统分组规则：按命名空间草拟（可随意改）。规则按顺序匹配、第一条命中生效。', 'System grouping rules: drafted by namespace (edit freely). Rules are matched in order; the first hit wins.'),
      exclude: hintDirs.size ? [...hintDirs] : null,
      systems: systems.map(({ name, color, namespaces }) => ({ name, color, namespaces })),
    },
    files: b.totals?.files || 0,
    by: 'namespace',
    preview: systems.map((s) => ({ name: s.name, files: s._files, unit: t('个类型', 'types') })),
    notes,
  };
}

export function draftFacets(opts) {
  if (opts.by === 'namespace') return draftFacetsByNamespace(opts);
  const roots = Array.isArray(opts.roots) ? opts.roots : [opts.roots];
  const languages = resolveLanguages(opts.lang || 'auto');
  const { files } = collectFiles(roots, { languages, maxKb: Number(opts.maxKb || 1024), excludes: [] });
  const notes = [];

  // 「根目录」这个 key 既当 Map 键、又当草拟出来的系统名 —— 前后必须取**同一个** t() 的值，
  // 否则切语言后比较键不一致，根目录下的文件会被拆错。
  const ROOT_KEY = t('(根目录)', '(root)');

  /** 文件在第 level 层归到哪个 key（直接躺在这一层的文件归到上一层） */
  const keyOf = (rel, level) => {
    const segs = rel.split('/');
    if (segs.length <= level) return level <= 1 ? ROOT_KEY : keyOf(rel, level - 1);
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
  const bigAt = (m) => [...m.entries()].filter(([k, fs]) => k !== ROOT_KEY && fs.length >= 3);
  if (bigAt(groups).length < 3) {
    const g2 = groupAt(2);
    if (bigAt(g2).length > bigAt(groups).length) {
      groups = g2;
      level = 2;
      notes.push(t('顶层目录太集中（大目录不够 3 个），改按第 2 层目录草拟', 'Top-level directories are too concentrated (fewer than 3 big ones) — drafting by second-level directories instead'));
    }
  }

  const excluded = [];
  const systems = [];
  const small = [];
  const rootFiles = [];
  for (const [key, fs] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (key === ROOT_KEY) { rootFiles.push(...fs); continue; }
    const dirName = key.split('/').pop();
    // 目录名以这些词开头就算“拿来的代码”（reference-yySync / vendor_js / third_party…）
    if ([...DRAFT_EXCLUDE_HINTS].some((h) => dirName.toLowerCase().startsWith(h))) { excluded.push(dirName); continue; }
    if (fs.length >= 3 && systems.length < 8) systems.push({ key, name: dirName, files: fs.length });
    else small.push({ key, files: fs.length });
  }

  const out = [];
  systems.forEach((s, i) => out.push({ name: s.name, color: DRAFT_COLORS[i % DRAFT_COLORS.length], paths: [`${s.key}/**`], _files: s.files }));
  if (small.length) out.push({ name: t('其他', 'Other'), color: DRAFT_GREY, paths: small.map((s) => `${s.key}/**`), _files: small.reduce((a, s) => a + s.files, 0) });
  // 根目录放最后：`files: ["*"]` 会按“文件名”命中，所以只能当兜底规则（规则是第一条命中生效）
  if (rootFiles.length) out.push({ name: t('根目录', 'root'), color: DRAFT_GREY, files: ['*'], _files: rootFiles.length });

  if (excluded.length) notes.push(t(`建议排除：${excluded.join(', ')}（一看就是第三方/参考代码的目录名）`, `Suggested exclusions: ${excluded.join(', ')} (directory names that look like third-party / reference code)`));
  if (!systems.length) notes.push(t('没找到够大的目录（>=3 个文件）——草案可能不好用，建议手动写规则', 'No directory is big enough (>= 3 files) — the draft may not be useful; consider writing the rules by hand'));

  const config = {
    _comment: t('Code Atlas 系统分组规则（由首次运行向导按目录结构草拟，可直接改）。规则按顺序匹配，第一条命中生效；匹配对象 = 文件相对路径 / 文件名 / 命名空间 / 完整限定名（glob，** 表示任意层级）。exclude 是额外忽略的目录名。', 'Code Atlas system grouping rules (drafted by the first-run wizard from the directory structure; edit freely). Rules are matched in order, first hit wins; candidates = file relative path / file name / namespace / fully-qualified name (glob, ** = any depth). exclude lists extra directory names to ignore.'),
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
      // 去掉 UTF-8 BOM：Windows 上太常见（PowerShell 5.1 的 Set-Content -Encoding utf8、
      // VS Code 的“UTF-8 with BOM”、老版记事本都会加），JSON.parse 遇到 BOM 会直接报
      // Unexpected token —— 配置文件是给人手改的，这种“看起来没毛病却读不了”的坑必须挡掉。
      const text = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
      return { file: f, config: JSON.parse(text) };
    } catch (err) {
      throw new Error(t(`facets 分组配置解析失败：${f}\n${err.message}`, `cannot parse the facets config: ${f}\n${err.message}`));
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
    // 没有规则文件：不算分组，让前端退回按目录看（别拿一个 UNCLASSIFIED 分组占着位）
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
    const key = hit ? hit.name : UNCLASSIFIED;
    const g = groups.get(key) || { name: key, color: (hit && hit.color) || '#6e7681', types: 0, loc: 0, files: new Set() };
    g.types++; g.loc += t.loc; g.files.add(t.file);
    groups.set(key, g);
  }
  const order = [...rules.map((r) => r.name), UNCLASSIFIED];
  const systems = [...groups.values()]
    .map((g) => ({ name: g.name, color: g.color, types: g.types, files: g.files.size, loc: g.loc }))
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return {
    configFile: facetsDoc ? path.basename(facetsDoc.file) : null,
    configPath: facetsDoc ? facetsDoc.file : null,
    systems,
    unclassified: groups.get(UNCLASSIFIED) ? { types: groups.get(UNCLASSIFIED).types, loc: groups.get(UNCLASSIFIED).loc } : { types: 0, loc: 0 },
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
    const language = await Language.load(resolveWasm(lang));
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
  // 不再在这里打“开始解析”：父进程已经报过总数（单语言时两行一模一样，看着像重复）
  // console.log(t(`  开始解析：${totalFiles} 个文件（${langsUsed.join(', ')}）`, `  Parsing ${totalFiles} files (${langsUsed.join(', ')})`));

  for (const f of files) {
    let rawSource;
    let nonUtf8 = false;
    try {
      // 顺手查一眼编码：非 UTF-8（GBK / ANSI 之类）会被**静默**替换成 U+FFFD —— 注释和字符串变乱码，
      // 而语法树不报错，用户容易以为是工具的问题。统计出来，在报告 / MCP / 网页里都说一句。
      const rawBuf = fs.readFileSync(f.abs);
      rawSource = rawBuf.toString('utf8');
      if (Buffer.compare(Buffer.from(rawSource, 'utf8'), rawBuf) !== 0) nonUtf8 = true;
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
        // 类型自己身上的签名（JS/TS 的顶层函数、C#/Java 的 record 主构造函数都在"类型"这一档）：
        // 没抽到就没有这两个键（不是空值）——读侧看到没有就是"不知道"
        ...(t.p ? { p: t.p } : null),
        ...(t.r ? { r: t.r } : null),
        members: t.members,
        memberList: t.memberList,
        complexity: t.complexity,
        fanIn: 0,
        fanOut: 0,
        tags: GENERATED_NAME_RE.test(t.name) ? ['compiler-generated'] : [],
      });
      for (const r of facts.refs) {
        if (r.owner === t.index) part.refs.push({ t: id, name: r.name, n: r.n });
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
      for (const r of facts.fileScope.refs) part.refs.push({ t: id, name: r.name, n: r.n });
    }

    // 进度提示：文件多的时候每 150 个或每 2.5 秒报一次（小项目只有开始那一行）
    parsedFiles++;
    if (totalFiles > 150 && (parsedFiles % 150 === 0 || Date.now() - lastReportAt > 2500)) {
      lastReportAt = Date.now();
      console.log(t(`  解析中… ${parsedFiles}/${totalFiles} 文件（${((Date.now() - startedAt) / 1000).toFixed(1)}s）`, `  Parsing… ${parsedFiles}/${totalFiles} files (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`));
    }

    part.file = {
      path: f.rel,
      lang: f.lang.id,
      loc, code, comment, blank,
      bytes: f.bytes,
      mtime: Math.round(f.mtime),
      errors: facts.errors,
      nonUtf8,
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
      // n = 这个"解析前的名字"在同一个 owner 里被引用了几次（权重就是从这里来的）
      for (const r of pf.refs || []) out.allRefs.push({ owner: r.t + tOff, name: r.name, n: r.n || 1 });
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

// ---------- Elixir 专用：语法树里 defmodule / def / alias 全是 call 节点，只能按“调用的名字”判断 ----------
/** 取这个 call 的“调用名”；普通调用如 IO.puts 的 target 是 dot，返回 null */
function elixirCallee(node) {
  if (!node || node.type !== 'call') return null;
  const target = node.childForFieldName('target') || node.namedChildren[0];
  return target && target.type === 'identifier' ? target.text : null;
}
function elixirFirstArg(node) {
  const args = node.namedChildren.find((c) => c.type === 'arguments');
  return (args && args.namedChildren[0]) || null;
}
function elixirName(node) {
  const callee = elixirCallee(node);
  if (!callee) return null;
  const first = elixirFirstArg(node);
  if (!first) return null;
  if (callee === 'defmodule') return first.type === 'alias' ? first.text : null;
  if (callee.startsWith('def')) {
    if (first.type === 'identifier') return first.text;
    if (first.type === 'call') return elixirCallee(first);   // def area(x) → 名字在里层的 call 上
    return null;
  }
  return null;
}
function elixirKind(node) {
  return elixirCallee(node) === 'defmodule' ? 'module' : null;
}
function elixirMemberKind(node) {
  const c = elixirCallee(node);
  if (!c) return null;
  if (['def', 'defp', 'defmacro', 'defmacrop', 'defdelegate'].includes(c)) return 'function';
  if (c === 'defstruct') return 'struct';
  if (c === 'defprotocol' || c === 'defimpl') return 'protocol';
  return null;
}
function elixirImportKind(node) {
  const c = elixirCallee(node);
  return ['alias', 'import', 'use', 'require'].includes(c) ? 'import' : null;
}
function elixirIsDecision(node) {
  const c = elixirCallee(node);
  return ['if', 'unless', 'case', 'cond', 'with', 'for', 'try', 'receive'].includes(c);
}

export async function scan(opts) {
  const t0 = Date.now();
  const roots = (opts.roots?.length ? opts.roots : ['.']).map((r) => path.resolve(r));
  const languages = resolveLanguages(opts.lang);
  const outDir = path.resolve(opts.outDir || 'dist');
  const maxKb = opts.maxKb || 1024;

  for (const r of roots) {
    if (!fs.existsSync(r) || !fs.statSync(r).isDirectory()) {
      throw new Error(t(`目录不存在：${r}`, `Directory not found: ${r}`));
    }
  }

  const facetsDoc = loadFacets(opts, roots);
  const excludes = [...(opts.excludes || []), ...(facetsDoc?.config?.exclude || [])];
  // 项目自己的跳过规则：atlas.ignore（存在才生效）+ 可选的 .gitignore（--gitignore 才读）
  const ignoreRules = loadIgnoreRules(roots, { gitignore: opts.gitignore });
  const { files, skipped } = collectFiles(roots, { languages, maxKb, excludes, budget: opts.fileBudget, ignoreRules });

  const langById = new Map(languages.map((l) => [l.id, l]));
  const byLang = new Map();
  for (const f of files) {
    if (!byLang.has(f.lang.id)) byLang.set(f.lang.id, []);
    byLang.get(f.lang.id).push(f);
  }

  // 解析：**每门语言起一个子进程**（父进程自己一律不装语法包）
  //
  // 为什么分进程：老运行时（web-tree-sitter 0.20.8）每门语法包一加载就常驻 150~180 MB 且没有释放接口，
  // 同进程装 9 门就崩（退出期 0xC0000409，1~3 门正常）——详见 ROADMAP 附录 A.11 的实测表。
  // 升到 0.27 后单门内存降到约 11 MB、105 门同进程一次装也能干净退出（实测），内存不再是理由；
  // 保留分进程是为了**崩溃隔离**：某个语法包在特定输入上硬 abort（wasm 层 abort 杀进程，JS 拦不住）时，
  // 只丢那一门、其余照常进地图。代价是每门约 0.2 s 进程启动。
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
    console.log(t(`  增量扫描：复用 ${reused.size} 个没变的文件，重新解析 ${freshFiles.length} 个` + (cache ? '' : '（没有可用缓存，本次算全量）'), `  Incremental: reused ${reused.size} unchanged files, re-parsing ${freshFiles.length}` + (cache ? '' : ' (no usable cache — treating this as a full scan)')));
  }

  const freshParts = [];
  const failedLanguages = [];   // 整门语言没抽出来（子进程崩了等）——要记进 bundle，不能只飘一行日志
  if (freshFiles.length) {
    const langsWithFiles = [...new Set(freshFiles.map((f) => f.lang.id))];
    console.log(t(`  开始解析：${freshFiles.length} 个文件（${langsWithFiles.join(', ')}）`, `  Parsing ${freshFiles.length} files (${langsWithFiles.join(', ')})`));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-atlas-'));
    const work = path.join(tmp, 'files.json');
    fs.writeFileSync(work, JSON.stringify({
      files: freshFiles.map((f) => ({ abs: f.abs, rel: f.rel, root: f.root, bytes: f.bytes, mtime: f.mtime, lang: f.lang.id })),
    }));
    const NODE = process.env.NODE_BIN || process.execPath;   // 一般就是 node.exe；特殊情况可用 NODE_BIN 指定
    let n = 0;
    for (const langId of langsWithFiles) {
      const emit = path.join(tmp, `part-${n++}.json`);
      const r = spawnSync(NODE, [
        // 我们的语法树遍历是递归的，深度 = 文件嵌套深度；V8 默认栈实测在约 3000 层就爆
        // （Maximum call stack size exceeded），而生成代码 / 极端嵌套的配置完全能到这个量级。
        // 加大到 8000 KB（实测过 1 万层）。再深照样会爆——但那时会记 failedLanguages、汇总里也会明说。
        '--stack-size=8000',
        CLI_PATH, '__extract', '--work', work, '--lang', langId, '--emit', emit,
      ], {
        stdio: ['ignore', 'inherit', 'pipe'],   // 进度直接透传，stderr 收起来（免得崩溃刷屏）
        timeout: 30 * 60 * 1000,
        windowsHide: true,
      });
      let ok = false;
      if (fs.existsSync(emit)) {
        try { freshParts.push(JSON.parse(fs.readFileSync(emit, 'utf8'))); ok = true; } catch (e) { console.log(t(`  ⚠ ${langId} 的结果读不出来：${e.message}`, `  ⚠ ${langId}: cannot read the extract result: ${e.message}`)); }
      }
      if (!ok) {
        const tail = String(r.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
        console.log(t(`  ⚠ ${langId} 没解析成功（子进程退出码 ${r.status}）—— 这门语言这次不进地图。${tail ? `子进程最后一句：${tail.slice(0, 200)}` : ''}`, `  ⚠ ${langId} failed to parse (child exit code ${r.status}) — this language is not in the map this time. ${tail ? `Last line from the child: ${tail.slice(0, 200)}` : ''}`));
        failedLanguages.push({ lang: langId, files: (byLang.get(langId) || []).length, reason: tail || `子进程退出码 ${r.status}` });
      }
      // 注意：子进程是 SIGKILL 硬退的（绕开退出阶段的 libuv 断言），所以**成功时退出码也是 1**。
      // 不要用“退出码非 0”去判定失败，也不要据此打日志（否则每门语言都会刷一行）——成败只看 emit。
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

  /**
   * 名字解析：把一个引用名（可能是简单名，比如 `Widget`）对到一个符号上。
   *
   * 优先级（从强到弱）：
   *   1. 唯一命中 → 直接用
   *   2. **同一个文件里声明的** → 本地声明优先（语言的作用域就是本地优先；这是治同名误归的根因）
   *   3. 唯一命中且同命名空间 → 退一步用命名空间近似
   *   4. 唯一命中且同根包（`a.b.c` 的 `a` 相同） → 再退一步
   *   5. 都不行 → 放弃，计入 ambiguous（宁可缺边，也不要接错）
   *
   * 为什么 2 要排在 3/4 前面：同一个文件里声明的同名符号，在 Java/JS/C# 这些语言里
   * 就是引用的那个（本地作用域胜过包/命名空间近似）；反过来，同一包里另一个文件里的
   * 同名符号只是“看起来像”，按名字接上去就是误归。
   */
  const unresolved = { ambiguous: 0, unknown: 0 };
  const resolveName = (name, fromTypeId) => {
    const hit = bySimpleName.get(name);
    if (!hit || !hit.length) { unresolved.unknown++; return null; }
    if (hit.length === 1) return hit[0];
    const from = allTypes[fromTypeId];
    const sameFile = hit.filter((id) => allTypes[id].file === from.file);
    if (sameFile.length === 1) return sameFile[0];
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
  // 权重 = 引用**次数**（同一个 owner 里同名字出现几次）：
  //   · 网页里连线的粗细（stroke-width = min(4, 1 + log2(1 + w))）、依赖矩阵的浓淡都用它
  //   · fanIn / fanOut 也是权重之和 → "被引用多少次 / 引用别人多少次"
  //   · 同名不同含义的"仅同名边"会在读侧被标出来，别只看数字大小（见 mcp.mjs 的 evidenceOf）
  const edgeMap = new Map();
  const addEdge = (from, to, kind, n = 1) => {
    if (from == null || to == null || from === to) return;
    const key = `${from}|${to}|${kind}`;
    edgeMap.set(key, (edgeMap.get(key) || 0) + n);
  };

  for (const r of allRefs) {
    const to = resolveName(r.name, r.owner);
    if (to != null) addEdge(r.owner, to, 'ref', r.n || 1);
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
    // 没有命名空间的文件（JS / TS / Shell 这类）也要挂到它类型所在的那个合成节点上，
    // 否则 root / (global) 的 allFiles 会少算（实测：114 个文件 → 0）
    if (!f.namespaces.length) ensureNs('(global)').files.push(f.id);
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
  nonUtf8Files: fileRecs.filter((f) => f.nonUtf8).length,
    compilerGenerated: allTypes.filter((t) => t.tags.includes('compiler-generated')).length,
  };

  // ---- 系统 / 模块分组（facets 规则）----
  const facets = applyFacets(facetsDoc, allTypes, fileRecs);

  // ---- 版本戳 ----
  const git = roots.map(gitInfo).find(Boolean) || null;
  // ---- git 热度（写进 files[]；非 git 仓库不带这个字段）----
  // changes：最近 200 次提交里被改了几次；lastDaysAgo：最近一次改动距今多少天（永远不会是负数）；
  // untracked：这个文件根本没提交过（新增 / 未提交）——只在确实是这种情形时才带这个键。
  const heat = git ? (roots.map(gitHeat).find(Boolean) || null) : null;
  if (heat) {
    const now = Date.now();
    for (const f of fileRecs) {
      const h = heat.byPath.get(f.path);
      if (h) f.git = { changes: h.changes, lastDaysAgo: Math.max(0, Math.round((now - h.lastTs) / 86400000)) };
      else if (!heat.tracked.has(f.path)) f.git = { changes: 0, lastDaysAgo: null, untracked: true };
      else f.git = { changes: 0, lastDaysAgo: null };
    }
  }
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
      // 整门语言没抽出来（如子进程崩了）——以前只在终端飘一行 ⚠，bundle 里什么都没有，
      // 结果"整门语言消失"看起来像"扫完了、就是空的"（实测：3000 层嵌套触发爆栈）。
      failedLanguages,
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
    ignoredDirs: Object.fromEntries(skipped.ignoredDirs || []),
      // 项目自己的规则（atlas.ignore / .gitignore）命中多少：进 bundle，报告和 MCP 都能看见
      projectDirs: Object.fromEntries(skipped.projectDirs || []),
      projectFiles: skipped.projectFiles || 0,
      ignoreSources: skipped.ignoreSources || [],
      ignorePatterns: skipped.ignorePatterns || 0,
      // 读了几份规则文件：嵌套 .gitignore 之后，光看 sources（只有名字）看不出到底读了几份
      ignoreFiles: skipped.ignoreFiles || 0,
      ignoreNegations: skipped.ignoreNegations || 0,
      tooBig: skipped.tooBig || 0,
      unknown: skipped.unknown || 0,
      unsupported: Object.fromEntries(skipped.unsupported || []),
      outOfScope: Object.fromEntries(skipped.outOfScope || []),
    },
  };

  // （原来这里有个"释放解析器"的循环：解析已经挪到子进程里，父进程不再持有解析器，所以删掉了）

  // 写回增量缓存（下次没变的文件就不用再解析了）
  if (freshFiles.length || reused.size) {
    try { writeScanCache(cacheFile, langSpec, maxKb, files, byRel); } catch (e) { console.log(t(`  （增量缓存没写成功：${e.message}；不影响这次扫描）`, `  (could not write the incremental cache: ${e.message}; this scan is unaffected)`)); }
  }

  return { bundle, outDir, files, skipped, roots };
}

/** 扫描并写出 bundle.json */
export async function scanToDisk(opts) {
  const result = await scan(opts);
  fs.mkdirSync(result.outDir, { recursive: true });
  const out = path.join(result.outDir, 'bundle.json');
  // **原子替换**（临时文件 + rename）：监控模式下网页与 MCP 随时在读这个文件，
  // 绝不能读到写了一半的 JSON。同目录、同卷的 rename 是原子的。
  const tmpOut = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(tmpOut, JSON.stringify(result.bundle));
  try {
    fs.renameSync(tmpOut, out);
  } catch {
    fs.writeFileSync(out, JSON.stringify(result.bundle));   // 极端情况下（被占 / 跨卷）退回去直接写
    try { fs.rmSync(tmpOut, { force: true }); } catch { /* 忽略 */ }
  }
  return { ...result, out };
}

/**
 * 持续扫描（`scan --watch`）—— 就是用户要的那个「内构监控」：
 *   ① 首扫**分几趟**把地图“长”出来：先数一遍文件，再按 2%/10%/25%/50%/100% 分趟增量扫，
 *      每趟写一次 bundle。复用现成的增量缓存 —— 后一趟只解析新增的那批，不重复干活。
 *   ② 之后每 1.5 秒巡检一遗：已纳入文件的 mtime/大小（再加每个目录的条目数）—变了就增量重扫 → 原子替换 bundle。
 *      用**轮询**而不是 fs.watch —— 实测 fs.watch 在本机这条路径里收不到事件（见函数里那段说明）。
 * ⚠ 退出别指望优雅：这个进程在退出阶段会撞 libuv 的 UV_HANDLE_CLOSING（老坑），
 *   所以启动器停监控 / 关窗口时请**直接强杀**（process.kill），别发信号等它自己退。
 * 返回 `{ stop() }`（CLI 用不上 —— 它靠 Ctrl+C；启动器与测试可以直接调）。
 */
export async function watchScan(opts) {
  const base = { ...opts, incremental: true };      // 监控模式一律带增量（否则每次重扫都是全量）
  const roots = (opts.roots?.length ? opts.roots : ['.']).map((r) => path.resolve(r));
  const languages = resolveLanguages(opts.lang);
  const maxKb = opts.maxKb || 1024;
  const excludes = opts.excludes || [];
  let lastFiles = [];
  let pass = 0;

  const runPass = async (budget) => {
    const r = await scanToDisk({ ...base, fileBudget: budget });
    lastFiles = r.files || [];
    pass++;
    console.log(t(`  ✓ 地图已更新（第 ${pass} 趟）：${r.bundle.totals.files} 文件 · ${r.bundle.totals.types} 类型 · ${new Date().toLocaleTimeString()}`,
      `  ✓ Map updated (pass ${pass}): ${r.bundle.totals.files} files · ${r.bundle.totals.types} types · ${new Date().toLocaleTimeString()}`));
    return r;
  };

  // ① 分趟长出来（小项目就一趟全量）
  const { files: all } = collectFiles(roots, { languages, maxKb, excludes, ignoreRules: loadIgnoreRules(roots, { gitignore: opts.gitignore }) });
  const total = all.length;
  const c = (f) => Math.max(20, Math.round(total * f));
  const caps = [...new Set([c(0.02), c(0.1), c(0.25), c(0.5)].filter((n) => n < total).concat([total]))].sort((a, b) => a - b);
  for (let i = 0; i < caps.length; i++) {
    await runPass(caps[i] >= total ? null : caps[i]);
    if (i < caps.length - 1) await new Promise((s) => setTimeout(s, 1200));   // 留出时间让网页看出来
  }

  // ② 之后：**轮询**已纳入文件的 mtime/大小（再加每个目录的条目数，用来发现新增/删除），
  //    变了就增量重扫 + 原子替换 bundle。
  //
  // 为什么不用 fs.watch（原计划是它）：本机实测**装上了却一个事件都收不到、也不报错** ——
  // 同一个目录用裸 `fs.watch` 能收到事件（做过对照），但放进我们这个“先 spawnSync 跑完解析”的
  // 进程里就是没有；而且它在网络盘 / 目录被重建 / 编辑器临时文件上还有一堆坑。
  // 轮询没有句柄、没有平台差异，代价只是每 1.5 秒 stat 一遗（超过 2 万文件自动放宽到 5 秒）。
  let dirSnap = new Map();           // 目录 -> 条目数（新增 / 删除文件的信号）
  const snapDirs = () => {
    dirSnap = new Map();
    for (const f of lastFiles) {
      const d = path.dirname(f.abs);
      if (dirSnap.has(d)) continue;
      try { dirSnap.set(d, fs.readdirSync(d).length); } catch { dirSnap.set(d, -1); }
    }
  };

  let busy = false;
  let again = false;
  const fire = async () => {
    if (busy) { again = true; return; }        // 正在扫就排队，扫完再补一次
    busy = true;
    try {
      await runPass(null);                     // 增量重扫（缓存让没变的文件不用重解析）
      snapDirs();
    } catch (err) {
      console.error(t(`  ⚠ 重扫失败：${err.message}`, `  ⚠ Rescan failed: ${err.message}`));
    }
    busy = false;
    if (again) { again = false; fire(); }
  };

  /** 一遗轻量巡检：文件 mtime/大小变了、或某个目录的条目数变了 → 需要重扫 */
  const dirty = () => {
    for (const f of lastFiles) {
      let st;
      try { st = fs.statSync(f.abs); } catch { return true; }        // 被删 / 改名了
      if (st.size !== f.bytes || Math.round(st.mtimeMs) !== Math.round(f.mtime)) return true;
    }
    for (const [d, n] of dirSnap) {
      try { if (fs.readdirSync(d).length !== n) return true; } catch { return true; }
    }
    return false;
  };

  snapDirs();
  const intervalMs = lastFiles.length > 20000 ? 5000 : 1500;
  const timer = setInterval(() => {
    if (busy || !dirty()) return;
    console.log(t('  · 检测到改动，重扫…', '  · Change detected, rescanning…'));
    fire();
  }, intervalMs);
  console.log(t(`  监控中：${lastFiles.length} 个文件 / ${dirSnap.size} 个目录（每 ${intervalMs / 1000} 秒巡检一次；Ctrl+C 停）`,
    `  Watching ${lastFiles.length} files in ${dirSnap.size} directories (polling every ${intervalMs / 1000}s; Ctrl+C to stop)`));
  return { stop: () => clearInterval(timer) };
}
