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
import { t as T, sysLabel } from './i18n.mjs';

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
  '- `refs` tags every edge with its evidence strength: `same file` (both sides in one file — solid) > `import-backed` (the',
  '  referring file imports a module of that name — matched by module name, so treat it as strong evidence, not proof) >',
  '  `same name only` (usually a coincidence; do not read it as a real dependency). Solitary `same name only` edges are why',
  '  a raw reference count can be misleading, so the `overview` "most depended-on" list is ranked by references with',
  '  evidence instead (the number in brackets is how many count);',
  '- Files with parse errors are flagged individually; their data may be incomplete;',
  '- Top-level functions in JS / TS are recorded as [function] **types**, not members: search(scope="member") will not find',
  '  them — use the default scope (any) or scope="type";',
  '- Dependency edges are **type-level**: there are no per-call-site edges, so "who calls method X" cannot be answered',
  '  exactly. `refs` / `symbol` do accept a member name or `Type.Member`, and answer with the owning type plus that type\'s',
  '  referrers (an upper bound); for exact call sites, search the method name inside those referrer files;',
  '  `area(int, int): double`, or just `(int, int)` when the grammar gives the return type no name. A member printed without',
  '  a signature means "not extracted", **not** "takes no arguments" — do not read absence as fact;',
  '- Decompiled output (.dll / .exe / .jar) carries no source comments, so an empty "description" is expected;',
  '- Every path in the output is **relative to the scan root**, which overview reports (use it to build absolute paths and read source yourself);',
  '- The data is a snapshot (UTC): overview spells out the generation time (scan options included) and every tool result ends',
  '  with the same short "snapshot" stamp; a freshly scanned bundle is picked up automatically, but an **engine code update**',
  '  does need this server process restarted (the client reconnects and gets the new tool list);',
  '- overview also checks freshness: it re-stats the files already in the map, and when some of them changed on disk after',
  '  the scan it says so (`N mapped files changed…`, of which M are timestamp-only). It only covers files already in the',
  '  map — files added or removed on disk are not detected there, so a re-scan is still how you pick those up;',
  '- `impact` also lists the **test files** that would be affected, recognized **by path** (test / tests / __tests__ dirs,',
  '  `.test.` / `.spec.` / `_test.` / `_spec.`, or a `test_` prefix). A project',
  '  that keeps its tests elsewhere will not be seen',
  '  there — and when the list is empty, impact says whether that means "no test references it" or "no test files were',
  '  recognized in this map", so an empty list is never mistaken for safety. Test files are matched by path only — a bundle',
  '  scanned by a much older engine carries no such marks at all, and impact says so instead of implying "no tests exist";',
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

