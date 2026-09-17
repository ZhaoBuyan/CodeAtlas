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
  'How to use it: start with overview for the big picture, then search for symbols (it returns ids), then drill down with',
  'symbol / refs / subgraph / impact. When context is tight, call map(budget) first to get the skeleton',
  '(systems -> key types -> key members).',
  '',
  'Boundaries you must know (honesty first — do not treat inference as fact):',
  '- Types / members / line counts / imports come from the syntax tree and are trustworthy; dependency edges come from static',
  '  **name matching** — dynamic calls, reflection and names built by string concatenation are invisible, and the counts of',
  '  unmatched and ambiguous references are reported explicitly in overview and impact;',
  '- Files with parse errors are flagged individually; their data may be incomplete;',
  '- Decompiled output (.dll / .exe / .jar) carries no source comments, so an empty "description" is expected;',
  '- Every path in the output is **relative to the scan root**, which overview reports (use it to build absolute paths and read source yourself);',
  '- The data is a snapshot: overview shows the generation time, and the server picks up a freshly scanned bundle automatically, no restart needed.',
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
    description: 'Project overview: size, systems/modules, most depended-on symbols, largest files. Call this first to get the big picture.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search',
    description: 'Search by name: type names / qualified names / file-name fragments. **Member names are included by default** (searching "OnPaint" finds who declares that method). Returns type ids for symbol/refs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name fragment, e.g. "Logger" / "Players" / "OnPaint"' },
        scope: { type: 'string', enum: ['any', 'type', 'member'], description: 'Where to search: any (default, types + members) / type (type names only) / member (member names only)' },
        kind: { type: 'string', description: 'Optional: restrict to one kind (class/interface/enum/function/module...); applies to types only' },
        limit: { type: 'number', description: 'Maximum number of results, default 20' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'symbol',
    description: 'Everything about one symbol (type): description, file:line, member list, base types, dependents/dependencies, owning system.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'id (number) or a name / qualified name' } },
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
    description: 'Impact analysis: who is affected if this type changes — multi-hop expansion along "who references it" (2 levels by default), plus an explicit statement of what is invisible (static name matching cannot see dynamic calls or reflection).',
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

function resolve(idx, key) {
  const s = String(key ?? '').trim();
  if (/^\d+$/.test(s) && idx.byId.has(Number(s))) return { type: idx.byId.get(Number(s)) };
  const low = s.toLowerCase();
  const exact = idx.b.types.filter((t) => t.name.toLowerCase() === low || t.fqn.toLowerCase() === low);
  if (exact.length === 1) return { type: exact[0] };
  const hits = idx.b.types.filter((t) => t.name.toLowerCase().includes(low) || t.fqn.toLowerCase().includes(low));
  if (hits.length === 1) return { type: hits[0] };
  if (!hits.length) return { error: T(`找不到匹配 "${s}" 的符号。用 search 先找找。`, `No symbol matches "${s}". Try search first.`) };
  return {
    error: T(`"${s}" 匹配到 ${hits.length} 个，请用更精确的名字或 id：\n`, `"${s}" matched ${hits.length} symbols — use a more precise name or id:\n`) +
      hits.slice(0, 12).map((t) => `  ${t.id}  ${t.fqn}  [${t.kind}]  ${idx.files.get(t.file)?.path}`).join('\n'),
  };
}

function toolOverview(idx) {
  const b = idx.b;
  const topIn = b.types.slice().sort((a, c) => c.fanIn - a.fanIn).slice(0, 8);
  const bigFiles = b.files.slice().sort((a, c) => c.code - a.code).slice(0, 6);
  const lines = [];
  lines.push(T(`项目：${b.source.labels.join(', ')}${b.source.git ? ` @ ${b.source.git.commit}` : ''}`, `Project: ${b.source.labels.join(', ')}${b.source.git ? ` @ ${b.source.git.commit}` : ''}`));
  const roots = (b.source.roots || []).join('  ');
  if (roots) lines.push(T(`扫描根：${roots}（输出里的路径都相对于它）`, `Scan root: ${roots} (paths in the output are relative to it)`));
  const so = b.source.scanOptions || {};
  const when = String(b.generated || '').replace('T', ' ').slice(0, 19);
  lines.push(T(`数据快照：${when} · 扫描耗时 ${(Number(b.source.scanMs || 0) / 1000).toFixed(1)}s · 语言 ${so.lang || 'auto'} · 单文件上限 ${so.maxKb || 1024}KB · ${so.incremental ? '增量' : '全量'}`, `Snapshot: ${when} · scan took ${(Number(b.source.scanMs || 0) / 1000).toFixed(1)}s · languages ${so.lang || 'auto'} · max file ${so.maxKb || 1024}KB · ${so.incremental ? 'incremental' : 'full'}`));
  lines.push(T(`规模：${fmt(b.files.length)} 文件 · ${fmt(b.totals.types)} 类型 · ${fmt(b.totals.edges)} 依赖边 · ${fmt(b.totals.code)} 行代码`, `Size: ${fmt(b.files.length)} files · ${fmt(b.totals.types)} types · ${fmt(b.totals.edges)} dependency edges · ${fmt(b.totals.code)} lines of code`));
  if (b.totals.parseErrors) lines.push(T(`注意：${b.totals.parseErrors} 处语法树解析异常（这些文件数据可能不全）`, `Note: ${b.totals.parseErrors} parse errors (data in those files may be incomplete)`));
  if (b.totals.compilerGenerated) lines.push(T(`注意：${b.totals.compilerGenerated} 个编译器生成/反编译生成类型（非手写代码）`, `Note: ${b.totals.compilerGenerated} compiler-generated / decompiled types (not hand-written code)`));
  if (b.totals.nonUtf8Files) lines.push(T(`注意：${b.totals.nonUtf8Files} 个文件可能不是 UTF-8 编码（其中的注释 / 字符串是乱码）`, `Note: ${b.totals.nonUtf8Files} files are probably not UTF-8 (their comments / strings are mojibake)`));
  // 诚实边界：把"依赖边是名字匹配"这个前提摆在第一屏——只调 overview 的 AI 也得看得到
  const un = b.unresolved || {};
  lines.push(T(`可信度：依赖边是静态名字匹配（动态调用 / 反射 / 字符串拼名看不见）——未匹配 ${fmt(un.unknown || 0)} 处 · 同名歧义 ${fmt(un.ambiguous || 0)} 处`, `Confidence: dependency edges are static name matches (dynamic calls / reflection / string-built names are invisible) — ${fmt(un.unknown || 0)} unmatched · ${fmt(un.ambiguous || 0)} ambiguous`));
  const sys = b.facets?.systems || [];
  if (sys.length) lines.push(T(`系统划分（${b.facets.configFile}）：\n`, `Systems (${b.facets.configFile}):\n`) + sys.map((s) => T(`  ${sysLabel(s.name)}：${fmt(s.loc)} 行 · ${s.types} 类型 · ${s.files} 文件`, `  ${sysLabel(s.name)}: ${fmt(s.loc)} lines · ${s.types} types · ${s.files} files`)).join('\n'));
  else lines.push(T('没有系统分组规则（可用 configs/<项目>.facets.json 定义；否则按目录/文件看）', 'No system grouping rules (define them in configs/<project>.facets.json; otherwise browse by directory / file)'));
  lines.push(T('被依赖最多（改动的波及面最大）：\n', 'Most depended-on (biggest blast radius):\n') + topIn.map((t) => T(`  ${t.fqn} [${t.kind}] 被 ${t.fanIn} 处引用 · ${idx.files.get(t.file)?.path}`, `  ${t.fqn} [${t.kind}] referenced by ${t.fanIn} · ${idx.files.get(t.file)?.path}`)).join('\n'));
  lines.push(T('最大的文件：\n', 'Largest files:\n') + bigFiles.map((f) => T(`  ${f.path}  ${fmt(f.code)} 行`, `  ${f.path}  ${fmt(f.code)} lines`)).join('\n'));
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
      out.push(T(`  ${t.id}\t${t.fqn}\t[${t.kind}] 被引 ${t.fanIn} 次\t${idx.files.get(t.file)?.path}:${t.line}`, `  ${t.id}\t${t.fqn}\t[${t.kind}] referenced ${t.fanIn} times\t${idx.files.get(t.file)?.path}:${t.line}`));
    }
  }
  if (memberHits.length) {
    out.push(T(`成员（显示前 ${Math.min(memberHits.length, limit)}）：`, `Members (first ${Math.min(memberHits.length, limit)}):`));
    for (const { t, m } of memberHits.slice(0, limit)) {
      out.push(T(`  ${t.fqn}.${m.n}\t[${m.k}]\t${idx.files.get(t.file)?.path}:${m.l}\t（定义在 ${t.id} ${t.name}）`, `  ${t.fqn}.${m.n}\t[${m.k}]\t${idx.files.get(t.file)?.path}:${m.l}\t(defined in ${t.id} ${t.name})`));
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
  const members = (t.memberList || []).slice(0, 40);
  const lines = [];
  lines.push(`${t.fqn}  [${t.kind}]${t.tags?.length ? `  (${t.tags.join(', ')})` : ''}`);
  lines.push(T(`文件：${f?.path}:${t.line}${t.endLine > t.line ? `-${t.endLine}` : ''}   系统：${t.system ? sysLabel(t.system) : '（未分组）'}${t.systemRule ? `（规则 ${t.systemRule}）` : ''}`, `File: ${f?.path}:${t.line}${t.endLine > t.line ? `-${t.endLine}` : ''}   System: ${t.system ? sysLabel(t.system) : '(ungrouped)'}${t.systemRule ? ` (rule ${t.systemRule})` : ''}`));
  lines.push(T(`规模：${t.code} 行代码 · 复杂度≈${t.complexity} · 成员 ${Object.entries(t.members || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '无'}`, `Size: ${t.code} lines of code · complexity≈${t.complexity} · members ${Object.entries(t.members || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}`));
  lines.push(T(`依赖：被 ${t.fanIn} 处引用 · 引用了 ${t.fanOut} 个`, `Dependencies: referenced by ${t.fanIn} · references ${t.fanOut}`));
  if (t.bases?.length) lines.push(T(`基类/接口：${t.bases.join(', ')}`, `Base types / interfaces: ${t.bases.join(', ')}`));
  if (f?.errors) lines.push(T(`注意：该文件有 ${f.errors} 处解析异常，数据可能不全`, `Note: this file has ${f.errors} parse errors — its data may be incomplete`));
  lines.push(T(`说明：${t.doc || '（源码里没有注释说明）'}`, `Doc: ${t.doc || '(no doc comment in the source)'}`));
  if (members.length) {
    lines.push(T(`成员（前 ${members.length} / 共 ${(t.memberList || []).length}）：`, `Members (first ${members.length} / ${(t.memberList || []).length} total):`));
    for (const m of members) lines.push(`  ${m.l}\t${m.k} ${m.n}${m.d ? ` — ${String(m.d).slice(0, 80)}` : ''}`);
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
  const show = (es, label, pick) => {
    if (!es.length) { out.push(T(`${label}：无`, `${label}: none`)); return; }
    es.sort((x, y) => y.w - x.w);
    out.push(`${label}（${es.length}）：`);
    for (const e of es.slice(0, limit)) {
      const o = pick(e);
      out.push(T(`  ${o.fqn} [${o.kind}]${e.kind === 'inherit' ? ' (继承)' : ''} ×${e.w}  ${idx.files.get(o.file)?.path}:${o.line}`, `  ${o.fqn} [${o.kind}]${e.kind === 'inherit' ? ' (inherits)' : ''} ×${e.w}  ${idx.files.get(o.file)?.path}:${o.line}`));
    }
    if (es.length > limit) out.push(T(`  …还有 ${fmt(es.length - limit)} 条没显示（limit 可调，上限 200）`, `  …${fmt(es.length - limit)} more not shown (limit is adjustable, max 200)`));
  };
  if (dir === 'in' || dir === 'both') show(idx.ins.get(t.id) || [], T('被谁引用', 'referenced by'), (e) => idx.byId.get(e.from));
  if (dir === 'out' || dir === 'both') show(idx.outs.get(t.id) || [], T('引用了谁', 'references'), (e) => idx.byId.get(e.to));
  return `${t.fqn} [${t.kind}]\n${out.join('\n')}`;
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
    lines.push(T(`第 ${d} 层（${at.length}）：`, `Level ${d} (${at.length}): `) + at.slice(0, 40).map((t) => `${t.fqn}[${t.kind}]`).join('  '));
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
    T(`${f.path}  [${f.lang}]  ${f.loc} 行（代码 ${f.code} / 注释 ${f.comment} / 空 ${f.blank}）`, `${f.path}  [${f.lang}]  ${f.loc} lines (code ${f.code} / comment ${f.comment} / blank ${f.blank})`),
  ];
  if (f.errors) lines.push(T(`注意：${f.errors} 处解析异常`, `Note: ${f.errors} parse errors`));
  lines.push(T(`类型 ${types.length}：`, `Types ${types.length}: `) + types.map((t) => `${t.name}[${t.kind}]`).join('  '));
  const imports = f.imports || [];
  lines.push(T(`导入（${imports.length}）：${imports.slice(0, 20).join(', ')}${imports.length > 20 ? ` …等 ${imports.length} 条` : ''}`, `Imports (${imports.length}): ${imports.slice(0, 20).join(', ')}${imports.length > 20 ? ` … ${imports.length} in total` : ''}`));
  return lines.join('\n');
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
      if (!push(`  ${t.name}: ${ms.map((m) => m.n).join(', ')}`)) break;
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
  out.push('');
  out.push(T('要注意的：', 'Worth knowing:'));
  out.push(T('  · 这是**静态名字匹配**的结果：动态调用 / 反射 / 字符串拼出来的名字看不见；', '  · these edges come from **static name matching**: dynamic calls / reflection / string-built names are invisible;'));
  if (b.unresolved?.unknown) out.push(T(`  · 本项目有 ${fmt(b.unresolved.unknown)} 处引用没匹配上任何类型（这些边不在图里）；`, `  · ${fmt(b.unresolved.unknown)} references in this project matched no type (those edges are not in the graph);`));
  if (b.unresolved?.ambiguous) out.push(T(`  · 还有 ${fmt(b.unresolved.ambiguous)} 处匹配到多个同名目标，只取了一个；`, `  · ${fmt(b.unresolved.ambiguous)} references matched several same-named targets; only one was taken;`));
  out.push(T('  · 想看更宽：depth 加大（最多 4）；某个方向：refs(名字, in|out)。', '  · go wider: raise depth (max 4); one direction only: refs(name, in|out).'));
  return out.join('\n');
}

const IMPL = { overview: toolOverview, search: toolSearch, symbol: toolSymbol, refs: toolRefs, subgraph: toolSubgraph, file: toolFile, map: toolMap, impact: toolImpact };

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
      return ok(id, { content: [{ type: 'text', text }], isError: false });
    }
    if (id !== undefined) fail(id, -32601, T(`不支持的方法：${method}`, `Unsupported method: ${method}`));
  }

  // 让调用方能优雅收尾
  process.stdin.on('end', () => process.exit(0));
}
