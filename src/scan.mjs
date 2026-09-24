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
import { resolveWasm, LANGUAGES, languageForExt, resolveLanguages, expandUseTree } from './languages.mjs';
// 模块名归一 / import 是否能指到目标 —— 与读期（mcp.mjs 的证据分档）**共用同一套口径**
import { moduleKey, importMatchesTarget } from './modules.mjs';
import { rmrf, rmFile } from './fsx.mjs';
import { t } from './i18n.mjs';
import { preprocess, csharpAsyncIdentifier } from './preprocess.mjs';

export const SCHEMA = 'code-atlas/1';
export const VERSION = '1.8.0';

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

/** 清单文件（包名 / 路径别名发现用）：**只在 collectFiles 里记路径、之后统一读**。
 * 2026-09-23（AI 实测反馈）：以前 discoverPackages 自己走全树、还把遇到的**每个文件**读进内存
 * （图外 4 万多个样本文件也读），而且不遵守跳过规则 —— 图外的 176 个包名会泄进图内。*/
const MANIFEST_NAMES = new Set(['package.json', 'Cargo.toml', 'go.mod', 'pubspec.yaml', 'Package.swift', 'tsconfig.json', 'jsconfig.json']);

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
// `.gitignore`：**默认读**（--no-gitignore 关掉；启动器上有个勾选框）。
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
      // 没勾 --gitignore / 传了 --no-gitignore 时 .gitignore 一份都不读；`atlas.ignore` 是本工具自己的约定，永远读（只有目标根那一份）
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

/**
 * 一级被跳过目录的“体量”（有上限地数文件；.git 不数）—— AI 实测反馈（2026-09-23）：只报“跳了哪几类”
 * 不够，使用者会把“图里 72 个文件”当成“仓库就 72 个文件”。数出来，让两个数同框。
 * 只数一级（rel 没斜杠）；嵌套的仍按名字聚合（ignoredDirs）。上限定 10 万，防极端目录。
 */
function noteRootDirSkip(skipped, name, abs, rel) {
  if (rel.includes('/') || name.startsWith('.git')) return;
  const cnt = countFilesBounded(abs);
  const prev = skipped.rootDirs.get(name);
  if (prev) { prev.files += cnt.files; prev.capped = prev.capped || cnt.capped; }
  else skipped.rootDirs.set(name, cnt);
}

