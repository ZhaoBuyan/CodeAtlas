/**
 * MCP 服务：把 bundle 变成 AI 能"按需提问"的接口。
 *
 *   node src/cli.mjs mcp [--out dist]      # stdio 传输，给 MCP 客户端（Chatbox 等）用
 *
 * 设计意图：AI 不用把整份源码塞进上下文，而是问一句拿一小块：
 *   overview()              项目概览（有哪些系统、谁被依赖最多）
 *   search(名字片段)         找符号（默认连成员名一起搜，例如 "OnPaint"）
 *   symbol(id 或名字)        一个类型的全部细节（说明 / 成员 / 基类 / 依赖数）
 *   refs(名字, in|out|both)  谁引用它 / 它引用谁
 *   subgraph(名字, 深度)     依赖子图（改动的波及面）
 *   map(token 预算)          按预算导出的骨架地图（系统 → 关键类型 → 关键成员）
 *   impact(名字, 层数)        影响面分析（谁引用我，多跳）
 *   file(路径片段)           一个文件的类型、导入、行数
 *
 * 输出是紧凑文本而非 JSON —— 省 token，也更直接。
 * 注意：stdout 只走 JSON-RPC，日志一律走 stderr。
 */
import fs from 'node:fs';
import path from 'node:path';
// 本文件用 T(...) 而不是 t(...)：mcp.mjs 里到处是「类型对象」的局部名 t（箭头参数、const t = r.type …），
// 导入的 t 会被它们遮住（这种错是静默的），所以这里显式取别名。
import { t as T, isEn, sysLabel } from './i18n.mjs';
// 模块名归一 / import 是否能指到目标 —— 与扫描期（scan.mjs 的 resolveName）**共用同一套口径**
import { moduleKey, importMatchesTarget } from './modules.mjs';

export function listToolsText() {
  return TOOLS.map((t) => {
    const args = Object.entries(t.inputSchema?.properties || {})
      .map(([k, v]) => `${k}${(t.inputSchema.required || []).includes(k) ? '' : '?'}:${String(v.type)}`)
      .join(', ');
    return `  ${t.name}(${args})\n      ${t.description}`;
  }).join('\n');
}

const PROTOCOL = '2024-11-05';

/**
 * 给 AI 的"说明书"：MCP 客户端的 initialize 会把这段交给模型。
 * 为什么要有它：光看工具描述，AI 只能知道"能问什么"，不知道"这些结论能信到什么程度"——
 * 本项目的第一条价值观是诚实，所以把边界直接说在开头，而不是等模型自己踩坑。
 * （overview 里也放了一版浓缩的，因为不是每个客户端都会把 instructions 交给模型。）
 */
const INSTRUCTIONS = [
  'This is a code map produced by Code Atlas: a static parse of the source tree via tree-sitter, entirely local, never online.',
  '',
  'How to use it: start with overview for the big picture. If you do not know any names yet, call list(path) to browse',
  'directories and file names (its output is meant to be fed into file() / search()). Then search for symbols (it returns',
  'ids) and drill down with symbol / refs / subgraph / impact. When context is tight, call map(budget) first to get the',
  'skeleton (systems -> key types -> key members).',
  '',
  'Boundaries you must know (honesty first — do not treat inference as fact):',
  '- Types / members / line counts / imports come from the syntax tree and are trustworthy; dependency edges come from static',
  '  **name matching** — dynamic calls, reflection and names built by string concatenation are invisible, and the counts of',
  '  unmatched and ambiguous references are reported explicitly in overview and impact;',
  '- `refs` tags every edge with its evidence strength: `same file` (both sides in one file — solid) > `backed` (the',
  '  referring file imports a module of that name, or imports the target\'s namespace / package, or both sides sit in the',
  '  same namespace / package, or the target file sits inside an imported package, or a parent namespace in C# / VB — strong evidence, not proof) > `same name only` (this',
  '  bucket holds both coincidences and real references we failed to recognize — a parent namespace needs no `using`, and a',
  '  qualified name like `A.B.C` is not covered either — so check the source when in doubt). Solitary `same name only` edges are',
  '  why a raw reference count can be misleading, so the `overview`',
  '  "most depended-on" list is ranked by references with evidence instead (the number in brackets is how many count);',
  '- Files with parse errors are flagged individually; their data may be incomplete;',
  '- Top-level functions in JS / TS are recorded as [function] **types**, not members: search(scope="member") will not find',
  '  them — use the default scope (any) or scope="type";',
  '- Dependency edges are **type-level** (no per-call-site edges). But `refs` / `symbol` accept a member name or',
  '  `Type.Member` and answer with the owning type PLUS the member\'s **call / access sites** (`file:line`), matched',
  '  **by name only**: the receiver type is not resolved (same-named members elsewhere are mixed in), and dynamic calls /',
  '  aliases / reflection are invisible. Lines come from the syntax tree; "call vs access" is judged from the source text',
  '  (name followed by `(`, or preceded by `.` / `->` / `::`) — so Lisp-style `(foo x)` calls are not seen as calls;',
  '  `area(int, int): double`, or just `(int, int)` when the grammar gives the return type no name. A member printed without',
  '  a signature means "not extracted", **not** "takes no arguments" — do not read absence as fact;',
  '- Decompiled output (.dll / .exe / .jar) carries no source comments, so an empty "description" is expected;',
  '- Every path in the output is **relative to the scan root**, which overview reports (use it to build absolute paths and read source yourself);',
  '- The data is a snapshot (UTC): overview spells out the generation time (scan options included) and every tool result ends',
  '  with the same short "snapshot" stamp; a freshly scanned bundle is picked up automatically, but an **engine code update**',
  '  does need this server process restarted (the client reconnects and gets the new tool list);',
  '- overview also checks freshness: it re-stats the files already in the map, and when some of them changed on disk after',
  '  the scan it says so (`N mapped files changed…`, of which M are timestamp-only). It only covers files already in the',
  '  map — mapped files that disappeared ARE reported, while newly added files are not; a re-scan is how you pick those up;',
  '- `impact` also lists the **test files** that would be affected, recognized **by path** (test / tests / __tests__ dirs,',
  '  `.test.` / `.spec.` / `_test.` / `_spec.`, or a `test_` prefix). A project',
  '  that keeps its tests elsewhere will not be seen',
  '  there — and when the list is empty, impact says whether that means "no test references it" or "no test files were',
  '  recognized in this map", so an empty list is never mistaken for safety. Test files are matched by path only — a bundle',
  '  scanned by a much older engine carries no such marks at all, and impact says so instead of implying "no tests exist";',
  '- `symbol(name, neighbors: true)` adds a compact neighborhood (top 5 referrers, top 5 out-edges, related test files). It is',
  '  **off by default** — the default `symbol` output is unchanged; use `refs` when you need evidence tags and full lists;',
  '- `overview` / `search` / `refs` / `map` / `impact` take an optional **`exclude`** (comma-separated path patterns) that drops',
  '  matching names from that call only — nothing is persisted. Use it instead of assuming the engine knows your project layout',
  '  (sample corpora, vendored code, generated files). Multi-segment patterns (`tests/fixtures`) match a **consecutive** segment',
  '  sequence; single-segment ones (`vendor`) match a directory segment at any level or a file-name stem; matching is',
  '  case-insensitive; no wildcards. Every drop is counted next to the list it affected, and the project totals never change.',
].join('\n');

export function buildIndex(b) {
  const byId = new Map(b.types.map((t) => [t.id, t]));
  const files = new Map(b.files.map((f) => [f.id, f]));
  const ins = new Map();
  const outs = new Map();
  for (const e of b.edges) {
    if (!outs.has(e.from)) outs.set(e.from, []);
    outs.get(e.from).push(e);
    if (!ins.has(e.to)) ins.set(e.to, []);
    ins.get(e.to).push(e);
  }
  return { b, byId, files, ins, outs };
}

/**
 * `exclude` 的**参数说明**（写在 5 个“会列出名字”的工具上）—— 调用前就看得到，不用读文档。
 */
const EXCLUDE_DOC = 'Comma-separated path patterns; drops matching names from THIS call only (nothing is persisted) and reports how many were dropped. Matching is fixed and simple: a multi-segment pattern like `tests/fixtures` matches a **consecutive** segment sequence (matches `a/tests/fixtures/b.java`, NOT `tests/x/fixtures/y`); a single-segment pattern like `vendor` matches a directory segment at any level OR a file-name stem (so it also drops `vendor.ts`); always **case-insensitive**. No wildcards and no extension patterns (`*.g.cs` belongs in atlas.ignore, not here). Project totals are never changed by it.';

const TOOLS = [
  {
    name: 'overview',
    description: 'Project overview: size, systems/modules, most depended-on symbols, largest files, plus a freshness check (files already in the map that changed on disk after the scan, plus mapped files that are no longer on disk) — newly added files are not detected. Call this first to get the big picture.',
    inputSchema: { type: 'object', properties: { exclude: { type: 'string', description: EXCLUDE_DOC } }, additionalProperties: false },
  },
  {
    name: 'search',
    description: 'Search by name: type names / qualified names / file-name fragments. **Member names are included by default** (searching "OnPaint" finds who declares that method). Hits carry the signature (parameter list / return type) when the grammar exposes it, so same-name overloads are told apart. Returns type ids for symbol/refs. Note: top-level JS/TS functions are *types*, so scope="member" will miss them — keep the default scope=any.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name fragment, e.g. "Logger" / "Players" / "OnPaint"' },
        scope: { type: 'string', enum: ['any', 'type', 'member'], description: 'Where to search: any (default, types + members) / type (type names only) / member (member names only; JS/TS top-level functions are types, so this scope will not find them)' },
        kind: { type: 'string', description: 'Optional: restrict to one kind (class/interface/enum/function/module...); applies to types only' },
        limit: { type: 'number', description: 'Maximum number of results, default 20' },
        exclude: { type: 'string', description: EXCLUDE_DOC },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'symbol',
    description: 'Everything about one symbol (type): description, file:line, signature (parameter list + return type, when the grammar exposes it), member list, base types, dependents/dependencies, owning system. Members are listed with their own id/line; a **member** name or `Type.Member` is accepted too and answered with its owning type plus that member\'s call / access sites (`file:line`, matched by name). Pass `neighbors: true` to also get a compact neighborhood (top 5 referrers, top 5 out-edges, related test files) — off by default so the output stays small.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'id (number) or a name / qualified name' },
        members: { type: 'number', description: 'Max members to list, default 40 (max 300) — raise it when you need the whole member list' },
        neighbors: { type: 'boolean', description: 'Also print a compact neighborhood block: who references it (top 5), what it references (top 5), related test files — ranked by evidence strength like refs. Off by default: without it the output is unchanged. Use refs for evidence tags and full lists.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'refs',
    description: 'References: who references it (in) / what it references (out). Use this before changing code to see the blast radius. A **member** name (or `Type.Member`) is also accepted: you then get the owning type plus that member\'s call / access sites (`file:line`, matched by name — see the instructions for the exact limits).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        direction: { type: 'string', description: 'in | out | both (default both)' },
        limit: { type: 'number', description: 'Default 30' },
        exclude: { type: 'string', description: EXCLUDE_DOC },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'subgraph',
    description: 'Dependency subgraph around a symbol within a depth limit (compact list); answers "what does changing this drag along".',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        depth: { type: 'number', description: 'How many levels to expand, default 2, maximum 3' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'map',
    description: 'Export a \"skeleton map\" within a token budget: systems -> key types -> key members, most important first. Purpose: let an AI grasp the whole project in limited context instead of exploring one question at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        budget: { type: 'number', description: 'Token budget (estimated), default 4000' },
        exclude: { type: 'string', description: EXCLUDE_DOC },
      },
    },
  },
  {
    name: 'impact',
    description: 'Impact analysis: who is affected if this type changes — multi-hop expansion along "who references it" (2 levels by default), the test files that would be affected (recognized by path), plus an explicit statement of what is invisible (static name matching cannot see dynamic calls or reflection).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Type name / qualified name / id' },
        depth: { type: 'number', description: 'How many levels, 1-4, default 2' },
        exclude: { type: 'string', description: EXCLUDE_DOC },
      },
      required: ['name'],
    },
  },
  {
    name: 'file',
    description: 'Look at one file by path fragment: which types it declares, what it imports, how many lines, whether it has parse errors.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path fragment, e.g. "Utils/Loc.cs"' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list',
    description: 'Browse the scanned tree by directory: pass a directory path fragment (or nothing for the scan root) and get its direct entries with file / type / code-line counts. Use this when you do not know any names yet — the output gives you paths and file names to feed into file() / search().',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory fragment, e.g. "client/src" / "src/Players"; omit for the scan root' },
        limit: { type: 'number', description: 'Max entries to list, default 40 (max 200)' },
      },
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