const TOOLS = [
  {
    name: 'overview',
    description: 'Project overview: size, systems/modules, most depended-on symbols, largest files, plus a freshness check (files already in the map that changed on disk after the scan — it does not see files added or removed). Call this first to get the big picture.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'symbol',
    description: 'Everything about one symbol (type): description, file:line, signature (parameter list + return type, when the grammar exposes it), member list, base types, dependents/dependencies, owning system. Members are listed with their own id/line; a **member** name or `Type.Member` is accepted too and answered with its owning type.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'id (number) or a name / qualified name' },
        members: { type: 'number', description: 'Max members to list, default 40 (max 300) — raise it when you need the whole member list' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'refs',
    description: 'References: who references it (in) / what it references (out). Use this before changing code to see the blast radius.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        direction: { type: 'string', description: 'in | out | both (default both)' },
        limit: { type: 'number', description: 'Default 30' },
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

function basename(p) {
  return String(p).split('/').pop();
}

/** 源码后缀：判“import 是否指到这个文件”时用来去掉尾部扩展名（'util.log-or-console' 这种不能被当成扩展名切掉） */
const SRC_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'java', 'cs', 'kt', 'kts', 'go', 'rs', 'rb', 'php',
  'lua', 'swift', 'scala', 'ex', 'exs', 'zig', 'hcl', 'tf', 'sol', 'tla', 'res', 're', 'ml', 'mli', 'graphql', 'gql',
  'sh', 'bash', 'ps1', 'el', 'c', 'h', 'hpp', 'cpp', 'cc', 'dart', 'jl', 'pl', 'r', 'json', 'yaml', 'yml', 'toml', 'html',
]);

/** 模块名归一：'x/y/util.log-or-console.js' 与 './util.log-or-console' 都算 'util.log-or-console' */
function moduleKey(p) {
  const b = basename(String(p || ''));
  const m = b.match(/\.([A-Za-z0-9]+)$/);
  return m && SRC_EXT.has(m[1].toLowerCase()) ? b.slice(0, -m[0].length) : b;
}

/**
 * 引用证据强度 —— 依赖边是静态名字匹配，所以“同名但无关”的边会混进来：实测（一个真实 monorepo 样本）
 * 有个函数 145 条入边里 141 条来自别的文件里同名对象的方法调用，跟它根本无关。
 * 读侧分三档（不动引擎数据）：同文件最硬；引用方文件的 imports 能指到被引用方那个文件 = 有 import 支撑；
 * 剩下只共享一个名字的归“仅同名”，噪声主要在这一档。
 */
function evidenceOf(idx, e) {
  const src = idx.byId.get(e.from);
  const dst = idx.byId.get(e.to);
  if (!src || !dst) return 'name';
  if (src.file === dst.file) return 'same';
  const dstPath = idx.files.get(dst.file)?.path;
  const f = idx.files.get(src.file);
  if (dstPath && f) {
    const key = moduleKey(dstPath);
    for (const raw of f.imports || []) if (moduleKey(raw) === key) return 'import';
  }
  return 'name';
}

const EVIDENCE_RANK = { same: 2, import: 1, name: 0 };

/** refs 每行尾的短标签（有证据的排前面，标了才看得出来哪几条是噪声） */
function evidenceTag(ev) {
  if (ev === 'same') return T('  [同文件]', '  [same file]');
  if (ev === 'import') return T('  [import]', '  [import]');
  return T('  [仅同名]', '  [same name only]');
}

/**
 * 某个类型“算数的”被引用**次数**（同文件 + 有 import 支撑的边，按权重相加）—— overview 热点榜拿它排序。
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

/** 成员名被交给 refs / symbol / subgraph / impact 时的回答（诚实地讲清“能答什么”与“怎么接下一步”） */
function memberNote(idx, name, hits) {
  const head = T(`「${name}」是**成员**，不是类型。本图的依赖边只记**类型级**（成员级的调用点没有逐个记录），所以不能直接列出“谁调用了它”。`,
    `"${name}" is a **member**, not a type. Dependency edges here are **type-level** (per-call-site references are not recorded), so we cannot list "who calls it" directly.`);
  const rows = hits.slice(0, 12).map(({ t, m }) => {
    const f = idx.files.get(t.file);
    const ev = evidencedIn(idx, t);
    return T(`  ${m.l}\t${t.fqn}.${m.n}\t[${m.k}]\t${f ? f.path : '?'}:${m.l}  （所属类型 id=${t.id}，被引 ${t.fanIn} 次${ev < t.fanIn ? `，其中算数的 ${ev} 次` : ''}）`,
      `  ${m.l}\t${t.fqn}.${m.n}\t[${m.k}]\t${f ? f.path : '?'}:${m.l}  (owner type id=${t.id}, referenced ${t.fanIn} times${ev < t.fanIn ? `, ${ev} with evidence` : ''})`);
  });
  const tail = T(`→ 想看“谁可能调用它”：对上面每个类型调 refs(id) —— 那是**超集**，不等于该方法的调用点；\n  要精确的调用点，就在那些引用方的文件里搜方法名。`,
    `→ To narrow down callers: call refs(id) on each owner type above — that is an **upper bound**, not the exact call sites;\n  for exact call sites, search the method name inside those referrer files.`);
  return `${head}\n${rows.join('\n')}\n${tail}`;
}

/**
 * 快照新鲜度：bundle 是一份快照，**图里那些文件在磁盘上可能已经变了**。
 *
 * 只 re-stat「已经纳入图里的文件」（N 次 stat，不遍历目录）—— 代价与收益对等：报“改动”只要知道路径，
 * 报“新增”得真去遍历目录（还要套 ignore 规则与扩展名规则），那是重新扫描的事。所以这行**只覆盖图里已有的文件**，
 * 目录级的新增 / 删除它发现不了，措辞里也如实限定（不承诺完整性）。
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

function toolOverview(idx) {
  const b = idx.b;
  // 热点榜按“有证据的引用数”排（并列再按原始引用数）——
  // 不这么排的话，“同名但无关”的边会把一个没人真用的类型顶到第一（实测样本上就是这样）
  const topIn = b.types.slice()
    .sort((a, c) => (evidencedIn(idx, c) - evidencedIn(idx, a)) || (c.fanIn - a.fanIn))
    .slice(0, 8);
  const bigFiles = b.files.slice().sort((a, c) => c.code - a.code).slice(0, 6);
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
  lines.push(T('最大的文件（按代码行）：\n', 'Largest files (by code lines):\n') + bigFiles.map((f) => T(`  ${f.path}  ${fmt(f.code)} 代码行`, `  ${f.path}  ${fmt(f.code)} code lines`)).join('\n'));
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
  const memberHits = [];
  if (scope !== 'type') {
    for (const t of idx.b.types) {
      for (const m of t.memberList || []) {
        if ((m.n || '').toLowerCase().includes(q)) memberHits.push({ t, m });
      }
    }
    memberHits.sort((x, y) => y.t.fanIn - x.t.fanIn);
  }

  if (!hits.length && !memberHits.length) return T(`没有匹配 "${a.query}" 的符号（类型名和成员名都找过了）。`, `No symbol matches "${a.query}" (both type names and member names were searched).`);

  const out = [];
  out.push(T(`匹配：${hits.length} 个类型 · ${memberHits.length} 个成员（按被引用次数排序）`, `Matches: ${hits.length} types · ${memberHits.length} members (sorted by reference count)`));
  if (hits.length) {
    out.push(T(`类型（显示前 ${Math.min(hits.length, limit)}）：`, `Types (first ${Math.min(hits.length, limit)}):`));
    for (const t of hits.slice(0, limit)) {
      out.push(T(`  ${t.id}\t${t.fqn}${sigText(t)}\t[${t.kind}] 被引 ${t.fanIn} 次\t${idx.files.get(t.file)?.path}:${t.line}`, `  ${t.id}\t${t.fqn}${sigText(t)}\t[${t.kind}] referenced ${t.fanIn} times\t${idx.files.get(t.file)?.path}:${t.line}`) + (t.doc ? T(`\t说明：${briefDoc(t.doc)}`, `\tdoc: ${briefDoc(t.doc)}`) : ''));
    }
  }
  if (memberHits.length) {
    out.push(T(`成员（显示前 ${Math.min(memberHits.length, limit)}）：`, `Members (first ${Math.min(memberHits.length, limit)}):`));
    for (const { t, m } of memberHits.slice(0, limit)) {
      out.push(T(`  ${t.fqn}.${m.n}${sigText(m)}\t[${m.k}]\t${idx.files.get(t.file)?.path}:${m.l}\t（所属类型 id=${t.id}，被引 ${t.fanIn} 次）`, `  ${t.fqn}.${m.n}${sigText(m)}\t[${m.k}]\t${idx.files.get(t.file)?.path}:${m.l}\t(owner type id=${t.id}, referenced ${t.fanIn} times)`) + (m.d ? T(`\t说明：${briefDoc(m.d)}`, `\tdoc: ${briefDoc(m.d)}`) : ''));
    }
    out.push(T('（成员名后面要看它的上下文，用 symbol 加类型名/id）', '(to see a member in context, call symbol with the type name / id)'));
  }
  return out.join('\n');
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
  const show = (es, label, pick) => {
    if (!es.length) { out.push(T(`${label}：无`, `${label}: none`)); return; }
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
      out.push(T(`  ${o.fqn} [${o.kind}]${e.kind === 'inherit' ? ' (继承)' : ''} ×${e.w}  ${idx.files.get(o.file)?.path}:${o.line}`, `  ${o.fqn} [${o.kind}]${e.kind === 'inherit' ? ' (inherits)' : ''} ×${e.w}  ${idx.files.get(o.file)?.path}:${o.line}`) + evidenceTag(ev));
    }
    if (es.length > limit) out.push(T(`  …还有 ${fmt(es.length - limit)} 条没显示（limit 可调，上限 200）`, `  …${fmt(es.length - limit)} more not shown (limit is adjustable, max 200)`));
  };
  if (dir === 'in' || dir === 'both') show(idx.ins.get(t.id) || [], T('被谁引用', 'referenced by'), (e) => idx.byId.get(e.from));
  if (dir === 'out' || dir === 'both') show(idx.outs.get(t.id) || [], T('引用了谁', 'references'), (e) => idx.byId.get(e.to));
  const legend = sawNameOnly
    ? T('（边尾的标签：同文件 / import 有支撑 / 仅同名 —— 后两档是按模块名近似判的；“仅同名”多半只是名字巧合，别当真）\n', '(tag after each edge: same file / import-backed / same name only — the latter two are matched by module name; "same name only" is usually a coincidence, do not trust it)\n')
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

  push(`# ${b.source.labels.join(', ')}${b.source.git ? ` @ ${b.source.git.commit}` : ''}`);
  push(T(`${fmt(b.files.length)} 文件 / ${fmt(b.totals.types)} 类型 / ${fmt(b.totals.edges)} 依赖边 / ${fmt(b.totals.code)} 行代码`, `${fmt(b.files.length)} files / ${fmt(b.totals.types)} types / ${fmt(b.totals.edges)} dependency edges / ${fmt(b.totals.code)} lines of code`));
  push('');

  const systems = b.facets?.systems || [];
  if (systems.length) {
    push(T(`## 系统（${systems.length} 个，按体量排序）`, `## Systems (${systems.length}, largest first)`));
    for (const s of [...systems].sort((x, y) => y.types - x.types)) {
      if (!push(T(`[${sysLabel(s.name)}] ${s.types} 类型 / ${s.files} 文件`, `[${sysLabel(s.name)}] ${s.types} types / ${s.files} files`))) break;
      for (const t of b.types.filter((x) => x.system === s.name).sort((x, y) => score(y) - score(x)).slice(0, 5)) {
        if (!push(T(`  - ${t.fqn} [${t.kind}] 被引${t.fanIn} · ${pth(t)}`, `  - ${t.fqn} [${t.kind}] refs ${t.fanIn} · ${pth(t)}`))) break;
      }
      if (used >= budget * 0.6) break;
    }
    push('');
  }

  if (used < budget) {
    push(T('## 关键类型（被引用最多 = 改动的波及面最大）', '## Key types (most referenced = biggest blast radius)'));
    for (const t of [...b.types].sort((x, y) => y.fanIn - x.fanIn).slice(0, 25)) {
      if (!push(T(`  ${t.fqn} [${t.kind}] 被引${t.fanIn} · ${pth(t)}`, `  ${t.fqn} [${t.kind}] refs ${t.fanIn} · ${pth(t)}`))) break;
    }
    push('');
  }

  if (used < budget * 0.8) {
    push(T('## 关键成员（挑最重要的几个类型）', '## Key members (from the most important types)'));
    for (const t of [...b.types].sort((x, y) => score(y) - score(x)).slice(0, 6)) {
      const ms = (t.memberList || []).slice(0, 6);
      if (!ms.length) continue;
      if (!push(`  ${t.name}: ${ms.map((m) => m.n + sigText(m)).join(', ')}`)) break;
    }
    push('');
  }

  const warn = [];
  if (b.unresolved?.unknown) warn.push(T(`名字没匹配上的引用 ${fmt(b.unresolved.unknown)} 处（这些依赖看不到）`, `References whose name did not match: ${fmt(b.unresolved.unknown)} (those dependencies are invisible)`));
  if (b.unresolved?.ambiguous) warn.push(T(`匹配到多个目标的引用 ${fmt(b.unresolved.ambiguous)} 处（只取了一个，可能不准）`, `References matching several targets: ${fmt(b.unresolved.ambiguous)} (only one was taken — may be off)`));
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
    layers.push({ d, list });
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
    out.push(T(`第 ${L.d} 层（${L.list.length} 个）：`, `Level ${L.d} (${L.list.length}):`));
    for (const x of L.list.slice(0, 25)) {
      const kinds = [...x.kinds].map((k) => KIND[k] || k).join('/');
      out.push(`  ${x.t.fqn} [${x.t.kind}] ${kinds} ×${x.w} · ${idx.files.get(x.t.file)?.path}`);
    }
    if (L.list.length > 25) out.push(T(`  …（还有 ${L.list.length - 25} 个）`, `  …(${L.list.length - 25} more)`));
  }
  // 会被波及的**测试文件**：单列（用户要的）——“要跑哪些测试”与“哪些生产代码要改”是两件事。
  // 按路径规则认（files[].isTest，规则见 scan.mjs 的 isTestPath）；depth 之外的层不算，和上面的层次一致。
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
  }
  out.push('');
  out.push(T('要注意的：', 'Worth knowing:'));
  out.push(T('  · 这是**静态名字匹配**的结果：动态调用 / 反射 / 字符串拼出来的名字看不见；', '  · these edges come from **static name matching**: dynamic calls / reflection / string-built names are invisible;'));
  if (b.unresolved?.unknown) out.push(T(`  · 本项目有 ${fmt(b.unresolved.unknown)} 处引用没匹配上任何类型（这些边不在图里）；`, `  · ${fmt(b.unresolved.unknown)} references in this project matched no type (those edges are not in the graph);`));
  if (b.unresolved?.ambiguous) out.push(T(`  · 还有 ${fmt(b.unresolved.ambiguous)} 处匹配到多个同名目标，只取了一个；`, `  · ${fmt(b.unresolved.ambiguous)} references matched several same-named targets; only one was taken;`));
  out.push(T('  · 想看更宽：depth 加大（最多 4）；某个方向：refs(名字, in|out)。', '  · go wider: raise depth (max 4); one direction only: refs(name, in|out).'));
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
