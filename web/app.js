/* Code Atlas 前端：吃 bundle.json，画树形图 / 树状列表 + 检查器。
 * 只依赖 d3（全局）。数据全在 /data/bundle.json，前端不含被扫描项目的代码。 */

const METRICS = {
  code: '代码行',
  loc: '总行数',
  complexity: '复杂度（估）',
  members: '成员数',
  fanIn: '被依赖 fanIn',
};

const KIND_COLOR = {
  class: '#58a6ff', record: '#3fb950', struct: '#d29922', interface: '#bc8cff',
  enum: '#f778ba', delegate: '#39c5cf', function: '#8b949e', type: '#8b949e', annotation: '#8b949e',
};

const state = {
  bundle: null, metric: 'code', colorMode: 'file', groupBy: 'system', groupDepth: 2, view: 'treemap',
  kinds: new Set(), q: '', minCode: 0, focus: '', selected: null, groupColors: new Map(), collapsed: new Set(),
  depFocus: false, hideGenerated: false,
  // null = 没启用语言过滤（全显示）；否则是选中的语言 id 集合
  langs: null,
};

const $ = (s) => document.querySelector(s);
// 当前树形图的绘制现场（高亮依赖时要复用这些坐标与选择集）
let chartState = null;
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const truncate = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
// 数据里的哨兵值 → 网页显示文案（映射表的源头在 src/i18n.mjs；网页目前只有中文，这里先做显示兜底）：
// bundle 里存的是中性值 '(unclassified)'，老 bundle 里是 '(未分类)'，两种都认。
const SENTINELS = {
  '(unclassified)': '(未分类)', '(未分类)': '(未分类)',
  '(root)': '(根目录)', '(根目录)': '(根目录)',
  'Other': '其他', '其他': '其他', 'Top level': '顶层', '顶层': '顶层',
  'root': '根目录', '根目录': '根目录',
};
const sysLabel = (n) => SENTINELS[n] || n;

fetch('/data/bundle.json')
  .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
  .then(boot)
  .catch((err) => { $('#chart').innerHTML = `<div class="empty">读取 bundle 失败：${esc(err.message)}<br>先跑 <code>npm run scan -- &lt;目录&gt;</code></div>`; });

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
function boot(b) {
  state.bundle = b;
  state.typeById = new Map(b.types.map((t) => [t.id, t]));
  state.fileById = new Map(b.files.map((f) => [f.id, f]));
  state.ins = new Map();
  state.outs = new Map();
  for (const e of b.edges) {
    (state.outs.get(e.from) || state.outs.set(e.from, []).get(e.from)).push(e);
    (state.ins.get(e.to) || state.ins.set(e.to, []).get(e.to)).push(e);
  }
  state.kinds = new Set(b.types.map((t) => t.kind));
  state.sysColors = new Map((b.facets?.systems || []).map((s) => [s.name, s.color]).filter(([, c]) => c));
  state.hasFacets = Boolean(b.facets?.configFile);
  // 反编译产物默认把编译器生成物藏起来（那些东西不是人写的，混在里面只会干扰看）
  state.hideGenerated = Boolean(b.source.ingest?.tool) && (b.totals.compilerGenerated || 0) > 0;

  readHash();
  if (!state.hasFacets && state.groupBy === 'system') state.groupBy = 'dir';

  $('#ver').textContent = `v${b.generator.version}`;
  renderMeta();
  renderControls();
  renderKinds();
  renderLangs();
  renderTopList();
  draw();
  const redraw = debounce(() => draw(), 60);
  new ResizeObserver(redraw).observe($('#chart'));
  window.addEventListener('resize', redraw);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { state.q = ''; $('#q').value = ''; state.selected = null; writeHash(); draw(); }
  });
}

function renderMeta() {
  const b = state.bundle, s = b.source;
  // 反编译产物：源目录是临时产物（src），显示原始的发行版名字更有意义
  const fromLabel = b.source.ingest?.original
    ? b.source.ingest.original.split(/[\\/]/).pop()
    : s.labels.join(', ');
  const facets = b.facets?.configFile
    ? `<span class="chip">分组规则 <b>${esc(b.facets.configFile)}</b> · ${b.facets.systems.length} 个系统</span>`
    : '';
  const chips = [
    `<span class="chip">来源 <b>${esc(fromLabel)}</b></span>`,
    s.git
      ? `<span class="chip">版本 <b>${esc(s.git.commit)}</b>${s.git.dirty ? ' · 有未提交改动' : ''}</span>`
      : `<span class="chip">快照 <b>${new Date(s.newestMtime || 0).toLocaleString()}</b></span>`,
    `<span class="chip">生成 <b>${new Date(b.generated).toLocaleString()}</b></span>`,
    `<span class="chip">文件 <b>${fmt(b.totals.files)}</b> · 类型 <b>${fmt(b.totals.types)}</b> · 依赖边 <b>${fmt(b.totals.edges)}</b></span>`,
    facets,
    b.totals.compilerGenerated
      ? `<span class="chip">编译器生成物 <b>${fmt(b.totals.compilerGenerated)}</b>${state.hideGenerated ? '（已隐藏）' : ''}</span>`
      : '',
    b.source.ingest?.tool
      ? `<span class="chip">反编译产物 · 无源码注释 · 行数含语法糖展开</span>`
      : '',
    b.totals.parseErrors
      ? `<span class="chip warn">解析异常 <b>${fmt(b.totals.parseErrors)}</b> 处 / ${fmt(b.totals.parseErrorFiles)} 个文件</span>`
      : '',
    (() => {
      const u = b.stats?.skipped?.unsupported || {};
      const total = Object.values(u).reduce((a, c) => a + c, 0);
      if (!total) return '';
      const top = Object.entries(u).sort((a, c) => c[1] - a[1]).slice(0, 4).map(([e, c]) => `${e} ${c}`).join(' · ');
      return `<span class="chip warn" title="这些后缀的文件被跳过了：${esc(top)}">未支持语言 <b>${fmt(total)}</b> 个文件</span>`;
    })(),
    `<span class="chip warn">结构 = tree-sitter 解析 · 依赖边 = 静态推断，可能漏 / 错</span>`,
  ];
  $('#meta').innerHTML = chips.filter(Boolean).join('');
}