// 模块名归一（basename / SRC_EXT / moduleKey）已挑到 src/modules.mjs —— 扫描器与读期必须判得一样

/**
 * 引用证据强度 —— 依赖边是静态名字匹配，所以“同名但无关”的边会混进来：实测（一个真实 monorepo 样本）
 * 有个函数 145 条入边里 141 条来自别的文件里同名对象的方法调用，跟它根本无关。
 * 读侧分三档（不动引擎数据）：同文件最硬；引用方文件的 imports 能指到被引用方（模块名 / 命名空间 / 包）
 * = 有支撑；剩下只共享一个名字的归“仅同名”，噪声主要在这一档。
 * ⚠ 复测报告 §3：以前只比“被引用文件的文件名主干”，于是**命名空间语言（C#/Java/Kotlin）全军塔成“仅同名”**
 * （一个 C# 项目 53 条边里“有支撑”0 条，连 `using MuSync.Models;` 都认不出来），overview 热点榜跟着失真。
 * 现在改走 modules.mjs 的 `importMatchesTarget`（模块名 + 命名空间 + 包路径 + Rust 段后缀 + 仓库内包名自引用）。
 */
function evidenceOf(idx, e) {
  const src = idx.byId.get(e.from);
  const dst = idx.byId.get(e.to);
  if (!src || !dst) return 'name';
  if (src.file === dst.file) return 'same';
  const f = idx.files.get(src.file);
  const target = { ns: dst.ns, fqn: dst.fqn, path: idx.files.get(dst.file)?.path };
  if (f && target.path) {
    // 仓库自身的包名（package.json 的 name → 包目录）+ TS/JS 的路径别名（tsconfig paths）：
    // 与扫描期同一套口径
    if (idx._pkgCtx === undefined) {
      const src0 = idx.b?.source || {};
      idx._pkgCtx = (src0.packages?.length || src0.aliases?.length)
        ? { packages: src0.packages || [], aliases: src0.aliases || [] }
        : null;
    }
    for (const raw of f.imports || []) if (importMatchesTarget(raw, target, idx._pkgCtx)) return 'import';
    // C/C++ 的 include 闭包（≤2 跳）：A include 的 B 又 include 了 C → A 也能撑住 C 里的引用
    //（实测 redis / fmt / ocaml：类型全在被“间接 include”的内部头文件里）
    if (idx._closure === undefined) {
      idx._closure = new Map();
      idx.b.files.forEach((x, i) => { if (x && Array.isArray(x.closure) && x.closure.length) idx._closure.set(i, new Set(x.closure)); });
    }
    const clo = idx._closure.get(src.file);
    if (clo && clo.has(dst.file)) return 'import';
  }
  // C# / VB：子命名空间**不用 using 也能引用父命名空间里的类型**（语言语义如此）。实测一个 C# 项目里有 7 条
  // 真引用因此被留在“仅同名”档，AI 照标签会把它们丢掉。只对 C# 家族做（Java/Kotlin 不适用）。
  const dstExt = String(target.path || '').split('.').pop().toLowerCase();
  if ((dstExt === 'cs' || dstExt === 'vb') && dst.ns && src.ns && src.ns.startsWith(`${dst.ns}.`)) return 'import';
  if (dst.ns && src.ns === dst.ns) return 'import';
  return 'name';
}

const EVIDENCE_RANK = { same: 2, import: 1, name: 0 };

/** refs 每行尾的短标签（有证据的排前面，标了才看得出来哪几条是噪声） */
function evidenceTag(ev) {
  if (ev === 'same') return T('  [同文件]', '  [same file]');
  if (ev === 'import') return T('  [有支撑]', '  [backed]');
  return T('  [仅同名]', '  [same name only]');
}

/**
 * 某个类型“算数的”被引用**次数**（同文件 + 有支撑的边，按权重相加）—— overview 热点榜拿它排序。
 * 与 fanIn（全部入边权重之和）同一个口径：都是“次”；差别只是这里扣掉了“仅同名”那一档噪声。
 * （权重以前恒为 1，这两个数等价；2026-09-20 边权重变成真的引用次数后，必须按权重加才不失真）
 */
function evidencedIn(idx, t) {
  let n = 0;
  for (const e of idx.ins.get(t.id) || []) if (evidenceOf(idx, e) !== 'name') n += e.w || 1;
  return n;
}

/** 搜索命中上挂的一行说明摘要：压空白、截到 n 字（省 AI 一次 symbol 调用） */
function briefDoc(s, n = 80) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * 签名文本：`(int a, string b): bool`（类型是顶层函数时只有后半截）。
 * 空串的含义是**源码里没抽到**，不是"它没有参数"/"它没有返回类型"——别当成事实读。
 * 存在价值：同名重载只给名字就长得一模一样，有了签名才分得清 AI 问的/改的是哪一个。
 */
function sigText(x) {
  return `${x?.p || ''}${x?.r ? `: ${x.r}` : ''}`;
}

function resolve(idx, key) {
  const s = String(key ?? '').trim();
  if (/^\d+$/.test(s) && idx.byId.has(Number(s))) return { type: idx.byId.get(Number(s)) };
  const low = s.toLowerCase();
  const exact = idx.b.types.filter((t) => t.name.toLowerCase() === low || t.fqn.toLowerCase() === low);
  if (exact.length === 1) return { type: exact[0] };
  const hits = idx.b.types.filter((t) => t.name.toLowerCase().includes(low) || t.fqn.toLowerCase().includes(low));
  if (hits.length === 1) return { type: hits[0] };
  if (!hits.length) {
    // 给的是**成员名**（或 `类型.成员`）时，不要拿“找不到符号”把人顶回去：
    // 依赖边只记类型级，但我们可以把“所属类型”指出来（用户要查调用点时这就是最窄的超集）。
    const mem = memberHitsOf(idx, s);
    if (mem.length) return { error: memberNote(idx, s, mem) };
    return { error: T(`找不到匹配 "${s}" 的符号。用 search 先找找。`, `No symbol matches "${s}". Try search first.`) };
  }
  return {
    error: T(`"${s}" 匹配到 ${hits.length} 个，请用更精确的名字或 id：\n`, `"${s}" matched ${hits.length} symbols — use a more precise name or id:\n`) +
      hits.slice(0, 12).map((t) => `  ${t.id}  ${t.fqn}  [${t.kind}]  ${idx.files.get(t.file)?.path}`).join('\n'),
  };
}

/**
 * 成员名（或 `类型.成员`）→ [{ t: 所属类型, m: 成员 }]。
 * 为什么要有：图的依赖边**只到类型这一级**（`refs` 答的是“谁引用了这个类型”）；
 * 所以拿方法名去问 refs 时，以前直接答“找不到匹配的符号”—— 既不准确（符号明明在），
 * 也帮不上“找出这个方法的调用点”这个真实需求。2026-09-20 用户实测报告里那条“硬伤”。
 */
function memberHitsOf(idx, raw) {
  const s = String(raw ?? '').trim();
  const found = [];
  const claim = (t, m) => { if (m && !found.some((x) => x.t.id === t.id && x.m.l === m.l)) found.push({ t, m }); };
  const lastDot = s.lastIndexOf('.');
  if (lastDot > 0) {   // 类型.成员（C# 的 `MuSync.SteamStatusManager.ClearStatus` 走这条）
    const owner = s.slice(0, lastDot);
    const mName = s.slice(lastDot + 1);
    const owners = idx.b.types.filter((t) => t.name === owner || t.fqn === owner || t.fqn.toLowerCase().endsWith('.' + owner.toLowerCase()));
    for (const t of owners) for (const m of t.memberList || []) if (m.n === mName || m.n === `${mName}()`) claim(t, m);
  }
  if (!found.length) {  // 光一个成员名：在所有类型里找（可能有多个候选）
    for (const t of idx.b.types) {
      for (const m of t.memberList || []) if (m.n === s || m.n === `${s}()` || (m.n || '').startsWith(`${s}(`)) claim(t, m);
    }
  }
  return found;
}

/**
 * ① 成员级“调用 / 访问位置”（2026-09-20）：按**名字**在整张图里找。
 * 这是“谁调用了这个方法”这个名字级回答 —— 口径与边界（工具描述 / README / CHANGELOG 里也都写着）：
 *   · 只看名字 + 源码里“紧跟 `(`” / “前面紧挨 `.` / `->` / `::`”，**不解析接收者类型** → 同名的别的成员会混进来；
 *   · 动态调用 / 别名 / 反射，以及 Lisp 那种 `(foo x)` 写法（名字后面不跟括号）抓不到；
 *   · **声明处要排掉**：声明名后面也常跟 `(`（`void ClearStatus() {`），那不是调用点。
 * 数据来自扫描端的 `types[].uses`（类型内）与 `files[].uses`（类型之外，如脚本末尾的 `main()`）。
 */