const dirCountMemo = new Map();   // abs -> { mtime, files, capped }：watch 一个进程跑很多趟，别每趟重数一遍（47k 文件约 2s）
function countFilesBounded(dir, cap = 100000) {
  let mt = 0;
  try { mt = fs.statSync(dir).mtimeMs; } catch { return { files: 0, capped: false }; }
  const memo = dirCountMemo.get(dir);
  if (memo && memo.mtime === mt) return { files: memo.files, capped: memo.capped };
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      if (e.isDirectory()) { if (!e.name.startsWith('.git')) stack.push(path.join(d, e.name)); }
      else n++;
      if (n >= cap) { dirCountMemo.set(dir, { mtime: mt, files: n, capped: true }); return { files: n, capped: true }; }
    }
  }
  dirCountMemo.set(dir, { mtime: mt, files: n, capped: false });
  return { files: n, capped: false };
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
  const manifests = [];   // 图内遇到的清单文件（清单名 → 路径）；包名/别名发现统一从这里读，不再自己走树
  // ignoredDirs：被默认跳过表命中的目录名 → 次数。它进 bundle、进扫描报告，
  // 让“图里少了东西”这件事可见（monorepo 的 packages/ 当年就是这么被发现的）。
  const skipped = { ignored: 0, ignoredDirs: new Map(), tooBig: 0, unknown: 0, unsupported: new Map(), outOfScope: new Map(),
    projectDirs: new Map(), projectFiles: 0, projectBySrc: {}, rootDirs: new Map() };

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
          if (ignoreDirs.has(e.name) || e.name.startsWith('.git')) {
            skipped.ignored++; skipped.ignoredDirs.set(e.name, (skipped.ignoredDirs.get(e.name) || 0) + 1);
            noteRootDirSkip(skipped, e.name, abs, rel);
            continue;
          }
          // 项目自己的规则（atlas.ignore / .gitignore）也走同一本账，好让“图里少了东西”始终可见
          if (ignoreRules && ignoreRules.hit(rootIdx, rel, e.name, true)) {
            skipped.ignored++;
            skipped.ignoredDirs.set(e.name, (skipped.ignoredDirs.get(e.name) || 0) + 1);
            skipped.projectDirs.set(e.name, (skipped.projectDirs.get(e.name) || 0) + 1);
            noteRootDirSkip(skipped, e.name, abs, rel);
            continue;
          }
          stack.push(abs);
          continue;
        }
        if (!e.isFile()) continue;
        if (isIgnoredFile(e.name)) { skipped.ignored++; continue; }
        const ruleSrc = ignoreRules ? ignoreRules.hit(rootIdx, rel, e.name, false) : null;
        if (ruleSrc) {
          // 按规则来源记账（atlas.ignore / .gitignore）——“因为 .gitignore 跳了多少”要能直接报出来
          skipped.ignored++; skipped.projectFiles++;
          skipped.projectBySrc[ruleSrc] = (skipped.projectBySrc[ruleSrc] || 0) + 1;
          continue;
        }
        // 清单文件（包名 / 路径别名）：**只记路径**，遵守跳过规则（默认表 / --exclude / atlas.ignore / .gitignore）
        if (MANIFEST_NAMES.has(e.name)) manifests.push({ abs, rel: path.relative(root, abs).split(path.sep).join('/'), name: e.name });
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
        // `.h` 到底算 C 还是 C++ 得看内容：头文件里写 C++ 的很多（redis 的 deps/、fmt 的 include/
        // 实测解析异常一大半来自「C++ 内容按 C 解析」）。读前 4KB 嗅一下，命中才算 C++。
        let fileLang = lang;
        if (lang.id === 'c' && ext === '.h') {
          let head = '';
          try {
            const fd = fs.openSync(abs, 'r');
            const buf = Buffer.alloc(4096);
            const n = fs.readSync(fd, buf, 0, 4096, 0);
            fs.closeSync(fd);
            head = buf.slice(0, n).toString('utf8');
          } catch { head = ''; }
          if (/\btemplate\s*</.test(head) || /\bnamespace\s+\w+/.test(head) || /\bclass\s+\w+\s*[:{]/.test(head)
            || /#\s*include\s*<(vector|string|map|memory|iostream|algorithm|sstream|optional|utility|type_traits|array|functional|unordered_map|cstdint)>/.test(head)) {
            fileLang = LANGUAGES.cpp || lang;
          }
        }
        let stat;
        try { stat = fs.statSync(abs); } catch { continue; }
        if (stat.size > maxKb * 1024) { skipped.tooBig++; continue; }
        files.push({
          abs,
          rel: path.relative(root, abs).split(path.sep).join('/'),
          root,
          lang: fileLang,
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
  return { files, skipped, manifests };
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
/**
 * ① 成员级名字级调用图（2026-09-20）：这个名字所在的这一行，看起来是**调用**还是**成员访问**？
 *   判据只看源码那一行：名字后面（跳过空白）紧跟 `(` → 调用；名字前面紧挨 `.` / `>` / `:` → 成员访问
 *   （`.` / `->` / `::` / `?.` 都能盖住）。
 * 为什么不走语法树：29 门语言的“调用 / 成员访问”节点名各不相同，逐门实测的成本远超收益；而这里需要的只是
 *   “这个名字在哪些行被用到”——**行号来自语法树**（node.startPosition），位置判据来自源码文本。
 * ⚠ `startPosition/endPosition.column` 直接用，**不要再做字节换算**：web-tree-sitter 是拿 JS 字符串（UTF-16）解析的，
 *   它给的 column 就是码元偏移（曾经按“UTF-8 字节”算过一次，结果中文注释在同一行时整个错位 —— 有门盯着）。
 * 已知抓不到（写进 CHANGELOG 与工具描述了）：Lisp 那种 `(foo x)` 的写法（名字后面不跟括号）、动态调用 / 别名 / 反射。
 * 误判很轻：注释与字符串里的“名字”本来就不是标识符节点，根本走不到这里。
 */
function sourceUseKind(lines, node) {
  const line = lines[node.startPosition.row];
  if (!line) return null;
  const end = node.endPosition.column;
  if (line.slice(end).replace(/^\s+/, '').startsWith('(')) return 'call';
  const before = node.startPosition.column > 0 ? line[node.startPosition.column - 1] : '';
  if (before === '.' || before === '>' || before === ':') return 'access';
  return null;
}

/**
 * “这个名字在哪些行被调用 / 被当成员访问”里，各语言给**成员名**用的节点类型。
 * 实测来源：JS/TS/TSX/Vue 用 `property_identifier`（`w.render()` 里的 render 就是它，不是 identifier）；
 * Go / Rust 用 `field_identifier`；这两类之外的语言（C# / Java / Python / C++ …）成员名就叫 `identifier`，已在上一个分支里。
 * 这是一张**表**：换新语言时先跑一份真实样本，看是不是有节点类型没盖到（- 比改完才发现靠猜好）。
 */
const USE_ID_TYPES = new Set(['property_identifier', 'field_identifier']);

function nameOf(node, lang) {
  // Rust impl 块：名字取它实现的类型（field 'type'），让方法挂到同名节点上
  // 有专用取名钩子的语言（例如 Elixir）以它为准；**它没给出名字时继续往下走通用兜底**——
  // 以前这里直接 return，钩子返回 null 就真没名字了，于是那个成员只计数、不列出（1.4.0 复测 P1 的同类）
  const hooked = lang && lang.nameOf ? lang.nameOf(node) : null;
  if (hooked) return hooked;
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
  // 名字可能包在外层绑定里：Zig 的 struct 在 variable_declaration、OCaml 的在 type_binding、
  // **C# 的字段在 field_declaration → variable_declaration → variable_declarator → identifier**
  // （最后这条以前取不到名字：那样的成员会被计进 members 却不进 memberList —— 见 1.4.0 复测报告 P1）
  const WRAPPERS = ['variable_declaration', 'variable_declarator', 'init_declarator', 'type_spec', 'type_binding', 'let_binding', 'module_binding'];
  // "声明符"类：名字就挂在它里面。**必须比裸 identifier 先看** ——
  // C# 的 `Color Bg = …` 里 Color（类型）也是 identifier，先扫 identifier 就会把 7 个字段全起名叫 Color（实际踩过）
  const DECLARATORS = ['variable_declarator', 'init_declarator', 'declarator', 'pointer_declarator', 'function_declarator', 'array_declarator'];
  const innerName = (n, depth) => {
    if (depth > 0) {
      const dec = n.namedChildren.find((c) => DECLARATORS.includes(c.type));
      if (dec) {
        const got = innerName(dec, depth - 1);
        if (got) return got;
      }
    }
    const byField = n.childForFieldName('name') || n.childForFieldName('pattern');
    if (byField) return byField.text;
    const id = n.namedChildren.find((c) => ID_TYPES.includes(c.type));
    if (id) return id.text;
    // 再往里一层：C# 的 variable_declaration 自己不叫 name，里面那层 variable_declarator 才叫
    if (depth > 0) {
      const deeper = n.namedChildren.find((c) => WRAPPERS.includes(c.type));
      if (deeper) return innerName(deeper, depth - 1);
    }
    return null;
  };
  const group = node.namedChildren.find((c) => WRAPPERS.includes(c.type));
  if (group) {
    const g = innerName(group, 2);
    if (g) return g;
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
  // 通用兜底（2026-09-20）：以上都取不到就**往子树里找标识符** —— 这是"计了数却不列出来"
  // 那个 bug 的根治（bash 的变量、PHP 的属性、OCaml 的字段、Elixir 的 struct 都栽在这条上：
  // 名字取不到 → 只进 members 分档、不进 memberList → symbol / map 里整块消失）。
  // 限制层数、跳过函数体与嵌套类型体，免得把函数体里的某个标识符当成名字。
  const NAME_STOP = new Set(['block', 'statement_block', 'compound_statement', 'function_body', 'body_statement', 'class_body', 'declaration_list', 'do_block']);
  const deepId = (n, depth) => {
    for (const c of n.namedChildren) {
      if (ID_TYPES.includes(c.type)) return c.text;
      if (depth > 1 && !NAME_STOP.has(c.type)) {
        const got = deepId(c, depth - 1);
        if (got) return got;
      }
    }
    return null;
  };
  const deep = deepId(node, 3);
  if (deep) return deep;
  // 最后一层：连标识符都没有（bash 的某些赋值、Elixir 的 defstruct、Zig 的 const 结构…）——
  // 宁可把源码那一行截取出来当名字，也不能让成员"计了数却消失"。
  // 有了这层，members 分档求和与 memberList 长度**恒定相等**（tests/run-fixtures.mjs 有全局断言盯着）。
  const firstLine = String(node.text || '').split(/\r?\n/)[0].trim().replace(/\s+/g, ' ');
  return firstLine ? firstLine.slice(0, 40) : null;
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


/**
 * 从 import 语句里抠出目标名，**返回数组** —— 一个 import 节点可能挂着好几条：
 * Go 的 `import ( "a"\n"b" )` 整块就是一个 import_declaration 节点（gin 实测里整块被记成一整条字符串，
 * 99 个文件只采到 94 条）。C# using / Java import / JS-TS import / Python from-import / C-C++ #include / PHP use 都吃。
 */
function parseImports(text) {
  const raw = String(text).trim();
  // 先剥掉挡在前面的东西：Rust 的可见性前缀（`pub use` / `pub(crate) use`）、
  // Swift 的属性（`@testable import X`）、以及**跟在后头的注释**
  //（Kotlin 的 import 会把紧随的 KDoc 并进节点文本 —— 实测 coroutines 4,421 条 import 里 278 条带这个尾巴）。
  const stmtRaw = raw
    .replace(/^pub(?:\s*\([^)]*\))?\s+/, '')
    .replace(/^@\w+(?:\([^)]*\))?\s+/, '');
  // 剥掉语句**尾巴上的注释**：Kotlin 的 import 会把紧随的 KDoc / 行注释并进节点文本
  //（实测 coroutines：4,354 条 import 里一度 278 条带尾巴；一次剥不干净——连着好几行 `//` 要循环剥）。
  // 只在“注释一直延伸到结尾”时才切（多行 import 里的行内注释不算）。
  let stmt = stmtRaw;
  for (;;) {
    const m = stmt.match(/\r?\n\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)\s*$/);
    if (!m) break;
    stmt = stmt.slice(0, m.index).trimEnd();
  }
  // JS/TS 的 CommonJS：`require('x')` / `const x = require('x')` / TS 的 `import x = require('x')`
  // —— 直接取引号里的路径（实测 axios：TS 的 import-equals 会被 `=` 分支切成 "require('axios')" 这种垃圾）
  const cjs = stmt.match(/^(?:(?:const|let|var|import)\b[^=]*?=\s*)?require\s*\(\s*['"]([^'"]+)['"]\s*\)/)
    || stmt.match(/^require\s*['"]([^'"]+)['"]/);   // Lua 的 `require "cjson"` / `require"cjson"`（无括号、甚至无空格）
  if (cjs) return [cjs[1]];
  // Zig 的 `@import("std")` / `@import("util.zig")`（zls 实测：102 个文件一条 import 也采不到）
  const zig = stmt.match(/^@import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  if (zig) return [zig[1]];
  // C/C++：#include <stdio.h> / #include "x.h"
  const inc = stmt.match(/^#\s*include\s*[<"]([^>"]+)[>"]/);
  if (inc) return [inc[1]];
  // **单行别名导入**：Go 的 `import pb "go.etcd.io/etcd/api/v3/etcdserverpb"`。
  // 已有那条 `^import\s*\(…\)` 只管**括号块**，单行这种落到最后的通用分支 →
  // 剥掉 import 后剩 `pb "path"`，取最后一段就成了 `pb "path"`（别名 + 引号都留着，
  // 整条 import 永远对不上任何目标）。实测 etcd / grpc-go / prometheus 共 8 条。
  // 别名（`pb` / `_` / `.`）对"指到哪个包"没有意义，要的就是引号里那个路径。
  const aliased = stmt.match(/^import\s+(?:[A-Za-z_][\w.]*|[_.])\s+(['"])([^'"]+)\1/);
  if (aliased) return [aliased[2]];
  const py = stmt.match(/^from\s+([^\s]+)\s+import/i);
  if (py) return [py[1]];
  // Go 的括号块导入：逐行拆（`import ( "crypto/subtle"\n"fmt" )`）。
  // 别名（`_ "embed"` / `f "fmt"`）与行尾 `// 注释` 都认：先剥注释、再取本行引号串。
  const blk = stmt.match(/^import\s*\(([\s\S]*)\)\s*(?:\/\/[^\r\n]*)?$/);
  if (blk) {
    const out = [];
    for (const line of blk[1].split(/\r?\n/)) {
      for (const q of line.replace(/\/\/.*$/, '').match(/"[^"]*"|'[^']*'/g) || []) {
        const v = q.slice(1, -1).trim();
        if (v) out.push(v);
      }
    }
    return out;
  }
  // Rust / PHP 的 `use a::{b, c::{d, e}, f as g, self}` 树：一个节点里挂着好几条路径，要展开
  if (/^use\s/.test(stmt) && /[{}]/.test(stmt)) {
    const body = stmt.replace(/^use\s+/, '').replace(/;+$/, '').trim();
    const expanded = expandUseTree(body);
    if (expanded.length) return expanded;
  }
  // 点号花括号树：Scala 的 `import a.{b, c}` / Elixir 的 `alias Foo.{A, B}` → 展开成每条完整路径
  //（akka 实测：30,341 条 import 里 1,859 条是这种碎片「{…」）
  if (/\.\{/.test(stmt.replace(/\s+/g, ''))) {
    const body = stmt.replace(/^(?:import|alias|use|require|from|open|using|package)\s+/, '').replace(/[;,]+$/, '').trim();
    const parts = expandUseTree(body).filter(Boolean);
    if (parts.length) return parts;
  }
  let t = stmt.replace(/;+$/, '').replace(/^global\s+/, '');
  t = t.replace(/^(using|import|package|require|from|use|namespace)\s+/, '');
  t = t.replace(/^(static|type)\s+/, '');
  const eq = t.indexOf('=');
  if (eq >= 0) t = t.slice(eq + 1);
  t = t.trim();
  const m = t.match(/from\s+['"]([^'"]+)['"]/) || t.match(/^['"]([^'"]+)['"]$/);
  if (m) t = m[1];
  // 折换行：import 是**单行概念**，留着换行只会让下游的字符串比对（moduleKey / 前缀匹配）失配。
  // 实测 aspnetcore：`using X = CSharpCodeFixVerifier<\n    …Analyzer,\n    …Fixer>;` 采出来带换行，
  // 谁也认不出它（24 条）。折成空格是对"声明本身跨行写的"最保守的处理（不猜、不合并）。
  return [t.split(',')[0].trim().replace(/\s+as\s+\S+$/i, '').replace(/\s+/g, ' ')];
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
    // 参数表后面紧跟的"类型节点"（Kotlin 的 : Double、TS 的 : void、GraphQL 的字段类型）
    const sibs = node.namedChildren;
    for (let i = sibs.indexOf(pnode) + 1; i > 0 && i < sibs.length; i++) {
      if (TYPE_TYPES.has(sibs[i].type)) { rnode = sibs[i]; break; }
    }
  }
  if (!rnode) {
    // C# 的字段类型挂在里面那层：field_declaration → variable_declaration(type) → variable_declarator
    // （外面那层没有 type 字段，所以字段连类型也拿不到）
    const wrap = node.namedChildren.find((c) => c.type === 'variable_declaration' || c.type === 'variable_declarator');
    const tc = wrap && wrap.childForFieldName('type');
    if (tc) rnode = tc;
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
 * 文件头注释 → 一行摘要（“半句话”）：给 list / file 用。
 * AI 实测反馈：定向阶段最缺的是“这文件是干什么的”，而注释里恰好写着 —— 图的性价比在这里倒挂。
 * 认法：根节点下、第一个**非注释节点之前**的第一段注释（shebang 跳过）；取它第一行有内容的文字。
 */
function headerDocOf(tree) {
  let text = null;
  for (const c of tree.rootNode.namedChildren) {
    if (c.type === 'hash_bang_line') continue;
    if (c.type.includes('comment')) { if (!text) text = c.text; continue; }
    break;
  }
  if (!text) return null;
  const line = text.split('\n')
    .map((l) => l.replace(/^[\s/*#<!%-]+/, '').replace(/[\s*/%>-]+$/, ''))
    .find((l) => l.length > 2 && !/^[-=*]{3,}$/.test(l));
  if (!line) return null;
  return line.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * 数一棵语法树里的 ERROR 节点（不递归进 ERROR 内部，避免嵌套放大；与 extractFile 里
 * `facts.errors` 的口径**刻意不同**——这里要的是"这份源码解析得有多差"的可比较量）。
 * 用途：C# 的 async 兜底改写只在这条数**真的下降**时才采纳（见 extractFiles）。
 */
function countErrorNodes(node) {
  if (node.type === 'ERROR') return 1;
  let n = 0;
  for (const c of node.namedChildren) n += countErrorNodes(c);
  return n;
}

/**
 * 提取一个文件的全部事实。
 * @returns {{types: object[], imports: string[], refs: object[], namespaces: string[], commentRows: number, decisions: number}}
 */
function extractFile(source, tree, lang, fileRel) {
  const lines = source.split(/\r?\n/);
  const mask = new Uint8Array(lines.length);
  const types = [];
  const imports = [];
  const refs = [];
  const comments = [];
  // Dart 的 export 转出的**包名**（父进程据此建包级重导出图，多跳 barrel）
  const reexports = [];
  // Dart 的 `part of` 目标（库文件 uri；父进程据此建 part 库组）
  let partOf = null;
  // 引用**次数**（2026-09-20）：每一个 (owner, 名字) 出现过几次就记几次。
  // 之前这里是两个 Set，只记"出现过没有" → 边的权重恒为 1（"A 引用了 B 3 次" 这个信息被去重丢了）。
  // 用 Map：既当计数器，又天然保持"首次出现顺序"（跟原来 push 的顺序一模一样）。
  const refCount = new Map();        // `${ownerIndex}|${name}` -> { owner, name, n }
  const fileRefCount = new Map();    // 文件级（没有类型归属）的那些：name -> n
  // 参数名所在的标识符节点（这些不当"引用"算）
  const skipIds = new Set();
  // ① 调用 / 成员访问的“位置”记录（每行同一个名字只记一次）：`${ownerIndex}|${name}|${line}|${kind}` -> entry
  const useSeen = new Map();
  const fileUses = [];            // 没有类型归属的（脚本的顶层代码）—— 挂到后面合成的 module 节点上
  function noteUse(node) {
    if (skipIds.has(node.id)) return;                     // 参数名之类不算
    const k = sourceUseKind(lines, node);
    if (!k) return;
    const name = node.text;
    const line = node.startPosition.row + 1;
    const c = k === 'call' ? 1 : 0;
    const t = currentType();
    if (!t) {
      if (!fileUses.some((u) => u.n === name && u.l === line && u.c === c)) fileUses.push({ n: name, l: line, c });
      return;
    }
    const key = `${t.index}|${name}|${line}|${c}`;
    if (!useSeen.has(key)) useSeen.set(key, { t: t.index, n: name, l: line, c });
  }
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

  // 各语言里“算引用”的节点名：默认 identifier / type_identifier；
  // 个别语言要在配置里加（PHP 的类型引用是 name、Ruby 的类引用是 constant）
  const refTypes = new Set(['identifier', 'type_identifier', ...(lang.refTypes || [])]);

  /**
   * 给一个节点造类型记录（不入栈、不递归）。
   * `nsOverride` 用于"既是作用域又是节点"的模块：**模块自己**的限定名不该带上它自己
   * （`module X` 的 fqn 是 `X` 而不是 `X.X`），而它的成员才享受带前缀的待遇。
   */
  function addTypeNode(node, lang, kind, nsOverride, extra) {
    // 名字取不到就**不造节点**（返回 null，由 emitType 决定要不要继续往下走）。
    // 以前这里兜底成 `'(anonymous)'`：对 C# / Java 那种"匿名类型也是实体"的语言是对的，
    // 但对 Markdown 不行 —— 文件开头的 YAML frontmatter 会被包成一个无标题 `section`，
    // 兜底会在图上凭空多出一个名叫 "(anonymous)" 的节。所以：**只有语言自己声明了
    // 匿名兜底（`anonymousName`）才造**，其余一律当"不是个节点"。
    const nm = nameOf(node, lang);
    if (!nm && !lang.anonymousName) return null;
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
      name: nm || '(anonymous)',
      kind: (lang.typeKindFn && lang.typeKindFn(node)) || kind,
      ns: nsOverride !== undefined ? nsOverride : (nsStack.join('.') || fileNamespace),
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
    // `extra`：给"按需候选"带内部标记（`onDemand` / `hasModulePrefix`）。不写进 bundle。
    if (extra) Object.assign(rec, extra);
    return rec;
  }

  /**
   * 发出一个**按需候选**节点（OCaml 的 `value_definition` / `value_specification`）。
   *
   * 为什么单独一条路：OCaml 的模块里值远多于类型（实测某项目 `.mli` 里 val 14,869 / type 10,247），
   * 而值**才是函数级跨模块依赖的目标**（`Env.normalize`、`List.iter`）。但**全量**给值发节点会：
   *   · 图上多 53,074 个节点（3.6 倍）
   *   · 其中 90% 根本没有任何边指向它（实测只有 5,531 个出现在边里）
   *   · 还有 8.5% 是模式解构/解析残缺的垃圾名（`(n', b)`、`()`、`(let+)`）
   * 所以标 `onDemand`，由父进程在**建符号表之前**只保留"被某个限定名引用指到"的那些
   * （见 pruneOnDemandTypes）。这样图几乎不涨，且没有一个垃圾节点。
   *
   * 只在**命名空间里**的值才发：顶层值没有模块前缀可引用（`Env.normalize` 这种才是跨文件依赖）。
   *
   * ⚠ 这里**只造节点、压栈，不递归子树**，返回压栈的那个 rec（可能是 null）。
   * 调用方（member 分支）随后会走一遍子树 —— 那正是"这个值内部的引用归属它"想要的。
   * 曾经这里调的是 `emitType(node, …)`，而 `emitType` 自己会递归走子树，于是调用方又走一遍：
   * **每个 `value_definition` 的整棵子树被走两遍**（实测：同一文件内重复 fqn 6,321 个节点、
   * 图里 29% 的 OCaml 节点是重复的；`let` 里的引用权重也翻倍）。别再改回去。
   */
  function emitOnDemandValue(node) {
    if (!lang.onDemandTypes) return null;
    const kind = lang.onDemandTypes[node.type];
    if (!kind) return null;
    if (!nsStack.length) return null;                  // 顶层值不可能被 `Module.x` 指到
    const name = nameOf(node, lang);
    if (!name || !/^[a-z_][A-Za-z0-9_']*$/.test(name)) return null;   // 顺手挡掉模式解构等垃圾名
    // `hasModulePrefix`：这个节点**可能**被 `Module.x` 这种限定名指到（它自己就在模块里）。
    // 父进程据此判"要不要为它保留节点"—— 是个结构事实，不用去猜哪个前缀算模块。
    const rec = addTypeNode(node, lang, kind, undefined, { onDemand: true, hasModulePrefix: true });
    if (rec) typeStack.push(rec);
    return rec;
  }

  /** 造类型记录 + 压栈 + 递归收成员（普通的类型声明走这条） */
  function emitType(node, lang, kind, extra) {
    const rec = addTypeNode(node, lang, kind, undefined, extra);
    // 基类子树不再当引用重复统计
    const baseChildren = new Set();
    for (const field of lang.baseFields || []) {
      const b = node.childForFieldName(field);
      if (b) baseChildren.add(b.id);
    }
    // `rec` 为空 = 取不到名字（`nameOf` 返回空）→ 不造节点，但**仍要往下走**：
    // Markdown 的匿名 section（YAML frontmatter）就包着后面所有有名 section，跳过整棵子树会把它们丢光。
    if (rec) typeStack.push(rec);
    for (const c of node.namedChildren) {
      if (baseChildren.has(c.id)) continue;
      walk(c);
    }
    if (rec) typeStack.pop();
  }

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
      const targets = parseImports(lang.importTextOf ? lang.importTextOf(node) : node.text);
      for (const target of targets) {
        if (!target) continue;
        imports.push(target);
        // Dart：export 'package:Y/…'（impKind === 'export'）→ 记下 Y，父进程会算成包级重导出（多跳 barrel）
        if (impKind === 'export' && target.startsWith('package:')) reexports.push(target.slice(8).split('/')[0]);
      }
      sweepComments(node);
      return;
    }

    // Dart 的 `part of 'x.dart';`（库结构）：一个文件只会有一条，记下就够
    if (lang.partOfOf) {
      const po = lang.partOfOf(node);
      if (po) { partOf = po; return; }
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
        // ⚠ 命名空间节点**自己**通常不成节点（Java/Kotlin 的 package 语句、C# 的 namespace 块都不是类型）。
        // 但 OCaml 的 `module` 是**实体**：既开作用域又是个可被引用的模块。少了它，图上就没有
        // "模块"这个节点了（实测 fixture：类型数 4→3、`Shape` 整个消失）。
        // `namespaceIsType` 标出这类语言；不标的一律保持原行为。
        //
        // 名字的算法要注意：**模块自己**的限定名不该带上它自己（`module X` 的 fqn 是 `X` 而不是 `X.X`），
        // 所以造节点时先把它从栈里摘掉，成员才享受"带模块前缀"的待遇。
        if (lang.namespaceIsType) {
          // 模块**自己**的限定名不带它自己：`module X` 的 fqn 是 `X`，成员才是 `X.t`
          const outer = nsStack.slice(0, -1).join('.') || fileNamespace;
          const rec = addTypeNode(node, lang, lang.types[type] || 'module', outer);
          const baseChildren = new Set();
          for (const field of lang.baseFields || []) {
            const b = node.childForFieldName(field);
            if (b) baseChildren.add(b.id);
          }
          if (rec) typeStack.push(rec);       // rec 可能是 null（取不到名字 → 不造节点），仍要往下走
          for (const c of node.namedChildren) {
            if (baseChildren.has(c.id)) continue;
            walk(c);
          }
          if (rec) typeStack.pop();
        } else {
          for (const c of node.namedChildren) walk(c);
        }
        nsStack.pop();
        return;
      }
    }

    const kind = lang.kindOf ? lang.kindOf(node) : lang.types[type];
    // typedef struct X{} X; 这类写法会让内外两层都命中，内层就不再重复记（但仍会进去收成员）
    const skipParents = lang.typeSkipParent && lang.typeSkipParent[type];
    const parentType = node.parent ? node.parent.type : null;
    if (kind && !(skipParents && parentType && skipParents.includes(parentType)) && (!lang.typeGuards?.[type] || lang.typeGuards[type](node))) {
      emitType(node, lang, kind);
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
      // 同一个节点如果也是"按需候选"（OCaml 的 value_definition），额外发一个**可被限定名引用
      // 命中的节点**；父进程会砍掉没被引用的那些。位置在 bumpMember 之后：成员计数与成员列表的
      // 行为完全不变。
      // ⚠ `emitOnDemandValue` **不递归**，子树由下面这一趟走 —— 它压的栈正是"值内部的引用归属
      //   这个值"需要的。以前这里跟着一个会递归的 `emitType`，于是子树被走了两遍。
      const onDemandRec = emitOnDemandValue(node);
      for (const c of node.namedChildren) walk(c);
      if (onDemandRec) typeStack.pop();
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

    if (refTypes.has(type)) {
      // `refFilter`：按**引用的结构/文本**再筛一道，而不只是按节点类型。
      // 为什么需要它：有些语言里同一个节点类型既承担"跨文件依赖"又承担"局部作用域引用"，
      // 只看类型会把后者当依赖。OCaml 就是标准例子 —— 它的 `*_path` 节点在有模块前缀时是
      // 跨文件引用（`Mach.fundecl`），裸名字时是局部变量/内置类型（`n`、`int`），
      // 而这两者在语法树上**类型相同、父节点也区分不了**。钩子返回 false 表示"这条不算引用"。
      if (!lang.refFilter || lang.refFilter(node)) {
        addRef(node);
        noteUse(node);     // ① 同一处标识符：顺手记下“这个名字在这一行是调用还是成员访问”
      }
    } else if (USE_ID_TYPES.has(type)) {
      // 各语言给“成员名”用的节点名不一样（JS/TS 是 property_identifier、Go/Rust 是 field_identifier…）。
      // ⚠ 只记**位置**，不进 refs —— 进 refs 会改边权重，那是另一个决定。
      noteUse(node);
    }

    for (const c of node.namedChildren) walk(c);
  }

  /**
   * **文件模块当命名空间**（`fileModuleNamespace`）。
   *
   * 语言背景：OCaml 里 `foo.ml` 本身就是一个模块 `Foo` —— 它的顶层定义**就是** `Foo` 的成员，
   * 别的文件写 `Foo.map` 指的就是它。但提取器不知道这件事：`stdlib/list.ml` 顶层的
   * `let map` 会被登记成**裸名** `map`，于是引用 `List.map` 永远对不上（实测 `List.map` 唯一
   * 能精确命中的，只有某个测试文件里显式写的局部 `module List`）→ 783 条边接到 testsuite。
   *
   * 例外：文件顶层**已经**有同名模块时不再加前缀 —— `stdlib/stdlib.ml` 里有 `module List = List`
   * （重导出别名），那时候 `List` 已经是根层名字，再加文件前缀会变成 `Stdlib.List`，反而错。
   */
  const fileModuleNs = () => {
    if (!lang.fileModuleNamespace) return null;
    const stem = String(fileRel || '').replace(/\.[^.]+$/, '').split('/').pop();
    if (!stem || !/^[A-Za-z_][A-Za-z0-9_']*$/.test(stem)) return null;
    const cap = stem.charAt(0).toUpperCase() + stem.slice(1);
    // 顶层已存在同名模块（`module List = …`）→ 不加前缀（那是显式的根层名）
    for (const c of tree.rootNode.namedChildren) {
      if (c.type !== 'module_definition') continue;
      const nm = nameOf(c, lang);
      if (nm && nm.toLowerCase() === stem.toLowerCase()) return null;
    }
    return cap;
  };

  const fns = fileModuleNs();
  if (fns) nsStack.push(fns);
  walk(tree.rootNode);
  if (fns) nsStack.pop();
  for (const r of refCount.values()) refs.push(r);
  for (const [name, n] of fileRefCount) fileScope.refs.push({ name, n });
  if (process.env.CA_DEBUG_REFS && lang.id === process.env.CA_DEBUG_REFS) {
    console.error(`[REFS] ${(refs || []).slice(0, 12).map((r) => `${r.name}×${r.n}`).join('  ')}`);
  }
  return { types, imports, reexports, partOf, fileDoc: headerDocOf(tree), refs, uses: [...useSeen.values()], fileUses, namespaces: [...namespaces], mask, lines, errors, fileScope };
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
    const part = { rel: f.rel, lang: f.lang.id, ns: null, types: [], refs: [], uses: [], file: null };
    const parser = await getParser(f.lang);
    let source = f.lang.preprocess ? preprocess(rawSource, f.lang.preprocess) : rawSource;
    let tree = parser.parse(source);
    // C# 兜底：`async` 当标识符（`bool async` 参数）时语法包会把它当修饰符关键字，
    // **整个文件塌进一个 ERROR 节点**（实测 efcore 454 个文件、aspnetcore 51 个 —— 那些文件在图上
    // 几乎是隐形的：0 个类 / 0 个方法）。改名重解析一次，**只在真的减少 ERROR 时才采纳** ——
    // 判据是"数出来的 ERROR 总数"，不是"根节点有没有错"（后者对新旧两份都成立，分不出好坏）。
    if (f.lang.id === 'csharp' && source.includes('async')) {
      const before = countErrorNodes(tree.rootNode);
      if (before > 0) {
        const renamed = csharpAsyncIdentifier(source);
        if (renamed !== source) {
          const tree2 = parser.parse(renamed);
          const after = countErrorNodes(tree2.rootNode);
          if (after < before) { tree.delete?.(); tree = tree2; source = renamed; }
          else tree2.delete?.();
        }
      }
    }
    const facts = extractFile(source, tree, f.lang, f.rel);
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
        // 按需候选的内部标记必须**原样带过去** —— 漏了这两个键，父进程的 pruneOnDemandTypes
        // 就认不出候选，裁剪静默失效（实测踩过：`Env.unused` 这种没被引用的值也留在了图上）。
        ...(t.onDemand ? { onDemand: true, hasModulePrefix: !!t.hasModulePrefix } : null),
        fanIn: 0,
        fanOut: 0,
        tags: GENERATED_NAME_RE.test(t.name) ? ['compiler-generated'] : [],
      });
      for (const r of facts.refs) {
        if (r.owner === t.index) part.refs.push({ t: id, name: r.name, n: r.n });
      }
      for (const u of facts.uses) {
        if (u.t === t.index) part.uses.push({ t: id, n: u.n, l: u.l, c: u.c });
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
        // 文件级包 / 命名空间（Go 的 `package gin`、PHP 的 `namespace Foo`、Java/Kotlin 的 package）：
        // 合成的 module 节点也是这个包里的一员。ns 留空会让「同包」这一档认不出来 ——
        // gin 实测：跨文件引用里一大半是**同包互引**（Go 同目录的文件互相引不需要 import），
        // 却全塔成“仅同名”（有支撑 0% 的构成里它们占大头）。
        ns: f.lang.namespaceScope === 'file' && facts.namespaces.length === 1 ? facts.namespaces[0] : '',
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

    // ① 文件级（类型之外）的调用位置：挂到**文件**上，不管有没有合成 module 节点 ——
    // 脚本末尾的 `main()`、`if __name__ == '__main__'` 这类调用都在这里，丢了就变成“没人调用它”
    if (facts.fileUses.length) part.fileUses = facts.fileUses;

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
    if (facts.reexports.length) part.file.reexports = facts.reexports;
    if (facts.partOf) part.file.partOf = facts.partOf;
    if (facts.fileDoc) part.file.doc = facts.fileDoc;
    if (isTestPath(f.rel)) part.file.isTest = true;
    part.ns = facts.namespaces;
    parts.push(part);
  }
  return { files: parts, failures };
}

/**
 * 按**路径**认“测试文件”：引擎没有比这更聪明的办法 —— 大多数语言里测试就是普通函数，语法树上分不出来。
 * 规则就这几条，宁可漏也不硬猜：
 *   · 目录段（任意层级）：`test` / `tests` / `__tests__`
 *   · 文件名：`.test.` / `.spec.` / `_test.` / `_spec.`（扩展名之前）
 *   · 文件名以 `test_` 开头（Python 的 `test_*.py` 惯例）
 * 故意**不认** `spec/` 这个目录名：它很常常是 API 规范（OpenAPI 之类）而不是测试，认了会误报；
 * 而 Jasmine / RSpec 风格的文件靠文件名 `.spec.` / `_spec.` 已经能抓住。
 * 同样**不做** `fixtures` / `__fixtures__` 目录的特判（试过、已撤）：那类目录一般放样例数据，
 * 但“要不要算测试”是因项目而异的判断 —— 写进分类器就成了“按某一个项目调的规则”，而且会**静默**
 * 把一批文件从名单里划掉。宁可让名单带点噪音（本项目自扫 54 个里有 53 个是 tests/fixtures 语料），
 * 也不替读者做这个决定。
 * 结果写进 files[].isTest，**只在是测试时才带这个键**（没有这个键 = 不是测试，或者 bundle 是老版本扫的）。
 */
function isTestPath(rel) {
  const segs = String(rel || '').replace(/\\/g, '/').split('/');
  const base = segs.pop() || '';
  if (segs.includes('test') || segs.includes('tests') || segs.includes('__tests__')) return true;
  if (!base) return false;
  // 只切**最后一个**扩展名：`foo.test.js` 要留 `foo.test` 才能匹配上 `.test.`
  //（`component.test.mjs` / `handler_test.go` / `foo_spec.rb` 都对）
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  return /[._](test|spec)$/i.test(stem) || /^test_/i.test(stem);
}

/** 合并各子进程/缓存的产出：把局部 id 平移到全局 id（文件、类型、parent、refs.owner 都要移） */
function mergeParts(parts) {
  const out = { fileRecs: [], allTypes: [], allRefs: [], allUses: [], fileNamespaces: [], failures: [] };
  for (const p of parts || []) {
    for (const pf of p.files || []) {
      if (!pf) continue;
      const fileId = out.fileRecs.length;
      const tOff = out.allTypes.length;
      if (pf.file) {
        const rec = { ...pf.file, id: fileId, types: (pf.file.types || []).map((t) => t + tOff) };
        if (pf.fileUses?.length) rec.uses = pf.fileUses;    // ① 文件级（类型之外）的调用位置
        out.fileRecs.push(rec);
      }
      for (const t of pf.types || []) {
        out.allTypes.push({ ...t, id: t.id + tOff, file: fileId, parent: t.parent == null ? null : t.parent + tOff });
      }
      // n = 这个"解析前的名字"在同一个 owner 里被引用了几次（权重就是从这里来的）
      for (const r of pf.refs || []) out.allRefs.push({ owner: r.t + tOff, name: r.name, n: r.n || 1 });
      for (const u of pf.uses || []) out.allUses.push({ owner: u.t + tOff, n: u.n, l: u.l, c: u.c });
      out.fileNamespaces.push(pf.ns || {});
    }
    out.failures.push(...(p.failures || []));
  }
  return out;
}

/**
 * 裁剪"按需候选"节点：只保留**真被限定名引用指到**的那些（OCaml 的值/成员）。
 *
 * 为什么需要：全量给值发节点会让图涨 3.6 倍，而其中 90% 没有任何边指向它（实测 53,074 个里
 * 只有 5,531 个出现在边里），还混着 8.5% 的模式解构垃圾名。按需保留后图几乎不涨、且没有垃圾节点。
 *
 * ⚠ 这个函数**只有存在候选节点时才会做任何事**（`hadAny` 为假直接原样返回），所以别的语言
 * （没有 `onDemandTypes`）走的是同一条老路径、行为一模一样。
 *
 * 判定"真被指到"用的是**结构事实**：一个名字里带 `.` 的引用，只可能命中带模块前缀的目标
 * （`hasModulePrefix`）—— 与语言无关，不用去猜"哪个前缀算模块"。
 */
function pruneOnDemandTypes(merged) {
  const all = merged.allTypes || [];
  let hadAny = false;
  for (const t of all) if (t.onDemand) { hadAny = true; break; }
  if (!hadAny) return merged;                      // 没有候选 → 原样返回（零影响）

  // ① 会被限定名指到的名字：`Env.normalize` 这种
  const reachable = new Set();
  for (const r of merged.allRefs || []) {
    if (typeof r.name === 'string' && r.name.includes('.')) reachable.add(r.name);
  }
  const isReachable = (t) => {
    if (!t.hasModulePrefix) return false;
    for (const n of reachable) {
      if (n === t.fqn || n.endsWith(`.${t.fqn}`)) return true;
    }
    return false;
  };

  const keep = new Array(all.length).fill(true);
  let removed = 0;
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    if (t.onDemand && !isReachable(t)) { keep[i] = false; removed++; }
  }
  if (!removed) return merged;

  // ② 重编 id（删了节点就必须搬，否则 refs.owner / file.types / parent 全部错位）
  const map = new Array(all.length).fill(-1);
  let next = 0;
  for (let i = 0; i < all.length; i++) if (keep[i]) map[i] = next++;

  // ③ 被剪掉的节点**身上的引用与调用位置不能跟着丢**。
  //    它们多半是"函数体内部的依赖"（`let map f l = … fold_left …` 里的 `fold_left`）——
  //    丢掉等于把这门语言的函数级依赖挖掉一大块；调用位置丢了，`refs("成员名")` 就会少答
  //    一批 `文件:行`。做法：归属**上移到最近一个活着的祖先**（通常是所在模块 / 文件模块）：
  //    粒度变粗，但依赖与位置都留住了。
  //    ⚠ 这里以前是 `.filter((r) => keep[r.owner])`（引用直接丢），而 `allUses` 连 id 都
  //      没重映射（剪掉 N 个节点后，所有 owner 一律偏 N，位置挂到别的类型身上）。
  //      当时看不出来，是因为 `emitOnDemandValue` 会递归走一遍子树、member 分支再走一遍，
  //      **第二遍的归属正好落在没被剪的外层节点上**，等于一直在替这两个 bug 兜底。
  //      修掉重复走树之后，`ocaml-cross` 那道门立刻变红，才把它们露出来。
  //    顶层值没有祖先（`let go` 在文件顶层时 `parent` 还是 null —— 那个"文件模块"节点是
  //    **事后**合成的，发节点时还不存在），这时落到**同一文件的那个合成 module 节点**上：
  //    它的判别特征很干净 —— `fqn` 就等于文件的相对路径（见上面合成处 `fqn: f.rel`），
  //    而 OCaml 顶层 `let` 的 fqn 是 `Use.go` 这种，不会撞。
  const fileModuleIdx = new Map();
  for (let i = 0; i < all.length; i++) {
    if (!keep[i]) continue;
    const t = all[i];
    const p = merged.fileRecs?.[t.file]?.path;
    if (p && t.fqn === p) fileModuleIdx.set(t.file, i);
  }
  const upTo = (i) => {
    let p = all[i] ? all[i].parent : null, guard = 0;
    while (p != null && !keep[p] && guard++ <= all.length) p = all[p] ? all[p].parent : null;
    if (p != null && keep[p]) return p;
    const t = all[i];
    const fm = t ? fileModuleIdx.get(t.file) : null;
    return fm == null ? null : fm;
  };
  const remapOwner = (o) => {
    if (o == null) return null;
    if (keep[o]) return map[o];
    const up = upTo(o);
    return up == null ? null : map[up];
  };

  const newTypes = [];
  for (let i = 0; i < all.length; i++) {
    if (!keep[i]) continue;
    const t = all[i];
    const nt = { ...t, id: map[i] };
    if (nt.parent != null) nt.parent = map[nt.parent] ?? null;
    delete nt.onDemand;                            // 内部标记，不写进 bundle
    newTypes.push(nt);
  }
  merged.allTypes = newTypes;
  merged.allRefs = (merged.allRefs || [])
    .map((r) => { const o = remapOwner(r.owner); return o == null ? null : { ...r, owner: o }; })
    .filter(Boolean);
  merged.allUses = (merged.allUses || [])
    .map((u) => { const o = remapOwner(u.owner); return o == null ? null : { ...u, owner: o }; })
    .filter(Boolean);
  for (const f of merged.fileRecs || []) {
    if (f.types) f.types = f.types.filter((i) => keep[i]).map((i) => map[i]);
  }
  return merged;
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

/**
 * 仓库自身的包（清单列表 → 名字 + 包目录）。扫描期与读期共用（匹配规则在 modules.mjs）：
 *   · package.json 的 name —— JS/TS 的“包名自引用”（ant-design 的 demo 写 `import { Button } from 'antd'`）
 *   · Cargo.toml 的 [package] name —— Rust 的跨 crate 引用（`grep_matcher::Matcher`；crate 名把 `-` 写成 `_`）
 *   · go.mod 的 module —— Go 的模块路径（`github.com/gin-gonic/gin/render`）
 * 2026-09-23（AI 实测反馈）：清单列表改由 collectFiles 统一收集（它遵守跳过规则）——
 * 以前这里自己走全树、把遇到的**每个文件**都读进内存（图外 4 万多个样本文件也读），
 * 而且不遵守跳过规则（图外的 176 个包名会泄进图内，给图内的边错发“有支撑”）。现在只处理**图内**的清单。
 */
function discoverPackages(manifests) {
  const out = [];
  const seen = new Set();
  const push = (name, dir) => {
    const n = String(name || '').trim();
    if (!n) return;
    const key = `${n}|${dir}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: n, dir });
  };
  for (const m of manifests) {
    const pkgDir = path.posix.dirname(m.rel) === '.' ? '' : path.posix.dirname(m.rel);
    let txt = '';
    try { txt = fs.readFileSync(m.abs, 'utf8'); } catch { continue; }
    if (m.name === 'package.json') {
      try { push(JSON.parse(txt).name, pkgDir); } catch { /* 解析不了就跳过 */ }
    } else if (m.name === 'Cargo.toml') {
      const sec = txt.match(/\[package\]([\s\S]*?)(?:\r?\n\[|$)/);
      const mm = sec && sec[1].match(/\bname\s*=\s*"([^"]+)"/);
      // Rust 代码里 crate 名把 `-` 写成 `_`（Cargo.toml 写 grep-matcher，代码里是 grep_matcher）
      push(mm ? mm[1].replace(/-/g, '_') : '', pkgDir);
    } else if (m.name === 'go.mod') {
      const mm = txt.match(/^\s*module\s+(\S+)/m);
      push(mm ? mm[1] : '', pkgDir);
    } else if (m.name === 'pubspec.yaml') {
      // Dart：包名写在 pubspec.yaml 的第一层（name: riverpod）—— import 里写作 package:riverpod/…
      const mm = txt.match(/^name:\s*([^\s#]+)/m);
      push(mm ? mm[1] : '', pkgDir);
    } else if (m.name === 'Package.swift') {
      // Swift：模块名通常与包名同名（`import Alamofire`）—— SwiftPM 的清单也是 Swift 代码，粗暴取第一个 name
      const mm = txt.match(/\bname\s*:\s*"([^"]+)"/);
      push(mm ? mm[1] : '', pkgDir);
    }
  }
  return out;
}

/**
 * ③b TS / JS 的**路径别名**（tsconfig.json / jsconfig.json 的 compilerOptions.paths + baseUrl）：
 * `@/components/VX` 这类 import 得按 tsconfig 的映射换成仓库内路径才比得上 —— 实测 vuetify：
 * 5,908 条跨文件引用只有 38% 有支撑，剩下的大多是 `@/…` / `@vuetify/…` 别名对不上。
 * 只收**解析得动**的 tsconfig（JSON 里带注释也认，去注释再 parse；真解析不了就跳过，不猜）。
 * 2026-09-23：清单同样来自 collectFiles（遵守跳过规则）—— 图外样本库的 tsconfig 不再泄进图内。
 */
function discoverPathAliases(manifests) {
  const out = [];
  const seen = new Set();
  for (const m of manifests) {
    if (m.name !== 'tsconfig.json' && m.name !== 'jsconfig.json') continue;
    let txt = '';
    try { txt = fs.readFileSync(m.abs, 'utf8'); } catch { continue; }
    // JSONC：去块注释 / 行注释 / 尾逗号再 parse（tsconfig 实际就是 JSONC）
    const cleaned = txt
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"'\\])\/\/[^\n]*/g, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    let j;
    try { j = JSON.parse(cleaned); } catch { continue; }
    const co = j.compilerOptions || {};
    const base = String(co.baseUrl || '.').replace(/\\/g, '/');
    const dirRel = path.posix.dirname(m.rel) === '.' ? '' : path.posix.dirname(m.rel);
    // 压掉 '.' / './' / 连续斜杠（tsconfig 里 baseUrl 常写成 './' / '../'）
    const joinRel = (p2) => [dirRel, base, p2].join('/').split('/').filter((s) => s && s !== '.').join('/');
    for (const [k, v] of Object.entries(co.paths || {})) {
      if (!k.endsWith('*') || !Array.isArray(v)) continue;
      for (const target of v) {
        if (typeof target !== 'string' || !target.endsWith('*')) continue;
        const prefix = k.slice(0, -1);
        let dir2 = joinRel(target.slice(0, -1));
        if (dir2.endsWith('/')) dir2 = dir2.slice(0, -1);
        if (!prefix || !dir2) continue;
        const key = `${prefix}|${dir2}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ prefix, dir: dir2 });
      }
    }
  }
  return out;
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
  // 项目自己的跳过规则：atlas.ignore（存在才生效）+ .gitignore（**默认读**，--no-gitignore 关）
  const ignoreRules = loadIgnoreRules(roots, { gitignore: opts.gitignore !== false });   // 默认读；opts.gitignore === false 才关
  const { files, skipped, manifests } = collectFiles(roots, { languages, maxKb, excludes, budget: opts.fileBudget, ignoreRules });
  // ③ 仓库自身的包名（package.json 的 name → 包目录）：解释/生成两侧的“包名自引用”都用（见 modules.mjs）
  // （清单来自 collectFiles —— 遵守跳过规则，图外的包不再泄进图内）
  const packages = discoverPackages(manifests);
  // ③b TS/JS 的路径别名（tsconfig/jsconfig 的 paths）—— 同一套 ctx 一起传下去
  const aliases = discoverPathAliases(manifests);

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
  // 持续扫描（--watch）把本趟信息带进来：把增量统计补全（MCP 读侧靠它提示 AI“图刚更新过、重解析了多少”）
  if (opts.watchInfo) {
    opts.watchInfo.reparsed = freshFiles.length;
    opts.watchInfo.reused = reused.size;
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
    let spawnErrorShown = false;   // 子进程起不来只报一次（AI 实测反馈：30 门语言各刷一行“退出码 null”没法看）
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
        if (r.error) {
          // 子进程**起不来**（EPERM / ENOENT 这类）：一次说清“引擎跑不起来”，不是你的代码问题（AI 实测反馈）
          const code = String(r.error.code || r.error.message || 'spawn 失败');
          if (!spawnErrorShown) {
            spawnErrorShown = true;
            console.log(t(`  ⚠ 起不了解析子进程（${code}）—— 引擎在当前环境跑不了解析（不是你的代码问题）；后面的语言不再逐门重复`,
              `  ⚠ Cannot spawn the parse child process (${code}) — the engine cannot run here (not your code's fault); no per-language repeats`));
          }
          failedLanguages.push({ lang: langId, files: (byLang.get(langId) || []).length, reason: `子进程起不来（${code}）`, spawn: true });
        } else {
          console.log(t(`  ⚠ ${langId} 没解析成功（子进程退出码 ${r.status}）—— 这门语言这次不进地图。${tail ? `子进程最后一句：${tail.slice(0, 200)}` : ''}`, `  ⚠ ${langId} failed to parse (child exit code ${r.status}) — this language is not in the map this time. ${tail ? `Last line from the child: ${tail.slice(0, 200)}` : ''}`));
          failedLanguages.push({ lang: langId, files: (byLang.get(langId) || []).length, reason: tail || `子进程退出码 ${r.status}` });
        }
      }
      // 注意：子进程是 SIGKILL 硬退的（绕开退出阶段的 libuv 断言），所以**成功时退出码也是 1**。
      // 不要用“退出码非 0”去判定失败，也不要据此打日志（否则每门语言都会刷一行）——成败只看 emit。
      // ⚠ 清理必须真的删掉：emit 是本轮的产物，下一门语言（或下一趟扫描）看到旧的 emit 就会把
      // 上一轮的结果当成本轮结果（`fs.rmSync` 在 DSH 自带的 node v24.9.0 上**静默不删**，
      // 见 src/fsx.mjs 的文件头）——所以走 rmFile（删完复查）。
      rmFile(emit);
    }
    rmrf(tmp);
  }

  // 按 collectFiles 的顺序合并（缓存命中的 + 新解析的）：顺序稳定，只改几个文件时 id 不会乱跳
  const byRel = new Map(reused);
  for (const p of freshParts) for (const pf of p.files || []) byRel.set(pf.rel, pf);
  const merged = mergeParts([{ files: files.map((f) => byRel.get(f.rel)).filter(Boolean), failures: freshParts.flatMap((p) => p.failures || []) }]);
  // 按需候选（OCaml 的值）在这里落地：只留"真被限定名指到"的那些，并重编 id。
  // 没有候选的语言此函数直接原样返回，零影响。
  const { fileRecs, allTypes, allRefs, allUses, fileNamespaces, failures } = pruneOnDemandTypes(merged);

  // C/C++ 的 **include 闭包**（≤2 跳）：A include 了 B、B include 了 C → A 也能撑住 C 里的引用。
  // 实测 redis / fmt / ocaml：tsdn_t 这类类型全在被“间接 include”的内部头文件里（jemalloc_internal_includes.h
  // 把内部头文件一把兜进来），光看直接 include 对不上。只对 C/C++ 文件算（其它语言的 import 语义不同），
  // 直接边按“文件名主干唯一对上”建（宁可少不该多），闭包 ≤40 个才带上，避免大仓库里膨胀。
  {
    const cLike = /\.(c|h|cc|cpp|cxx|hpp|hh|hxx)$/i;
    const byStem = new Map();
    fileRecs.forEach((f, i) => {
      if (!f || !cLike.test(f.path)) return;
      const k = moduleKey(f.path).toLowerCase();
      if (!byStem.has(k)) byStem.set(k, []);
      byStem.get(k).push(i);
    });
    const direct = new Map();
    fileRecs.forEach((f, i) => {
      if (!f || !cLike.test(f.path) || !f.imports || !f.imports.length) return;
      const set = new Set();
      const myDir = f.path.slice(0, f.path.lastIndexOf("/") + 1);
      for (const imp of f.imports) {
        if (!/[./]/.test(imp)) continue;
        let hit = byStem.get(moduleKey(String(imp).split('/').pop() || '').toLowerCase());
        if (!hit || !hit.length) continue;
        // 多个同名候选时**同目录优先**（C 的 include 默认先在自身目录找）；仍不唯一就不建边（宁可少）
        // 同名多候选：先按**扩展名**（`decay.h` 别被同目录的 `decay.c` 抢），再按同目录
        if (hit.length > 1) {
          const ext = (String(imp).match(/\.[A-Za-z]+$/) || [''])[0].toLowerCase();
          const sameExt = ext ? hit.filter((j) => fileRecs[j].path.toLowerCase().endsWith(ext)) : [];
          if (sameExt.length) hit = sameExt;
        }
        if (hit.length > 1) hit = hit.filter((j) => fileRecs[j].path.slice(0, fileRecs[j].path.lastIndexOf("/") + 1) === myDir);
        if (hit.length === 1 && hit[0] !== i) set.add(hit[0]);
      }
      if (set.size) direct.set(i, set);
    });
    for (const [i, set] of direct) {
      const out = new Set(set);
      for (const j of set) for (const k2 of direct.get(j) || []) if (k2 !== i) out.add(k2);
      if (out.size && out.size <= 120) fileRecs[i].closure = [...out];
    }
  }
  // Dart 的包级重导出图（多跳 barrel）：flutter_riverpod 转出 riverpod 的类型时，
  // import package:flutter_riverpod/… 也应该能撑住 riverpod 里的目标（实测 riverpod 样本上这是大头）。
  // 闭包最多 3 跳、按包名去重；有环也不会死（seen 去重）。
  {
    const named = packages.filter((x) => x.name);
    if (named.length) {
      const byDir = named.slice().sort((a, b) => (b.dir || '').length - (a.dir || '').length);
      const byName = new Map(named.map((x) => [x.name, x]));
      const direct = new Map();
      for (const fr of fileRecs) {
        if (!fr || !fr.reexports || !fr.reexports.length) continue;
        const owner = byDir.find((x) => !x.dir || fr.path === x.dir || fr.path.startsWith(x.dir + '/'));
        if (!owner) continue;
        let set = direct.get(owner.name);
        if (!set) { set = new Set(); direct.set(owner.name, set); }
        for (const r of fr.reexports) if (byName.has(r)) set.add(r);
      }
      for (const x of named) {
        const seen = new Set();
        const stack = [...(direct.get(x.name) || [])];
        while (stack.length && seen.size < 20) {
          const y = stack.pop();
          if (y === x.name || seen.has(y)) continue;
          seen.add(y);
          for (const z of direct.get(y) || []) stack.push(z);
        }
        if (seen.size) x.exports = [...seen];
      }
    }
  }
  // Dart 的 part 库组（实测 riverpod：67 个 part 文件、10 个库组，未支撑边的大头）：
  //   · part 文件**不能写 import**（语言语义）—— 库文件的 imports 对全库可见 → 挂到 part 的 `libImports`
  //     （读期当 import 支撑算）；
  //   · 同一个库里的文件彼此同作用域，互相引用连 import 都不需要 → 都记上 `lib`（读期按“同库”算支撑）。
  {
    const dartParts = [];
    fileRecs.forEach((fr, i) => { if (fr && typeof fr.partOf === 'string' && fr.partOf) dartParts.push(i); });
    if (dartParts.length) {
      const pkgByName = new Map();
      for (const p of packages) if (p && p.name) pkgByName.set(p.name, p);
      const indexOfPath = new Map();
      fileRecs.forEach((fr, i) => { if (fr) indexOfPath.set(fr.path, i); });
      const groups = new Map();
      for (const i of dartParts) {
        const fr = fileRecs[i];
        const raw = fr.partOf;
        let key;
        if (raw.startsWith('package:')) {
          const [pkgName, ...sub] = raw.slice(8).split('/');
          const p = pkgByName.get(pkgName);
          key = p && p.dir ? `${p.dir}/lib/${sub.join('/')}` : `pkg:${raw}`;
        } else if (raw.includes('/') || raw.endsWith('.dart')) {
          key = path.posix.normalize(path.posix.join(path.posix.dirname(fr.path), raw));
        } else {
          key = `name:${raw}`;   // 旧式 `part of lib.name;`：按库名分组（根文件认不出来的话就只有 part 们互认）
        }
        let g = groups.get(key);
        if (!g) { g = { parts: [] }; groups.set(key, g); }
        g.parts.push(i);
      }
      for (const [key, g] of groups) {
        const rootIdx = indexOfPath.has(key) ? indexOfPath.get(key) : -1;
        const members = [...g.parts];
        if (rootIdx >= 0 && !members.includes(rootIdx)) members.push(rootIdx);
        for (const m of members) fileRecs[m].lib = key;
        const rootImports = rootIdx >= 0 ? (fileRecs[rootIdx].imports || []) : null;
        if (rootImports && rootImports.length) for (const m of g.parts) fileRecs[m].libImports = [...rootImports];
      }
    }
  }

  // ① 把“调用 / 成员访问”的位置挂回各自所属类型（没内容就不带这个键，保持 bundle 精简）
  for (const u of allUses) {
    const t = allTypes[u.owner];
    if (!t) continue;
    if (!t.uses) t.uses = [];
    t.uses.push({ n: u.n, l: u.l, c: u.c });
  }
  // ① 再筛一道：**只留“名字在项目里确实是个成员或类型”的**（父进程才知道全部名字）。
  // 不筛的话每个标识符都留一份位置，体积会翻倍（实测真实样本 0.16 MB → 0.36 MB）。
  // ⚠ 复测报告 §2：**顶层函数（JS/TS/Python）在这套模型里是“类型”不是成员** —— 只留成员名会把它们的
  // 位置全筛掉，于是 `refs("startMcp")` 拿不到“第几行调的”。所以保留集 = 成员名 ∪ 类型名。
  // 仍然筛掉的：纯局部变量 / 外部名（`Assert.Equal` 里的 Equal ），那些在图里本来就没有对应符号。
  {
    const keepNames = new Set();
    for (const t of allTypes) {
      if (t.name) keepNames.add(t.name);
      for (const m of t.memberList || []) if (m.n) keepNames.add(m.n);
    }
    const trim = (holder) => {
      if (!holder.uses) return;
      holder.uses = holder.uses.filter((u) => keepNames.has(u.n));
      if (!holder.uses.length) delete holder.uses;
    };
    for (const t of allTypes) trim(t);
    for (const f of fileRecs) trim(f);
  }

  // ---- 建索引：符号表 ----
  const bySimpleName = new Map();
  for (const t of allTypes) {
    if (!bySimpleName.has(t.name)) bySimpleName.set(t.name, []);
    bySimpleName.get(t.name).push(t.id);
  }

  /**
   * 边上的 `tier`：**这条边是凭什么接上的**（写进 bundle，读侧直接读，不再重算一遍）。
   *
   * 为什么要落这个字段：边是这张图的主数据（web / MCP 的排序、连线、波及面全建在它上面），
   * 而"这条边有多可信"以前只活在两个地方 —— 建图时 `resolveName` 的优先级（用完即弃）、
   * 读图时 `mcp.mjs` 的 `evidenceOf`（把同一套启发式在每条边上**重跑一遍**）。
   * 两份推理链会漂移（modules.mjs 文件头记的就是同类事故：解析时按 A 口径接边、读时说没支撑），
   * 而且读侧永远无法知道"当初是靠哪一档接上的"（唯一命中 / 同命名空间 / import 消歧 走的路径完全不同）。
   *
   * 取值（强 → 弱）：
   *   same   —— 同一个文件里声明的（最强，几乎不可能是巧合）
   *   import —— 有语言层面的依据 —— C# 父命名空间 / Dart part 库 / C-C++ include 闭包 / 同命名空间等
   *             "不需要写 import 也算有依据"的边（见 hasImportBacking）
   *   unique —— 引用名在**候选表里唯一**（不是"名字撞上了"）
   *   name   —— 兜底档（同命名空间 / 同根包近似挑出来的）；同名但挑不出唯一候选，依据最弱
   * 注意 unique 与 name 的区别：前者是"这个名字没有别的候选"，后者是"有多个候选、靠近似挑的"。
   *
   * ⚠ 别用"name 是不是够得着"来判断档位实现对不对：我一度以为它够不着（自扫 0 条、人工构造 6 种语言都没有），
   * 结论是**错的** —— 31 个真样本上 179,732 条边里 `name` 有 2,616 条（约 1.5%）。
   * 真样本里"同名多候选"是存在的（测试类与生产类同名、`Cell`/`Token` 这类通用名），
   * 只是自扫这个小仓库没有。**要验证这类判断，必须跑真样本**（见 工作文档\样本库\复扫.mjs）。
   */
  const TIER_RANK = { name: 0, unique: 1, import: 2, same: 3 };

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
   *
   * 返回值（`import` 与 `evidenced` 只影响档位、不影响挑谁）：
   *   `import: true`    —— 唯一候选 / 靠 import 消歧挑出来的
   *   `evidenced: true` —— 同名候选**都**有 import 依据（挑不出唯一的那个），退回同名档挑出来的，
   *                        但挑中的这个确实有 import 依据 → `tierOf` 仍记 import 档
   * 两者都不带，才落到 unique / name。
   * 返回 `{ id, ... }`；对不上时返回 null。
   * 外层还会按"两端是不是同一个文件"把 tier 升到 same —— 解析路径与边的性质是两件事。
   *
   * ## 限定名（含 `.`）的专门规则
   * 只做**精确匹配**（`fqn` 或 `name` 等于限定名 / 以其 `.限定名` 结尾），匹配不到就放弃 ——
   * **绝不退化成"按叶子名撞"**。理由：引用名里约一半是带点的（实测某真 OCaml 项目 25,345 / 49,660），
   * 而叶子名的候选池动辄几千个（`t` 有 3,406 个）→ 退化会接出 `typing/ctype.ml → List.map@测试文件`
   * 这类错误边，还会把它们记进 `unique` 档（把"猜"标成"有依据"）。实测这一类有 2,893 条。
   * 多候选时再按：① 引用方自己文件里的（OCaml 的局部 `module X`）② 归属锚点（候选的父模块名
   * 等于限定名的最后一段前缀）。都不满足 → 放弃。
   *
   * ⚠ **已知限制（未能解决，如实记）**：跨文件的 `List.map` / `Array.exists` / `Buffer.t` 这类
   * **stdlib 引用**仍可能接错。根因是建模缺口 —— 我们只把**显式** `module List = struct … end` 里的
   * 成员登记成 `List.map`，**从没把"文件模块的成员按文件名登记"**（`stdlib/list.ml` 里的 `map`
   * 是裸名 `map`）。于是 `List.map` 唯一能精确命中的是某个测试文件里的局部 `module List`。
   * 实测：783 条跨文件边的目标落在 testsuite/（引用方都在真源码里）。
   * 要真解决得让**文件模块也当命名空间**（`list.ml` 的成员登记成 `List.*`）—— 那是另一个地基。
   */
  /**
   * **import 依据**：引用方文件里有没有哪条 import 指得到这个候选？
   *
   * 这里必须把**读侧（mcp.mjs 的 evidenceRecomputed）认的那几种依据全覆盖**，否则会出现
   * "扫描时说这条边有依据、读时说没有"的自相矛盾（modules.mjs 文件头记的就是这类事故）。
   * 语言语义上"不需要写 import 也算有依据"的几种：
   *   · C# / VB 的子命名空间引用父命名空间（`Demo.Deep` 用 `Demo.Root`，不需要 using）
   *   · Dart 的 part 文件（part 不能写 import，但它所属库的 imports 对它可见）
   *   · Dart 同库（同一 part 组里的文件同作用域，互相引用连 import 都不需要）
   *   · C/C++ 的 include 闭包（≤2 跳：A include B、B include C ⇒ A 撑得住 C 里的引用）
   * 另外还有一条与 import 无关但同样"有依据"的：**两端同命名空间**。
   *
   * 为什么要单独查一次、而不是只在"同名多候选"时用：**唯一候选也可能有 import 依据**，
   * 而且那个依据比"名字恰好唯一"强得多（前者有语言层面的连接，后者只是这张图里没撞名）。
   * 早先只在多候选分支里查，等于把单候选边的 import 证据整片丢掉（实测：一条 C# 的
   * `using Demo.A;` 引过去的边会被记成"名字唯一"，跟"没有任何依据"挤在同一档）。
   */
  const hasImportBacking = (fromTypeId, toTypeId) => {
    const fromType = allTypes[fromTypeId], cand = allTypes[toTypeId];
    if (!fromType || !cand) return false;
    const fromFile = fileRecs[fromType.file], candFile = fileRecs[cand.file];
    if (!fromFile || !candFile) return false;
    const target = { ns: cand.ns, fqn: cand.fqn, path: candFile.path };
    for (const raw of fromFile.imports || []) if (importMatchesTarget(raw, target, { packages, aliases })) return true;
    // Dart 的 part 文件：库文件的 import 对它可见（part 文件自己不能写 import，这是语言语义）
    for (const raw of fromFile.libImports || []) if (importMatchesTarget(raw, target, { packages, aliases })) return true;
    // C/C++ 的 include 闭包（≤2 跳）
    if (Array.isArray(fromFile.closure) && fromFile.closure.includes(cand.file)) return true;
    // Dart：同一个 part 库组里的文件同作用域
    if (fromFile.lib && candFile.lib && fromFile.lib === candFile.lib) return true;
    // C# / VB：子命名空间不用 using 也能引用父命名空间里的类型
    const candExt = String(candFile.path || '').split('.').pop().toLowerCase();
    if ((candExt === 'cs' || candExt === 'vb') && cand.ns && fromType.ns && fromType.ns.startsWith(`${cand.ns}.`)) return true;
    // 同命名空间（不需要 import 语句就有依据）
    if (cand.ns && fromType.ns === cand.ns) return true;
    return false;
  };

  /**
   * **同一个编译单元的 `.ml` / `.mli` 两个节点，在解析时算同一个符号。**
   *
   * OCaml 里 `foo.ml` 与 `foo.mli` 是**同一个编译单元** `Foo` 的两面（实现 / 接口），
   * 但引擎是按文件各发一份节点的 —— 实测某真项目 **1,558 个 fqn 同时出现在同名的 .ml 与 .mli 里**
   * （3,116 个节点、134 条 ref 边指向它们）。于是 `Hashtbl.statistics` 会同时命中
   * `stdlib/hashtbl.ml` 与 `stdlib/hashtbl.mli` 两个候选，"归属锚点"挑不出唯一（两者的
   * parent 都是 null）—— 按"宁缺勿错"**只能放弃**，那几条边就是这么丢的。
   *
   * 这里把它们**在候选池里合成一个**。判定很紧：同目录 + 同主干 + 扩展名集合恰好是 {.ml, .mli}
   * 且只有两个节点。所以"同名文件散在不同目录"（`asmcomp` 下 5 个 arch 目录各有 arch.ml，
   * 共 10 个节点，那是**不同的**编译单元）不会被误合，同一文件里的重复定义也不会。
   * 选中哪一个：① 引用方自己文件里的（同文件这一档最强）→ ② `.ml`（实现，有成员与行号）。
   *
   * ⚠ 这一层只改**解析**，不改图：图上仍是两个节点，`file('foo.mli')` 照样能列出它声明的类型。
   *   真正"合并成一个节点"是另一个更大的改动 —— 那会让 `.mli` 文件的类型清单变空（读侧得先想清楚
   *   怎么表达"接口与实现是同一个符号"），先记在这里。
   */
  const sameUnitStem = (t) => {
    const p = fileRecs[t.file]?.path;
    if (!p) return null;
    const ext = p.slice(p.lastIndexOf('.'));
    if (ext !== '.ml' && ext !== '.mli') return null;
    return p.slice(0, -ext.length);
  };
  const collapseUnits = (ids, fromFileId) => {
    if (!ids || ids.length < 2) return ids;
    const groups = new Map();
    const out = [];
    for (const id of ids) {
      const t = allTypes[id];
      const k = t ? sameUnitStem(t) : null;
      if (!k) { out.push(id); continue; }
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(id);
    }
    for (const g of groups.values()) {
      const exts = new Set(g.map((id) => String(fileRecs[allTypes[id].file]?.path || '').split('.').pop()));
      if (g.length !== 2 || exts.size !== 2 || !exts.has('ml') || !exts.has('mli')) { out.push(...g); continue; }
      const own = fromFileId == null ? null : g.find((id) => allTypes[id].file === fromFileId);
      if (own != null) { out.push(own); continue; }
      const impl = g.find((id) => String(fileRecs[allTypes[id].file]?.path || '').endsWith('.ml'));
      out.push(impl != null ? impl : g[0]);
    }
    return out;
  };

  const unresolved = { ambiguous: 0, unknown: 0 };
  const resolveName = (name, fromTypeId) => {
    // 限定名（`Env.normalize`、`Mach.fundecl`、`X.t`、`Types.Uid.Tbl.t`）：候选表是按**简单名**建的，
    // 所以必须按完整限定名精确匹配 —— 匹配不上就**放弃**，绝不能退化成"按叶子名撞"。
    //
    // 为什么必须放弃（实测，某真 OCaml 项目）：引用名里 **25,345 / 49,660 种是带点的**，
    // 而退化会去 `bySimpleName.get(叶子)` 里挑 —— 那个池子动辄几千个同名（实测 `t` 有 3,406 个候选）。
    // 于是 `typing/ctype.ml → List.map` 会被接到 `testsuite/…/let_syntax.ml` 里任意一个 `map`，
    // `test.ml → Array.exists` 接到 `stdlib/float.ml` —— 全是**错误边**，而且它们还落在
    // `unique` 档（"名字全图唯一"），等于**把猜的当成有依据的**。这正是项目"宁缺勿错"要避免的。
    // 实测这一类有 2,893 条（占 ocaml 入边的 55%）。
    //
    // 匹配方式：候选的 `fqn` **或** `name` 等于限定名，或以其 `.限定名` 结尾
    // （后者兼容"模块前缀更完整"的登记方式）。同候选多个时优先**引用方自己文件里的**
    // —— `module X` 在 OCaml 里是局部模块，`X.t` 指的就是它。
    if (name.includes('.')) {
      const leaf = name.slice(name.lastIndexOf('.') + 1);
      const from = allTypes[fromTypeId];
      const fromLang = fileRecs[from?.file]?.lang;
      const rawPool = (bySimpleName.get(leaf) || []).filter((id) => {
        // ⚠ **只在同语言内解析限定名**。跨语言的"限定名"没有意义（C 里不会出现 `List.map`），
        // 而名字会撞：C 文件里的函数 `accu` 与 OCaml 的 `Remote_value.accu`、各语言都有的
        // `init`/`length` 之类 —— 实测某真 OCaml 项目上有 866 条 `c -> ocaml` 的边，
        // 全是这么撞出来的（`runtime/interp.c -> Debugcom.Remote_value.accu@debugger/debugcom.ml`）。
        const t = allTypes[id];
        return t && fileRecs[t.file]?.lang === fromLang;
      });
      // `.ml`/`.mli` 是同一个编译单元的两面 → 候选池里先合成一个（见 collapseUnits 的说明）
      const pool = collapseUnits(rawPool, from?.file);
      // 候选按证据强弱分三档，**这三档的先后不能换**（顺序是实测 oss3-ocaml 定下来的）：
      //   ① **同文件**：`module X` 在 OCaml 里常常是文件里的局部模块，本文件里写的 `X.t`
      //      指的就是它 —— 局部模块在作用域里是**确定的**，比任何跨文件推断都硬。
      //   ② **全名命中**：`fqn` 就等于引用名 —— 写 `Int32.t` 命中的就是 `Int32.t`。
      //   ③ **后缀命中**：`fqn` 以 `.引用名` 结尾 —— 兼容"登记的前缀更完整"（`open Types.Uid`
      //      之后写短名 `Tbl.t`，而它登记成 `Types.Uid.Tbl.t`）。这档**必要，不能删**，
      //      但它是三档里最弱的：**别人文件里嵌套的同名模块**也满足它。
      //
      // ②③ 不分档就会出事（实测）：`stdlib/random.mli` 里的 `Int32.t`，候选是
      //   `Int32.t@stdlib/int32.ml` 与 `Int32.t@stdlib/int32.mli`（**两者 parent 都是 null** ——
      //   fileModuleNamespace 只把文件名写进 fqn、不建父模块节点），
      //   以及 `Unbox_under_assign.Int32.t@testsuite/…`（只有这个的 parent 是 `Int32` 模块）。
      // 于是"归属锚点"消歧**只有那个错的能通过校验** —— 锚点规则会反过来系统性偏爱
      //   "别人文件里嵌套的局部模块"，压过真正的文件模块。实测这类接错的边 36 条。
      //
      // ⚠ ① 必须**先于** ②：只按 ②③ 分档、把同文件候选一起踢掉，反而会丢掉对的边
      //   （实测 12 条：`Inline_and_simplify_aux.Result` 里的 `Env.t` 会从本文件的
      //   `Inline_and_simplify_aux.Env.t` 跑到 `typing/env.ml`）。
      const own = allTypes[fromTypeId]?.file;
      const isRoot = (id) => {
        const t = allTypes[id];
        return !!t && (t.fqn === name || t.name === name);
      };
      const isSuffix = (id) => {
        const t = allTypes[id];
        if (!t) return false;
        for (const cand of [t.fqn, t.name]) {
          if (typeof cand === 'string' && cand && cand.endsWith(`.${name}`)) return true;
        }
        return false;
      };
      const sameFileHit = pool.filter((id) => allTypes[id]?.file === own && (isRoot(id) || isSuffix(id)));
      const rootHit = pool.filter(isRoot);
      const exact = sameFileHit.length ? sameFileHit : rootHit.length ? rootHit : pool.filter(isSuffix);
      if (exact.length === 1) {
        const id = exact[0];
        // `uniq: true`：限定名**精确匹配**上了，不是"从多个同名的里近似挑一个"，
        // 所以它不该落最弱的 `name` 档。tier 只影响标签，不影响选边。
        return { id, uniq: true, import: hasImportBacking(fromTypeId, id) };
      }
      if (exact.length > 1) {
        // 走到这儿 = 上面挑中的那一档**内部还有多个**（同名模块在多处定义 —— OCaml 里
        // `module List = …` 可以随便起）→ 再用"归属锚点"挑一次：
        //   `X.y` 里的 y 必然属于某个名叫 X 的**模块**（parent 链）。
        //   OCaml 里 `List.map` 的 `map` 就挂在某个 `List` 模块下面 —— 用这条把"成员属于谁"问清楚，
        //   比按文件主干猜可靠（实测主干法命中不了：图里 19 个叫 List 的模块，没有一个定义在 list.ml）
        // 挑不出唯一 → 放弃（宁缺勿错）
        const modName = name.slice(0, name.lastIndexOf('.')).split('.').pop();
        const owner = (id) => {
          const t = allTypes[id];
          return t && t.parent != null ? allTypes[t.parent] : null;
        };
        const byOwner = exact.filter((id) => {
          const o = owner(id);
          return o && o.kind === 'module' && (o.name === modName || (o.fqn || '').split('.').pop() === modName);
        });
        if (byOwner.length === 1) {
          const id = byOwner[0];
          return { id, uniq: true, import: hasImportBacking(fromTypeId, id) };
        }
      }
      // 到这儿就是"限定名对不上 / 挑不出可信的" —— 计入 unknown 并放弃（宁可缺边，不要接错）
      unresolved.unknown++;
      return null;
    }
    // ⚠ 简单名也**只在同语言内**解析。跨语言的名字匹配没有语义基础（C 里不会"引用" OCaml 的
    // `accu`），而各语言都有 `init` / `length` / `accu` / `type` 这类通用名 —— 实测某真 OCaml 项目上
    // 有 **866 条 `c -> ocaml` 边**全是这么撞出来的（`runtime/interp.c -> Remote_value.accu`）。
    // 真跨语言依赖（FFI / 反编译产物）不靠名字匹配表达，过滤掉只会让图更准。
    const fromLang = fileRecs[allTypes[fromTypeId]?.file]?.lang;
    const hit = collapseUnits((bySimpleName.get(name) || []).filter((id) => {
      const t = allTypes[id];
      return t && fileRecs[t.file]?.lang === fromLang;
    }), allTypes[fromTypeId]?.file);
    // `uniq` = 这个名字在**候选表里就是唯一的**（后面挑候选不会改变这一点）
    if (!hit || !hit.length) { unresolved.unknown++; return null; }
    if (hit.length === 1) {
      // 唯一候选也得看 import：这个档位差很多（有 import 依据 > 只是没撞名）
      const id = hit[0];
      return { id, uniq: true, import: hasImportBacking(fromTypeId, id) };
    }
    const from = allTypes[fromTypeId];
    const sameFile = hit.filter((id) => allTypes[id].file === from.file);
    if (sameFile.length === 1) return { id: sameFile[0] };
    // ③ 复测报告 §1：同名两处 + 第三方调用时，以前**直接放弃**（静默丢边）—— JS 没有命名空间，
    // “同文件”是唯一能救它的一档，救不到就丢；自扫实测 57 处这种被丢掉的引用。
    // 补一档：**用引用方文件的 imports 消歧**（与读期 evidenceOf 同一套口径，见 src/modules.mjs）。
    const viaImport = hit.filter((id) => hasImportBacking(fromTypeId, id));
    if (viaImport.length === 1) return { id: viaImport[0], import: true };
    // ⚠ `viaImport.length > 1` 不等于"没有 import 依据"：候选**都**有依据、挑不出唯一的那一个
    // （典型：import `a.b.X.Something` 经前缀规则同时指得到 `a.b.X` 与 `a.b.X.Something`，
    //  于是引用 `X` 时三个同名候选一起命中）。下面挑出来的候选仍然可能**确实有** import 依据，
    //  此时必须把 `evidenced` 带出去 —— 否则 `tierOf` 只会看到 `{id}`，把有依据的边记成 name 档。
    //  实测 oss3-akka：7 条这样的边（`jdocs.ddata.protobuf.TwoPhaseSetSerializer → jdocs.ddata.TwoPhaseSet` 等）。
    const sameNs = hit.filter((id) => allTypes[id].ns === from.ns);
    if (sameNs.length === 1) return { id: sameNs[0], evidenced: hasImportBacking(fromTypeId, sameNs[0]) };
    const sameRoot = hit.filter((id) => {
      const a = allTypes[id].ns.split('.')[0];
      const b = from.ns.split('.')[0];
      return a && a === b;
    });
    if (sameRoot.length === 1) return { id: sameRoot[0], evidenced: hasImportBacking(fromTypeId, sameRoot[0]) };
    unresolved.ambiguous++;
    return null;
  };

  // ---- 建图：引用 + 继承 ----
  // 权重 = 引用**次数**（同一个 owner 里同名字出现几次）：
  //   · 网页里连线的粗细（stroke-width = min(4, 1 + log2(1 + w))）、依赖矩阵的浓淡都用它
  //   · fanIn / fanOut 也是权重之和 → "被引用多少次 / 引用别人多少次"
  //   · 同名不同含义的"仅同名边"会在读侧被标出来，别只看数字大小（见 mcp.mjs 的 evidenceOf）
  // tier 记在边上（见 TIER_RANK 的说明）：同一条边被多次引用时**取最强的那一档** ——
  // 一边有 import 依据、另一边只是撞名，这条边的可信度按有依据的算。
  const edgeMap = new Map();
  const addEdge = (from, to, kind, n = 1, tier = 'name') => {
    if (from == null || to == null || from === to) return;
    const key = `${from}|${to}|${kind}`;
    const cur = edgeMap.get(key);
    if (!cur) edgeMap.set(key, { w: n, tier });
    else {
      cur.w += n;
      if ((TIER_RANK[tier] ?? 0) > (TIER_RANK[cur.tier] ?? 0)) cur.tier = tier;
    }
  };
  /**
   * 档位判定：把 `resolveName` 的结果翻成边上的 `tier`。
   *   same   —— 两端同一个文件（最强；解析路径无关，同文件就是同文件）
   *   import —— 有语言层面的依据（import / 父命名空间 / part 库 / include 闭包 / 同命名空间）
   *   unique —— 引用名在**候选表里唯一**（所以这条边不可能是撞名）
   *   name   —— 兜底：名字有多个候选、靠同命名空间 / 同根包近似挑出来的（依据最弱）
   *
   * ⚠ 唯一性必须用 `resolveName` 当时算的 `hit.length`，**不能**回头用 `bySimpleName.get(b.name)` 反查：
   * 引用名可能是**限定名**（Go 的 `package hclsyntax.Attributes`、Rust 的 `crate::x::Y`），
   * 而 bySimpleName 只按简单名建表 —— 反查会查不到，于是把一批本来唯一的边误判成 `name`
   * （实测 oss3-hcl 上 91 条、oss-guava 5 条）。
   */
  const tierOf = (fromTypeId, toTypeId, hit) => {
    const a = allTypes[fromTypeId], b = allTypes[toTypeId];
    if (hit?.same) return 'same';
    if (a && b && a.file === b.file) return 'same';
    if (hit?.import || hit?.evidenced) return 'import';
    // ⚠ 两端**同命名空间** = 有依据（语言语义上不需要 import 就能互相引用），必须算 import 档。
    // 漏了这一条会把一大批同包互引误判成 name 档（实测 oss3-hcl 131 条 / oss-guava 5 条：
    // Go 的 `package hclsyntax` 内部互引、Java 的 `com.google.common.hash` 内部互引）。
    // 判据与 hasImportBacking 里那条保持一致 —— 两处口径必须相同，否则又会出现"扫描说有、
    // 读侧说没有"的自相矛盾（modules.mjs 文件头记的就是这类事故）。
    if (a && b && a.ns && a.ns === b.ns) return 'import';
    return hit?.uniq ? 'unique' : 'name';
  };

  for (const r of allRefs) {
    const hit = resolveName(r.name, r.owner);
    if (hit) addEdge(r.owner, hit.id, 'ref', r.n || 1, tierOf(r.owner, hit.id, hit));
  }
  for (const t of allTypes) {
    for (const b of t.bases) {
      const hit = resolveName(b, t.id);
      if (hit) addEdge(t.id, hit.id, 'inherit', 1, tierOf(t.id, hit.id, hit));
    }
  }

  const edges = [];
  const edgeTiers = {};        // 证据档分布：写进 bundle.stats，overview 直接报（不必读侧重算）
  for (const [key, rec] of edgeMap) {
    const [f, t, k] = key.split('|');
    const from = Number(f), to = Number(t);
    edges.push({ from, to, kind: k, w: rec.w, tier: rec.tier });
    edgeTiers[rec.tier] = (edgeTiers[rec.tier] || 0) + 1;
    allTypes[from].fanOut += rec.w;
    allTypes[to].fanIn += rec.w;
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
      packages,
      aliases,
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
      // 持续扫描（scan --watch）的“趟信息”：第几趟 / 什么触发的 / 本趟重解析几个文件、改了哪几个
      //——MCP 据此在每个工具结果后提示“图更新过、请重查”（不写就是 null，老 bundle 没有这个键）
      watch: opts.watchInfo || null,
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
    // 证据档分布（same / import / unique / name，见 TIER_RANK）：读侧直接报，不再重算一遍
    edgeTiers,
    // 被跳过的文件：默认忽略目录 / 生成物、超限大小、以及“还不支持的语言”（后者要能看见，不能静静吞掉）
    skipped: {
      ignored: skipped.ignored || 0,
    ignoredDirs: Object.fromEntries(skipped.ignoredDirs || []),
      // 一级被跳过目录的体量（数文件；.git 不数）：让“图里 72 个文件”和“仓库其实 5 万个文件”同框出现
      rootDirs: Object.fromEntries(skipped.rootDirs || []),
      // 项目自己的规则（atlas.ignore / .gitignore）命中多少：进 bundle，报告和 MCP 都能看见
      projectDirs: Object.fromEntries(skipped.projectDirs || []),
      projectFiles: skipped.projectFiles || 0,
      projectBySrc: skipped.projectBySrc || {},
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
    rmFile(tmpOut);                                        // 同样是"删不掉就会留下旧产物"，走复查版
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
  let dirtyList = [];        // 本轮巡检发现的改动 → 写进 bundle.source.watch.changed（MCP 拿它提示 AI）

  const runPass = async (budget, reason) => {
    const r = await scanToDisk({
      ...base,
      fileBudget: budget,
      watchInfo: {
        pass: pass + 1,
        reason,                                                    // 'initial'（首扫分趟）/ 'change'（检测到改动）
        changed: reason === 'change' && dirtyList.length ? dirtyList.slice(0, 30) : null,
        changedMore: reason === 'change' ? Math.max(0, dirtyList.length - 30) : 0,
      },
    });
    dirtyList = [];
    lastFiles = r.files || [];
    pass++;
    console.log(t(`  ✓ 地图已更新（第 ${pass} 趟）：${r.bundle.totals.files} 文件 · ${r.bundle.totals.types} 类型 · ${new Date().toLocaleTimeString()}`,
      `  ✓ Map updated (pass ${pass}): ${r.bundle.totals.files} files · ${r.bundle.totals.types} types · ${new Date().toLocaleTimeString()}`));
    return r;
  };

  // ① 分趟长出来（小项目就一趟全量）
  const { files: all } = collectFiles(roots, { languages, maxKb, excludes, ignoreRules: loadIgnoreRules(roots, { gitignore: opts.gitignore !== false }) });
  const total = all.length;
  const c = (f) => Math.max(20, Math.round(total * f));
  const caps = [...new Set([c(0.02), c(0.1), c(0.25), c(0.5)].filter((n) => n < total).concat([total]))].sort((a, b) => a - b);
  for (let i = 0; i < caps.length; i++) {
    await runPass(caps[i] >= total ? null : caps[i], 'initial');
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
      await runPass(null, 'change');           // 增量重扫（缓存让没变的文件不用重解析）
      snapDirs();
    } catch (err) {
      console.error(t(`  ⚠ 重扫失败：${err.message}`, `  ⚠ Rescan failed: ${err.message}`));
    }
    busy = false;
    if (again) { again = false; fire(); }
  };

  /** 一遗轻量巡检：文件 mtime/大小变了、或某个目录的条目数变了 → 需要重扫（顺手记下改了哪些，给 MCP 提示用） */
  const dirty = () => {
    const hits = [];
    for (const f of lastFiles) {
      let st;
      try { st = fs.statSync(f.abs); } catch { hits.push(f.rel); continue; }        // 被删 / 改名了
      if (st.size !== f.bytes || Math.round(st.mtimeMs) !== Math.round(f.mtime)) hits.push(f.rel);
    }
    for (const [d, n] of dirSnap) {
      try { if (fs.readdirSync(d).length !== n) hits.push(`${path.basename(d)}/`); } catch { hits.push(`${path.basename(d)}/`); }
    }
    if (hits.length) dirtyList = hits;
    return hits.length > 0;
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