// ---------------------------------------------------------------------------
// 控件
// ---------------------------------------------------------------------------
function renderControls() {
  // 分组选项：「系统/模块」需要规则文件，「命名空间」对模块化项目没意义——
  // 只禁这两项，其余（目录 / 文件 / 平铺）任何时候都能用。
  const nsCount = state.bundle.stats.namespaces;
  const canSystem = state.hasFacets;
  const canNs = nsCount > 1;
  const items = [
    ['system', canSystem ? '系统 / 模块（规则）' : '系统 / 模块（需要规则文件）', canSystem ? '' : '需要 configs/<项目名>.facets.json；没有规则时用「目录」或「文件」代替最直观', !canSystem],
    ['dir', '目录', '', false],
    ['ns', canNs ? `命名空间（${nsCount} 个）` : '命名空间（这类语言没有）', canNs ? '' : 'C#/Java/Kotlin/Go/Scala 有 namespace/package 声明；TS/JS/Python 靠文件与目录组织代码（文件本身就是模块），扫不到命名空间。看「目录」或「文件」即可，目录在这类项目里通常就是模块边界。', !canNs],
    ['file', '文件', '', false],
    ['flat', '平铺（不分层）', '', false],
  ];
  $('#groupBy').innerHTML = items
    .map(([v, label, why, disabled]) => `<option value="${v}"${disabled ? ' disabled' : ''} title="${esc(why)}">${esc(label)}</option>`)
    .join('');
  $('#groupBy').value = state.groupBy;
  const hint = $('#groupHint');
  if (hint) hint.textContent = canSystem ? '' : '小提示：没有规则文件时用「目录」或「文件」分组最直观；「命名空间」需 C#/Java 这类有 namespace/package 声明的语言。';
  if (hint) hint.textContent = canSystem ? '' : '没有规则文件时，「目录」或「文件」分组最直观';
  $('#groupBy').onchange = (e) => { state.groupBy = e.target.value; state.focus = ''; state.selected = null; writeHash(); renderControls(); draw(); };

  $('#groupDepth').value = String(state.groupDepth);
  $('#groupDepth').disabled = !['dir', 'ns'].includes(state.groupBy);
  $('#depthField').style.opacity = $('#groupDepth').disabled ? 0.45 : 1;
  $('#groupDepth').onchange = (e) => { state.groupDepth = Number(e.target.value); state.focus = ''; state.selected = null; writeHash(); draw(); };

  $('#view').value = state.view;
  $('#view').onchange = (e) => { state.view = e.target.value; writeHash(); draw(); };

  $('#metric').innerHTML = Object.entries(METRICS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#metric').value = state.metric;
  $('#metric').onchange = (e) => { state.metric = e.target.value; writeHash(); draw(); renderTopList(); };

  $('#colorMode').value = state.colorMode;
  $('#colorMode').onchange = (e) => { state.colorMode = e.target.value; writeHash(); draw(); };

  $('#q').value = state.q;
  $('#q').oninput = (e) => { state.q = e.target.value.trim().toLowerCase(); writeHash(); draw(); renderTopList(); };

  $('#depFocus').checked = state.depFocus;
  $('#depFocus').onchange = (e) => { state.depFocus = e.target.checked; writeHash(); draw(); };

  const genN = state.bundle.totals.compilerGenerated || 0;
  $('#hideGenField').style.display = genN ? '' : 'none';
  $('#genCount').textContent = genN ? `（${genN}）` : '';
  $('#hideGen').checked = state.hideGenerated;
  $('#hideGen').onchange = (e) => { state.hideGenerated = e.target.checked; writeHash(); draw(); renderTopList(); };

  $('#minCode').value = state.minCode;
  $('#minCodeVal').textContent = state.minCode;
  $('#minCode').oninput = (e) => {
    state.minCode = Number(e.target.value);
    $('#minCodeVal').textContent = state.minCode;
    draw(); renderTopList();
  };
}

function renderKinds() {
  const kinds = [...state.kinds].sort();
  $('#kinds').innerHTML = kinds.map((k) => `
    <label><input type="checkbox" value="${k}" checked />
      <span class="swatch" style="background:${KIND_COLOR[k] || '#8b949e'}"></span>${esc(k)}</label>`).join('');
  $('#kinds').onchange = () => {
    state.kinds = new Set([...$('#kinds').querySelectorAll('input:checked')].map((i) => i.value));
    draw(); renderTopList();
  };
}

function renderLangs() {
  // 只列本次真的扫到的语言；只有一种语言时这个面板没意义，藏起来
  const langs = Object.entries(state.bundle.languages || {}).sort((a, b) => b[1].loc - a[1].loc);
  if (langs.length < 2) {
    $('#langPanel').style.display = 'none';
    state.langs = null;
    return;
  }
  $('#langPanel').style.display = '';
  if (!state.langs) state.langs = new Set(langs.map(([id]) => id));
  $('#langs').innerHTML = langs.map(([id, s]) => `
    <label title="${fmt(s.loc)} 行 · ${fmt(s.types || 0)} 个类型">
      <input type="checkbox" value="${esc(id)}" ${state.langs.has(id) ? 'checked' : ''} />
      <span>${esc(s.label || id)}</span><span class="muted">${fmt(s.files)}</span></label>`).join('');
  $('#langs').onchange = () => {
    const on = [...$('#langs').querySelectorAll('input:checked')].map((i) => i.value);
    // 全选 = 回成“不过滤”，这样 permalink 干净、也和“没动过”同一种状态
    state.langs = on.length === langs.length ? null : new Set(on);
    writeHash(); draw(); renderTopList();
  };
}

function langOf(t) {
  return state.fileById.get(t.file)?.lang || '';
}

function renderTopList() {
  const pool = [...state.bundle.types].filter(matchType).sort((a, b) => metricOf(b) - metricOf(a));
  const q = state.q;
  if (q) {
    const byMember = pool.filter((t) => memberHitOf(t)).length;
    $('#topTitle').textContent = `搜索结果（共 ${pool.length} 个类型${byMember ? ` · 其中 ${byMember} 个是成员命中` : ''}）`;
  } else {
    $('#topTitle').textContent = `最大的类型（${METRICS[state.metric]}）`;
  }
  const list = pool.slice(0, 12);
  $('#topList').innerHTML = list.map((t) => {
    const m = q ? memberHitOf(t) : null;
    const f = state.fileById.get(t.file);
    // 搜索时多一行“为什么命中”：搜成员名时如果不说清楚，很容易让人以为类型名里含这个词
    const sub = !q ? '' : `<span class="sub">${m ? `命中成员 ${esc(m.n)}${m.k ? `（${esc(m.k)}）` : ''}` : '命中类型名'}${f ? ` · ${esc(f.path)}:${m ? m.l : t.line}` : ''}</span>`;
    return `
    <li data-id="${t.id}" title="${esc(t.fqn)}">
      <span>${esc(truncate(t.name, 18))}</span><span class="v">${fmt(metricOf(t))}</span>
      ${sub}
    </li>`;
  }).join('');
  $('#topList').onclick = (e) => {
    const li = e.target.closest('li');
    if (li) select(Number(li.dataset.id));
  };
}

// ---------------------------------------------------------------------------
// 分组与筛选
// ---------------------------------------------------------------------------
function metricOf(t) {
  switch (state.metric) {
    case 'loc': return t.loc;
    case 'complexity': return t.complexity;
    case 'members': return Object.values(t.members).reduce((a, b) => a + b, 0);
    case 'fanIn': return t.fanIn + 1;
    default: return t.code || 1;
  }
}

/**
 * 这个类型为什么命中搜索：
 *   'self'   类型名 / 全名 / 命名空间 / 系统名命中了
 *   成员对象  类型名没中，但它的某个成员名中了（例如搜 OnPaint）
 *   null     没命中
 * 结果缓存：draw() 里要对每个类型问好几次，不缓存的话大项目会卡。
 */
let hitCache = { q: null, b: null, map: new Map() };
function searchHit(t) {
  if (!state.q) return null;
  if (hitCache.q !== state.q || hitCache.b !== state.bundle) hitCache = { q: state.q, b: state.bundle, map: new Map() };
  if (hitCache.map.has(t.id)) return hitCache.map.get(t.id);
  const q = state.q;
  let r = null;
  if (t.name.toLowerCase().includes(q) || t.fqn.toLowerCase().includes(q)
    || (t.ns || '').toLowerCase().includes(q) || (t.system || '').toLowerCase().includes(q)) r = 'self';
  else r = (t.memberList || []).find((m) => (m.n || '').toLowerCase().includes(q)) || null;
  hitCache.map.set(t.id, r);
  return r;
}

/** 只在“靠成员名命中”时才返回那个成员 */
function memberHitOf(t) {
  const h = searchHit(t);
  return h && h !== 'self' ? h : null;
}

function matchType(t) {
  if (!state.kinds.has(t.kind)) return false;
  if (state.langs && !state.langs.has(langOf(t))) return false;
  if ((t.code || 0) < state.minCode) return false;
  if (state.hideGenerated && isGenerated(t)) return false;
  if (state.depFocus && state.selected != null && state.typeById.has(state.selected)) {
    if (t.id !== state.selected && !depNeighbors().has(t.id)) return false;
  }
  if (!state.q) return true;
  return searchHit(t) !== null;
}

/** 类型 -> 分组路径（数组） */
function groupPath(t) {
  const cut = (segs) => (state.groupDepth > 0 ? segs.slice(0, state.groupDepth) : segs);
  switch (state.groupBy) {
    case 'ns': return cut((t.ns || '(全局)').split('.'));
    case 'dir': {
      const f = state.fileById.get(t.file);
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      return cut(dir ? dir.split('/') : ['(根目录)']);
    }
    case 'file': {
      const f = state.fileById.get(t.file);
      return [f.path];
    }
    case 'system': return [sysLabel(t.system || '(unclassified)')];
    default: return [];
  }
}

/** 用分组路径搭一棵层级树（已应用筛选） */
function buildTree() {
  const root = { isGroup: true, name: '全部', path: '', children: [], lookup: new Map() };
  for (const t of state.bundle.types) {
    if (!matchType(t)) continue;
    const segs = groupPath(t);
    let node = root, p = '';
    for (const s of segs) {
      p = p ? `${p}⁄${s}` : s;
      let child = node.lookup.get(s);
      if (!child) {
        child = { isGroup: true, name: s, path: p, children: [], lookup: new Map() };
        node.lookup.set(s, child);
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({ isType: true, name: t.name, kind: t.kind, id: t.id, ns: t.ns, system: t.system, value: metricOf(t) });
  }
  const clean = (node) => {
    node.children = node.children.filter((c) => (c.isType ? true : clean(c)));
    delete node.lookup;
    return node.children.length > 0;
  };
  return clean(root) ? root : null;
}

function findGroup(node, path) {
  if (node.path === path) return node;
  for (const c of node.children || []) {
    if (c.isType) continue;
    const hit = findGroup(c, path);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 颜色
// ---------------------------------------------------------------------------
/** 颜色键：按文件时看所属文件；按分组时看最细一层分组；按类别看类别 */
function colorKeyOf(d) {
  if (state.colorMode === 'kind') return `kind:${d.data.kind || '?'}`;
  if (state.colorMode === 'file') {
    if (!d.data.isType) return '';
    const t = state.typeById.get(d.data.id);
    const f = t && state.fileById.get(t.file);
    return f ? `file:${f.path}` : '';
  }
  if (!d.data.isType) return d.data.path || '(全部)';
  const parent = d.ancestors()[1];
  return (!parent || parent.depth === 0) ? '(全部)' : (parent.data.path || '(全部)');
}

function keyLabel(key) {
  if (key.startsWith('file:')) return key.slice(5).split('/').pop();
  if (key.startsWith('kind:')) return key.slice(5);
  return key.split('⁄').pop();
}

/** 键 -> 颜色：facets 配的色优先，否则按键 hash 出色相（不限于 10 色） */
function hashColor(key) {
  if (!key) return '#30363d';
  if (state.sysColors.has(key)) return state.sysColors.get(key);
  if (!state.groupColors.has(key)) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
    state.groupColors.set(key, d3.hsl(h, 0.5, 0.56).formatHex());
  }
  return state.groupColors.get(key);
}

function colorFor(d) {
  if (state.colorMode === 'kind') return KIND_COLOR[d.data.kind] || '#8b949e';
  // 按文件着色时，分组框走中性色（不跟文件抢颜色）
  if (state.colorMode === 'file' && !d.data.isType) return '#30363d';
  return hashColor(colorKeyOf(d));
}

function renderLegend(target) {
  const root = d3.hierarchy(target).sum((d) => d.value || 0).sort((a, b) => b.value - a.value);
  const names = { system: '系统 / 模块', dir: '目录', ns: '命名空间', file: '文件', flat: '（未分组）' };
  const modes = { file: '按文件', group: '按分组', kind: '按类型类别' };
  $('#legendTitle').textContent = `${names[state.groupBy] || '分组'} · ${modes[state.colorMode] || ''}`;

  const map = new Map();
  for (const leaf of root.leaves()) {
    const key = colorKeyOf(leaf);
    if (!key) continue;
    const e = map.get(key) || { key, loc: 0, types: 0, best: -1, id: null };
    e.loc += leaf.value || 0;
    e.types++;
    if ((leaf.value || 0) > e.best) { e.best = leaf.value || 0; e.id = leaf.data.id; }
    map.set(key, e);
  }
  const items = [...map.values()].sort((a, b) => b.loc - a.loc);
  if (!items.length) { $('#legend').innerHTML = '<li class="muted">无</li>'; return; }
  $('#legend').innerHTML = items.slice(0, 60).map((g) => `
    <li data-key="${esc(g.key)}" data-id="${g.id ?? ''}" title="${esc(g.key.replace(/^(file|kind):/, ''))}">
      <span class="p"><i style="background:${hashColor(g.key)}"></i>${esc(truncate(keyLabel(g.key), 22))}</span>
      <span class="v">${fmt(g.loc)} · ${g.types}</span>
    </li>`).join('') + (items.length > 60 ? `<li class="muted">…另有 ${items.length - 60} 项</li>` : '');
  $('#legend').onclick = (e) => {
    const li = e.target.closest('li');
    if (!li || !li.dataset.key) return;
    const key = li.dataset.key;
    if (key.startsWith('kind:')) return;
    if (key.startsWith('file:')) { if (li.dataset.id) select(Number(li.dataset.id)); return; }
    state.focus = key === '(全部)' ? '' : key;
    state.selected = null;
    writeHash(); draw();
  };
}

// ---------------------------------------------------------------------------
// 画
// ---------------------------------------------------------------------------
function draw() {
  const chart = $('#chart');
  const w = Math.max(chart.clientWidth, 0), h = Math.max(chart.clientHeight, 0);
  const full = buildTree();
  const target = full ? (state.focus ? findGroup(full, state.focus) : full) : null;
  let shown = 0;
  chart.innerHTML = '';
  renderCrumbs();

  if (!target) {
    chart.innerHTML = '<div class="empty">没有符合筛选的类型（放开类别 / 调小最小代码行 / 清空搜索）。</div>';
    $('#legend').innerHTML = '<li class="muted">无</li>';
    renderStatus(0, 0, w, h);
    renderInspector();
    return;
  }

  renderLegend(target);
  if (state.view === 'tree') shown = drawTreeList(target, chart);
  else if (state.view === 'graph') shown = drawGraph(chart, w, h);
  else if (state.view === 'matrix') shown = drawMatrix(target, chart, w, h);
  else shown = drawTreemap(target, chart, w, h);
  renderStatus(shown, 0, w, h);
  renderInspector();
}

/** 树形图 */
function drawTreemap(target, chart, w, h) {
  const root = d3.hierarchy(target).sum((d) => d.value || 0).sort((a, b) => b.value - a.value);
  d3.treemap()
    .size([w, h])
    .paddingOuter(3).paddingInner(2)
    .paddingTop((d) => (d.depth ? 16 : 0))
    .round(true)
    .tile(d3.treemapSquarify.ratio(1.15))(root);

  const svg = d3.select(chart).append('svg').attr('width', w).attr('height', h);
  // 只要 depth>0 的分组：根节点没有自己的框，否则它的标题会和第一层分组标题重叠
  const groups = root.descendants().filter((d) => d.children && d.depth > 0);
  const q = state.q;

  // 组头色条
  svg.append('g').selectAll('rect').data(groups).join('rect')
    .attr('x', (d) => d.x0).attr('y', (d) => d.y0)
    .attr('width', (d) => Math.max(0, d.x1 - d.x0)).attr('height', (d) => Math.max(0, Math.min(16, d.y1 - d.y0)))
    .attr('fill', (d) => colorFor(d)).attr('fill-opacity', 0.3);

  // 组边框
  svg.append('g').selectAll('rect').data(groups).join('rect')
    .attr('x', (d) => d.x0).attr('y', (d) => d.y0)
    .attr('width', (d) => Math.max(0, d.x1 - d.x0)).attr('height', (d) => Math.max(0, d.y1 - d.y0))
    .attr('fill', 'none')
    .attr('stroke', (d) => colorFor(d)).attr('stroke-opacity', 0.55)
    .style('cursor', 'pointer')
    .on('click', (ev, d) => { state.focus = d.data.path; state.selected = null; writeHash(); draw(); });

  // 组名 + 汇总
  svg.append('g').selectAll('text').data(groups.filter((d) => d.x1 - d.x0 > 60 && d.y1 - d.y0 > 16)).join('text')
    .attr('class', 'group-label')
    .attr('x', (d) => d.x0 + 5).attr('y', (d) => d.y0 + 11.5)
    .text((d) => truncate(`${d.data.name} · ${d.leaves().length}类型 · ${fmt(d.value)}`,
      Math.max(6, Math.floor((d.x1 - d.x0 - 8) / 6.2))));

  // 叶子
  const leaves = root.leaves();
  const g = svg.append('g').selectAll('g').data(leaves).join('g')
    .attr('transform', (d) => `translate(${d.x0},${d.y0})`);

  g.append('rect')
    .attr('width', (d) => Math.max(0, d.x1 - d.x0)).attr('height', (d) => Math.max(0, d.y1 - d.y0))
    .attr('fill', (d) => colorFor(d))
    .attr('fill-opacity', (d) => {
      const t = state.typeById.get(d.data.id);
      if (q && !matchType(t)) return 0.12;
      if (isGenerated(t)) return 0.3; // 生成物画淡一点，一眼能和手写代码分开
      return 0.72;
    })
    .attr('stroke', (d) => (state.selected === d.data.id ? '#fff' : '#0d1117'))
    .attr('stroke-width', (d) => (state.selected === d.data.id ? 2 : 1));

  // 依赖连线层：悬停/选中一个块时，把"谁引用它 / 它引用谁"用线连出来
  const linkG = svg.append('g').attr('class', 'links').attr('pointer-events', 'none');
  chartState = { leafSel: g, linkG, leafNodes: new Map(leaves.map((d) => [d.data.id, d])) };

  g.selectAll('rect')
    .on('click', (ev, d) => select(d.data.id))
    .on('mouseenter', (ev, d) => { hideTip(); applyEmphasis(d.data.id); })
    .on('mousemove', (ev, d) => showTip(ev, d))
    .on('mouseleave', () => { hideTip(); applyEmphasis(state.selected ?? null); });

  applyEmphasis(state.selected ?? null);

  const fontSize = (d) => Math.max(9, Math.min(13, Math.sqrt((d.x1 - d.x0) * (d.y1 - d.y0)) / 7));
  g.append('text')
    .attr('class', 'node-label').attr('x', 4).attr('y', 12)
    .style('font-size', (d) => fontSize(d))
    .style('display', (d) => (d.x1 - d.x0 > 46 && d.y1 - d.y0 > 15 ? null : 'none'))
    .text((d) => truncate(d.data.name, Math.max(4, Math.floor((d.x1 - d.x0 - 8) / (fontSize(d) * 0.62)))));

  g.append('text')
    .attr('class', 'node-value').attr('x', 4).attr('y', 24)
    .style('font-size', (d) => Math.max(8.5, fontSize(d) - 1.5))
    .style('display', (d) => (d.x1 - d.x0 > 52 && d.y1 - d.y0 > 32 ? null : 'none'))
    .text((d) => `${fmt(d.value)} ${METRICS[state.metric]}`);

  // 布局有时晚一步（字体/滚动条），量到的尺寸变了就补画一次，免得右侧/底部留白
  const cw = chart.clientWidth, ch = chart.clientHeight;
  if ((Math.abs(cw - w) > 4 || Math.abs(ch - h) > 4) && !chart._resizing) {
    chart._resizing = true;
    requestAnimationFrame(() => { chart._resizing = false; draw(); });
  }

  return leaves.length;
}

/** 树状列表 */
function drawTreeList(target, chart) {
  const root = d3.hierarchy(target).sum((d) => d.value || 0).sort((a, b) => b.value - a.value);
  // 手写前序遍历（d3 的 descendants() 是广度优先，会把所有分组排在前面），顺带支持折叠
  const nodes = [];
  const walk = (d) => {
    nodes.push(d);
    if (!state.collapsed.has(d.data.path)) (d.children || []).forEach(walk);
  };
  walk(root);

  const maxLeaf = d3.max(root.leaves(), (d) => d.value || 0) || 1;
  const rows = nodes.map((d) => {
    const depth = d.depth;
    const isType = d.data.isType;
    const val = d.value || 0;
    const barW = Math.max(1.5, (val / maxLeaf) * 100);
    const color = colorFor(d);
    const indent = 10 + depth * 18;
    if (isType) {
      const sel = state.selected === d.data.id ? ' sel' : '';
      const t = state.typeById.get(d.data.id);
      return `<div class="tree-row leaf${sel}" data-id="${d.data.id}" style="padding-left:${indent}px" title="${esc(t.fqn)}${t.doc ? '\n' + esc(t.doc) : ''}">
        <span class="bar" style="width:${barW}%;background:${color}"></span>
        <span class="name">${esc(d.data.name)}</span>
        <span class="kind" style="color:${KIND_COLOR[d.data.kind] || '#8b949e'}">${esc(d.data.kind)}</span>${isGenerated(t) ? '<span class="kind" style="color:#6e7681">生成物</span>' : ''}
        <span class="num">${fmt(val)}</span></div>`;
    }
    const collapsed = state.collapsed.has(d.data.path);
    return `<div class="tree-row group" data-path="${esc(d.data.path)}" style="padding-left:${indent}px">
      <span class="bar" style="width:${barW}%;background:${color};opacity:.32"></span>
      <span class="caret" data-toggle="1">${depth === 0 ? '⌂' : collapsed ? '▸' : '▾'}</span>
      <span class="name"><i style="background:${color}"></i>${esc(d.data.name)}</span>
      <span class="kind muted">${d.leaves().length} 类型</span>
      <span class="num">${fmt(val)}</span></div>`;
  }).join('');

  chart.innerHTML = `<div class="tree">${rows}</div>`;
  chartState = null; // 树状列表没有色块坐标，关掉高亮连线
  const box = chart.querySelector('.tree');
  box.onclick = (e) => {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    if (row.classList.contains('leaf')) { select(Number(row.dataset.id)); return; }
    const path = row.dataset.path;
    if (e.target.closest('.caret')) {
      if (state.collapsed.has(path)) state.collapsed.delete(path);
      else state.collapsed.add(path);
      draw();
      return;
    }
    state.focus = path;
    state.selected = null;
    writeHash();
    draw();
  };
  return root.leaves().length;
}

function renderCrumbs() {
  const segs = state.focus ? state.focus.split('⁄') : [];
  const parts = ['<a data-path="">全部</a>'];
  const acc = [];
  segs.forEach((s, i) => {
    acc.push(s);
    parts.push(i === segs.length - 1
      ? `<span class="now">${esc(s)}</span>`
      : `<a data-path="${esc(acc.join('⁄'))}">${esc(s)}</a>`);
  });
  $('#crumbs').innerHTML = `${parts.join('<span class="sep">›</span>')}<span id="chartInfo" class="muted"></span>`;
  $('#crumbs').onclick = (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    state.focus = a.dataset.path;
    state.selected = null;
    writeHash(); draw();
  };
  updateChartInfo();
}

/** 抬头：把当前图表的编码含义写清楚，别让人猜 */
function updateChartInfo(extra) {
  const el = $('#chartInfo');
  if (!el) return;
  const modes = { file: '按文件', group: '按分组', kind: '按类型类别' };
  const groups = { system: '系统', dir: '目录', ns: '命名空间', file: '文件', flat: '平铺' };
  const depth = ['dir', 'ns'].includes(state.groupBy) ? ` ${state.groupDepth || '全部'}层` : '';
  let t = `${groups[state.groupBy] || ''}${depth} · 面积=${METRICS[state.metric]} · 着色=${modes[state.colorMode]}`;
  if (state.depFocus) {
    t += state.selected != null && state.typeById.has(state.selected)
      ? ` · 依赖聚焦：仅显示该类型 + 关联 ${depNeighbors().size} 个`
      : ' · 依赖聚焦：还没选中类型（点一个色块）';
  }
  if (state.selected != null && state.typeById.has(state.selected)) {
    const ty = state.typeById.get(state.selected);
    const ins = (state.ins.get(state.selected) || []).length;
    const outs = (state.outs.get(state.selected) || []).length;
    t += ` · 选中 ${ty.name}：被引用 ${ins} / 引用 ${outs}（已在地图上高亮）`;
  }
  if (extra) t += ` · ${extra}`;
  el.textContent = `　${t}`;
}

function renderStatus(shown, _total, w = 0, h = 0) {
  const b = state.bundle;
  const ls = Object.entries(b.languages).map(([id, s]) => `${id} ${fmt(s.loc)} 行`).join(' · ');
  $('#statusbar').innerHTML = [
    `<span>显示 <b style="color:var(--text)">${fmt(shown)}</b> ${state.view === 'graph' ? '个节点' : state.view === 'matrix' ? '个分组' : '个类型'}</span>`,
    `<span>图区 ${w}×${h}</span>`,
    `<span>${ls}</span>`,
    `<span>未解析引用 unknown ${fmt(b.unresolved.unknown)} · ambiguous ${fmt(b.unresolved.ambiguous)}</span>`,
    b.totals.parseErrors ? `<span style="color:var(--warn)">解析异常 ${fmt(b.totals.parseErrors)} 处（这些文件的数据可能不全）</span>` : '',
    `<span>扫描耗时 ${(b.source.scanMs / 1000).toFixed(2)}s</span>`,
    `<span>点色块看详情 · 悬停看依赖高亮 · 点分组框只看这一组</span>`,
  ].join('');
}

// ---------------------------------------------------------------------------
// 提示 / 检查器 / permalink
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 依赖高亮：选中/悬停一个块时，把相关项提亮、其余压暗，并用连线指出来
// ---------------------------------------------------------------------------
const isGenerated = (t) => Array.isArray(t.tags) && t.tags.includes('compiler-generated');

/** 依赖聚焦用：选中项的关联集合（缓存，避免每个类型都重算） */
let depCache = { id: null, set: new Set() };
function depNeighbors() {
  const id = state.selected;
  if (depCache.id !== id) depCache = { id, set: new Set(emphasisTargets(id).keys()) };
  return depCache.set;
}

function emphasisTargets(id) {
  const set = new Map();
  for (const e of state.outs.get(id) || []) if (!set.has(e.to)) set.set(e.to, e);
  for (const e of state.ins.get(id) || []) if (!set.has(e.from)) set.set(e.from, e);
  return set;
}

function applyEmphasis(focusId) {
  if (!chartState || state.view !== 'treemap') return;
  const { leafSel, linkG, leafNodes } = chartState;
  const cells = leafSel.selectAll('rect');
  if (focusId == null || !state.typeById.has(focusId)) {
    cells.attr('fill-opacity', (d) => (isGenerated(state.typeById.get(d.data.id)) ? 0.3 : 0.72))
      .attr('stroke', (d) => (state.selected === d.data.id ? '#fff' : '#0d1117'))
      .attr('stroke-width', (d) => (state.selected === d.data.id ? 2 : 1));
    linkG.selectAll('*').remove();
    updateChartInfo();
    return;
  }
  const targets = emphasisTargets(focusId);
  cells
    .attr('fill-opacity', (d) => (d.data.id === focusId ? 1 : targets.has(d.data.id) ? 0.92 : 0.08))
    .attr('stroke', (d) => (d.data.id === focusId ? '#fff' : targets.has(d.data.id) ? '#e6edf3' : '#0d1117'))
    .attr('stroke-width', (d) => (d.data.id === focusId ? 2.5 : targets.has(d.data.id) ? 1.8 : 1));

  const src = leafNodes.get(focusId);
  if (!src) return;
  const sc = centerOf(src);
  const links = [];
  let outside = 0;
  for (const [id, e] of targets) {
    const t = leafNodes.get(id);
    if (!t) { outside++; continue; }
    const tc = centerOf(t);
    links.push({ sx: sc.x, sy: sc.y, tx: tc.x, ty: tc.y, kind: e.kind, w: e.w });
  }
  linkG.selectAll('path').data(links).join('path')
    .attr('d', (l) => {
      const mx = (l.sx + l.tx) / 2;
      const my = (l.sy + l.ty) / 2;
      const bend = Math.min(60, Math.hypot(l.tx - l.sx, l.ty - l.sy) / 3);
      return `M${l.sx},${l.sy} Q${mx},${my - bend} ${l.tx},${l.ty}`;
    })
    .attr('stroke', (l) => (l.kind === 'inherit' ? '#d29922' : '#58a6ff'))
    .attr('stroke-width', (l) => Math.min(4, 1 + Math.log2(1 + (l.w || 1))))
    .attr('fill', 'none').attr('opacity', 0.7);
  linkG.selectAll('circle').data(links).join('circle')
    .attr('cx', (l) => l.tx).attr('cy', (l) => l.ty).attr('r', 2.5)
    .attr('fill', (l) => (l.kind === 'inherit' ? '#d29922' : '#58a6ff'));

  if (outside) updateChartInfo(`另有 ${outside} 条边指向当前分组之外`);
  else updateChartInfo();
}

function centerOf(node) {
  return { x: (node.x0 + node.x1) / 2, y: (node.y0 + node.y1) / 2 };
}

/** 提示框跟随鼠标（之前这段内联在 showTip 里，别处用不到；现在提出来供矩阵等处复用） */
function moveTip(ev) {
  const tip = $('#tooltip');
  if (!tip) return;
  tip.style.left = Math.min(ev.clientX + 14, innerWidth - 400) + 'px';
  tip.style.top = Math.min(ev.clientY + 14, innerHeight - 90) + 'px';
}

/** 自由文本提示（依赖矩阵用） */
function showTipText(ev, text) {
  const tip = $('#tooltip');
  tip.innerHTML = esc(text).replace(/\n/g, '<br>');
  tip.classList.remove('hidden');
  moveTip(ev);
}

function showTip(ev, d) {
  const t = state.typeById.get(d.data.id);
  if (!t) return;
  const f = state.fileById.get(t.file);
  const tip = $('#tooltip');
  tip.classList.remove('hidden');
  tip.innerHTML = `<b>${esc(t.name)}</b> <span class="muted">${esc(t.kind)}${t.system ? ' · ' + esc(sysLabel(t.system)) : ''}</span>
${esc(f.path)}:${t.line}
代码 ${fmt(t.code)} 行 · 复杂度 ${t.complexity} · fanIn ${t.fanIn} / fanOut ${t.fanOut}${t.doc ? `\n\n${esc(t.doc)}` : ''}`;
  tip.style.left = Math.min(ev.clientX + 14, innerWidth - 400) + 'px';
  tip.style.top = Math.min(ev.clientY + 14, innerHeight - 90) + 'px';
}
function hideTip() { $('#tooltip').classList.add('hidden'); }

function select(id) {
  state.selected = id;
  const t = state.typeById.get(id);
  if (t) {
    const path = groupPath(t).join('⁄');
    if (!state.focus || !(path === state.focus || path.startsWith(`${state.focus}⁄`))) state.focus = '';
  }
  writeHash();
  draw();
}

function readHash() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (p.get('by')) state.groupBy = p.get('by');
  if (p.get('d')) state.groupDepth = Number(p.get('d'));
  if (p.get('v')) state.view = p.get('v');
  if (p.get('g')) state.focus = p.get('g');
  if (p.get('t')) state.selected = Number(p.get('t'));
  if (p.get('m') && METRICS[p.get('m')]) state.metric = p.get('m');
  if (p.get('c')) state.colorMode = p.get('c');
  if (p.get('dep') === '1') state.depFocus = true;
  if (p.get('nogen') === '1') state.hideGenerated = true;
  if (p.get('q')) state.q = p.get('q').toLowerCase();
  if (p.get('l')) state.langs = new Set(p.get('l').split(',').map((s) => s.trim()).filter(Boolean));
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.groupBy !== (state.hasFacets ? 'system' : 'dir')) p.set('by', state.groupBy);
  if (state.groupDepth !== 2) p.set('d', String(state.groupDepth));
  if (state.view !== 'treemap') p.set('v', state.view);
  if (state.focus) p.set('g', state.focus);
  if (state.selected != null) p.set('t', String(state.selected));
  if (state.metric !== 'code') p.set('m', state.metric);
  if (state.colorMode !== 'file') p.set('c', state.colorMode);
  if (state.depFocus) p.set('dep', '1');
  if (state.hideGenerated) p.set('nogen', '1');
  if (state.q) p.set('q', state.q);
  if (state.langs) p.set('l', [...state.langs].join(','));
  const h = p.toString();
  history.replaceState(null, '', h ? `#${h}` : location.pathname);
}

// ---------------------------------------------------------------------------
// 依赖图（力导向）与依赖矩阵
// ---------------------------------------------------------------------------

let graphSim = null; // 力导向仿真（重画时要先停掉，否则会越跑越卡）

/** 类型级别的颜色（和树形图共用同一套调色，保证多视图颜色一致） */
function typeColor(t) {
  if (state.colorMode === 'kind') return KIND_COLOR[t.kind] || '#8b949e';
  if (state.colorMode === 'group') return hashColor(groupKeyOfType(t));
  const f = state.fileById.get(t.file);
  return hashColor('file:' + (f ? f.path : '?'));
}

function groupKeyOfType(t) {
  const segs = groupPath(t);
  return segs.length ? segs.join('\u2044') : '(\u5168\u90e8)';
}

function radiusOf(t) {
  const v = Math.max(1, metricOf(t));
  return Math.max(3.5, Math.min(22, Math.sqrt(v) / 2.2));
}

/** 依赖图：看清“谁和谁连在一起”。节点太多时只画连接最多的前 N 个。 */
function drawGraph(chart, w, h) {
  if (graphSim) { graphSim.stop(); graphSim = null; }
  const MAX = 400;
  const types = state.bundle.types.filter(matchType);
  const idSet = new Set(types.map((t) => t.id));
  let edges = state.bundle.edges.filter((e) => idSet.has(e.from) && idSet.has(e.to));
  let nodes = types;
  let note = '';
  // 节点多的时候先去掉完全孤立（没有任何依赖关系）的类型，否则一团毛线球看不出东西
  if (nodes.length > 120) {
    const linked = new Set();
    for (const e of edges) { linked.add(e.from); linked.add(e.to); }
    const kept = nodes.filter((t) => linked.has(t.id));
    if (kept.length < nodes.length) {
      note = `已隐藏 ${nodes.length - kept.length} 个没有依赖关系的类型`;
      nodes = kept;
    }
  }
  if (nodes.length > MAX) {
    const deg = new Map();
    for (const e of edges) {
      deg.set(e.from, (deg.get(e.from) || 0) + e.w);
      deg.set(e.to, (deg.get(e.to) || 0) + e.w);
    }
    nodes = types.slice().sort((a, b) => (deg.get(b.id) || 0) - (deg.get(a.id) || 0)).slice(0, MAX);
    const keep = new Set(nodes.map((t) => t.id));
    edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
    note = `${note}${note ? ' · ' : ''}节点太多，只画连接最多的前 ${MAX} 个`;
  }
  if (!nodes.length) { chart.innerHTML = '<div class="empty">没有符合条件的类型。</div>'; return 0; }

  const svg = d3.select(chart).append('svg').attr('width', w).attr('height', h);
  const root = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.15, 5]).on('zoom', (ev) => root.attr('transform', ev.transform)));

  const simNodes = nodes.map((t) => ({ id: t.id, t }));
  const simLinks = edges.map((e) => ({ source: e.from, target: e.to, e }));

  const link = root.append('g').selectAll('line').data(simLinks).join('line')
    .attr('stroke', (d) => (d.e.kind === 'inherit' ? '#d29922' : '#58a6ff'))
    .attr('stroke-opacity', 0.4)
    .attr('stroke-width', (d) => Math.min(3, 0.5 + Math.log2(1 + d.e.w) * 0.5));

  const node = root.append('g').selectAll('circle').data(simNodes).join('circle')
    .attr('r', (d) => radiusOf(d.t))
    .attr('fill', (d) => typeColor(d.t))
    .attr('fill-opacity', 0.85)
    .attr('stroke', (d) => (state.selected === d.id ? '#fff' : '#0d1117'))
    .attr('stroke-width', (d) => (state.selected === d.id ? 2.5 : 1))
    .style('cursor', 'pointer');

  const label = root.append('g').selectAll('text').data(simNodes.filter((d) => radiusOf(d.t) >= 8))
    .join('text').attr('class', 'node-label').attr('text-anchor', 'middle')
    .text((d) => truncate(d.t.name, 18));

  graphSim = d3.forceSimulation(simNodes)
    .force('link', d3.forceLink(simLinks).id((d) => d.id).distance(55).strength(0.3))
    .force('charge', d3.forceManyBody().strength(-110))
    .force('center', d3.forceCenter(w / 2, h / 2))
    .force('collide', d3.forceCollide((d) => radiusOf(d.t) + 3))
    .on('tick', () => {
      link.attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
      node.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
      label.attr('x', (d) => d.x).attr('y', (d) => d.y + radiusOf(d.t) + 11);
    });

  // 高亮：当前节点 + 它的邻居是亮的，其余压暗
  const emphasize = (focusId) => {
    if (focusId == null) {
      node.attr('fill-opacity', 0.85).attr('stroke', (d) => (state.selected === d.id ? '#fff' : '#0d1117'))
        .attr('stroke-width', (d) => (state.selected === d.id ? 2.5 : 1));
      link.attr('stroke-opacity', 0.4);
      return;
    }
    const nb = new Set([focusId]);
    for (const e of state.outs.get(focusId) || []) nb.add(e.to);
    for (const e of state.ins.get(focusId) || []) nb.add(e.from);
    node.attr('fill-opacity', (d) => (d.id === focusId ? 1 : nb.has(d.id) ? 0.95 : 0.12))
      .attr('stroke', (d) => (nb.has(d.id) ? '#c9d1d9' : '#0d1117'))
      .attr('stroke-width', (d) => (d.id === focusId ? 2.5 : nb.has(d.id) ? 1.6 : 1));
    link.attr('stroke-opacity', (d) => (d.e.from === focusId || d.e.to === focusId ? 0.9 : 0.05))
      .attr('stroke-width', (d) => (d.e.from === focusId || d.e.to === focusId ? 2 : Math.min(3, 0.5 + Math.log2(1 + d.e.w) * 0.5)));
  };
  emphasize(state.selected);

  node.on('click', (ev, d) => { select(d.id); emphasize(d.id); })
    .on('mouseenter', (ev, d) => { emphasize(d.id); showTip(ev, { data: d.t }); })
    .on('mousemove', (ev) => moveTip(ev))
    .on('mouseleave', () => { emphasize(state.selected); hideTip(); })
    .call(d3.drag()
      .on('start', (ev, d) => { graphSim.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on('end', (ev, d) => { graphSim.alphaTarget(0); d.fx = null; d.fy = null; }));

  updateChartInfo(note || `${nodes.length} 个节点 · ${edges.length} 条边（拖动可调位、滚轮缩放、点节点看详情）`);
  return nodes.length;
}

/** 依赖矩阵：分组之间的耦合强度（行 → 列 的边数），对角线是组内耦合 */
function drawMatrix(target, chart, w, h) {
  const MAXG = 22;
  const groups = new Map();
  for (const t of state.bundle.types) {
    if (!matchType(t)) continue;
    const key = groupKeyOfType(t);
    if (!groups.has(key)) groups.set(key, { key, color: typeColor(t), ids: [] });
    groups.get(key).ids.push(t.id);
  }
  let list = [...groups.values()].sort((a, b) => b.ids.length - a.ids.length);
  if (!list.length) { chart.innerHTML = '<div class="empty">没有符合筛选的类型。</div>'; return 0; }
  if (list.length > MAXG) list = list.slice(0, MAXG).concat([{ key: '(其他)', color: '#484f58', ids: list.slice(MAXG).flatMap((g) => g.ids) }]);
  const n = list.length;
  const idx = new Map(list.map((g, i) => [g.key, i]));
  const groupOf = new Map();
  for (const g of list) for (const id of g.ids) groupOf.set(id, g.key);
  const m = new Array(n * n).fill(0);
  for (const e of state.bundle.edges) {
    const a = groupOf.get(e.from), b = groupOf.get(e.to);
    if (a == null || b == null) continue;
    m[idx.get(a) * n + idx.get(b)] += e.w;
  }
  const max = Math.max(1, ...m);
  const padL = 168, padT = 130;
  const cell = Math.max(6, Math.min((w - padL - 24) / n, (h - padT - 24) / n));
  const svg = d3.select(chart).append('svg').attr('width', w).attr('height', h);
  const g0 = svg.append('g').attr('transform', `translate(${padL},${padT})`);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = m[i * n + j];
      const g = g0.append('g');
      g.append('rect')
        .attr('x', j * cell).attr('y', i * cell).attr('width', cell - 1.5).attr('height', cell - 1.5)
        .attr('rx', 1.5)
        .attr('fill', i === j ? '#30363d' : list[i].color)
        .attr('fill-opacity', v ? 0.15 + 0.85 * (Math.log(1 + v) / Math.log(1 + max)) : 0.05)
        .style('cursor', v ? 'pointer' : 'default')
        .on('mouseenter', (ev) => {
          if (!v) return;
          showTipText(ev, `${list[i].key}\n→ ${list[j].key}\n${v} 条依赖${i === j ? '（组内）' : ''}`);
        })
        .on('mousemove', moveTip)
        .on('mouseleave', hideTip);
    }
    // 行 / 列标签（用完整分组路径，只把分隔符换成 /，否则 "client/src" 和 "server/src" 都显示成 src）
    const labelOf = (k) => truncate(k.replace(/\u2044/g, '/'), 26);
    g0.append('text').attr('class', 'mx-label').attr('x', -6).attr('y', i * cell + cell / 2 + 4)
      .attr('text-anchor', 'end').text(labelOf(list[i].key));
    g0.append('text').attr('class', 'mx-label').attr('transform', `translate(${i * cell + cell / 2 + 4},-8) rotate(-60)`)
      .attr('text-anchor', 'start').text(labelOf(list[i].key));
  }
  // 找耦合最紧的一对（不含对角线）
  let best = { v: 0, i: 0, j: 0 };
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && m[i * n + j] > best.v) best = { v: m[i * n + j], i, j };
  const info = best.v
    ? `耦合最紧：${list[best.i].key.replace(/\u2044/g, '/')} → ${list[best.j].key.replace(/\u2044/g, '/')}（${best.v} 条）· 对角线=组内耦合 · 悬停看具体数量`
    : '分组之间暂时没有依赖边 · 悬停看具体数量';
  updateChartInfo(info);
  return n;
}

