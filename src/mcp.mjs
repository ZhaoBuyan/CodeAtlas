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

export function listToolsText() {
  return TOOLS.map((t) => {
    const args = Object.entries(t.inputSchema?.properties || {})
      .map(([k, v]) => `${k}${(t.inputSchema.required || []).includes(k) ? '' : '?'}:${String(v.type)}`)
      .join(', ');
    return `  ${t.name}(${args})\n      ${t.description}`;
  }).join('\n');
}

const PROTOCOL = '2024-11-05';

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
    description: '项目概览：规模、系统/模块划分、被依赖最多的符号、最大的文件。先调这个建立全局印象。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search',
    description: '按名字搜索：类型名 / 限定名 / 文件名片段，**默认连成员名一起搜**（例如搜 "OnPaint" 能找到“谁定义了这个方法”）。返回类型 id，供 symbol/refs 使用。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '名字片段，例如 "Logger" / "Players" / "OnPaint"' },
        scope: { type: 'string', enum: ['any', 'type', 'member'], description: '搜哪儿：any（默认，类型+成员）/ type（只搜类型名）/ member（只搜成员名）' },
        kind: { type: 'string', description: '可选：只找某一类（class/interface/enum/function/module…），只对类型生效' },
        limit: { type: 'number', description: '最多返回多少条，默认 20' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'symbol',
    description: '一个符号（类型）的完整信息：说明、文件:行、成员清单、基类、被依赖/依赖数量、所属系统。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'id（数字）或名字/限定名' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'refs',
    description: '引用关系：谁引用了它（in）/ 它引用了谁（out）。改代码前先用它看影响面。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        direction: { type: 'string', description: 'in | out | both，默认 both' },
        limit: { type: 'number', description: '默认 30' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'subgraph',
    description: '以某个符号为中心、指定深度内的依赖子图（紧凑清单），用来回答"改这里会牵连什么"。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        depth: { type: 'number', description: '探索层数，默认 2，最多 3' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'map',
    description: '按 token 预算导出一份"骨架地图"：系统 → 关键类型 → 关键成员，重要的排前面。用处：让 AI 在有限上下文里先拿到全局，而不是一问一答地探索。',
    inputSchema: {
      type: 'object',
      properties: {
        budget: { type: 'number', description: 'token 预算（估算值），默认 4000' },
      },
    },
  },
  {
    name: 'impact',
    description: '影响面分析：改这个类型会影响谁——沿"谁引用它"多跳展开（默认 2 层），并明说哪些看不到（静态名匹配看不到动态调用/反射）。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '类型名 / 限定名 / id' },
        depth: { type: 'number', description: '展开几层，1~4，默认 2' },
      },
      required: ['name'],
    },
  },
  {
    name: 'file',
    description: '按路径片段看一个文件：它定义了哪些类型、导入了什么、多少行、有没有解析异常。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '路径片段，例如 "Utils/Loc.cs"' } },
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
  if (!hits.length) return { error: `找不到匹配 "${s}" 的符号。用 search 先找找。` };
  return {
    error: `"${s}" 匹配到 ${hits.length} 个，请用更精确的名字或 id：\n` +
      hits.slice(0, 12).map((t) => `  ${t.id}  ${t.fqn}  [${t.kind}]  ${idx.files.get(t.file)?.path}`).join('\n'),
  };
}