/** 按名字收集“调用 / 访问位置”，并排掉声明行（`<fileId>#<line>` 在 declKeys 里的一律不算调用点） */
function collectUses(idx, names, declKeys) {
  const want = new Set([...names].filter(Boolean).map((s) => String(s).toLowerCase()));
  if (!want.size) return [];
  const out = [];
  const seen = new Set();
  const push = (fileId, u) => {
    if (!want.has(String(u.n || '').toLowerCase())) return;
    if (declKeys.has(`${fileId}#${u.l}`)) return;
    const k = `${fileId}#${u.l}#${u.c}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ fileId, l: u.l, c: u.c });
  };
  for (const t of idx.b.types) for (const u of t.uses || []) push(t.file, u);
  for (const f of idx.b.files) for (const u of f.uses || []) push(f.id, u);
  out.sort((a, b) => (a.fileId - b.fileId) || (a.l - b.l));
  return out;
}

/** 同名成员的声明行（从“调用位置”里排掉：`void ClearStatus() {` 后面也跟括号，但那不是调用） */
function memberDeclKeys(idx, names) {
  const want = new Set(names.map((s) => String(s || '').toLowerCase()));
  const keys = new Set();
  for (const t of idx.b.types) {
    for (const m of t.memberList || []) if (want.has((m.n || '').toLowerCase())) keys.add(`${t.file}#${m.l}`);
  }
  return keys;
}

/** 成员名的调用 / 访问位置 */
function memberUses(idx, name) {
  return collectUses(idx, [name], memberDeclKeys(idx, [name]));
}

/**
 * 这份 bundle 的**引擎版本**支不支持“调用 / 访问位置”记录（1.5.0 起）。
 * ⚠ 不能拿“图里有没有 uses 字段”当判据：**新引擎扫的小工程本来就可能一条都没有**（没有名字出现在调用位），
 * 那时说“老版本引擎扫的图，重扫一次就会带上”就是把“没有”错说成“没记录”（复测第三轮抓到的）。
 */
function engineHasUses(idx) {
  const parts = (v) => String(v || '').split('.').map((n) => parseInt(n, 10) || 0);
  const a = parts(idx.b.generator?.version);
  const b = parts('1.5.0');
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** 调用 / 访问位置的正文（成员回答与类型回答共用） */
function usesLines(idx, sites, withData) {
  const CAP = 12;
  if (!sites.length) {
    return withData
      ? T('调用 / 访问位置：一处都没找到（这个图里没有名字出现在调用位或成员访问位）',
        'Call / access sites: none found (this name never appears in a call or member-access position in the map)')
      : T('调用 / 访问位置：这份图里没有这类记录（老版本引擎扫的图 —— 重新扫一次就会带上）',
        'Call / access sites: this map carries no such records (it was scanned by an older engine — a re-scan adds them)');
  }
  const callCount = sites.filter((s) => s.c).length;
  return T(`调用 / 访问位置（按名字匹配，共 ${fmt(sites.length)} 处${callCount ? `，其中调用 ${fmt(callCount)} 处` : ''}）：\n`,
    `Call / access sites (matched by name: ${fmt(sites.length)}${callCount ? `, ${fmt(callCount)} of them calls` : ''}):\n`)
    + sites.slice(0, CAP).map((s) => T(`  ${idx.files.get(s.fileId)?.path}:${s.l}\t${s.c ? '调用' : '访问'}`,
      `  ${idx.files.get(s.fileId)?.path}:${s.l}\t${s.c ? 'call' : 'access'}`)).join('\n')
    + (sites.length > CAP ? T(`\n  …还有 ${fmt(sites.length - CAP)} 处`, `\n  …${fmt(sites.length - CAP)} more`) : '');
}

/** 成员名被交给 refs / symbol / subgraph / impact 时的回答（诚实地讲清“能答什么”与“怎么接下一步”） */
function memberNote(idx, name, hits) {
  const head = T(`「${name}」是**成员**，不是类型（所以没有类型级依赖边）。成员级的**调用 / 访问位置**在下面，按名字匹配。`,
    `"${name}" is a **member**, not a type (so it has no type-level edges). Its per-name **call / access sites** are below.`);
  // ④ 复测报告：两个“被引”不同义（387 = 类型名出现次数；下面那行 = 本成员的位置数），同屏并列容易被读成矛盾
  // → 这里写明这是**该类型**的数；本成员的数在下面那段里。
  const rows = hits.slice(0, 12).map(({ t, m }) => {
    const f = idx.files.get(t.file);
    const ev = evidencedIn(idx, t);
    return T(`  ${m.l}\t${t.fqn}.${m.n}\t[${m.k}]\t${f ? f.path : '?'}:${m.l}  （所属类型 id=${t.id}；**该类型**被引 ${t.fanIn} 次${ev < t.fanIn ? `，其中算数的 ${ev} 次` : ''}）`,
      `  ${m.l}\t${t.fqn}.${m.n}\t[${m.k}]\t${f ? f.path : '?'}:${m.l}  (owner type id=${t.id}; **that type** is referenced ${t.fanIn} times${ev < t.fanIn ? `, ${ev} with evidence` : ''})`);
  });
  // 注意：要拿**成员名**去找位置，不能拿整串查询（`Widget.render` 不是名字）；同名多命中时取并集
  const memberNames = [...new Set(hits.map((h) => h.m.n).filter(Boolean))];
  const seenSite = new Set();
  const sites = [];
  for (const mn of memberNames) {
    for (const s of memberUses(idx, mn)) {
      const k = `${s.fileId}#${s.l}#${s.c}`;
      if (!seenSite.has(k)) { seenSite.add(k); sites.push(s); }
    }
  }
  sites.sort((a, b) => (a.fileId - b.fileId) || (a.l - b.l));
  const siteBlock = usesLines(idx, sites, engineHasUses(idx));
  const tail = T(`→ 这些位置是**按名字匹配**的：不解析接收者类型，同名的其它成员会混进来；动态调用 / 别名 / 反射，\n  以及 Lisp 那种 \`(foo x)\` 写法**抓不到**。要交叉核对：对上面每个所属类型调 refs(id)（那是超集）。`,
    `→ These sites are matched **by name only**: the receiver type is not resolved, so same-named members elsewhere are mixed in;\n  dynamic calls / aliases / reflection — and Lisp-style \`(foo x)\` calls — are invisible. To cross-check: refs(id) on each owner type above (an upper bound).`);
  return `${head}\n${rows.join('\n')}\n${siteBlock}\n${tail}`;
}

/**
 * 快照新鲜度：bundle 是一份快照，**图里那些文件在磁盘上可能已经变了**。
 *
 * 只 re-stat「已经纳入图里的文件」（N 次 stat，不遍历目录）—— 代价与收益对等：报“改动”只要知道路径，
 * 报“新增”得真去遍历目录（还要套 ignore 规则与扩展名规则），那是重新扫描的事。所以这行**只覆盖图里已有的文件**。
 * ⚠ 别把这句话写成“新增 / 删除都看不见”（复验报告 §5 抓到的就是这处与实现不一致）：
 * **「图里有、磁盘上没了」是能报的**（stat 失败即可知），发现不了的只是“图上还没有的东西”。
 * （这跟“我连的是哪份引擎代码”是两回事：这里答的是“数据是不是旧的”。）
 *
 * 三条口径都有理由：
 *   · size 变了 → 内容确实变了；**只有 mtime 变了 → 单独计数**。等长改动（改常量、`!=`→`==`、等长重命名）
 *     在代码里很常见，所以“仅时间戳变化”≠“内容没变”，措辞上写“时间戳变化”而不是“未改”；
 *     但它确实有用：切分支 / git checkout 会批量刷 mtime，看到“9 个仅时间戳变化”就知道图的**内容**大体还准，
 *     不必一律重扫。反过来也不能把这一类弱化到可忽略 —— 所以数字分开、但不单列成第二条提示。
 *   · stat 失败 = 这个文件已经从磁盘上没了。“图还在、文件没了”图自己永远发现不了（它的引用 / 影响面会虚高），
 *     而检测它是免费的（顺手就得到了），所以白送一句。
 *   · 多根（roots > 1）时 bundle 里的 path 是相对**各自**根的、没记属于哪个根 → 直接不报，不猜。
 *   · 数字超过量级就截断成 `50+`：这行的价值是“图旧了、别全信”，不是文件清单（要清单去看 git status）。
 *
 * 暂不做结果缓存：本仓库 67 个文件是几次毫秒级 stat；等有了大项目上的实测数据再谈节流（没证据不动）。
 */
export function freshnessNote(b) {
  const roots = b?.source?.roots || [];
  if (roots.length !== 1) return '';                                  // 多根：path 归谁无法判定，不猜
  const root = roots[0];
  const files = Array.isArray(b?.files) ? b.files : [];
  if (!files.length || files.some((f) => typeof f.mtime !== 'number')) return '';   // 老 bundle 没有 mtime
  let st0;
  try { st0 = fs.statSync(root); } catch { return ''; }               // 图是在别的机器上扫的（连根都不在）→ 别乱报
  if (!st0.isDirectory()) return '';

  let changed = 0, timeOnly = 0, gone = 0;
  for (const f of files) {
    let st;
    try { st = fs.statSync(path.join(root, f.path)); } catch { gone++; continue; }
    if (!st.isFile()) { gone++; continue; }
    if (st.size !== f.bytes) changed++;                               // 大小变了 → 内容确实变了
    else if (Math.round(st.mtimeMs) !== f.mtime) { changed++; timeOnly++; }
  }
  if (!changed && !gone) return '';
  const cap = (n) => (n > 50 ? '50+' : fmt(n));
  if (!changed) {
    return T(`⚠ 快照后有 ${cap(gone)} 个已纳入图里的文件已不在磁盘 —— 未反映在图里`,
      `⚠ ${cap(gone)} mapped files are no longer on disk — not reflected in the map`);
  }
  return T(`⚠ 快照后 ${cap(changed)} 个已纳入图里的文件有改动${timeOnly ? `（其中 ${cap(timeOnly)} 个仅时间戳变化）` : ''}${gone ? `，另有 ${cap(gone)} 个已不在磁盘` : ''} —— 未反映在图里`,
    `⚠ ${cap(changed)} mapped files changed after this snapshot${timeOnly ? ` (${cap(timeOnly)} timestamp-only)` : ''}${gone ? `, and ${cap(gone)} are no longer on disk` : ''} — not reflected in the map`);
}

// ---------------------------------------------------------------------------
// exclude：让调用方（AI）自己排除不需要的部分
//
// 引擎永远认不出“这个项目里哪些是样例数据 / 生成物”——那是**项目语感**，该由调用方在调用时给。
// 所以这里只提供一条**查询层**的通道：每次调用带、用完即弃（不落成设置；项目里固定要排除的，
// 仍然走 atlas.ignore / 启动器里的扫描范围）。**只保留这一个**开关 —— 再开第二个（include_only 之类），
// 引擎就开始“理解项目结构”了，又回到“按某一个项目调规则”那条老路。
//
// 取值语义**写死**（一眼能猜对，不需要记）：
//   · 逗号分隔，多条
//   · **多段项**（`tests/fixtures`）= **连续段序列**：命中 `a/tests/fixtures/b.java`，
//     **不**命中 `tests/x/fixtures/y`（不连续就不算）
//   · **单段项**（`vendor`）= 任意层级的**目录段**，或文件名的**主干**（排 vendor 时顺手排掉 vendor.ts）
//   · 一律**大小写不敏感**（Windows 路径不敏感、Linux 敏感 —— 同一个 exclude 在两种机器上必须一个结果）
//   · 只做路径段匹配：**不做通配、不看扩展名**（`*.g.cs` 那类属于项目属性，走 atlas.ignore）
//
// 只过滤**名单（显示）**，不改遍历、也不改项目事实（overview 的「规模」永远是整库的数）。
// 每次排除都在名单**后面当场**写清排掉了多少 —— 尤其是“名单被排空”时必须说“全被排除”，
// 绝不能显示成 `（0 个）` 让人读成“没有”。
// ---------------------------------------------------------------------------

/** "tests/fixtures, vendor" → [['tests','fixtures'], ['vendor']] */
export function parseExclude(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase())
    .filter(Boolean)
    .map((s) => s.split('/').filter(Boolean))
    .filter((segs) => segs.length);
}

/** 这条路径命中任一条 exclude 规则？（语义见上面那段注释） */
export function isExcluded(patterns, filePath) {
  if (!patterns?.length) return false;
  const all = String(filePath || '').replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
  const base = all.pop() || '';
  for (const pat of patterns) {
    if (pat.length === 1) {
      const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
      if (all.includes(pat[0]) || stem === pat[0]) return true;
      continue;
    }
    const seq = [...all, base];   // 连续段序列：多段项必须在路径里一级不差地挨着出现
    for (let i = 0; i + pat.length <= seq.length; i++) {
      if (pat.every((p, j) => seq[i + j] === p)) return true;
    }
  }
  return false;
}

/** 过滤一份名单（保留项 + 排除数）。调用方把 dropNote 紧跟在**这份名单**后面 */
function applyExclude(items, patterns, pathOf) {
  if (!patterns?.length) return { items, dropped: 0 };
  const kept = [];
  let dropped = 0;
  for (const it of items) (isExcluded(patterns, pathOf(it)) ? dropped++ : kept.push(it));
  return { items: kept, dropped };
}

/** 单位用 [中文, English] 一对传进来（i18n 那边 T() 只能挑一种） */
const U = (pair) => (isEn ? pair[1] : pair[0]);

/**
 * exclude 的自报行（紧跟在被它过滤的那份名单后面）。
 * `kept` 为 0 时必须明说“这个名单的项全被排除” —— 否则读者会把它读成“没有”。
 * `pool = true` 用于“先过滤再取前 N 名”的榜（overview 热点榜 / 最大的文件 · map 骨架）：
 * 那时被排除的不是榜单里的 8 行，而是**候选池** —— 不说清就变成“从 8 行里排掉了 134 个”这种假精度。
 */
function dropNote(patterns, dropped, kept, unit, pool = false) {
  if (!dropped) return '';
  const u = U(unit);
  const which = patterns.map((p) => p.join('/')).join(', ');
  if (pool) {
    return kept
      ? T(`  （exclude "${which}"：候选里排除了 ${fmt(dropped)} 个${u}，下面这个榜是按剩下的排的）`, `  (exclude "${which}": dropped ${fmt(dropped)} ${u} from the candidate pool; the list below is ranked from what is left)`)
      : T(`  （exclude "${which}"：候选里的 ${fmt(dropped)} 个${u}全被排除 —— 这个榜是空的）`, `  (exclude "${which}": the whole candidate pool (${fmt(dropped)} ${u}) was dropped — this list is empty)`);
  }
  return kept
    ? T(`  （exclude "${which}"：本次排除了 ${fmt(dropped)} 个${u}）`, `  (exclude "${which}": dropped ${fmt(dropped)} ${u})`)
    : T(`  （exclude "${which}"：本次排除了 ${fmt(dropped)} 个${u} —— 这个名单的项全被排除）`, `  (exclude "${which}": dropped ${fmt(dropped)} ${u} — the whole list was dropped)`);
}

/** exclude 写了错字、在图里一条路径都没命中 → 明说（否则调用方会以为过滤生效了） */
function excludeMissNote(patterns, b) {
  if (!patterns?.length) return '';
  if (b.files.some((f) => isExcluded(patterns, f.path))) return '';
  const which = patterns.map((p) => p.join('/')).join(', ');
  return T(`（exclude "${which}" 在图里没匹配到任何路径 —— 检查一下写法？单段项按目录段或文件名主干匹配，多段项要连续出现）`,
    `(exclude "${which}" matched no path in this map — check the spelling? single-segment patterns match a directory segment or a file-name stem; multi-segment ones must appear consecutively)`);
}

function toolOverview(idx, a) {
  const b = idx.b;
  const ex = parseExclude(a?.exclude);
  const pathOfType = (t) => idx.files.get(t.file)?.path || '';
  // 热点榜按“有证据的引用数”排（并列再按原始引用数）——
  // 不这么排的话，“同名但无关”的边会把一个没人真用的类型顶到第一（实测样本上就是这样）
  // exclude 在**切片之前**生效：否则排掉两条就只剩 6 条了（名单会莫名其妙变短）
  const hot = applyExclude(b.types.slice()
    .sort((a, c) => (evidencedIn(idx, c) - evidencedIn(idx, a)) || (c.fanIn - a.fanIn)), ex, pathOfType);
  const topIn = hot.items.slice(0, 8);
  const big = applyExclude(b.files.slice().sort((a, c) => c.code - a.code), ex, (f) => f.path);
  const bigFiles = big.items.slice(0, 6);
  const lines = [];
  lines.push(T(`项目：${b.source.labels.join(', ')}${b.source.git ? ` @ ${b.source.git.commit}` : ''}`, `Project: ${b.source.labels.join(', ')}${b.source.git ? ` @ ${b.source.git.commit}` : ''}`));
  const roots = (b.source.roots || []).join('  ');
  if (roots) lines.push(T(`扫描根：${roots}（输出里的路径都相对于它）`, `Scan root: ${roots} (paths in the output are relative to it)`));
  const so = b.source.scanOptions || {};
  // bundle 里的 generated 是 UTC（ISO 末尾 Z）；这里不做时区换算，只如实标注是 UTC，
  // 否则客户端会把 18:16 当成本地时间（本地其实是次日 02:16）
  const when = String(b.generated || '').replace('T', ' ').slice(0, 19) + ' UTC';
  lines.push(T(`数据快照：${when} · 扫描耗时 ${(Number(b.source.scanMs || 0) / 1000).toFixed(1)}s · 语言 ${so.lang || 'auto'} · 单文件上限 ${so.maxKb || 1024}KB · ${so.incremental ? '增量' : '全量'}`, `Snapshot: ${when} · scan took ${(Number(b.source.scanMs || 0) / 1000).toFixed(1)}s · languages ${so.lang || 'auto'} · max file ${so.maxKb || 1024}KB · ${so.incremental ? 'incremental' : 'full'}`));
  const fresh = freshnessNote(b);
  if (fresh) lines.push(fresh);
  lines.push(T(`规模：${fmt(b.files.length)} 文件 · ${fmt(b.totals.types)} 类型 · ${fmt(b.totals.edges)} 依赖边 · ${fmt(b.totals.code)} 行代码`, `Size: ${fmt(b.files.length)} files · ${fmt(b.totals.types)} types · ${fmt(b.totals.edges)} dependency edges · ${fmt(b.totals.code)} lines of code`));
  // 被默认跳过表命中的目录：AI 也该知道“这张图缺了东西”（诚实优先）。老 bundle 没这个字段 → 当空处理。
  // **项目规则跳掉的那几类排前面**（那是"这个项目自己选跳的"，通常才是需要注意的），
  // 默认表命中的（.git / node_modules / dist…）跟在后面 —— 不删名字（删了就是瞒着人），只把顺序分开
  const projDirs = new Set(Object.keys(b.stats?.skipped?.projectDirs || {}));
  const allIgn = Object.entries(b.stats?.skipped?.ignoredDirs || {}).sort((x, y) => y[1] - x[1]);
  const ordered = [...allIgn.filter(([n]) => projDirs.has(n)), ...allIgn.filter(([n]) => !projDirs.has(n))];
  const ignDirs = ordered.slice(0, 8);
  if (ignDirs.length) {
    const detail = ignDirs.map(([n, c]) => `${n}(${c})`).join(' · ')
      + (ordered.length > ignDirs.length ? T(` …共 ${ordered.length} 类`, ` …${ordered.length} dir names in total`) : '')
      + (projDirs.size ? T(`（前 ${projDirs.size} 个是项目规则跳的${ordered.length > projDirs.size ? '，其余是默认表命中' : ''}）`, ` (the first ${projDirs.size} came from project rules${ordered.length > projDirs.size ? ', the rest matched the default list' : ''})`) : '');
    lines.push(T(`跳过目录：${detail} —— 这些目录里的源码不在本图里`, `Skipped dirs: ${detail} — source inside them is not in this map`));
  }
  if (b.totals.parseErrors) {
    const bad = b.files.filter((f) => f.errors).sort((x, y) => y.errors - x.errors);
    const showBad = bad.slice(0, 8);
    const list = showBad.map((f) => `${f.path}(${f.errors})`).join(' · ');
    const tail = bad.length > showBad.length ? T(` …等 ${bad.length} 个文件`, ` … ${bad.length} files in total`) : '';
    lines.push(T(`注意：${b.totals.parseErrors} 处语法树解析异常（这些文件数据可能不全）：${list}${tail}`, `Note: ${b.totals.parseErrors} parse errors (data in those files may be incomplete): ${list}${tail}`));
  }
  if (b.totals.compilerGenerated) lines.push(T(`注意：${b.totals.compilerGenerated} 个编译器生成/反编译生成类型（非手写代码）`, `Note: ${b.totals.compilerGenerated} compiler-generated / decompiled types (not hand-written code)`));
  if (b.totals.nonUtf8Files) lines.push(T(`注意：${b.totals.nonUtf8Files} 个文件可能不是 UTF-8 编码（其中的注释 / 字符串是乱码）`, `Note: ${b.totals.nonUtf8Files} files are probably not UTF-8 (their comments / strings are mojibake)`));
  // 诚实边界：把"依赖边是名字匹配"这个前提摆在第一屏——只调 overview 的 AI 也得看得到
  const un = b.unresolved || {};
  lines.push(T(`可信度：依赖边是静态名字匹配（动态调用 / 反射 / 字符串拼名看不见）——未匹配 ${fmt(un.unknown || 0)} 处 · 同名歧义 ${fmt(un.ambiguous || 0)} 处`, `Confidence: dependency edges are static name matches (dynamic calls / reflection / string-built names are invisible) — ${fmt(un.unknown || 0)} unmatched · ${fmt(un.ambiguous || 0)} ambiguous`));
  const sys = b.facets?.systems || [];
  if (sys.length) lines.push(T(`系统划分（${b.facets.configFile}）：\n`, `Systems (${b.facets.configFile}):\n`) + sys.map((s) => T(`  ${sysLabel(s.name)}：${fmt(s.loc)} 行 · ${s.types} 类型 · ${s.files} 文件`, `  ${sysLabel(s.name)}: ${fmt(s.loc)} lines · ${s.types} types · ${s.files} files`)).join('\n'));
  else lines.push(T('没有系统分组规则（可用 configs/<项目>.facets.json 定义；否则按目录/文件看）', 'No system grouping rules (define them in configs/<project>.facets.json; otherwise browse by directory / file)'));
  const hotLine = (t) => {
    const ev = evidencedIn(idx, t);
    const note = ev < t.fanIn ? T(`（有证据 ${ev} 次）`, ` (${ev} with evidence)`) : '';
    return T(`  ${t.fqn} [${t.kind}] 被引用 ${t.fanIn} 次${note} · ${idx.files.get(t.file)?.path}`, `  ${t.fqn} [${t.kind}] referenced ${t.fanIn} times${note} · ${idx.files.get(t.file)?.path}`);
  };
  lines.push(T('被依赖最多（改动的波及面最大；按“有证据的引用次数”排 —— 仅同名的边不算，见 refs）：\n', 'Most depended-on (biggest blast radius; ranked by references with evidence — same-name-only edges do not count, see refs):\n') + topIn.map(hotLine).join('\n'));
  if (hot.dropped) lines.push(dropNote(ex, hot.dropped, topIn.length, ['类型', 'types'], true));
  lines.push(T('最大的文件（按代码行）：\n', 'Largest files (by code lines):\n') + bigFiles.map((f) => T(`  ${f.path}  ${fmt(f.code)} 代码行`, `  ${f.path}  ${fmt(f.code)} code lines`)).join('\n'));
  if (big.dropped) lines.push(dropNote(ex, big.dropped, bigFiles.length, ['文件', 'files'], true));
  const miss = excludeMissNote(ex, b);
  if (miss) lines.push(miss);
  lines.push(T('深入用：search / symbol / refs / subgraph / file', 'Dig deeper with: search / symbol / refs / subgraph / file'));
  return lines.join('\n');
}

function toolSearch(idx, a) {
  const q = String(a.query || '').toLowerCase();
  const limit = Math.min(Number(a.limit) || 20, 100);
  const scope = String(a.scope || 'any').toLowerCase();

  // 类型命中：类型名 / 限定名 / 文件名
  let hits = scope === 'member' ? [] : idx.b.types.filter((t) =>
    t.name.toLowerCase().includes(q) ||
    t.fqn.toLowerCase().includes(q) ||
    (idx.files.get(t.file)?.path || '').toLowerCase().includes(q));
  if (a.kind) hits = hits.filter((t) => t.kind === a.kind);
  hits.sort((x, y) => y.fanIn - x.fanIn);

  // 成员命中：谁定义了这个成员（搜 “OnPaint” 时这是主要价值）
  let memberHits = [];
  if (scope !== 'type') {
    for (const t of idx.b.types) {
      for (const m of t.memberList || []) {
        if ((m.n || '').toLowerCase().includes(q)) memberHits.push({ t, m });
      }
    }
    memberHits.sort((x, y) => y.t.fanIn - x.t.fanIn);
  }

  // exclude：命中被排空的时刻**不许**说成“没有匹配”——那会读成“这个项目里没有它”
  const ex = parseExclude(a?.exclude);
  const pathOfType = (t) => idx.files.get(t.file)?.path || '';
  const hAll = applyExclude(hits, ex, pathOfType);
  const mAll = applyExclude(memberHits, ex, (h) => pathOfType(h.t));
  hits = hAll.items;
  memberHits = mAll.items;
  const dropped = hAll.dropped + mAll.dropped;

  if (!hits.length && !memberHits.length) {
    if (dropped) {
      const which = ex.map((p) => p.join('/')).join(', ');
      return T(`匹配到 ${fmt(dropped)} 个（类型 + 成员），但都被 exclude "${which}" 排除了 —— 去掉 exclude 再看。`,
        `${fmt(dropped)} match(es) (types + members) were all dropped by exclude "${which}" — retry without it.`);
    }
    return T(`没有匹配 "${a.query}" 的符号（类型名和成员名都找过了）。`, `No symbol matches "${a.query}" (both type names and member names were searched).`);
  }

  const out = [];
  out.push(T(`匹配：${hits.length} 个类型 · ${memberHits.length} 个成员（按被引用次数排序）`, `Matches: ${hits.length} types · ${memberHits.length} members (sorted by reference count)`));
  if (dropped) out.push(dropNote(ex, dropped, hits.length + memberHits.length, ['命中', 'hits']));
  if (hits.length) {
    out.push(T(`类型（显示前 ${Math.min(hits.length, limit)}）：`, `Types (first ${Math.min(hits.length, limit)}):`));
    for (const t of hits.slice(0, limit)) {
      out.push(T(`  ${t.id}\t${t.fqn}${sigText(t)}\t[${t.kind}] 被引 ${t.fanIn} 次\t${idx.files.get(t.file)?.path}:${t.line}`, `  ${t.id}\t${t.fqn}${sigText(t)}\t[${t.kind}] referenced ${t.fanIn} times\t${idx.files.get(t.file)?.path}:${t.line}`) + (t.doc ? T(`\t说明：${briefDoc(t.doc)}`, `\tdoc: ${briefDoc(t.doc)}`) : ''));
    }
  }
  if (memberHits.length) {
    out.push(T(`成员（显示前 ${Math.min(memberHits.length, limit)}）：`, `Members (first ${Math.min(memberHits.length, limit)}):`));
    for (const { t, m } of memberHits.slice(0, limit)) {
      out.push(T(`  ${t.fqn}.${m.n}${sigText(m)}\t[${m.k}]\t${idx.files.get(t.file)?.path}:${m.l}\t（所属类型 id=${t.id}；**该类型**被引 ${t.fanIn} 次）`, `  ${t.fqn}.${m.n}${sigText(m)}\t[${m.k}]\t${idx.files.get(t.file)?.path}:${m.l}\t(owner type id=${t.id}; **that type** is referenced ${t.fanIn} times)`) + (m.d ? T(`\t说明：${briefDoc(m.d)}`, `\tdoc: ${briefDoc(m.d)}`) : ''));
    }
    out.push(T('（成员名后面要看它的上下文，用 symbol 加类型名/id）', '(to see a member in context, call symbol with the type name / id)'));
  }
  const sMiss = excludeMissNote(ex, idx.b);
  if (sMiss) out.push(sMiss);
  return out.join('\n');
}

/**
 * `symbol(…, neighbors: true)` 才追加的“邻居”块：改一个类型时最常接着问的三件事 ——
 * 谁直接引用它 / 它直接引用了谁 / 相关测试文件。
 *
 * 为什么**默认关**：`symbol` 的输出本来就长，上一轮复验明确嫌它啰嗦（两方诉求相反），所以默认一个字节都不变。
 * 排序与 `refs` 一致：先按证据强度（同文件 > import 支撑 > 仅同名）、同档再按权重 —— 否则一堆“仅同名”的边会先把
 * 前 5 个位置占满。要证据标签与**完整**列表，仍然去 `refs`（这里只给“顺手看一眼”的量）。
 */
function neighborBlock(idx, t) {
  const lines = [];
  const rank = (es, other) => (es || []).map((e) => ({ e, o: other(e) })).filter((x) => x.o)
    .sort((x, y) => (EVIDENCE_RANK[evidenceOf(idx, y.e)] - EVIDENCE_RANK[evidenceOf(idx, x.e)]) || ((y.e.w || 1) - (x.e.w || 1)));
  const inb = rank(idx.ins.get(t.id) || [], (e) => idx.byId.get(e.from));
  const outb = rank(idx.outs.get(t.id) || [], (e) => idx.byId.get(e.to));
  const wsum = (l) => l.reduce((a, x) => a + (x.e.w || 1), 0);
  const show = (list, label) => {
    if (!list.length) { lines.push(T(`${label}：无`, `${label}: none`)); return; }
    const top = list.slice(0, 5).map((x) => `${x.o.fqn} [${x.o.kind}] ×${x.e.w || 1}`).join(' · ');
    // 抬头跟 refs **同一个口径**（“N 条边 · 共 M 次”）—— 同一个数在两个工具里不该是两种说法
    lines.push(T(`${label}（${list.length} 条边 · 共 ${fmt(wsum(list))} 次${list.length > 5 ? '，前 5' : ''}）：${top}`,
      `${label} (${list.length} edges · ${fmt(wsum(list))} in total${list.length > 5 ? ', first 5' : ''}): ${top}`));
  };
  lines.push('');
  lines.push(T('邻居（neighbors: true；默认不显示）：', 'Neighbors (neighbors: true; hidden by default):'));
  show(inb, T('被谁引用', 'referenced by'));
  show(outb, T('引用了谁', 'references'));
  // 相关测试文件：口径跟 impact 一致（按路径认的 files[].isTest），三种情况分开说，不把“没认出”说成“没有”
  const tests = [];
  const seen = new Set();
  for (const x of inb) {
    const tf = idx.files.get(x.o.file);
    if (tf?.isTest && !seen.has(tf.path)) { seen.add(tf.path); tests.push(tf.path); }
  }
  const mapTests = idx.b.files.filter((x) => x.isTest).length;
  lines.push(tests.length
    ? T(`相关测试文件（${tests.length} 个）：${tests.slice(0, 5).join(' · ')}${tests.length > 5 ? ` …还有 ${tests.length - 5} 个` : ''}`,
      `Related test files (${tests.length}): ${tests.slice(0, 5).join(' · ')}${tests.length > 5 ? ` …${tests.length - 5} more` : ''}`)
    : (mapTests
      ? T(`相关测试文件：无（图里 ${fmt(mapTests)} 个测试文件，都不引用它）`, `Related test files: none (the map has ${fmt(mapTests)} test files; none of them references it)`)
      : T('相关测试文件：无（图里没认出测试文件）', 'Related test files: none (no test file was recognized in this map)')));
  lines.push(T('（这里只给前 5 个；要证据标签与完整列表：refs(名字, in|out)）', '(top 5 only; for evidence tags and the full lists: refs(name, in|out))'));
  return lines;
}

function toolSymbol(idx, a) {
  const r = resolve(idx, a.name);
  if (r.error) return r.error;
  const t = r.type;
  const f = idx.files.get(t.file);
  const memberCap = Math.min(Math.max(Number(a.members) || 40, 1), 300);
  const members = (t.memberList || []).slice(0, memberCap);
  const lines = [];
  lines.push(`${t.fqn}${sigText(t)}  [${t.kind}]${t.tags?.length ? `  (${t.tags.join(', ')})` : ''}`);
  lines.push(T(`文件：${f?.path}:${t.line}${t.endLine > t.line ? `-${t.endLine}` : ''}   系统：${t.system ? sysLabel(t.system) : '（未分组）'}${t.systemRule ? `（规则 ${t.systemRule}）` : ''}`, `File: ${f?.path}:${t.line}${t.endLine > t.line ? `-${t.endLine}` : ''}   System: ${t.system ? sysLabel(t.system) : '(ungrouped)'}${t.systemRule ? ` (rule ${t.systemRule})` : ''}`));
  const mKinds = Object.entries(t.members || {});
  const mTotal = mKinds.reduce((a, [, v]) => a + v, 0);   // 真实总数（直方图求和）
  const mListed = (t.memberList || []).length;
  lines.push(T(`规模：${t.code} 行代码（该类型区间）· 复杂度≈${t.complexity} · 成员 ${mKinds.map(([k, v]) => `${k} ${v}`).join(' · ') || '无'}`, `Size: ${t.code} lines of code (this type's range) · complexity≈${t.complexity} · members ${mKinds.map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}`));
  lines.push(T(`依赖：被引用 ${t.fanIn} 次 · 引用别人 ${t.fanOut} 次`, `Dependencies: referenced ${t.fanIn} times · references ${t.fanOut} times`));
  if (t.bases?.length) lines.push(T(`基类/接口：${t.bases.join(', ')}`, `Base types / interfaces: ${t.bases.join(', ')}`));
  if (f?.errors) lines.push(T(`注意：该文件有 ${f.errors} 处解析异常，数据可能不全`, `Note: this file has ${f.errors} parse errors — its data may be incomplete`));
  lines.push(T(`说明：${t.doc || '（源码里没有注释说明）'}`, `Doc: ${t.doc || '(no doc comment in the source)'}`));
  if (members.length) {
    // “共 N”写**真实总数**（分档求和），不是列表长度 —— 两者以前相等，现在不相等了就得说清
    lines.push(T(`成员（前 ${members.length} / 共 ${mTotal}）：`, `Members (first ${members.length} / ${mTotal} total):`));
    for (const m of members) lines.push(`  ${m.l}\t${m.k} ${m.n}${sigText(m)}${m.d ? ` — ${String(m.d).slice(0, 80)}` : ''}`);
    if (mListed < mTotal) {
      lines.push(T(`  …另有 ${mTotal - mListed} 个成员的名字没能从语法树里取到，只计入了上面的分档`, `  …${mTotal - mListed} more members had no extractable name; they are only counted above`));
    }
  } else if (mTotal) {
    // 有成员却一个也没列出来：说清楚是什么情况，别让人以为它是空类型
    lines.push(T(`成员：共 ${mTotal} 个（${mKinds.map(([k, v]) => `${k} ${v}`).join(' · ')}），但这些成员的名字没能从语法树里取到，暂不单列`, `Members: ${mTotal} total (${mKinds.map(([k, v]) => `${k} ${v}`).join(' · ')}), but none of their names could be extracted — not listed individually`));
  }
  // 邻居块：**默认不输出**（`a.neighbors` 没给就是 falsy → 一个字节都不变），只有显式要才追加
  if (a.neighbors) lines.push(...neighborBlock(idx, t));
  return lines.join('\n');
}

function toolRefs(idx, a) {
  const r = resolve(idx, a.name);
  if (r.error) return r.error;
  const t = r.type;
  const dir = (a.direction || 'both').toLowerCase();
  const limit = Math.min(Number(a.limit) || 30, 200);
  const out = [];
  let sawNameOnly = false;
  let sawAnyEdge = false;
  const ex = parseExclude(a?.exclude);
  const show = (es, label, pick) => {
    const f = applyExclude(es, ex, (e) => idx.files.get(pick(e).file)?.path || '');
    if (!f.items.length && !f.dropped) { out.push(T(`${label}：无`, `${label}: none`)); return; }
    if (!f.items.length) {
      // 整份名单被排空：不能说“无”（那是静默谎言），要说清是被 exclude 排掉的
      out.push(T(`${label}：本次全部被 exclude 排除（${fmt(f.dropped)} 条边）`, `${label}: everything dropped by exclude (${fmt(f.dropped)} edges)`));
      return;
    }
    es = f.items;
    // 有证据的排前面（同文件 > 有 import 支撑 > 仅同名），同档再按权重：
    // 否则一堆“仅同名”的噪声会把真正的那几条挤出 limit
    es.sort((x, y) => (EVIDENCE_RANK[evidenceOf(idx, y)] - EVIDENCE_RANK[evidenceOf(idx, x)]) || (y.w - x.w));
    // 抬头把条数与**总次数**都写出来：AI 看单条 ×数 与看总量是两件事（只写条数会误读量级）
    const wsum = es.reduce((a, e) => a + (e.w || 1), 0);
    out.push(T(`${label}（${es.length} 条边 · 共 ${fmt(wsum)} 次）：`, `${label} (${es.length} edges · ${fmt(wsum)} in total):`));
    for (const e of es.slice(0, limit)) {
      const o = pick(e);
      const ev = evidenceOf(idx, e);
      if (ev === 'name') sawNameOnly = true;
      sawAnyEdge = true;
      out.push(T(`  ${o.fqn} [${o.kind}]${e.kind === 'inherit' ? ' (继承)' : ''} ×${e.w}  ${idx.files.get(o.file)?.path}:${o.line}`, `  ${o.fqn} [${o.kind}]${e.kind === 'inherit' ? ' (inherits)' : ''} ×${e.w}  ${idx.files.get(o.file)?.path}:${o.line}`) + evidenceTag(ev));
    }
    if (es.length > limit) out.push(T(`  …还有 ${fmt(es.length - limit)} 条没显示（limit 可调，上限 200）`, `  …${fmt(es.length - limit)} more not shown (limit is adjustable, max 200)`));
    if (f.dropped) out.push(dropNote(ex, f.dropped, es.length, ['条边', 'edges']));
  };
  if (dir === 'in' || dir === 'both') show(idx.ins.get(t.id) || [], T('被谁引用', 'referenced by'), (e) => idx.byId.get(e.from));
  if (dir === 'out' || dir === 'both') show(idx.outs.get(t.id) || [], T('引用了谁', 'references'), (e) => idx.byId.get(e.to));
  // ② 复测报告：顶层函数（JS/TS/Python）在这套模型里是**类型**，光给边不给行号时 AI 还得自己翻文件找“第几行调的”。
  // 所以类型也照样给“调用 / 访问位置”（按名字匹配；该类型自己的声明行排掉）。
  // ① 排除集要连**同名成员**的声明行一起排 —— C#/Java/Kotlin 的**构造函数与类同名**，
  // 不排的话每个类的回答里都会多出一条“假调用点”（实测一个 C# 项目 20 个类型各中一个，共 20 处）。
  const typeDecl = memberDeclKeys(idx, [t.name, t.fqn]);
  typeDecl.add(`${t.file}#${t.line}`);
  const typeSites = collectUses(idx, [t.name, t.fqn], typeDecl);
  if (typeSites.length || !engineHasUses(idx)) {
    out.push('');
    out.push(usesLines(idx, typeSites, engineHasUses(idx)));
    // 同名符号会混进来（实测：`refs(某个叫 T 的函数)` 的 557 处里混着 C# 的 `L.T(...)`）。
    // ⚠ 不能把“自己那个与类同名的构造函数”算成同名风险 —— 否则 C# 上几乎每个类都会多打一句废话
    //（复测第三轮抓到）。只有**别的**类型里有这个成员名、或者另有同名类型时才提示。
    const shared = idx.b.types.filter((x) => x.name === t.name).length > 1
      || idx.b.types.some((x) => x !== t && (x.memberList || []).some((m) => m.n === t.name));
    if (typeSites.length && shared) {
      out.push(T('  （按名字匹配：同名的成员 / 类型也会混进这份位置里）',
        '  (matched by name: same-named members / types elsewhere are mixed in)'));
    }
  }
  const rMiss = excludeMissNote(ex, idx.b);
  if (rMiss) out.push(rMiss);
  const legend = sawAnyEdge
    ? T('（边尾的标签：同文件 / **有支撑**（引用方 import 的模块 / 命名空间 / 包能指到目标（Python 的 `from X import Y` 只记得到 X，所以包级也算）、C# / VB 父命名空间）/ 仅同名 —— “仅同名”里既有名字巧合，**也可能有没认出来的真引用**（父命名空间、限定名写法），拿不准就翻源码核对）\n', '(tag after each edge: same file / backed (the referrer imports the target module / namespace / package — a package-level import counts, and a C# / VB parent namespace too) / same name only — that last bucket holds both coincidences and **real references we failed to recognize** (parent namespaces, qualified names), so check the source when in doubt)\n')
    : '';
  return `${t.fqn} [${t.kind}]\n${legend}${out.join('\n')}`;
}

function toolSubgraph(idx, a) {
  const r = resolve(idx, a.name);
  if (r.error) return r.error;
  const depth = Math.max(1, Math.min(Number(a.depth) || 2, 3));
  const seen = new Map([[r.type.id, 0]]);
  let frontier = [r.type.id];
  for (let d = 1; d <= depth; d++) {
    const next = [];
    for (const id of frontier) {
      for (const e of [...(idx.ins.get(id) || []), ...(idx.outs.get(id) || [])]) {
        const other = (idx.ins.get(id) || []).includes(e) ? e.from : e.to;
        if (!seen.has(other)) { seen.set(other, d); next.push(other); }
      }
    }
    frontier = next;
  }
  const lines = [T(`以 ${r.type.fqn} 为中心、深度 ${depth} 的依赖子图：共 ${seen.size} 个符号`, `Dependency subgraph around ${r.type.fqn}, depth ${depth}: ${seen.size} symbols`)];
  for (let d = 0; d <= depth; d++) {
    const at = [...seen].filter(([, dd]) => dd === d).map(([id]) => idx.byId.get(id)).filter(Boolean);
    if (!at.length) continue;
    const shown = at.slice(0, 40);
    // 每层最多列 40 个（控 token），超了要写明“前 N / 共 M”——否则会被当成“这层只有 40 个”
    const head = shown.length < at.length ? `前 ${shown.length} / 共 ${at.length}` : `${at.length}`;
    const headEn = shown.length < at.length ? `first ${shown.length} of ${at.length}` : `${at.length}`;
    lines.push(T(`第 ${d} 层（${head}）：`, `Level ${d} (${headEn}): `) + shown.map((t) => `${t.fqn}[${t.kind}]`).join('  '));
  }
  lines.push(T('（只看名字；细节用 symbol，引用方向用 refs）', '(names only; use symbol for detail, refs for direction)'));
  return lines.join('\n');
}

function toolFile(idx, a) {
  const q = String(a.path || '').toLowerCase();
  const f = idx.b.files.find((x) => x.path.toLowerCase().includes(q));
  if (!f) return T(`没有匹配 "${a.path}" 的文件。用 search 可以按文件名片段搜符号。`, `No file matches "${a.path}". Use search to find symbols by file-name fragment.`);
  const types = idx.b.types.filter((t) => t.file === f.id);
  const lines = [
    T(`${f.path}  [${f.lang}]  ${f.loc} 行（其中代码 ${f.code} / 注释 ${f.comment} / 空 ${f.blank}）`, `${f.path}  [${f.lang}]  ${f.loc} lines total (code ${f.code} / comment ${f.comment} / blank ${f.blank})`),
  ];
  if (f.errors) lines.push(T(`注意：${f.errors} 处解析异常`, `Note: ${f.errors} parse errors`));
  lines.push(T(`类型 ${types.length}：`, `Types ${types.length}: `) + types.map((t) => `${t.fqn && t.fqn !== t.name ? t.fqn : t.name}[${t.kind}]`).join('  '));
  const imports = f.imports || [];
  lines.push(T(`导入（${imports.length}）：${imports.slice(0, 20).join(', ')}${imports.length > 20 ? ` …等 ${imports.length} 条` : ''}`, `Imports (${imports.length}): ${imports.slice(0, 20).join(', ')}${imports.length > 20 ? ` … ${imports.length} in total` : ''}`));
  return lines.join('\n');
}

/** 快照时间（UTC，和 overview 那条同一个来源）；挂在每个工具结果的末尾 */
function stampShort(b) {
  return String(b.generated || '').replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * list(path?, limit?)：目录浏览 —— AI 从零探索陌生库的入口（以前只能靠 search 猜名字）。
 * 不传 path 就列扫描根的顶层；输出里的路径可以直接喂给 file() / search()。
 */
function toolList(idx, a) {
  const b = idx.b;
  const q = String(a.path || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
  const norm = b.files.map((f) => f.path.replace(/\\/g, '/'));
  const scoped = b.files.filter((f, i) => (q === '' ? true : norm[i].toLowerCase() === q || norm[i].toLowerCase().startsWith(q + '/')));
  if (!scoped.length) {
    // 退一步：按「路径段」做近似匹配给候选 —— 段名以 q 开头(3) > 含 q(2) > q 是它的子序列(1)。
    // （原实现是在整条路径里搜子串再往前截，会给出 e2e/ 这种离谱候选、还会漏掉 server/）
    const isSub = (needle, hay) => { let i = 0; for (const ch of hay) if (ch === needle[i]) i++; return needle.length > 0 && i === needle.length; };
    const score = (seg) => (seg.startsWith(q) ? 3 : seg.includes(q) ? 2 : isSub(q, seg) ? 1 : 0);
    const hints = new Map();
    const consider = (p, isDir) => {
      const segs = p.split('/').filter(Boolean);
      for (let k = 0; k < segs.length; k++) {
        const sc = score(segs[k].toLowerCase());
        if (!sc) continue;
        const path = segs.slice(0, k + 1).join('/') + (k === segs.length - 1 && !isDir ? '' : '/');
        if (!hints.has(path) || hints.get(path) < sc) hints.set(path, sc);
      }
    };
    for (const p of norm) {
      consider(p, false);
      const segs = p.split('/').filter(Boolean);
      for (let k = 1; k < segs.length; k++) consider(segs.slice(0, k).join('/'), true);
    }
    const ranked = [...hints].sort((x, y) => y[1] - x[1] || x[0].length - y[0].length || (x[0] < y[0] ? -1 : 1));
    const keep = [];
    for (const [p] of ranked) {
      if (keep.some((k) => p.startsWith(k))) continue; // 父目录已列出就不列子孙
      keep.push(p);
      if (keep.length >= 6) break;
    }
    const hint = keep.join(' · ');
    return T(`没有正好叫 "${a.path}" 的目录或文件。${hint ? `相近的有：${hint}` : '用 search 按名字找符号，或 list() 看扫描根。'}`, `No directory or file matches "${a.path}".${hint ? ` Close ones: ${hint}` : ' Use search to find symbols by name, or list() for the scan root.'}`);
  }
  const prefix = q === '' ? '' : q + '/';
  const dirAgg = new Map();
  const filesHere = [];
  for (const f of scoped) {
    const rest = f.path.replace(/\\/g, '/').slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash >= 0) {
      const d = rest.slice(0, slash);
      const agg = dirAgg.get(d) || { files: 0, types: 0, code: 0 };
      agg.files++; agg.types += (f.types || []).length; agg.code += f.code || 0;
      dirAgg.set(d, agg);
    } else filesHere.push(f);
  }
  const rows = [];
  for (const [d, agg] of [...dirAgg].sort((x, y) => y[1].code - x[1].code)) rows.push({ dir: true, name: prefix + d + '/', agg });
  for (const f of filesHere.sort((x, y) => (y.code || 0) - (x.code || 0))) rows.push({ dir: false, f, name: f.path.replace(/\\/g, '/') });
  const cap = Math.min(Math.max(Number(a.limit) || 40, 1), 200);
  const tot = scoped.reduce((acc, f) => { acc.files++; acc.types += (f.types || []).length; acc.code += f.code || 0; return acc; }, { files: 0, types: 0, code: 0 });
  const out = [];
  out.push(q === ''
    ? T(`扫描根（${(b.source.roots || b.source.labels || []).join(', ')}）：本层 ${rows.length} 项 · 整棵树 ${fmt(tot.files)} 文件 / ${fmt(tot.types)} 类型 / ${fmt(tot.code)} 行代码`, `Scan root (${(b.source.roots || b.source.labels || []).join(', ')}): ${rows.length} entries here · ${fmt(tot.files)} files / ${fmt(tot.types)} types / ${fmt(tot.code)} lines of code in the whole tree`)
    : T(`${prefix}本层 ${rows.length} 项 · 这棵子树 ${fmt(tot.files)} 文件 / ${fmt(tot.types)} 类型 / ${fmt(tot.code)} 行代码`, `${prefix} ${rows.length} entries here · ${fmt(tot.files)} files / ${fmt(tot.types)} types / ${fmt(tot.code)} lines of code below`));
  for (const r of rows.slice(0, cap)) {
    if (r.dir) out.push(T(`  [目录] ${r.name}  ${fmt(r.agg.files)} 文件 · ${fmt(r.agg.types)} 类型 · ${fmt(r.agg.code)} 行`, `  [dir]  ${r.name}  ${fmt(r.agg.files)} files · ${fmt(r.agg.types)} types · ${fmt(r.agg.code)} lines`));
    else out.push(T(`  [文件] ${r.name}  ${fmt(r.f.code)} 行 · ${(r.f.types || []).length} 类型${r.f.errors ? ` · ${r.f.errors} 处解析异常` : ''}`, `  [file] ${r.name}  ${fmt(r.f.code)} lines · ${(r.f.types || []).length} types${r.f.errors ? ` · ${r.f.errors} parse errors` : ''}`));
  }
  if (rows.length > cap) out.push(T(`（只列前 ${cap} / 共 ${rows.length} 项：用 path= 缩到某个子目录，或调大 limit）`, `(first ${cap} of ${rows.length}: narrow it with path=, or raise limit)`));
  out.push(T('（看单个文件的类型/导入用 file，按名字找符号用 search）', '(use file for one file\'s types/imports, search to find symbols by name)'));
  return out.join('\n');
}

/**
 * map(budget)：按 token 预算导出一份骨架地图。
 * 估 token 用 4 字符 ≈ 1 token（本项目标识符为主，这个精度够用）。
 */
function toolMap(idx, a) {
  const b = idx.b;
  const budget = Math.max(300, Math.min(Number(a.budget) || 4000, 200000));
  const est = (s) => Math.ceil(s.length / 4) + 1;
  const out = [];
  let used = 0;
  const push = (s) => { const t = est(s); if (used + t > budget) return false; out.push(s); used += t; return true; };
  const pth = (t) => idx.files.get(t.file)?.path || '';
  const score = (t) => t.fanIn + (t.memberList?.length || 0) / 10;
  const ex = parseExclude(a?.exclude);
  const mt = applyExclude(b.types, ex, pth);
  const types = mt.items;

  push(`# ${b.source.labels.join(', ')}${b.source.git ? ` @ ${b.source.git.commit}` : ''}`);
  push(T(`${fmt(b.files.length)} 文件 / ${fmt(b.totals.types)} 类型 / ${fmt(b.totals.edges)} 依赖边 / ${fmt(b.totals.code)} 行代码`, `${fmt(b.files.length)} files / ${fmt(b.totals.types)} types / ${fmt(b.totals.edges)} dependency edges / ${fmt(b.totals.code)} lines of code`));
  // 上面这行是**项目事实**，exclude 不动它；排除了多少单独说
  if (mt.dropped) push(dropNote(ex, mt.dropped, types.length, ['类型', 'types'], true));
  push('');

  const systems = b.facets?.systems || [];
  if (systems.length) {
    push(T(`## 系统（${systems.length} 个，按体量排序）`, `## Systems (${systems.length}, largest first)`));
    for (const s of [...systems].sort((x, y) => y.types - x.types)) {
      if (!push(T(`[${sysLabel(s.name)}] ${s.types} 类型 / ${s.files} 文件`, `[${sysLabel(s.name)}] ${s.types} types / ${s.files} files`))) break;
      for (const t of types.filter((x) => x.system === s.name).sort((x, y) => score(y) - score(x)).slice(0, 5)) {
        if (!push(T(`  - ${t.fqn} [${t.kind}] 被引${t.fanIn} · ${pth(t)}`, `  - ${t.fqn} [${t.kind}] refs ${t.fanIn} · ${pth(t)}`))) break;
      }
      if (used >= budget * 0.6) break;
    }
    push('');
  }

  if (used < budget) {
    push(T('## 关键类型（被引用最多 = 改动的波及面最大）', '## Key types (most referenced = biggest blast radius)'));
    for (const t of [...types].sort((x, y) => y.fanIn - x.fanIn).slice(0, 25)) {
      if (!push(T(`  ${t.fqn} [${t.kind}] 被引${t.fanIn} · ${pth(t)}`, `  ${t.fqn} [${t.kind}] refs ${t.fanIn} · ${pth(t)}`))) break;
    }
    push('');
  }

  if (used < budget * 0.8) {
    push(T('## 关键成员（挑最重要的几个类型）', '## Key members (from the most important types)'));
    for (const t of [...types].sort((x, y) => score(y) - score(x)).slice(0, 6)) {
      const ms = (t.memberList || []).slice(0, 6);
      if (!ms.length) continue;
      if (!push(`  ${t.name}: ${ms.map((m) => m.n + sigText(m)).join(', ')}`)) break;
    }
    push('');
  }

  const warn = [];
  if (b.unresolved?.unknown) warn.push(T(`名字没匹配上的引用 ${fmt(b.unresolved.unknown)} 处（这些依赖看不到）`, `References whose name did not match: ${fmt(b.unresolved.unknown)} (those dependencies are invisible)`));
  if (b.unresolved?.ambiguous) warn.push(T(`匹配到多个目标的引用 ${fmt(b.unresolved.ambiguous)} 处（**没有计入图里** —— 宁可缺边也不接错）`, `References matching several targets: ${fmt(b.unresolved.ambiguous)} (they are **left out of the graph** — a missing edge beats a wrong one)`));
  const mapMiss = excludeMissNote(ex, b);
  if (mapMiss) push(mapMiss);
  if (warn.length) push(`⚠ ${warn.join('；')}`);
  push(T(`（预算 ~${budget} token，实际约 ${used}；要细节：symbol(id) / refs(名字) / impact(名字)）`, `(budget ~${budget} tokens, actual ~${used}; for detail: symbol(id) / refs(name) / impact(name))`));
  return out.join('\n');
}

/**
 * impact(name, depth)：影响面分析——“改它会影响谁”。
 * 沿**被引用**方向多跳展开，按层给，并明说看不见的部分（诚实优先）。
 */
function toolImpact(idx, a) {
  const r = resolve(idx, a.name);
  if (!r.type) return r.error;
  const t0 = r.type;
  const depth = Math.max(1, Math.min(Number(a.depth) || 2, 4));
  const ex = parseExclude(a?.exclude);
  const b = idx.b;
  const seen = new Set([t0.id]);
  let frontier = [t0.id];
  const layers = [];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next = new Map();
    for (const id of frontier) {
      for (const e of idx.ins.get(id) || []) {
        if (seen.has(e.from)) continue;
        const t = idx.byId.get(e.from);
        if (!t || seen.has(t.id)) continue;
        const cur = next.get(t.id) || { t, kinds: new Set(), w: 0 };
        cur.kinds.add(e.kind || 'ref');
        cur.w += e.w || 1;
        next.set(t.id, cur);
      }
    }
    const list = [...next.values()].sort((x, y) => (y.w + y.t.fanIn) - (x.w + x.t.fanIn));
    if (!list.length) break;
    // exclude 只过滤**显示**，不改遍历（seen / frontier 仍用完整名单）—— 否则“排掉一个目录”会把它下游
    // 的东西一起藏起来，而输出里看不出来
    const lf = applyExclude(list, ex, (x) => idx.files.get(x.t.file)?.path || '');
    layers.push({ d, list: lf.items, dropped: lf.dropped });
    for (const x of list) seen.add(x.t.id);
    frontier = list.map((x) => x.t.id);
  }

  const KIND = { inherit: T('继承', 'inherits'), call: T('调用', 'calls'), type: T('类型引用', 'type ref'), import: T('导入', 'import'), ref: T('引用', 'ref') };
  const out = [T(`影响面：${t0.fqn} [${t0.kind}]（${idx.files.get(t0.file)?.path}:${t0.line}）`, `Impact: ${t0.fqn} [${t0.kind}] (${idx.files.get(t0.file)?.path}:${t0.line})`)];
  out.push(T(`沿“谁引用它”展开 ${depth} 层：`, `Following "who references it" ${depth} levels deep:`));
  if (!layers.length) {
    out.push(T('  （没有已知的引用者：可能是入口/孤立类型，或者引用它的地方没被识别出来）', '  (no known referrers: entry point / isolated type, or the reference was not recognized)'));
  }
  for (const L of layers) {
    out.push('');
    if (!L.list.length) {
      // 整层被排空：绝不说“第 N 层（0 个）” —— 那会被读成“没有”
      out.push(T(`第 ${L.d} 层：本次全部被 exclude 排除（${fmt(L.dropped)} 个类型）`, `Level ${L.d}: everything dropped by exclude (${fmt(L.dropped)} types)`));
      continue;
    }
    out.push(T(`第 ${L.d} 层（${L.list.length} 个）：`, `Level ${L.d} (${L.list.length}):`));
    for (const x of L.list.slice(0, 25)) {
      const kinds = [...x.kinds].map((k) => KIND[k] || k).join('/');
      out.push(`  ${x.t.fqn} [${x.t.kind}] ${kinds} ×${x.w} · ${idx.files.get(x.t.file)?.path}`);
    }
    if (L.list.length > 25) out.push(T(`  …（还有 ${L.list.length - 25} 个）`, `  …(${L.list.length - 25} more)`));
    if (L.dropped) out.push(dropNote(ex, L.dropped, L.list.length, ['类型', 'types']));
  }
  // 会被波及的**测试文件**：单列（用户要的）——“要跑哪些测试”与“哪些生产代码要改”是两件事。
  // 按路径规则认（files[].isTest，规则见 scan.mjs 的 isTestPath）；depth 之外的层不算，和上面的层次一致。
  const droppedTypes = layers.reduce((acc, L) => acc + (L.dropped || 0), 0);
  const testFiles = [];
  const seenTest = new Set();
  for (const L of layers) {
    for (const x of L.list) {
      const f = idx.files.get(x.t.file);
      if (f?.isTest && !seenTest.has(f.path)) { seenTest.add(f.path); testFiles.push(f.path); }
    }
  }
  if (testFiles.length) {
    const show = testFiles.slice(0, 8);
    out.push(T(`会被波及的测试文件（${testFiles.length} 个）：${show.join(' · ')}${testFiles.length > show.length ? ` …还有 ${testFiles.length - show.length} 个` : ''}`,
      `Test files affected (${testFiles.length}): ${show.join(' · ')}${testFiles.length > show.length ? ` …${testFiles.length - show.length} more` : ''}`));
    out.push(T('  （测试文件是按**路径**认的：test / tests / __tests__ 目录 · `.test.` / `.spec.` / `_test.` / `_spec.` · `test_` 开头；认不出的不在这个名单里）',
      '  (test files are recognized **by path**: test / tests / __tests__ dirs · `.test.` / `.spec.` / `_test.` / `_spec.` · a `test_` prefix; anything else is not in this list)'));
  } else {
    // 一个字节都不许懒：名单为空要能分出“测试都不引用它” / “图里真没测试” / “这份图根本没带这个标记”
    // （老引擎扫的图没有 isTest 键，直接说“没认出测试文件”会把“引擎旧”说成“项目没测试”）
    const inMap = b.files.filter((f) => f.isTest).length;
    const hasMark = b.files.some((f) => 'isTest' in f);
    out.push(inMap
      ? T(`测试文件：没有被波及（图里认出 ${fmt(inMap)} 个测试文件，都不引用它）`, `Test files: none affected (the map recognizes ${fmt(inMap)} test files; none of them references it)`)
      : (hasMark
        ? T('测试文件：没有被波及（图里没有测试文件）', 'Test files: none affected (this map has no test files)')
        : T('测试文件：图里没有这个标记（既没认出测试文件，也可能是老版本引擎扫的图 —— 重新扫一次就会带上）',
          'Test files: this map carries no such mark (either no test file was recognized, or the bundle was scanned by an older engine — a re-scan adds it)')));
    // 名单空时尤其要说清：可能是 exclude 把唯一那几个测试类型排掉了（那就不等于“没有测试会挂”）
    if (droppedTypes) out.push(T(`  ⚠ 但本次 exclude 排除了 ${fmt(droppedTypes)} 个类型，测试名单也可能是被它排空的 —— 去掉 exclude 再确认一次。`,
      `  ⚠ but exclude dropped ${fmt(droppedTypes)} types in this call, so the test list may have been emptied by it — retry without exclude to be sure.`));
  }
  out.push('');
  out.push(T('要注意的：', 'Worth knowing:'));
  out.push(T('  · 这是**静态名字匹配**的结果：动态调用 / 反射 / 字符串拼出来的名字看不见；', '  · these edges come from **static name matching**: dynamic calls / reflection / string-built names are invisible;'));
  if (b.unresolved?.unknown) out.push(T(`  · 本项目有 ${fmt(b.unresolved.unknown)} 处引用没匹配上任何类型（这些边不在图里）；`, `  · ${fmt(b.unresolved.unknown)} references in this project matched no type (those edges are not in the graph);`));
  if (b.unresolved?.ambiguous) out.push(T(`  · 还有 ${fmt(b.unresolved.ambiguous)} 处匹配到多个同名目标 —— **这些边没有计入**（宁可缺边也不接错）；`, `  · ${fmt(b.unresolved.ambiguous)} references matched several same-named targets — those edges are **left out** (a missing edge beats a wrong one);`));
  out.push(T('  · 想看更宽：depth 加大（最多 4）；某个方向：refs(名字, in|out)。', '  · go wider: raise depth (max 4); one direction only: refs(name, in|out).'));
  const iMiss = excludeMissNote(ex, b);
  if (iMiss) out.push(iMiss);
  return out.join('\n');
}

const IMPL = { overview: toolOverview, search: toolSearch, symbol: toolSymbol, refs: toolRefs, subgraph: toolSubgraph, file: toolFile, list: toolList, map: toolMap, impact: toolImpact };

function callTool(idx, name, args) {
  const fn = IMPL[name];
  if (!fn) return T(`未知工具：${name}`, `Unknown tool: ${name}`);
  try {
    return fn(idx, args || {});
  } catch (err) {
    return T(`工具执行出错：${err.message}`, `Tool failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

export function startMcp({ bundlePath }) {
  if (!fs.existsSync(bundlePath)) {
    process.stderr.write(T(`MCP：找不到 ${bundlePath}，先跑一次扫描（atlas <路径>）\n`, `MCP: cannot find ${bundlePath} — run a scan first (atlas <path>)\n`));
    process.exit(1);
  }
  let idx = buildIndex(JSON.parse(fs.readFileSync(bundlePath, 'utf8')));
  let mtime = fs.statSync(bundlePath).mtimeMs;
  process.stderr.write(T(`MCP 就绪：${bundlePath}（${idx.b.types.length} 个类型，${TOOLS.length} 个工具）\n`, `MCP ready: ${bundlePath} (${idx.b.types.length} types, ${TOOLS.length} tools)\n`));
  if (process.stdin.isTTY) {
    process.stderr.write(T('提示：这是 stdio 服务 —— 它在等客户端发 JSON-RPC，直接跑就是这个样子（不是卡死）。\n', 'Note: this is a stdio service — it waits for the client to send JSON-RPC, so running it directly looks like this (it is not hung).\n'));
    process.stderr.write(T('     想看工具列表：node src/cli.mjs mcp --list-tools\n', '     list the tools: node src/cli.mjs mcp --list-tools\n'));
    process.stderr.write(T('     想自动化验证：node tests/mcp-selftest.mjs\n', '     verify automatically: node tests/mcp-selftest.mjs\n'));
    process.stderr.write(T('     Ctrl+C 退出。\n', '     Ctrl+C to exit.\n'));
  }

  // bundle 是快照，会过时。每次调用前看一眼 mtime：重新扫描过就自动换新的（AI 不会拿到隔夜数据）
  function maybeReload() {
    try {
      const t = fs.statSync(bundlePath).mtimeMs;
      if (t !== mtime) {
        mtime = t;
        idx = buildIndex(JSON.parse(fs.readFileSync(bundlePath, 'utf8')));
        process.stderr.write(T(`MCP：检测到 bundle 更新，已重载（${idx.b.types.length} 个类型）\n`, `MCP: bundle changed, reloaded (${idx.b.types.length} types)\n`));
      }
    } catch { /* 读不到就继续用旧的 */ }
  }

  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handle(line);
    }
  });

  function handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    if (method === 'initialize') {
      return ok(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'code-atlas', version: idx.b.generator?.version || '0.1.0' },
        // MCP 规范里的字段：客户端会把这段交给模型，相当于"使用说明书 + 边界声明"
        instructions: INSTRUCTIONS,
      });
    }
    if (method === 'notifications/initialized' || String(method).startsWith('notifications/')) return;
    if (method === 'ping') return ok(id, {});
    if (method === 'resources/list') return ok(id, { resources: [] });
    if (method === 'resources/templates/list') return ok(id, { resourceTemplates: [] });
    if (method === 'prompts/list') return ok(id, { prompts: [] });
    if (method === 'tools/list') return ok(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      maybeReload();
      const text = callTool(idx, name, args);
      // 结尾挂一条快照时间（overview 那行已经写全了，不重复）：单点调用时也能看出数据新不新
      const body = name === 'overview' ? text : `${text}\n${T(`（快照 ${stampShort(idx.b)}）`, `(snapshot ${stampShort(idx.b)})`)}`;
      return ok(id, { content: [{ type: 'text', text: body }], isError: false });
    }
    if (id !== undefined) fail(id, -32601, T(`不支持的方法：${method}`, `Unsupported method: ${method}`));
  }

  // 让调用方能优雅收尾
  process.stdin.on('end', () => process.exit(0));
}