function renderInspector() {
  const host = $('#inspector');
  const id = state.selected;
  if (id == null || !state.typeById.has(id)) {
    const b = state.bundle;
    host.innerHTML = `<div class="muted">点一个色块看详情。

这个 bundle 里有 <b>${fmt(b.totals.types)}</b> 个类型、<b>${fmt(b.stats.namespaces)}</b> 个命名空间、<b>${fmt(b.totals.edges)}</b> 条依赖边${b.facets?.systems?.length ? `，分成 <b>${b.facets.systems.length}</b> 个系统` : ''}。</div>`;
    return;
  }
  const t = state.typeById.get(id);
  const f = state.fileById.get(t.file);
  const memberRows = Object.entries(t.members).sort((a, b) => b[1] - a[1]);
  const ins = (state.ins.get(id) || []).slice().sort((a, b) => b.w - a.w);
  const outs = (state.outs.get(id) || []).slice().sort((a, b) => b.w - a.w);

  host.innerHTML = `
    <div class="insp-title">${esc(t.name)}</div>
    <div class="insp-sub">${esc(t.fqn)}
      <span class="badge" style="border-color:${KIND_COLOR[t.kind] || '#8b949e'};color:${KIND_COLOR[t.kind] || '#8b949e'}">${esc(t.kind)}</span>
      ${t.system ? `<span class="badge" title="分组规则：${esc(t.systemRule || '—')}">${esc(sysLabel(t.system))}</span>` : ''}
      ${isGenerated(t) ? '<span class="badge" style="border-color:#6e7681;color:#8b949e">编译器生成物</span>' : ''}</div>
    ${t.doc ? `<div class="doc">${esc(t.doc)}</div>` : '<div class="doc muted">（源码里没有注释说明）</div>'}
    ${f.errors ? `<div class="doc warn-doc">这个文件有 ${f.errors} 处语法树解析异常，此类型的数据可能不全。</div>` : ''}
    <div class="kv">
      <dt>文件</dt><dd>${esc(f.path)}:${t.line}
        <button class="mini" id="copyPath">复制</button></dd>
      <dt>行数</dt><dd>${fmt(t.loc)}（代码 ${fmt(t.code)} / 注释 ${fmt(t.comment)}）</dd>
      <dt>复杂度</dt><dd>${t.complexity} <span class="muted">估算</span></dd>
      <dt>成员</dt><dd>${memberRows.length ? memberRows.map(([k, v]) => `${esc(k)} ${v}`).join(' · ') : '—'}</dd>
      <dt>依赖</dt><dd>fanIn ${t.fanIn} · fanOut ${t.fanOut}</dd>
      <dt>基类</dt><dd>${t.bases.length ? t.bases.map(esc).join(', ') : '—'}</dd>
    </div>
    ${depsSection('被谁引用（fanIn）', ins, 'from')}
    ${depsSection('引用了谁（fanOut）', outs, 'to')}
    ${t.memberList.length ? `<div class="sect"><h4>成员（前 ${Math.min(t.memberList.length, 40)}）</h4>
      ${t.memberList.slice(0, 40).map((m) => `<div class="dep${state.q && (m.n || '').toLowerCase().includes(state.q) ? ' hit' : ''}" title="${esc(m.d || '')}"><span class="n">${esc(m.n)}</span><span class="w">${esc(m.k)} · ${m.l}</span></div>${m.d ? `<div class="m-doc">${esc(truncate(m.d, 110))}</div>` : ''}`).join('')}</div>` : ''}
  `;
  $('#copyPath')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(`${f.path}:${t.line}`);
    const el = $('#copyPath');
    el.textContent = '已复制';
    setTimeout(() => { el.textContent = '复制'; }, 1200);
  });
  host.querySelectorAll('.dep[data-id]').forEach((el) => {
    el.addEventListener('click', () => select(Number(el.dataset.id)));
  });
}

function depsSection(title, list, dir) {
  if (!list.length) return `<div class="sect"><h4>${title}</h4><div class="muted">无</div></div>`;
  return `<div class="sect"><h4>${title}（${list.length}）</h4>
    ${list.slice(0, 30).map((e) => {
      const o = state.typeById.get(e[dir]);
      if (!o) return '';
      return `<div class="dep ${e.kind === 'inherit' ? 'inherit' : ''}" data-id="${o.id}" title="${esc(o.fqn)}">
        <span class="n">${esc(o.name)}</span><span class="w">${e.kind === 'inherit' ? '继承 · ' : ''}${e.w}</span></div>`;
    }).join('')}</div>`;
}