function toolOverview(idx) {
  const b = idx.b;
  const topIn = b.types.slice().sort((a, c) => c.fanIn - a.fanIn).slice(0, 8);
  const bigFiles = b.files.slice().sort((a, c) => c.code - a.code).slice(0, 6);
  const lines = [];
  lines.push(`项目：${b.source.labels.join(', ')}${b.source.git ? ` @ ${b.source.git.commit}` : ''}`);
  lines.push(`规模：${fmt(b.files.length)} 文件 · ${fmt(b.totals.types)} 类型 · ${fmt(b.totals.edges)} 依赖边 · ${fmt(b.totals.code)} 行代码`);
  if (b.totals.parseErrors) lines.push(`注意：${b.totals.parseErrors} 处语法树解析异常（这些文件数据可能不全）`);
  if (b.totals.compilerGenerated) lines.push(`注意：${b.totals.compilerGenerated} 个编译器生成/反编译生成类型（非手写代码）`);
  const sys = b.facets?.systems || [];
  if (sys.length) lines.push(`系统划分（${b.facets.configFile}）：\n` + sys.map((s) => `  ${s.name}：${fmt(s.loc)} 行 · ${s.types} 类型 · ${s.files} 文件`).join('\n'));
  else lines.push('没有系统分组规则（可用 configs/<项目>.facets.json 定义；否则按目录/文件看）');
  lines.push('被依赖最多（改动的波及面最大）：\n' + topIn.map((t) => `  ${t.fqn} [${t.kind}] 被 ${t.fanIn} 处引用 · ${idx.files.get(t.file)?.path}`).join('\n'));
  lines.push('最大的文件：\n' + bigFiles.map((f) => `  ${f.path}  ${fmt(f.code)} 行`).join('\n'));
  lines.push('深入用：search / symbol / refs / subgraph / file');
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

  if (!hits.length && !memberHits.length) return `没有匹配 "${a.query}" 的符号（类型名和成员名都找过了）。`;

  const out = [];
  out.push(`匹配：${hits.length} 个类型 · ${memberHits.length} 个成员（按被引用次数排序）`);
  if (hits.length) {
    out.push(`类型（显示前 ${Math.min(hits.length, limit)}）：`);
    for (const t of hits.slice(0, limit)) {
      out.push(`  ${t.id}\t${t.fqn}\t[${t.kind}] 被引 ${t.fanIn} 次\t${idx.files.get(t.file)?.path}:${t.line}`);
    }
  }
  if (memberHits.length) {
    out.push(`成员（显示前 ${Math.min(memberHits.length, limit)}）：`);
    for (const { t, m } of memberHits.slice(0, limit)) {
      out.push(`  ${t.fqn}.${m.n}\t[${m.k}]\t${idx.files.get(t.file)?.path}:${m.l}\t（定义在 ${t.id} ${t.name}）`);
    }
    out.push('（成员名后面要看它的上下文，用 symbol 加类型名/id）');
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
  lines.push(`文件：${f?.path}:${t.line}${t.endLine > t.line ? `-${t.endLine}` : ''}   系统：${t.system || '（未分组）'}${t.systemRule ? `（规则 ${t.systemRule}）` : ''}`);
  lines.push(`规模：${t.code} 行代码 · 复杂度≈${t.complexity} · 成员 ${Object.entries(t.members || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '无'}`);
  lines.push(`依赖：被 ${t.fanIn} 处引用 · 引用了 ${t.fanOut} 个`);
  if (t.bases?.length) lines.push(`基类/接口：${t.bases.join(', ')}`);
  if (f?.errors) lines.push(`注意：该文件有 ${f.errors} 处解析异常，数据可能不全`);
  lines.push(`说明：${t.doc || '（源码里没有注释说明）'}`);
  if (members.length) {
    lines.push(`成员（前 ${members.length} / 共 ${(t.memberList || []).length}）：`);
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
    if (!es.length) { out.push(`${label}：无`); return; }
    es.sort((x, y) => y.w - x.w);
    out.push(`${label}（${es.length}）：`);
    for (const e of es.slice(0, limit)) {
      const o = pick(e);
      out.push(`  ${o.fqn} [${o.kind}]${e.kind === 'inherit' ? ' (继承)' : ''} ×${e.w}  ${idx.files.get(o.file)?.path}:${o.line}`);
    }
  };
  if (dir === 'in' || dir === 'both') show(idx.ins.get(t.id) || [], '被谁引用', (e) => idx.byId.get(e.from));
  if (dir === 'out' || dir === 'both') show(idx.outs.get(t.id) || [], '引用了谁', (e) => idx.byId.get(e.to));
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
  const lines = [`以 ${r.type.fqn} 为中心、深度 ${depth} 的依赖子图：共 ${seen.size} 个符号`];
  for (let d = 0; d <= depth; d++) {
    const at = [...seen].filter(([, dd]) => dd === d).map(([id]) => idx.byId.get(id)).filter(Boolean);
    if (!at.length) continue;
    lines.push(`第 ${d} 层（${at.length}）：` + at.slice(0, 40).map((t) => `${t.fqn}[${t.kind}]`).join('  '));
  }
  lines.push('（只看名字；细节用 symbol，引用方向用 refs）');
  return lines.join('\n');
}

function toolFile(idx, a) {
  const q = String(a.path || '').toLowerCase();
  const f = idx.b.files.find((x) => x.path.toLowerCase().includes(q));
  if (!f) return `没有匹配 "${a.path}" 的文件。用 search 可以按文件名片段搜符号。`;
  const types = idx.b.types.filter((t) => t.file === f.id);
  const lines = [
    `${f.path}  [${f.lang}]  ${f.loc} 行（代码 ${f.code} / 注释 ${f.comment} / 空 ${f.blank}）`,
  ];
  if (f.errors) lines.push(`注意：${f.errors} 处解析异常`);
  lines.push(`类型 ${types.length}：` + types.map((t) => `${t.name}[${t.kind}]`).join('  '));
  const imports = f.imports || [];
  lines.push(`导入（${imports.length}）：${imports.slice(0, 20).join(', ')}`);
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
  push(`${fmt(b.files.length)} 文件 / ${fmt(b.totals.types)} 类型 / ${fmt(b.totals.edges)} 依赖边 / ${fmt(b.totals.code)} 行代码`);
  push('');

  const systems = b.facets?.systems || [];
  if (systems.length) {
    push(`## 系统（${systems.length} 个，按体量排序）`);
    for (const s of [...systems].sort((x, y) => y.types - x.types)) {
      if (!push(`[${s.name}] ${s.types} 类型 / ${s.files} 文件`)) break;
      for (const t of b.types.filter((x) => x.system === s.name).sort((x, y) => score(y) - score(x)).slice(0, 5)) {
        if (!push(`  - ${t.fqn} [${t.kind}] 被引${t.fanIn} · ${pth(t)}`)) break;
      }
      if (used >= budget * 0.6) break;
    }
    push('');
  }

  if (used < budget) {
    push('## 关键类型（被引用最多 = 改动的波及面最大）');
    for (const t of [...b.types].sort((x, y) => y.fanIn - x.fanIn).slice(0, 25)) {
      if (!push(`  ${t.fqn} [${t.kind}] 被引${t.fanIn} · ${pth(t)}`)) break;
    }
    push('');
  }

  if (used < budget * 0.8) {
    push('## 关键成员（挑最重要的几个类型）');
    for (const t of [...b.types].sort((x, y) => score(y) - score(x)).slice(0, 6)) {
      const ms = (t.memberList || []).slice(0, 6);
      if (!ms.length) continue;
      if (!push(`  ${t.name}: ${ms.map((m) => m.n).join(', ')}`)) break;
    }
    push('');
  }

  const warn = [];
  if (b.unresolved?.unknown) warn.push(`名字没匹配上的引用 ${fmt(b.unresolved.unknown)} 处（这些依赖看不到）`);
  if (b.unresolved?.ambiguous) warn.push(`匹配到多个目标的引用 ${fmt(b.unresolved.ambiguous)} 处（只取了一个，可能不准）`);
  if (warn.length) push(`⚠ ${warn.join('；')}`);
  push(`（预算 ~${budget} token，实际约 ${used}；要细节：symbol(id) / refs(名字) / impact(名字)）`);
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

  const KIND = { inherit: '继承', call: '调用', type: '类型引用', import: '导入', ref: '引用' };
  const out = [`影响面：${t0.fqn} [${t0.kind}]（${idx.files.get(t0.file)?.path}:${t0.line}）`];
  out.push(`沿“谁引用它”展开 ${depth} 层：`);
  if (!layers.length) {
    out.push('  （没有已知的引用者：可能是入口/孤立类型，或者引用它的地方没被识别出来）');
  }
  for (const L of layers) {
    out.push('');
    out.push(`第 ${L.d} 层（${L.list.length} 个）：`);
    for (const x of L.list.slice(0, 25)) {
      const kinds = [...x.kinds].map((k) => KIND[k] || k).join('/');
      out.push(`  ${x.t.fqn} [${x.t.kind}] ${kinds} ×${x.w} · ${idx.files.get(x.t.file)?.path}`);
    }
    if (L.list.length > 25) out.push(`  …（还有 ${L.list.length - 25} 个）`);
  }
  out.push('');
  out.push('要注意的：');
  out.push('  · 这是**静态名字匹配**的结果：动态调用 / 反射 / 字符串拼出来的名字看不见；');
  if (b.unresolved?.unknown) out.push(`  · 本项目有 ${fmt(b.unresolved.unknown)} 处引用没匹配上任何类型（这些边不在图里）；`);
  if (b.unresolved?.ambiguous) out.push(`  · 还有 ${fmt(b.unresolved.ambiguous)} 处匹配到多个同名目标，只取了一个；`);
  out.push('  · 想看更宽：depth 加大（最多 4）；某个方向：refs(名字, in|out)。');
  return out.join('\n');
}

const IMPL = { overview: toolOverview, search: toolSearch, symbol: toolSymbol, refs: toolRefs, subgraph: toolSubgraph, file: toolFile, map: toolMap, impact: toolImpact };

function callTool(idx, name, args) {
  const fn = IMPL[name];
  if (!fn) return `未知工具：${name}`;
  try {
    return fn(idx, args || {});
  } catch (err) {
    return `工具执行出错：${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

export function startMcp({ bundlePath }) {
  if (!fs.existsSync(bundlePath)) {
    process.stderr.write(`MCP：找不到 ${bundlePath}，先跑一次扫描（atlas <路径>）\n`);
    process.exit(1);
  }
  let idx = buildIndex(JSON.parse(fs.readFileSync(bundlePath, 'utf8')));
  let mtime = fs.statSync(bundlePath).mtimeMs;
  process.stderr.write(`MCP 就绪：${bundlePath}（${idx.b.types.length} 个类型，${TOOLS.length} 个工具）\n`);
  if (process.stdin.isTTY) {
    process.stderr.write('提示：这是 stdio 服务 —— 它在等客户端发 JSON-RPC，直接跑就是这个样子（不是卡死）。\n');
    process.stderr.write('     想看工具列表：node src/cli.mjs mcp --list-tools\n');
    process.stderr.write('     想自动化验证：node tests/mcp-selftest.mjs\n');
    process.stderr.write('     Ctrl+C 退出。\n');
  }

  // bundle 是快照，会过时。每次调用前看一眼 mtime：重新扫描过就自动换新的（AI 不会拿到隔夜数据）
  function maybeReload() {
    try {
      const t = fs.statSync(bundlePath).mtimeMs;
      if (t !== mtime) {
        mtime = t;
        idx = buildIndex(JSON.parse(fs.readFileSync(bundlePath, 'utf8')));
        process.stderr.write(`MCP：检测到 bundle 更新，已重载（${idx.b.types.length} 个类型）\n`);
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
    if (id !== undefined) fail(id, -32601, `不支持的方法：${method}`);
  }

  // 让调用方能优雅收尾
  process.stdin.on('end', () => process.exit(0));
}
