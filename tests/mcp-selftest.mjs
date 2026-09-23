/**
 * MCP 自检：用和真实客户端一样的 stdio JSON-RPC 协议驱动 src/mcp.mjs，把每个工具都跑一遍。
 *   node tests/mcp-selftest.mjs [dist 目录，默认 dist]
 *
 * 注意：测试输入是从**这个 bundle 自己**里挑的（最热门的类型、最大的文件），
 * 所以换任何项目跑都成立 —— 不再硬编码某个项目的类名。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freshnessNote, parseExclude, isExcluded } from '../src/mcp.mjs';
import { importMatchesTarget } from '../src/modules.mjs';
import { csharpConditionalDirectives } from '../src/preprocess.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const NODE = process.env.NODE_BIN || 'node';
const outDir = process.argv[2] || 'dist';
const bundlePath = path.resolve(ROOT, outDir, 'bundle.json');
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));

const child = spawn(NODE, [path.join(ROOT, 'src', 'cli.mjs'), 'mcp', '--out', outDir], { stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT });
let buf = '';
let seq = 0;
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.log('  非 JSON 输出（会污染协议！）:', line.slice(0, 80)); continue; }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[服务] ' + d));

const req = (method, params) => new Promise((res) => { const id = ++seq; pending.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
const call = async (name, args) => {
  const r = await req('tools/call', { name, arguments: args });
  return r.result?.content?.[0]?.text ?? JSON.stringify(r.error || r.result);
};

const failed = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed.push(label);
};

// 握手
const init = await req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } });
check(!!init.result?.serverInfo, 'initialize', `${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}（协议 ${init.result?.protocolVersion}）`);
check(!!init.result?.instructions, 'initialize 带 instructions（给 AI 的说明书/边界声明）', String(init.result?.instructions || '').split('\n')[0].slice(0, 50));
notify('notifications/initialized');

const tools = await req('tools/list');
const names = (tools.result?.tools || []).map((t) => t.name);
check(names.length >= 6, 'tools/list', names.join(', '));

// 从 bundle 里挑测试输入
const hottest = bundle.types.slice().sort((a, b) => b.fanIn - a.fanIn)[0];
const biggestFile = bundle.files.slice().sort((a, b) => b.loc - a.loc)[0];
const groupName = bundle.facets?.systems?.[0]?.name || biggestFile.path.split('/')[0];

const overview = await call('overview', {});
check(/类型|types/.test(overview) && overview.length > 60, 'overview', overview.split('\n')[0].slice(0, 60));
check(/扫描根|Scan root/.test(overview), 'overview 给扫描根（AI 才能拼绝对路径去读源文件）', (overview.split('\n').find((l) => /扫描根|Scan root/.test(l)) || '').slice(0, 60));
check(/名字匹配|name match/i.test(overview), 'overview 交代可信度前提（依赖边是名字匹配）');
check(/数据快照|Snapshot/.test(overview), 'overview 给数据时效（生成时间/语言/上限）');

const search = await call('search', { query: hottest.fqn.slice(0, Math.max(3, Math.floor(hottest.name.length / 2))) });
check(search.includes(hottest.name), 'search', `找到 ${hottest.name}`);

const sym = await call('symbol', { name: String(hottest.id) });   // 用 id：多语言 bundle 里同名同全名的类型可能有好几个（C# 和 TS 的 Animal）
check(sym.includes(hottest.name) && /文件|[Ff]ile/.test(sym), 'symbol', sym.split('\n')[0].slice(0, 70));

// 用 **id** 而不是 fqn：多语言 bundle 里同名 / 同全名的类型可能有好几个（symbol / impact 那边已经这么做了，
// 这两处漏了）—— 用名字会被工具判成“歧义”并发回一句提示而不是数据，CI 上就因此红过。
const refs = await call('refs', { name: String(hottest.id), direction: 'in' });
check(refs.length > 10 && /×/.test(refs), 'refs', refs.split('\n')[0].slice(0, 70));
const refsTrunc = await call('refs', { name: String(hottest.id), direction: 'in', limit: 1 });
check(hottest.fanIn <= 1 || /还有 .*条没显示|more not shown/.test(refsTrunc), 'refs 超限时告知还剩多少', refsTrunc.split('\n').slice(-1)[0].slice(0, 60));

// 引用证据强度：refs 每条边挂一个标签（同文件 / 有支撑（import、同命名空间 / 同包、C# 父命名空间）/ 仅同名），
// overview 热点榜按“有证据的引用数”排 —— 免得好多“同名但无关”的边把没人真用的类型顶到第一
const refsAll = await call('refs', { name: String(hottest.id), direction: 'in', limit: 200 });
const tagCount = (refsAll.match(/\[(同文件|有支撑|仅同名|same file|backed|same name only)\]/g) || []).length;
const edgeCount = (refsAll.match(/×/g) || []).length;
check(edgeCount > 0 && tagCount === edgeCount, 'refs 每条边都标了引用证据强度', `${tagCount}/${edgeCount} 条带标签`);
const hasNameOnly = /\[(仅同名|same name only)\]/.test(refsAll);
// 图例只在会话首个 refs 出现（AI 实测反馈：每次重复是固定税）—— 所以查上面那次 refs（首个）
check(!hasNameOnly || /真引用|real references/.test(refs), 'refs 的图例把“仅同名”说准（图例只出现一次 · 首个 refs 上）', hasNameOnly ? '有仅同名边，首条 refs 带说明' : '这个 bundle 里没有仅同名边');

// 措辞跟着改过两轮：`被 N 处引用` → `被引用 N 次`（边权重变成真的引用次数后，"处（来源数）" 与 "次（次数）"
// 不再是同一个数，标签必须说清是哪个）。这里认两种语言的新措辞。
const hotLines = overview.split('\n').filter((l) => /被引用 \d+ 次|referenced \d+ times/.test(l));
const evOf = (l) => {
  const m = l.match(/有证据 (\d+) 次|\((\d+) with evidence\)/);       // 括号里的是“算数的”引用次数
  if (m) return Number(m[1] ?? m[2]);
  const n = l.match(/被引用 (\d+) 次|referenced (\d+) times/);
  return Number(n[1] ?? n[2]);
};
const evCounts = hotLines.map(evOf);
check(hotLines.length >= 3 && evCounts.every((v, i) => i === 0 || evCounts[i - 1] >= v), 'overview 热点榜按「有证据的引用数」排', evCounts.join(' ≥ '));

const sub = await call('subgraph', { name: String(hottest.id), depth: 2 });
check(sub.length > 10, 'subgraph', sub.split('\n')[0].slice(0, 70));

const fileOut = await call('file', { path: biggestFile.path.slice(0, Math.max(4, biggestFile.path.length - 4)) });
check(fileOut.includes('行') || fileOut.includes('line'), 'file', fileOut.split('\n')[0].slice(0, 70));

// list（目录浏览）：不认识任何名字时的入口 —— 从零探索陌生库
const listRoot = await call('list', {});
check(/\[(目录|dir)\]|\[(文件|file)\]/.test(listRoot), 'list（列扫描根）', listRoot.split('\n')[0].slice(0, 70));
const topDir = biggestFile.path.includes('/') ? biggestFile.path.split('/')[0] : '';
const listSub = await call('list', topDir ? { path: topDir } : {});
check(/本层|here/.test(listSub), 'list（子目录）', listSub.split('\n')[0].slice(0, 70));
const listMiss = await call('list', { path: 'zzz-no-such-dir-zzz' });
check(/没有正好叫|No directory or file matches/.test(listMiss), 'list（找不到时给提示）', listMiss.split('\n')[0].slice(0, 60));
// 近似候选的质量：拿真实顶层目录名的前缀去问，应该能把它找回来（原来这儿的匹配是坏的）
const seedDir = biggestFile.path.includes('/') ? biggestFile.path.split('/')[0] : '';
if (seedDir.length > 3) {
  const q2 = seedDir.slice(0, Math.min(4, seedDir.length - 1));
  const hintOut = await call('list', { path: q2 });
  check(hintOut.includes(seedDir + '/'), `list（近似候选："${q2}" 能找到 "${seedDir}/"）`, hintOut.split('\n')[0].slice(0, 70));
}

// 快照戳：只挂“本会话首个非 overview 结果”（下面是 search）—— AI 实测反馈：每次重复是固定税（2026-09-23）
const symTail2 = sym.split('\n').slice(-1)[0];
check(/(快照|snapshot).*UTC/.test(search) && !/(快照|snapshot).*UTC/.test(symTail2),
  '快照戳只挂本会话首个非 overview 结果（后面不再重复）', `first:${/(快照|snapshot)/.test(search)} later:${/(快照|snapshot)/.test(symTail2)}`);

const miss = await call('symbol', { name: 'zzz-this-does-not-exist' });
check(/没有|找不到|No symbol|not found/i.test(miss), '找不到时给提示', miss.split('\n')[0].slice(0, 60));

const byKind = await call('search', { query: hottest.fqn.slice(0, Math.max(3, Math.floor(hottest.name.length / 2))), kind: hottest.kind });
check(byKind.length > 0, 'search（带类别过滤）', byKind.split('\n')[0].slice(0, 60));

// 成员名搜索：同样从 bundle 自己里挑（谁定义了某个成员）
const owner = bundle.types.filter((t) => (t.memberList || []).length && t.memberList.some((m) => m.n && m.n.length >= 4)).sort((a, b) => b.fanIn - a.fanIn)[0];
if (owner) {
  const member = owner.memberList.find((m) => m.n && m.n.length >= 4);
  const frag = member.n.slice(0, Math.max(4, Math.floor(member.n.length / 2)));
  const msearch = await call('search', { query: frag, scope: 'member' });
  check(msearch.includes(member.n), 'search（按成员名）', `找 ${owner.name}.${member.n}`);
  const noMember = await call('search', { query: frag, scope: 'type' });
  check(!/（定义在 |\(defined in /.test(noMember), 'search（scope=type 不搜成员）', noMember.split('\n')[0].slice(0, 60));
} else {
  check(true, 'search（按成员名）', '这个 bundle 里没有带名字的成员，跳过');
}

// 成员签名（参数表 + 返回类型）：同名重载靠它才分得开 —— 从 bundle 自己里挑一个真抽到签名的来验
const sigOwner = bundle.types.find((t) => (t.memberList || []).some((m) => m.p || m.r));
if (sigOwner) {
  const sm = sigOwner.memberList.find((m) => m.p || m.r);
  const sig = `${sm.p || ''}${sm.r ? `: ${sm.r}` : ''}`;
  const symSig = await call('symbol', { name: String(sigOwner.id), members: 300 });
  check(symSig.includes(sm.n + sig), 'symbol（成员带签名）', `${sigOwner.name}.${sm.n}${sig}`);
  const msearch2 = await call('search', { query: sm.n, scope: 'member' });
  check(msearch2.includes(sig), 'search（成员命中带签名）', sig.slice(0, 48));
} else {
  check(true, 'symbol（成员带签名）', '这个 bundle 里没有抽到签名的成员，跳过');
}
// 类型自己身上的签名（JS/TS 的顶层函数、record 主构造函数都在这一档）
const typeSig = bundle.types.find((t) => t.p || t.r);
if (typeSig) {
  const s = `${typeSig.p || ''}${typeSig.r ? `: ${typeSig.r}` : ''}`;
  const out = await call('symbol', { name: String(typeSig.id) });
  check(out.includes(s), 'symbol（类型带签名）', `${typeSig.name}${s}`);
}

// 成员级提问：refs 拿到“类型.成员”要指回所属类型与它的引用方，而不是答“找不到”（用户实测的硬伤）
const withMember = bundle.types.find((t) => (t.memberList || []).some((x) => x.n) && t.fqn);
if (withMember) {
  const m = withMember.memberList.find((x) => x.n);
  const q = `${withMember.fqn}.${m.n}`;
  const r = await call('refs', { name: q, dir: 'in' });
  check(!/找不到匹配/.test(r) && r.includes(`id=${withMember.id}`), 'refs（类型.成员 → 指回所属类型）', q);
  const sr = await call('search', { query: m.n, scope: 'member' });
  check(sr.includes(`所属类型 id=${withMember.id}`) || sr.includes(`owner type id=${withMember.id}`), 'search（成员命中带所属类型 id）', m.n);
}
// 行数口径：overview 与 file 都要写清哪个是“代码行”。这两条原来只认中文 —— 而自检是可以带着
// CODEATLAS_LANG=en 跑的（引擎本来就双语），那样这两门会假红。两语言都认。
check(/按代码行|by code lines/.test(overview), 'overview 写明“按代码行”', '最大的文件（按代码行）');
const anyFile = bundle.files.find((f) => f.loc > 0 && f.path);
if (anyFile) {
  const fi = await call('file', { path: anyFile.path.split('/').pop() });
  check(/其中代码|lines total/.test(fi), 'file 写明总行与代码行', `行数：${fi.match(/[\d,]+ 行[^\n]*|[\d,]+ lines total[^\n]*/)?.[0] || '（读不到）'}`.slice(0, 70));
}

const map600 = await call('map', { budget: 600 });
check(map600.length > 80 && map600.length / 4 < 600 * 1.4, 'map（token 预算）', `约 ${Math.ceil(map600.length / 4)} token / 预算 600`);

const impact = await call('impact', { name: String(hottest.id), depth: 2 });
check(/影响面|Impact/.test(impact) && /第 1 层|没有已知的引用者|Level 1|no known referrers/.test(impact), 'impact（影响面）', impact.split('\n')[0].slice(0, 70));
const impactMiss = await call('impact', { name: 'zzz-this-does-not-exist' });
check(/找不到|No symbol|not found/i.test(impactMiss), 'impact（找不到时给提示）', impactMiss.split('\n')[0].slice(0, 50));

// ---------------------------------------------------------------------------
// 快照新鲜度（overview 的「⚠ 快照后…」那行）：图里那些文件在磁盘上变了没有
// 只 re-stat 已纳入图里的文件 —— 所以这里逐个造出三种情形（内容变了 / 只动时间戳 / 文件没了），
// 看它有没有如实、分档地报出来；再加一个反例：刚扫完的图**不该**报“图旧了”（免得成天误报）。
// 用完的临时项目留在系统 temp 里（和语言夹具那边的做法一样），不清。
// ---------------------------------------------------------------------------
// 下面两段各自要一个独立的小项目 + 一个独立的 MCP 服务，所以把“起服务 + 最小客户端”抽出来
function spawnMcp(outDir) {
  const proc = spawn(NODE, [path.join(ROOT, 'src', 'cli.mjs'), 'mcp', '--out', outDir], { stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT });
  let buf = '';
  let seq = 0;
  const pending = new Map();
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    }
  });
  proc.stderr.on('data', () => {});   // 这两段只看工具正文，不把服务端日志掺进来
  const req = (method, params) => new Promise((res) => { const id = ++seq; pending.set(id, res); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args) => {
    const r = await req('tools/call', { name, arguments: args });
    return r.result?.content?.[0]?.text ?? '';
  };
  const ready = req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } });
  return { proc, req, call, ready };
}

/** 现造一个临时项目并扫一次（默认限制在一门语言里：同一个进程装多门语法包会崩） */
function scanProject(tmpDir, files, lang = 'javascript') {
  const root = path.join(tmpDir, 'proj');
  const out = path.join(tmpDir, 'out');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  execFileSync(NODE, [path.join(ROOT, 'src', 'cli.mjs'), 'scan', root, '--lang', lang, '--out', out], { stdio: 'pipe' });
  return { root, out };
}

/** 读一份 bundle（gate 里查边 / 查 unresolved 用） */
const readBundle = (outDir) => JSON.parse(fs.readFileSync(path.join(outDir, 'bundle.json'), 'utf8'));

const freshTmp = path.join(os.tmpdir(), `codeatlas-fresh-${process.pid}`);
const { root: freshRoot, out: freshOut } = scanProject(freshTmp, {
  'a.js': 'function alpha(x) { return x + 1; }\n',
  'b.js': 'function beta(y) { return y * 2; }\n',
  'c.js': 'function gamma(z) { return z; }\n',
});
const fA = path.join(freshRoot, 'a.js');
const fB = path.join(freshRoot, 'b.js');
const fC = path.join(freshRoot, 'c.js');

const fresh = spawnMcp(freshOut);
await fresh.ready;

// 三种措辞都要认（两语言 + “只有文件没了”那种单独形态）
const freshLine = (o) => o.split('\n').find((l) => /快照后|after this snapshot|are no longer on disk/i.test(l)) || '';
const grab = (line, res) => { for (const re of res) { const m = line.match(re); if (m) return Number(m[1]); } return null; };
const cntChanged = (line) => grab(line, [/快照后 (\S+) 个已纳入图里的文件有改动/, /⚠ (\S+) mapped files changed/]);
const cntTimeOnly = (line) => grab(line, [/其中 (\S+) 个仅时间戳变化/, /\((\S+) timestamp-only\)/]);
const cntGone = (line) => grab(line, [/另有 (\S+) 个已不在磁盘/, /and (\S+) are no longer on disk/, /快照后有 (\S+) 个已纳入图里的文件已不在磁盘/, /⚠ (\S+) mapped files are no longer on disk/]);

const oFresh = await fresh.call('overview', {});
check(!freshLine(oFresh), '快照新鲜度：刚扫完的图不报“图旧了”（不误报）');

fs.appendFileSync(fA, '// grow\n');                        // 内容变了（大小跟着变）
const lGrow = freshLine(await fresh.call('overview', {}));
check(!!lGrow && cntChanged(lGrow) === 1 && !cntTimeOnly(lGrow) && !cntGone(lGrow),
  '快照新鲜度：内容变了要报（1 个改动，不混进时间戳档）', lGrow.trim().slice(0, 80));

const mtimeB = fs.statSync(fB).mtimeMs;
fs.utimesSync(fB, new Date(), new Date(mtimeB + 60000));   // 只动时间戳：大小不变
const lTouch = freshLine(await fresh.call('overview', {}));
check(!!lTouch && cntChanged(lTouch) === 2 && cntTimeOnly(lTouch) === 1 && !cntGone(lTouch),
  '快照新鲜度：“仅时间戳变化”单独计数（也不叫“未改”——证明不了内容没变）', lTouch.trim().slice(0, 80));

fs.rmSync(fC);                                             // 已纳入图里、磁盘上已经没了
const lGone = freshLine(await fresh.call('overview', {}));
check(!!lGone && cntChanged(lGone) === 2 && cntTimeOnly(lGone) === 1 && cntGone(lGone) === 1,
  '快照新鲜度：已不在磁盘的要白送一句', lGone.trim().slice(0, 80));

// 不许乱报的几种输入：多了根（path 归谁无法判定）、没有根、文件没记 mtime（老 bundle）
const quiet = [
  [null, '空 bundle'],
  [{ source: { roots: ['C:/a', 'C:/b'] }, files: [{ path: 'x.js', mtime: 1, bytes: 1 }] }, '多根'],
  [{ source: { roots: [] }, files: [{ path: 'x.js', mtime: 1, bytes: 1 }] }, '没有根'],
  [{ source: { roots: [freshRoot] }, files: [{ path: 'a.js', bytes: 1 }] }, '老 bundle（没记 mtime）'],
  [{ source: { roots: [path.join(freshTmp, 'gone-proj')] }, files: [{ path: 'a.js', mtime: 1, bytes: 1 }] }, '根已不在磁盘'],
];
check(quiet.every(([b]) => freshnessNote(b) === ''), '快照新鲜度：多根 / 无根 / 老 bundle / 根不在 → 一律沉默（不猜）', `${quiet.length} 种输入`);

// 工具描述是调用方**调用前唯一能看到的东西**，不能和实现打架：新鲜度会报“已不在磁盘”，描述里就必须说；
// 也**不许**再写成“新增 / 删除都看不见” —— 复验报告 §5 抓到的就是这处不一致（门锁住它，防止改回去）。
const ovDesc = tools.result.tools.find((t) => t.name === 'overview').description;
// 门一：工具描述与实现一致 —— 取 tools/list 里的**实际描述文本**（运行时那份，不是源码）
check(/no longer on disk/.test(ovDesc) && !/added or removed/i.test(ovDesc),
  'overview 的工具描述与新鲜度实现一致（会报“已不在磁盘”；不许写成“新增 / 删除都看不见”）');

// 文档门（二轮复验的建议）：这次的教训是“同一句话说在 5 个地方”，而上面那道门只锁住了 schema 那一处 ——
// 另外 4 处（instructions / 注释 / CHANGELOG / 两个 README）仍靠人眼。所以把**文档也纳入断言**：
// 不许再出现旧措辞，而且 README 必须“说了对的话”（删旧词 ≠ 说了新话）。
const DOC_FILES = ['src/mcp.mjs', 'README.md', 'README_CN.md', 'CHANGELOG.md', 'USAGE.md', '使用说明.md'];
const docBad = [];
const docs = {};
for (const rel of DOC_FILES) {
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
  // 唯一允许带旧词的是 mcp.mjs 里那条“别把这句话写成……”的反向警示注释（它本身就是防线）
  const kept = lines.filter((l) => !/别把这句话写成/.test(l));
  docs[rel] = kept.join('\n');
  if (kept.some((l) => /added or removed|新增 \/ 删除/.test(l))) docBad.push(rel);
}
check(docBad.length === 0, '文档门：6 份文档里不许再出现旧措辞（added or removed / 新增 / 删除）',
  docBad.length ? docBad.join(', ') : '全部干净（含 instructions / 注释 / CHANGELOG / 中英 README / 中英使用说明）');
check(/no longer on disk/.test(docs['README.md']) && /已不在磁盘/.test(docs['README_CN.md']),
  '文档门：README 说了对的话（no longer on disk / 已不在磁盘），不只是删掉旧词');

fresh.proc.kill('SIGKILL');

// ---------------------------------------------------------------------------
// 影响面单列「会被波及的测试文件」：改一个类型 → 要跑哪些测试（与“哪些生产代码要改”分开说）
// 认测试文件只能按路径（规则见 scan.mjs 的 isTestPath）。这里把两种情况都摆上：
// ① 测试文件引用它 → 要列出来，而且生产代码不能混进这个名单；
// ② 只有生产代码引用它 → 要说清是“测试都不引用”而不是“图里没认出测试”（否则会被读成“没测试会挂”）。
// ---------------------------------------------------------------------------
const impTmp = path.join(os.tmpdir(), `codeatlas-impact-${process.pid}`);
const { out: impOut } = scanProject(impTmp, {
  'src/core.js': 'export class Widget { }\nexport function core() { return 1; }\n',
  'src/user.js': 'import { Widget } from "./core.js";\nexport function useWidget() { return new Widget(); }\n',
  'tests/core.test.js': 'import { Widget } from "../src/core.js";\nexport function specWidget() { return new Widget(); }\n',
});
const imp = spawnMcp(impOut);
await imp.ready;
const lineOf = (text) => (text.split('\n').find((l) => /测试文件|Test files/.test(l)) || '').trim();

const impWidget = await imp.call('impact', { name: 'Widget', depth: 2 });
const lWidget = lineOf(impWidget);
check(/tests\/core\.test\.js/.test(lWidget) && !/src\/user\.js/.test(lWidget),
  'impact：单列会被波及的测试文件（生产代码不混进这个名单）', lWidget.slice(0, 80));

const impCore = await imp.call('impact', { name: 'core', depth: 2 });
const lCore = lineOf(impCore);
check(/没有被波及|none affected/.test(lCore),
  'impact：测试都不引用它时，说明是“没被波及”而不是“没认出测试”（不留误读空间）', lCore.slice(0, 80));

// 图里根本没认出测试文件时，也得说清（不然 AI 会把空名单当成“安全”）
const noTestTmp = path.join(os.tmpdir(), `codeatlas-notest-${process.pid}`);
const { out: noTestOut } = scanProject(noTestTmp, {
  'src/a.js': 'export class Gadget { }\n',
  'src/b.js': 'import { Gadget } from "./a.js";\nexport function useGadget() { return new Gadget(); }\n',
});
const nt = spawnMcp(noTestOut);
await nt.ready;
const lNoTest = lineOf(await nt.call('impact', { name: 'Gadget', depth: 2 }));
check(/没认出测试文件|no such mark/.test(lNoTest),
  'impact：图里没有这个标记时明说（不把“没认出”或“引擎旧”说成“没被波及”）', lNoTest.slice(0, 80));
nt.proc.kill('SIGKILL');
imp.proc.kill('SIGKILL');

// 单元级：exclude 的取值语义 —— 先查解析（逗号 / 首尾斜杠 / 反斜杠 / 大小写 / 空白）
const exC = parseExclude('  Tests\\Fixtures/ ,  ');
check(exC.length === 1 && exC[0].join('/') === 'tests/fixtures',
  'exclude：解析归一（逗号分隔 / 首尾斜杠 / 反斜杠 / 大小写 / 空白）', exC.map((p) => p.join('/')).join(' | '));

// 再逐条查命中语义。这张表来自二轮复验的**独立探针**（15 条），现在成为永久门 ——
// 每条都写清“为什么”，改动时一眼看出哪条被破了。
const EX_CASES = [
  ['tests/fixtures', 'tests/fixtures/java/Sample.java', true, '多段：命中'],
  ['tests/fixtures', 'a/tests/fixtures/b.java', true, '多段：任意层级起点'],
  ['tests/fixtures', 'tests/x/fixtures/y.java', false, '多段：不连续 → 不命中（连续段序列）'],
  ['tests/fixtures', 'Tests\\Fixtures/Java/S.java', true, '反斜杠 + 大小写不敏感'],
  ['/tests/fixtures/', 'src/tests/fixtures/z.ts', true, '首尾斜杠归一'],
  ['vendor', 'src/vendor/lib.js', true, '单段：目录段'],
  ['vendor', 'src/vendor.ts', true, '单段：文件名主干（vendor.ts 也排）'],
  ['vendor', 'src/vendors/lib.js', false, '单段：vendors ≠ vendor（段要整段相等）'],
  ['vendor', 'src/vendor_helper.ts', false, '单段：主干要整词相等，vendor_helper 不误伤'],
  ['test', 'tests/a.js', false, '段必须整段相等（test 不该命中 tests/a.js）'],
  ['test', 'src/test/a.js', true, '整段相等 ✓'],
  ['*.g.cs', 'obj/Debug/Foo.g.cs', false, '不做通配 / 不看扩展名（那类走 atlas.ignore）'],
  ['obj', 'obj/Debug/Foo.g.cs', true, '目录段 obj'],
  ['tests/fixtures', 'tests/fixtures', true, '路径本身就是那个目录'],
  ['a,b', 'b/x.js', true, '逗号分隔多条'],
];
for (const [pat, p, want, why] of EX_CASES) {
  check(isExcluded(parseExclude(pat), p) === want, `exclude：${why}`, `exclude="${pat}" path="${p}" → ${want}`);
}

// 端到端：一个带 fixtures 噪声的小项目，把五个工具的 exclude 都走一遍
const exTmp = path.join(os.tmpdir(), `codeatlas-exclude-${process.pid}`);
const { out: exOut } = scanProject(exTmp, {
  'src/core.js': 'export class Widget { }\nexport function useWidget() { return new Widget(); }\n',
  'src/lonely.js': 'export class Lone { }\n',
  'tests/real.test.js': 'import { Widget } from "../src/core.js";\nexport function specWidget() { return new Widget(); }\n',
  'tests/fixtures/sample.js': 'import { Lone } from "../../src/lonely.js";\nexport function fixtureSample() { return new Lone(); }\n',
  'tests/fixtures/noise.test.js': 'import { Widget } from "../../src/core.js";\nexport function fixtureWidget() { return new Widget(); }\n',
});
const exc = spawnMcp(exOut);
await exc.ready;
const EX = 'tests/fixtures';
const sizeOf = (ov) => (ov.split('\n').find((l) => /^规模：|^Size: /.test(l)) || '').trim();

const ovPlain = await exc.call('overview', {});
const ovEx = await exc.call('overview', { exclude: EX });
check(sizeOf(ovPlain) === sizeOf(ovEx) && /规模|Size/.test(sizeOf(ovEx)),
  'exclude：**不改项目事实**（规模那行一模一样）', sizeOf(ovEx).slice(0, 40));
check(/exclude "/.test(ovEx) && /候选里排除了|from the candidate pool/.test(ovEx),
  'exclude：榜类名单报“候选里排除了 N 个”（不是拿 8 行的榜单说数）',
  (ovEx.split('\n').find((l) => /exclude "/.test(l)) || '').trim().slice(0, 70));

const srAll = await exc.call('search', { query: 'fixtureSample', exclude: EX });
check(/都被 exclude|were all dropped by exclude/.test(srAll),
  'exclude：命中被排空时**不说“没有匹配”**（那是静默谎言）', srAll.split('\n')[0].trim().slice(0, 70));
const srSome = await exc.call('search', { query: 'Widget', exclude: EX });
check(/specWidget/.test(srSome) && !/fixtureWidget/.test(srSome) && /src\/core\.js/.test(srSome),
  'exclude：search 生效（真命中留下、fixtures 里的那个没了）');

const imEx = await exc.call('impact', { name: 'Widget', exclude: EX });
const tl = (imEx.split('\n').find((l) => /^会被波及的测试文件|^Test files affected/.test(l)) || '').trim();
check(/tests\/real\.test\.js/.test(tl) && !/fixtures/.test(tl),
  'exclude：impact 的测试文件名单也被过滤', tl.slice(0, 70));

const imLone = await exc.call('impact', { name: 'Lone', exclude: EX });
check(/全部被 exclude 排除|everything dropped by exclude/.test(imLone) && !/（0 个）|\(0\)/.test(imLone),
  'exclude：整层被排空时说“全被排除”，**不许出现 (0 个)**',
  (imLone.split('\n').find((l) => /exclude/.test(l)) || '').trim().slice(0, 70));

const rfLone = await exc.call('refs', { name: 'Lone', direction: 'in', exclude: EX });
check(/全部被 exclude 排除|everything dropped by exclude/.test(rfLone) && !/：无|: none/.test(rfLone),
  'exclude：refs 整份名单被排空时不显示“无”', (rfLone.split('\n')[1] || '').trim().slice(0, 70));

const mapEx = await exc.call('map', { budget: 600, exclude: EX });
check(/exclude "/.test(mapEx.split('\n').slice(0, 3).join('\n')),
  'exclude：map 的自报行在开头（骨架整份就是“名单”）');

const missEx = await exc.call('overview', { exclude: 'zzz-nope' });
check(/没匹配到任何路径|matched no path/.test(missEx),
  'exclude：写错字 / 没命中时明说（否则以为过滤生效了）',
  (missEx.split('\n').find((l) => /exclude/.test(l)) || '').trim().slice(0, 70));

// 工具范围：exclude 只给“会列出名字”的 5 个；list / symbol / file 不加（浏览、单点工具加了会让人误判“这里没有”）
const withEx = tools.result.tools.filter((t) => t.inputSchema?.properties?.exclude).map((t) => t.name).sort().join(',');
check(withEx === 'impact,map,overview,refs,search', 'exclude 只加在 5 个“会列出名字”的工具上（list/symbol/file 不加）', withEx);
exc.proc.kill('SIGKILL');

// ---------------------------------------------------------------------------
// symbol(neighbors: true)：默认输出一个字节不变，显式要才追加“邻居”块
// （上一轮复验嫌 symbol 啰嗦，两方诉求相反 —— 所以默认关，而且验的就是“默认真的一字节没变”）
// ---------------------------------------------------------------------------
const nbTmp = path.join(os.tmpdir(), `codeatlas-neighbors-${process.pid}`);
const { out: nbOut } = scanProject(nbTmp, {
  'src/core.js': 'export class Widget { }\nexport class Lone { }\n',
  'src/a.js': 'import { Widget } from "./core.js";\nexport function a() { return new Widget(); }\n',
  'src/b.js': 'import { Widget } from "./core.js";\nexport function b() { return new Widget(); }\n',
  'src/c.js': 'import { Widget } from "./core.js";\nexport function c() { return new Widget(); }\n',
  'src/d.js': 'import { Widget } from "./core.js";\nexport function d() { return new Widget(); }\n',
  'src/e.js': 'import { Widget } from "./core.js";\nexport function e() { return new Widget(); }\n',
  'src/f.js': 'import { Widget } from "./core.js";\nexport function f() { return new Widget(); }\n',
  'tests/one.test.js': 'import { Widget } from "../src/core.js";\nexport function t1() { return new Widget(); }\n',
  'tests/two.test.js': 'import { Widget } from "../src/core.js";\nexport function t2() { return new Widget(); }\n',
  'src/loneUser.js': 'import { Lone } from "./core.js";\nexport function loneUser() { return new Lone(); }\n',
});
const nb = spawnMcp(nbOut);
await nb.ready;
const symDef = await nb.call('symbol', { name: 'Widget', members: 0 });
const symOff = await nb.call('symbol', { name: 'Widget', members: 0, neighbors: false });
const symOn = await nb.call('symbol', { name: 'Widget', members: 0, neighbors: true });
// 最后一行可能是一次性快照戳（只挂本会话首个非 overview 结果），比较前去掉它
const strip = (s) => s.split('\n').filter((l) => !/^（快照 |^\(snapshot /.test(l)).join('\n');
check(strip(symDef) === strip(symOff) && !/邻居|Neighbors/.test(symDef),
  'symbol：不带 neighbors 时输出**一个字节不变**（邻居块默认不显示）');
check(strip(symOn).startsWith(strip(symDef)),
  'symbol(neighbors:true)：只是在原有输出后面**追加**（原有内容一字不动）');
check(/被谁引用|referenced by/.test(symOn) && /引用了谁|references/.test(symOn),
  'symbol(neighbors:true)：给出“被谁引用”与“引用了谁”两行');
check(/tests\/one\.test\.js/.test(symOn) && /tests\/two\.test\.js/.test(symOn),
  'symbol(neighbors:true)：列出相关测试文件',
  (symOn.split('\n').find((l) => /相关测试文件|Related test files/.test(l)) || '').trim().slice(0, 60));
check((symOn.match(/×1/g) || []).length === 5 && /前 5|first 5/.test(symOn),
  'symbol(neighbors:true)：来源多于 5 个时只给前 5 个并标明', `${(symOn.match(/×1/g) || []).length} 条列出来`);
// 口径一致：邻居块的“N 条边 · 共 M 次”与 refs 对同一个类型说的同一句话
const refsIn = await nb.call('refs', { name: 'Widget', direction: 'in' });
// 不硬编码条数：从 refs 自己那句抬头里取出来，再看 symbol 那边说的是不是同一句
const rm = refsIn.match(/（(\d+) 条边 · 共 ([\d,]+) 次）/) || refsIn.match(/\((\d+) edges · ([\d,]+) in total\)/);
check(!!rm && (symOn.includes(`${rm[1]} 条边 · 共 ${rm[2]} 次`) || symOn.includes(`${rm[1]} edges · ${rm[2]} in total`)),
  'symbol 的邻居块与 refs **同一个口径**（N 条边 · 共 M 次）', rm ? `refs 说「${rm[1]} 条边 · 共 ${rm[2]} 次」` : '（refs 抬头解析失败）');
const symLone = await nb.call('symbol', { name: 'Lone', members: 0, neighbors: true });
check(/相关测试文件：无（图里 \d+ 个测试文件，都不引用它）|Related test files: none \(the map has/.test(symLone),
  'symbol(neighbors:true)：有测试文件但都不引用它时说清楚（不把“没被引用”说成“没有测试”）',
  (symLone.split('\n').find((l) => /相关测试文件|Related test files/.test(l)) || '').trim().slice(0, 60));
nb.proc.kill('SIGKILL');

// ---------------------------------------------------------------------------
// ① 成员级名字级调用图：refs("成员名") 直接列调用 / 访问位置（file:line）
// ---------------------------------------------------------------------------
const useTmp = path.join(os.tmpdir(), `codeatlas-memberuses-${process.pid}`);
const { out: useOut } = scanProject(useTmp, {
  'widget.js': 'export class Widget {\n  render() { return 1; }\n  get title() { return "x"; }\n}\nexport function useIt() {\n  const w = new Widget();\n  w.render();\n  return w.title;\n}\n',
  // 文件级（类型之外）的调用 + **同一行前面有中文**（列号陷阱：tree-sitter 的 column 就是码元偏移，别再换算）
  'main.mjs': 'import { Widget } from "./widget.js";\nconst w2 = new Widget();\nw2.render();\n/* 中文注释在同行 */ w2.render();\n',
});
const us = spawnMcp(useOut);
await us.ready;

const rRender = await us.call('refs', { name: 'render' });
check(/widget\.js:7/.test(rRender) && /main\.mjs:3/.test(rRender),
  '① refs(成员名)：列出调用位置（file:line）', (rRender.split('\n').find((l) => /widget\.js:7/.test(l)) || '').trim().slice(0, 60));
// 只检查“位置行”（形如 `  file:line\t调用`），不要去碰“所属类型”那一行 —— 后者本来就写着声明位置
const siteRows = rRender.split('\n').filter((l) => /^\s+\S+:\d+\t(调用|访问|call|access)$/.test(l));
check(siteRows.length === 3 && !siteRows.some((l) => /widget\.js:2\b/.test(l)),
  '① 声明行不算调用点（`render() {` 后面也跟括号，但它不是调用）', `${siteRows.length} 行位置：${siteRows.map((l) => l.trim()).join(' · ')}`);
check(/main\.mjs:4/.test(rRender) && /共 3 处|matched by name: 3/.test(rRender),
  '① 同一行前面有中文注释也抓得到（列号不当字节算）',
  (rRender.split('\n').find((l) => /共 \d+ 处|matched by name/.test(l)) || '').trim().slice(0, 60));
const rTitle = await us.call('refs', { name: 'Widget.title' });
check(/widget\.js:8\t(访问|access)/.test(rTitle),
  '① `类型.成员` 形式也给位置，并且区分“调用 / 访问”',
  (rTitle.split('\n').find((l) => /widget\.js:8/.test(l)) || '').trim().slice(0, 60));
const rNone = await us.call('refs', { name: 'no_such_member_zzz' });
check(!/调用 \/ 访问位置/.test(rNone), '① 查不存在的名字时不扯调用位置');

// 老图：判据是**引擎版本**（不是“图里有没有 uses 字段”—— 新引擎扫的小工程本来就可能一条都没有）
const oldOut = path.join(useTmp, 'out-old');
{
  fs.mkdirSync(oldOut, { recursive: true });
  const b = JSON.parse(fs.readFileSync(path.join(useOut, 'bundle.json'), 'utf8'));
  b.generator.version = '1.4.2';              // 老引擎版本
  for (const t of b.types) delete t.uses;     // 而且老引擎根本不会产生 uses —— 两样都要模拟，否则位置段照常列位置
  for (const f of b.files) delete f.uses;
  fs.writeFileSync(path.join(oldOut, 'bundle.json'), JSON.stringify(b));
}
const usOld = spawnMcp(oldOut);
await usOld.ready;
const rOld = await usOld.call('refs', { name: 'render' });
check(/没有这类记录|carries no such records/.test(rOld) && !/一处都没找到|none found/.test(rOld),
  '① 引擎 < 1.5.0 的图明说“没记录”，不说“一处都没找到”',
  (rOld.split('\n').find((l) => /调用 \/ 访问位置|Call \/ access sites/.test(l)) || '').trim().slice(0, 70));
usOld.proc.kill('SIGKILL');
us.proc.kill('SIGKILL');

// ---------------------------------------------------------------------------
// 复测报告（2026-09-20）三个发现的回归门：① 同名歧义丢边 ② 顶层函数没有行号 ③ 命名空间语言证据塔掉
// ---------------------------------------------------------------------------
// ① 同名两处 + 第三方调用（JS 没命名空间）：import 已指名目标，就该接上，而不是整条丢掉
const ambTmp = path.join(os.tmpdir(), `codeatlas-ambig-${process.pid}`);
const { out: ambOut } = scanProject(ambTmp, {
  'f1.js': 'export function dup() { return 1; }\n',
  'f2.js': 'import { dup } from "./f1.js";\nexport function use1() { return dup(); }\n',
  'f3.js': 'export function dup() { return 2; }\nexport function use2() { return dup(); }\n',
});
const ambB = readBundle(ambOut);
const dup1 = ambB.types.find((t) => t.name === 'dup' && ambB.files[t.file].path === 'f1.js');
const dup3 = ambB.types.find((t) => t.name === 'dup' && ambB.files[t.file].path === 'f3.js');
const use1 = ambB.types.find((t) => t.name === 'use1');
const use2 = ambB.types.find((t) => t.name === 'use2');
check(ambB.edges.some((e) => e.from === use1.id && e.to === dup1.id),
  '① 同名歧义：**import 指名的那一个**被接上了（以前整条边静默丢掉）',
  `use1 → ${dup1 ? 'f1.js 的 dup' : '?'} 的边${ambB.edges.some((e) => e.from === use1.id) ? '在' : '缺'}`);
check(ambB.edges.some((e) => e.from === use2.id && e.to === dup3.id),
  '① 另一个调用方仍然接到它自己那份（没被消歧带到错的地方）');
check(ambB.unresolved.ambiguous === 0,
  '① 消歧成功后不再计入 ambiguous（以前这里会 +1）', `ambiguous=${ambB.unresolved.ambiguous}`);

// ③ 命名空间语言：同命名空间 / 用了 using 的都算“有支撑”，不能整片塔成“仅同名”
const nsTmp = path.join(os.tmpdir(), `codeatlas-ns-${process.pid}`);
const { out: nsOut } = scanProject(nsTmp, {
  'a/A.cs': 'namespace Demo.A\n{\n    public class Alpha\n    {\n        public int Value() { return 1; }\n    }\n}\n',
  'a/B.cs': 'namespace Demo.A\n{\n    public class Beta\n    {\n        public Alpha Make() { return new Alpha(); }\n    }\n}\n',
  'c/C.cs': 'using Demo.A;\n\nnamespace Demo.C\n{\n    public class Gamma\n    {\n        public Alpha Make() { return new Alpha(); }\n    }\n}\n',
  // 父命名空间：子命名空间里引用父命名空间的类型**不需要 using**（C# 语义）—— 实测一个真实 C# 项目有 7 条真引用
  // 因此被留在“仅同名”档，AI 照标签会把它们丢掉
  'p/Root.cs': 'namespace Demo\n{\n    public class Root\n    {\n    }\n}\n',
  'q/Kid.cs': 'namespace Demo.Deep\n{\n    public class Kid\n    {\n        public Root Field;\n    }\n}\n',
  // 构造函数与类同名（C#/Java/Kotlin 必然如此）：它的声明行不能算“调用点”
  'r/Widget.cs': 'namespace Demo.R\n{\n    public class Widget\n    {\n        public Widget() { }\n    }\n}\n',
  'r/Use.cs': 'namespace Demo.R\n{\n    public class User\n    {\n        public User() { }\n        public Widget Make() { return new Widget(); }\n    }\n}\n',
  // 别的类型里有个成员叫 Widget —— 这才是真正会混进 `refs("…Widget")` 的那种同名风险
  's/Holder.cs': 'namespace Demo.S\n{\n    public class Holder\n    {\n        public int Widget;\n    }\n}\n',
}, 'csharp');
const ns = spawnMcp(nsOut);
await ns.ready;
const rAlpha = await ns.call('refs', { name: 'Demo.A.Alpha', direction: 'in' });
const backed = (rAlpha.match(/\[(有支撑|backed)\]/g) || []).length;
const nameOnly = (rAlpha.match(/\[(仅同名|same name only)\]/g) || []).length;
check(backed >= 2 && nameOnly === 0,
  '③ 命名空间语言：“同命名空间”与“using 了目标命名空间”都算有支撑（以前全塔成仅同名）',
  `有支撑 ${backed} 条 · 仅同名 ${nameOnly} 条`);
const ovNs = await ns.call('overview', {});
check(/Alpha|Beta|Gamma/.test(ovNs.split('\n').find((l) => /被引用 \d+ 次|referenced \d+ times/.test(l)) || ''),
  '③ overview 热点榜能看见被真依赖的类型（实样本上以前会把第一名挤掉）');
// 父命名空间不许 using 也算有支撑（C# 语义），且只对 C# 家族生效
const rRoot = await ns.call('refs', { name: 'Demo.Root', direction: 'in' });
check(/\[(有支撑|backed)\]/.test(rRoot) && !/\[(仅同名|same name only)\]/.test(rRoot),
  '③ C# 父命名空间（子ns下引用父ns类型）也算有支撑',
  (rRoot.split('\n').find((l) => /Root/.test(l)) || '').trim().slice(0, 70));
// 类型回答的位置段不许把“同名成员（构造函数）的声明行”当调用点 —— 实测一个 C# 项目 20 个类型各中一个
const nsBundle = readBundle(nsOut);
const ctorOwner = nsBundle.types.find((t) => t.name === 'Widget' && (t.memberList || []).some((m) => m.n === 'Widget' && m.k === 'ctor'));
if (ctorOwner) {
  const ctorLine = ctorOwner.memberList.find((m) => m.n === 'Widget' && m.k === 'ctor').l;
  const ctorPath = nsBundle.files[ctorOwner.file].path;
  const rW = await ns.call('refs', { name: 'Demo.R.Widget', direction: 'in' });
  const siteRows = rW.split('\n').filter((l) => /^\s+\S+:\d+\t(调用|访问|call|access)$/.test(l));
  check(siteRows.length > 0 && !siteRows.some((l) => l.includes(`${ctorPath}:${ctorLine}`)),
    '① 类型回答的位置段排除“同名成员的声明行”（C# 构造函数必然与类同名）',
    `位置 ${siteRows.length} 行，构造函数声明行 ${ctorPath}:${ctorLine}`);
} else {
  check(false, '① 类型回答的位置段排除“同名成员的声明行”', '夹具里没找到构造函数，门没意义');
}
// 复测第三轮 §3-b：不能把“自己那个与类同名的构造函数”算成同名风险
const rUser = await ns.call('refs', { name: 'Demo.R.User' });
check(!/同名的成员|same-named members/.test(rUser),
  '③b 类只有“自己的构造函数”同名时不打同名提示（C# 上否则几乎每个类都会多一句废话）');
const rWidget2 = await ns.call('refs', { name: 'Demo.R.Widget' });
check(/同名的成员|same-named members/.test(rWidget2),
  '③b **别的**类型里有这个成员名时才提示“同名会混进来”');
ns.proc.kill('SIGKILL');

// ③c 复测第三轮：小工程“没有位置”不能被说成“老版本引擎扫的图”
//（判据改成**引擎版本**，不看“图里有没有 uses 字段”—— 新引擎扫的小工程本来就可能一条都没有）
const declTmp = path.join(os.tmpdir(), `codeatlas-declonly-${process.pid}`);
const { out: declOut } = scanProject(declTmp, {
  'decl.js': 'export class OnlyDecl { render() { return 1; } }\n',
});
const ds = spawnMcp(declOut);
await ds.ready;
const rDeclM = await ds.call('refs', { name: 'render' });   // 成员：正文总会出，措辞得是“一处都没找到”
check(/一处都没找到|none found/.test(rDeclM) && !/老版本引擎|older engine/.test(rDeclM),
  '③c 新引擎扫的小工程没有位置 → 说“一处都没找到”，不说“老版本引擎扫的图”',
  (rDeclM.split('\n').find((l) => /调用 \/ 访问位置|Call \/ access/.test(l)) || '').trim().slice(0, 60));
const rDeclT = await ds.call('refs', { name: 'OnlyDecl' });  // 类型：没有位置就干脆不打印，不瞎报一句
check(!/调用 \/ 访问位置|Call \/ access sites/.test(rDeclT),
  '③c 类型没有位置时**不打印**位置段（不瞎报“老版本引擎”）');
ds.proc.kill('SIGKILL');
// 真·老图：把同一份 bundle 的引擎版本改小 → 必须走“没记录”那个分支
const oldTmp2 = path.join(os.tmpdir(), `codeatlas-oldeng-${process.pid}`);
fs.rmSync(oldTmp2, { recursive: true, force: true });
fs.mkdirSync(oldTmp2, { recursive: true });
const oldB = JSON.parse(JSON.stringify(readBundle(declOut)));
oldB.generator.version = '1.4.2';
fs.writeFileSync(path.join(oldTmp2, 'bundle.json'), JSON.stringify(oldB));
const os2 = spawnMcp(oldTmp2);
await os2.ready;
const rOld2 = await os2.call('refs', { name: 'OnlyDecl' });
check(/老版本引擎|older engine/.test(rOld2),
  '③c 引擎 < 1.5.0 的图才说“没有这类记录 … 重新扫一次就会带上”');
os2.proc.kill('SIGKILL');

// ⑨ 2026-09-22（Django 实测暴露）：import 的是**包 / 模块路径**，目标文件在那个包里 → 算有支撑。
// 不认这一档的话，Django 上 79% 的边会落到“仅同名”（实测有支撑 1.8% → 54.1%）。
const mt = (p, ns, fqn) => ({ path: p, ns, fqn });
const djFile = mt('django/db/models/fields/related.py', 'django.db.models.fields');
check(importMatchesTarget('django.db.models', djFile) && importMatchesTarget('django.db', djFile),
  '⑨ 包 / 模块路径前缀算有支撑（Python 的 `from X import Y` 只记得到 X）');
check(!importMatchesTarget('django.other', djFile) && !importMatchesTarget('a', mt('a/b/c.py'))
  && !importMatchesTarget('x/y.js', mt('x/z/q.py')) && !importMatchesTarget('import a b', mt('a/b/c.py')),
  '⑨ 不相干的包 / 太短的串 / 带空格的垃圾串不误判');

// ⑩ 2026-09-22（gin 实测暴露）：Go 的 `import ( … )` 多行块以前整块记成一整条字符串
//（`["(\r\n\t\"crypto/subtle\"…\r\n)"]`）→ 跨包引用全部落“仅同名”，有支撑 0%。
// 现在要逐条拆开，且拆出来的 import 能把“跨文件引用”撑成“有支撑”。
const goTmp = path.join(os.tmpdir(), `codeatlas-goimports-${process.pid}`);
const { out: goOut } = scanProject(goTmp, {
  'util/util.go': 'package util\n\ntype Num struct {\n\tV int\n}\n\nfunc Double(n int) int { return n * 2 }\n',
  'main.go': 'package main\n\nimport (\n\t"fmt"\n\n\t"example.org/app/util"\n)\n\nfunc Run() string {\n\treturn fmt.Sprint(util.Num{V: 21}, util.Double(21))\n}\n',
}, 'go');
const goB = readBundle(goOut);
const goMain = goB.files.find((f) => f.path === 'main.go');
check((goMain?.imports || []).includes('example.org/app/util') && !(goMain?.imports || []).some((i) => /[()"\r\n]/.test(i)),
  '⑩ Go 多行 import ( … ) 逐条拆开（不再是整块一条字符串）',
  JSON.stringify(goMain?.imports || []).slice(0, 70));
const gs = spawnMcp(goOut);
await gs.ready;
const rNum = await gs.call('refs', { name: 'Num', direction: 'in' });
check(/\[(有支撑|backed)\]/.test(rNum) && !/\[(仅同名|same name only)\]/.test(rNum),
  '⑩ 跨包引用（Go）算“有支撑”（import 拆开后模块名能对上目标文件）',
  (rNum.split('\n').find((l) => /Num/.test(l)) || '').trim().slice(0, 70));
gs.proc.kill('SIGKILL');

// ⑪ 2026-09-22（ripgrep 实测暴露）：Rust 的 `use a::{b, c}` 树以前被按逗号切碎
//（`"crate::flags::{Category"`）→ 跨 crate / 跨模块引用全塔“仅同名”（有支撑 0%）。
// 现在：花括号树逐条展开；`crate::x::Y` 这种不写 crate 根的路径按段后缀对到目标文件。
const rsTmp = path.join(os.tmpdir(), `codeatlas-rustuse-${process.pid}`);
const { out: rsOut } = scanProject(rsTmp, {
  'src/util.rs': 'pub struct Num {\n    pub v: i32,\n}\n\npub fn double(n: i32) -> i32 {\n    n * 2\n}\n',
  'src/main.rs': 'mod util;\npub(crate) use crate::util::{self as util_mod, Num};\n\nfn main() {\n    let n = Num { v: 1 };\n    println!("{}", util_mod::double(n.v));\n}\n',
}, 'rust');
const rsB = readBundle(rsOut);
const rsMain = rsB.files.find((f) => f.path === 'src/main.rs');
check((rsMain?.imports || []).includes('crate::util::Num') && (rsMain?.imports || []).includes('crate::util')
  && !(rsMain?.imports || []).some((i) => /[(){}\r\n]/.test(i)),
  '⑪ Rust use 树（含 pub(crate) 前缀 / 别名 / self）展开成完整路径',
  JSON.stringify(rsMain?.imports || []).slice(0, 70));
const rs = spawnMcp(rsOut);
await rs.ready;
const rRs = await rs.call('refs', { name: 'Num', direction: 'in' });
check(/\[(有支撑|backed)\]/.test(rRs) && !/\[(仅同名|same name only)\]/.test(rRs),
  '⑪ `use crate::util::Num` 的跨文件引用算“有支撑”（不写 crate 根也对得上）',
  (rRs.split('\n').find((l) => /Num/.test(l)) || '').trim().slice(0, 70));
rs.proc.kill('SIGKILL');

// ③ 2026-09-22（ant-design 实测暴露）：仓库内**包名自引用** —— 文件 import 写的是包名（`antd`），
// 不是相对路径；不认“包名 → 包目录”这一档，ant-design 上 6,801 条“仅同名”里有 3,364 条是它。
const pkgs = [{ name: '@fixture/app', dir: 'pkg' }];
check(importMatchesTarget('@fixture/app', mt('pkg/src/widget.js', '', ''), { packages: pkgs })
  && importMatchesTarget('@fixture/app/src', mt('pkg/src/widget.js', '', ''), { packages: pkgs }),
  '③ 包名自引用算有支撑（裸包名 / 包名子路径对到包目录）');
check(!importMatchesTarget('@fixture/app/other', mt('pkg/src/widget.js', '', ''), { packages: pkgs })
  && !importMatchesTarget('@fixture/app', mt('other/src/widget.js', '', ''), { packages: pkgs })
  && !importMatchesTarget('@fixture/appx', mt('pkg/src/widget.js', '', ''), { packages: pkgs })
  && !importMatchesTarget('@fixture/app', mt('pkg/src/widget.js', '', ''), undefined),
  '③ 不越界：子路径不在包目录里 / 包目录外 / 相似名 / 没带包清单时都不算');
// 同一套规则也接跨 crate（Cargo.toml 的名字，`-` → `_`）与 Go 的 module 路径
const cratePkgs = [{ name: 'grep_matcher', dir: 'crates/matcher' }];
check(importMatchesTarget('grep_matcher::Matcher', mt('crates/matcher/src/lib.rs', '', ''), { packages: cratePkgs })
  && importMatchesTarget('grep_matcher::matcher::Matcher', mt('crates/matcher/src/matcher/mod.rs', '', ''), { packages: cratePkgs }),
  '③ Rust 跨 crate 引用（crate 名 → crate 目录；`crate::mod::Item` 也认）');
const goPkgs = [{ name: 'example.org/app', dir: 'app' }];
check(importMatchesTarget('example.org/app', mt('app/root.go', '', ''), { packages: goPkgs })
  && importMatchesTarget('example.org/app/util', mt('app/util/util.go', '', ''), { packages: goPkgs })
  && !importMatchesTarget('example.org/app/util', mt('app/other.go', '', ''), { packages: goPkgs }),
  '③ Go 的 module 路径（模块根 / 子包 → 对应目录，子包不越界）');
// 端到端：MCP 的 refs 标签要走同一套口径
const pkgTmp = path.join(os.tmpdir(), `codeatlas-pkgref-${process.pid}`);
const { out: pkgOut } = scanProject(pkgTmp, {
  'pkg/package.json': '{\n  "name": "@fixture/app",\n  "version": "1.0.0"\n}\n',
  'pkg/src/widget.js': 'export class Widget { render() { return 1; } }\n',
  'demo/use.js': 'import { Widget } from "@fixture/app";\nexport function run() { return new Widget().render(); }\n',
});
const pkgB = readBundle(pkgOut);
check((pkgB.source.packages || []).some((p) => p.name === '@fixture/app' && p.dir === 'pkg'),
  '③ 包清单进 bundle（name → 包目录）', JSON.stringify(pkgB.source.packages || []));
const ps = spawnMcp(pkgOut);
await ps.ready;
const rPkgW = await ps.call('refs', { name: 'Widget', direction: 'in' });
check(/\[(有支撑|backed)\]/.test(rPkgW) && !/\[(仅同名|same name only)\]/.test(rPkgW),
  '③ 包名自引用的跨文件引用在 MCP 里算“有支撑”',
  (rPkgW.split('\n').find((l) => /Widget/.test(l)) || '').trim().slice(0, 70));
ps.proc.kill('SIGKILL');

// ⑫ 2026-09-22（顺手补）：跨 crate / 跨模块用**包名**引用（Cargo.toml 的 crate 名、go.mod 的 module 路径）
// —— 与 ③ 同一套“包名 → 目录”规则，各配一个端到端门。
const rsWsTmp = path.join(os.tmpdir(), `codeatlas-rscrate-${process.pid}`);
const { out: rsWsOut } = scanProject(rsWsTmp, {
  'Cargo.toml': '[workspace]\nmembers = ["crates/lib-x", "crates/appbin"]\n',
  'crates/lib-x/Cargo.toml': '[package]\nname = "lib-x"\nversion = "0.1.0"\n',
  'crates/lib-x/src/lib.rs': 'pub struct Widget {\n    pub n: i32,\n}\n',
  'crates/appbin/Cargo.toml': '[package]\nname = "app-bin"\nversion = "0.1.0"\n',
  'crates/appbin/src/main.rs': 'use lib_x::Widget;\n\nfn main() {\n    let w = Widget { n: 1 };\n    println!("{}", w.n);\n}\n',
}, 'rust');
const rsWsB = readBundle(rsWsOut);
check((rsWsB.source.packages || []).some((p) => p.name === 'lib_x' && p.dir === 'crates/lib-x'),
  '⑫ Cargo.toml 的 crate 名进包清单（`-` → `_`）',
  JSON.stringify(rsWsB.source.packages || []));
const rws = spawnMcp(rsWsOut);
await rws.ready;
const rWid = await rws.call('refs', { name: 'Widget', direction: 'in' });
check(/\[(有支撑|backed)\]/.test(rWid) && !/\[(仅同名|same name only)\]/.test(rWid),
  '⑫ 跨 crate 引用（`use lib_x::Widget`）算“有支撑”',
  (rWid.split('\n').find((l) => /Widget/.test(l)) || '').trim().slice(0, 70));
rws.proc.kill('SIGKILL');

// ⑬ Go 的 module 路径（go.mod）：模块根 / 子包都要能对到目录
const goModTmp = path.join(os.tmpdir(), `codeatlas-gomodule-${process.pid}`);
const { out: goModOut } = scanProject(goModTmp, {
  'go.mod': 'module example.org/app\n\ngo 1.21\n',
  'app.go': 'package app\n\ntype Root struct {\n\tN int\n}\n',
  'util/util.go': 'package util\n\ntype Num struct {\n\tV int\n}\n',
  'sub/sub.go': 'package sub\n\nimport (\n\t"example.org/app"\n\t"example.org/app/util"\n)\n\ntype Holder struct {\n\tR app.Root\n\tN util.Num\n}\n',
}, 'go');
const goModB = readBundle(goModOut);
check((goModB.source.packages || []).some((p) => p.name === 'example.org/app' && p.dir === ''),
  '⑬ go.mod 的 module 路径进包清单', JSON.stringify(goModB.source.packages || []));
const gms = spawnMcp(goModOut);
await gms.ready;
const rGoRoot = await gms.call('refs', { name: 'Root', direction: 'in' });
const rGoNum = await gms.call('refs', { name: 'Num', direction: 'in' });
check(/\[(有支撑|backed)\]/.test(rGoRoot) && !/\[(仅同名|same name only)\]/.test(rGoRoot)
  && /\[(有支撑|backed)\]/.test(rGoNum) && !/\[(仅同名|same name only)\]/.test(rGoNum),
  '⑬ 跨包引用走 module 路径（模块根 + 子包）都算“有支撑”',
  (rGoRoot.split('\n').find((l) => /Root/.test(l)) || '').trim().slice(0, 60));
gms.proc.kill('SIGKILL');

// ---------------------------------------------------------------------------
// ⑭ 2026-09-22 第二轮（另 10 个开源项目实测）：提取器里的六个小缺陷，各配一道门。
// ---------------------------------------------------------------------------
// ① Kotlin：import 节点会把紧随的 KDoc 并进来（coroutines 4,421 条里 278 条带尾巴）→ 先切注释
// ② 通配导入：`import kotlinx.coroutines.*` 一个目标也撞不上（Kotlin/Java/Scala/Rust 都吃）
// ③ JS/TS：CommonJS 的 `require('x')`、TS 的 `import x = require('y')` 都进不了 import
// ④ Swift：`@testable import X` 带着属性进来；模块名（Package.swift）没进包清单
// ⑤ Ruby：RSpec 的 `include("path=/foo")` 会被当 mixin 采成坏串；类引用（constant）没进 refs
// ⑥ PHP：类型引用节点是 `name`（不是 identifier）→ 一条 ref 都采不到；命名空间分隔符 `\` 没归一
// ⑦ C#：多个 `#if` 块叠在一起时命名空间被吞进 ERROR（Newtonsoft 上 8 个类型全丢 ns）→ 指令行留空
const ktTmp = path.join(os.tmpdir(), `codeatlas-ktimports-${process.pid}`);
const { out: ktOut } = scanProject(ktTmp, {
  'src/lib.kt': 'package demo\n\nimport kotlinx.coroutines.*\n\n/**\n * 说明。\n */\nclass Widget {\n    fun run(): Job = launch { }\n}\n',
}, 'kotlin');
const ktF = readBundle(ktOut).files.find((f) => f.path === 'src/lib.kt');
check((ktF?.imports || []).includes('kotlinx.coroutines.*') && !(ktF?.imports || []).some((i) => /[\r\n]|\/\*/.test(i)),
  '⑭ Kotlin：import 尾巴上的 KDoc 不再并进路径',
  JSON.stringify(ktF?.imports || []).slice(0, 60));
check(importMatchesTarget('kotlinx.coroutines.*', mt('src/k.kt', 'kotlinx.coroutines.internal', ''))
  && !importMatchesTarget('kotlinx.coroutines.*', mt('src/k.kt', 'kotlinx.other', '')),
  '⑭ 通配导入（`pkg.*`）按包算有支撑、不越界');

const cjsTmp = path.join(os.tmpdir(), `codeatlas-cjs-${process.pid}`);
const { out: cjsOut } = scanProject(cjsTmp, {
  'lib/a.js': 'module.exports = function a() { return 1; };\n',
  'lib/b.js': 'const a = require("./a.js");\nmodule.exports = a;\n',
  'lib/c.js': 'module.exports = { name: "c" };\n',
  'lib/d.ts': 'import c = require("./c.js");\nexport const name = c.name;\n',
}, 'javascript,typescript');
const cjsB = readBundle(cjsOut);
const bFile = cjsB.files.find((f) => f.path === 'lib/b.js');
const dFile = cjsB.files.find((f) => f.path === 'lib/d.ts');
check((bFile?.imports || []).includes('./a.js') && (dFile?.imports || []).includes('./c.js'),
  '⑭ CommonJS 的 require / TS 的 import-equals 都进 import（不再是 "require(…)" 垃圾串）',
  JSON.stringify([bFile?.imports, dFile?.imports]).slice(0, 90));

const swTmp = path.join(os.tmpdir(), `codeatlas-swiftmod-${process.pid}`);
const { out: swOut } = scanProject(swTmp, {
  'Package.swift': '// swift-tools-version:5.7\nlet package = Package(\n    name: "Alamofire",\n    targets: [.target(name: "Alamofire", path: "Source")]\n)\n',
  'Source/Core/Session.swift': 'public class Session {\n    public init() { }\n}\n',
  'Tests/SessionTests.swift': 'import XCTest\n@testable import Alamofire\n\nfinal class SessionTests: XCTestCase {\n    func testIt() {\n        var s: Session? = nil\n        _ = s\n    }\n}\n',
}, 'swift');
const swB = readBundle(swOut);
const swT = swB.files.find((f) => /SessionTests\.swift$/.test(f.path));
check((swT?.imports || []).includes('Alamofire') && !(swT?.imports || []).some((i) => i.includes('@')),
  '⑭ Swift：`@testable import X` 剥掉属性，留下模块名',
  JSON.stringify(swT?.imports || []).slice(0, 60));
check((swB.source.packages || []).some((p) => p.name === 'Alamofire'),
  '⑭ Swift：Package.swift 的模块名进包清单', JSON.stringify(swB.source.packages || []));
const sws = spawnMcp(swOut);
await sws.ready;
const rSw = await sws.call('refs', { name: 'Session', direction: 'in' });
check(/\[(有支撑|backed)\]/.test(rSw) && !/\[(仅同名|same name only)\]/.test(rSw),
  '⑭ Swift：`import Alamofire` 的跨文件引用算“有支撑”',
  (rSw.split('\n').find((l) => /Session/.test(l)) || '').trim().slice(0, 60));
sws.proc.kill('SIGKILL');

const rbTmp = path.join(os.tmpdir(), `codeatlas-rbmix-${process.pid}`);
const { out: rbOut } = scanProject(rbTmp, {
  'lib/base.rb': 'class Base\nend\n',
  'lib/widget.rb': 'require_relative \'base\'\n\nclass Widget < Base\n  include Comparable\n\n  def build\n    Base.new\n  end\nend\n',
  'spec/widget_spec.rb': 'expect(header).to include(\'path=/foo\')\nexpect(x).to include(";")\n',
}, 'ruby');
const rbB = readBundle(rbOut);
const rbSpec = rbB.files.find((f) => /widget_spec\.rb$/.test(f.path));
check((rbSpec?.imports || []).length === 0,
  '⑭ Ruby：RSpec 的 `include("…")` 不再被当 import 采进来', JSON.stringify(rbSpec?.imports || []));
const rbW = rbB.files.find((f) => /widget\.rb$/.test(f.path));
check((rbW?.imports || []).includes('base') && (rbW?.imports || []).includes('Comparable'),
  '⑭ Ruby：`require_relative base` 与 `include Comparable` 都采得到', JSON.stringify(rbW?.imports || []));
check(rbB.edges.some((e) => e.kind === 'ref' && rbB.types[e.from]?.name === 'Widget' && rbB.types[e.to]?.name === 'Base'),
  '⑭ Ruby：类引用（constant，如 `Base`）进引用图');

const phTmp = path.join(os.tmpdir(), `codeatlas-phpns-${process.pid}`);
const { out: phOut } = scanProject(phTmp, {
  'src/Client.php': '<?php\nnamespace App;\n\nclass Client\n{\n    public function send(Helper $h): Reply\n    {\n        return new Reply();\n    }\n}\n',
  'src/Helper.php': '<?php\nnamespace App;\n\nclass Helper\n{\n}\n',
  'src/Reply.php': '<?php\nnamespace App;\n\nclass Reply\n{\n}\n',
}, 'php');
const phB = readBundle(phOut);
const phEdges = phB.edges.filter((e) => e.kind === 'ref').map((e) => `${phB.types[e.from]?.name}->${phB.types[e.to]?.name}`);
check(phEdges.includes('Client->Helper') && phEdges.includes('Client->Reply'),
  '⑭ PHP：类型引用（name 节点）进引用图（以前 0 条）', phEdges.join(' ').slice(0, 70));
check(importMatchesTarget('GuzzleHttp\\Client', mt('src/Client.php', 'GuzzleHttp', 'GuzzleHttp\\Client'))
  && !importMatchesTarget('Acme\\Thing', mt('src/Client.php', 'GuzzleHttp', 'GuzzleHttp\\Client')),
  '⑭ PHP：命名空间分隔符 `\\` 归一后 use 能对上（别的命名空间仍不算）');

const csTmp = path.join(os.tmpdir(), `codeatlas-csprec-${process.pid}`);
const { out: csOut } = scanProject(csTmp, {
  'a/Foo.cs': ['using System;', '#if A', 'using X1;', '#else', 'using X2;', '#endif', '#if B', 'using Y1;', '#else', 'using Y2;', '#endif', '#if C', 'using Z1;', '#endif', '', 'namespace Demo.Tests', '{', '    public class Foo', '    {', '    }', '}', ''].join('\n'),
}, 'csharp');
const fooT = readBundle(csOut).types.find((t) => t.name === 'Foo');
check(!!fooT && fooT.ns === 'Demo.Tests',
  '⑭ C#：叠 #if 块的文件里类型仍带对命名空间（烟测）',
  fooT ? `ns=${JSON.stringify(fooT.ns)}` : '没抽到 Foo');
// 真正的回归门在预处理函数上：指令行要留空、行数不能变
//（⚠ 缩不到自包含的最小复现 —— 触发靠真文件整体形状。真样本效果见提交信息：
//  Newtonsoft.Json 解析异常 226 → 2、空 ns 类型 13 → 3、有支撑 58% → 66%）
const csSrc = 'using System;\n#if A\nusing X1;\n#else\nusing X2;\n#endif\n\nnamespace Demo.Tests\n{\n    public class Foo\n    {\n    }\n}\n';
const csPre = csharpConditionalDirectives(csSrc);
check(!/(^|\n)\s*#\s*(if|else|elif|endif)\b/.test(csPre) && csPre.split('\n').length === csSrc.split('\n').length
  && csPre.includes('using X1;') && csPre.includes('using X2;'),
  '⑭ C#：条件编译指令行留空（行数不变，分支代码不丢）');

// ---------------------------------------------------------------------------
// ⑮ 2026-09-22 第三轮（再 12 个开源项目，专挑没上过真项目的语言）：
// ① Lua 的 require / ② Zig 的 @import / ③ Elisp 的 (require 'x) —— 以前一条 import 都采不到（kong/zls/spacemacs）
// ④ Scala / Elixir 的点号花括号导入（`import a.{b, c}` / `alias Foo.{A, B}`）以前被切成 `{…` 碎片（akka 1,859 条）
// ⑤ Elixir 模块名 CamelCase ↔ 文件名 snake_case（只对 .ex/.exs 目标开大小写不敏感）
// ⑥ TS/JS 路径别名（tsconfig/jsconfig 的 paths，如 `@/*`）以前对不上（vuetify 只有 38%）
const luaTmp = path.join(os.tmpdir(), `codeatlas-luareq-${process.pid}`);
const { out: luaOut } = scanProject(luaTmp, {
  'util.lua': 'local M = {}\nfunction M.trim(s)\n  return s\nend\nreturn M\n',
  'main.lua': 'local utils = require("util")\nlocal json = require "cjson"\nlocal inspect = require"inspect"\nreturn { utils, json, inspect }\n',
}, 'lua');
const luaMain = readBundle(luaOut).files.find((f) => f.path === 'main.lua');
check((luaMain?.imports || []).includes('util') && (luaMain?.imports || []).includes('cjson') && (luaMain?.imports || []).includes('inspect'),
  '⑮ Lua：`require("util")` / `require "cjson"` / `require"inspect"`（无空格）都进 import（kong 实测：以前 0 条）',
  JSON.stringify(luaMain?.imports || []));

const zigTmp = path.join(os.tmpdir(), `codeatlas-zigimp-${process.pid}`);
const { out: zigOut } = scanProject(zigTmp, {
  'src/util.zig': 'pub fn trim(s: []const u8) []const u8 { return s; }\n',
  'src/main.zig': 'const std = @import("std");\nconst util = @import("util.zig");\npub fn run() void { _ = util.trim("x"); }\n',
}, 'zig');
const zigMain = readBundle(zigOut).files.find((f) => f.path === 'src/main.zig');
check((zigMain?.imports || []).includes('util.zig') && (zigMain?.imports || []).includes('std'),
  '⑮ Zig：`@import("…")` 进 import（zls 实测：以前 0 条）', JSON.stringify(zigMain?.imports || []));

const elTmp = path.join(os.tmpdir(), `codeatlas-elreq-${process.pid}`);
const { out: elOut } = scanProject(elTmp, {
  'mod.el': '(provide \'mod)\n(defun mod-helper (x) (+ x 1))\n',
  'main.el': '(require \'mod)\n(defun run () (mod-helper 1))\n',
}, 'elisp');
const elMain = readBundle(elOut).files.find((f) => f.path === 'main.el');
check((elMain?.imports || []).includes('mod'),
  '⑮ Elisp：`(require \'mod)` 进 import（spacemacs 实测：以前 23 条 / 703 文件）',
  JSON.stringify(elMain?.imports || []));

const scalaTmp = path.join(os.tmpdir(), `codeatlas-scalabrace-${process.pid}`);
const { out: scalaOut } = scanProject(scalaTmp, {
  'a/B.scala': 'package a\n\nobject B { val v = 1 }\n',
  'a/C.scala': 'package a\n\nobject C { val v = 2 }\n',
  'main.scala': 'import a.{B, C}\nimport scala.concurrent.duration._\n\nobject Main { val x = B.v + C.v }\n',
}, 'scala');
const scalaMain = readBundle(scalaOut).files.find((f) => f.path === 'main.scala');
check((scalaMain?.imports || []).includes('a.B') && (scalaMain?.imports || []).includes('a.C')
  && !(scalaMain?.imports || []).some((i) => i.includes('{')),
  '⑮ Scala：`import a.{B, C}` 展开成 a.B / a.C（akka 实测：30,341 条里 1,859 条是碎片）',
  JSON.stringify(scalaMain?.imports || []));
check(importMatchesTarget('Controller', mt('lib/phoenix/controller.ex', '', '')),
  '⑮ Elixir：模块名 CamelCase ↔ 文件名 snake_case（只对 .ex/.exs 目标）');
const aliasPkgs = [{ prefix: '@/', dir: 'packages/app/src' }];
check(importMatchesTarget('@/components/VBtn', mt('packages/app/src/components/VBtn/index.ts', '', ''), { aliases: aliasPkgs })
  && !importMatchesTarget('@/components/VBtn', mt('other/src/components/VBtn/index.ts', '', ''), { aliases: aliasPkgs }),
  '⑮ TS 路径别名：`@/x` 按 tsconfig 的 paths 对到目录（vuetify 实测：以前 38%）');
const aliasTmp = path.join(os.tmpdir(), `codeatlas-tsalias-${process.pid}`);
const { out: aliasOut } = scanProject(aliasTmp, {
  'tsconfig.json': '{\n  "compilerOptions": {\n    "baseUrl": "./",\n    "paths": { "@/*": ["src/*"] }\n  }\n}\n',
  'src/util.js': 'export function trim(s) { return s; }\n',
  'src/app.js': 'import { trim } from "@/util";\nexport function run() { return trim("x"); }\n',
});
const aliasB = readBundle(aliasOut);
check((aliasB.source.aliases || []).some((a) => a.prefix === '@/' && a.dir === 'src'),
  '⑮ tsconfig 的 paths 进包清单（baseUrl “./” 也压得对）', JSON.stringify(aliasB.source.aliases || []));
const als = spawnMcp(aliasOut);
await als.ready;
const rAls = await als.call('refs', { name: 'trim', direction: 'in' });
check(/\[(有支撑|backed)\]/.test(rAls) && !/\[(仅同名|same name only)\]/.test(rAls),
  '⑮ `@/util` 的跨文件引用算“有支撑”',
  (rAls.split('\n').find((l) => /trim/.test(l)) || '').trim().slice(0, 60));
als.proc.kill('SIGKILL');

// ---------------------------------------------------------------------------
// ⑯ 2026-09-23：**新增 Dart 支持**（朋友问“没有 dart 吗” → 查了一下 npm 包里其实有现成 wasm）
// 三个实测到的坑：类名不是 name 字段 / 抽象方法与构造函数都包在 declaration 里 / 返回类型在名字前面。
const dartTmp = path.join(os.tmpdir(), `codeatlas-dart-${process.pid}`);
const { out: dartOut } = scanProject(dartTmp, {
  'lib/util.dart': 'class Helper {\n  int twice(int n) => n * 2;\n}\n',
  'lib/main.dart': "import 'util.dart';\n\nclass App {\n  final Helper h = Helper();\n}\n",
}, 'dart');
const dartB = readBundle(dartOut);
const dartMain = dartB.files.find((f) => /main\.dart$/.test(f.path));
check((dartMain?.imports || []).includes('util.dart') && !(dartMain?.imports || []).some((i) => /[\r\n\x22']/.test(i)),
  '⑯ Dart：import util.dart 采得到（且没有引号 / 换行残留）', JSON.stringify(dartMain?.imports || []));
const dartHelper = dartB.types.find((t) => t.name === 'Helper');
check(Boolean(dartHelper) && (dartHelper.memberList || []).some((m) => m.n === 'twice' && m.k === 'method'),
  '⑯ Dart：类名与成员都取得到（类名不是 name 字段这个坑）',
  JSON.stringify((dartHelper?.memberList || []).map((m) => `${m.k}:${m.n}`)));
const dartSvc = spawnMcp(dartOut);
await dartSvc.ready;
const rDh = await dartSvc.call('refs', { name: 'Helper', direction: 'in' });
check(/\[(有支撑|backed)\]/.test(rDh) && !/\[(仅同名|same name only)\]/.test(rDh),
  '⑯ Dart：util.dart 的跨文件引用算“有支撑”',
  (rDh.split('\n').find((l) => /Helper/.test(l)) || '').trim().slice(0, 70));
dartSvc.proc.kill('SIGKILL');
// 再补一道：Dart 的 `package:xxx/…` 入口形式（pubspec.yaml 的包名 + barrel 转出）
const dartPkgTmp = path.join(os.tmpdir(), `codeatlas-dartpkg-${process.pid}`);
const { out: dartPkgOut } = scanProject(dartPkgTmp, {
  'pubspec.yaml': 'name: demo_app\n\ndependencies:\n  flutter:\n    sdk: flutter\n',
  'lib/demo.dart': "export 'src/thing.dart';\n",
  'lib/src/thing.dart': 'class Thing {\n  int id = 1;\n}\n',
  'test/thing_test.dart': "import 'package:demo_app/demo.dart';\n\nclass Uses {\n  final Thing t = Thing();\n}\n",
}, 'dart');
const dartPkgB = readBundle(dartPkgOut);
check((dartPkgB.source.packages || []).some((p) => p.name === 'demo_app'),
  '⑯ Dart：pubspec.yaml 的包名进包清单', JSON.stringify(dartPkgB.source.packages || []));
const dartPkgSvc = spawnMcp(dartPkgOut);
await dartPkgSvc.ready;
const rThing = await dartPkgSvc.call('refs', { name: 'Thing', direction: 'in' });
check(/\[(有支撑|backed)\]/.test(rThing) && !/\[(仅同名|same name only)\]/.test(rThing),
  '⑯ Dart：package:demo_app/… 的 barrel 转出引用算“有支撑”',
  (rThing.split('\n').find((l) => /Thing/.test(l)) || '').trim().slice(0, 70));
dartPkgSvc.proc.kill('SIGKILL');
// 再补一道：跨包**多跳** barrel（mid 转出 base）—— riverpod 样本上这是大头
const dartBarrelTmp = path.join(os.tmpdir(), `codeatlas-dartbarrel-${process.pid}`);
const { out: dartBarrelOut } = scanProject(dartBarrelTmp, {
  'base/pubspec.yaml': 'name: base\n',
  'base/lib/base.dart': "export 'src/thing.dart';\n",
  'base/lib/src/thing.dart': 'class Thing {\n  int id = 1;\n}\n',
  'mid/pubspec.yaml': 'name: mid\n',
  'mid/lib/mid.dart': "export 'package:base/base.dart';\n",
  'app/pubspec.yaml': 'name: app\n',
  'app/test/thing_test.dart': "import 'package:mid/mid.dart';\n\nclass Uses {\n  final Thing t = Thing();\n}\n",
}, 'dart');
const dartBarrelB = readBundle(dartBarrelOut);
check((dartBarrelB.source.packages || []).some((p) => p.name === 'mid' && (p.exports || []).includes('base')),
  '⑯ Dart：包级重导出图（mid 转出 base）',
  JSON.stringify((dartBarrelB.source.packages || []).map((p) => `${p.name}→${(p.exports || []).join(',')}`)));
const dartBarrelSvc = spawnMcp(dartBarrelOut);
await dartBarrelSvc.ready;
const rThing2 = await dartBarrelSvc.call('refs', { name: 'Thing', direction: 'in' });
check(/\[(有支撑|backed)\]/.test(rThing2) && !/\[(仅同名|same name only)\]/.test(rThing2),
  '⑯ Dart：跨包多跳 barrel 的引用算“有支撑”',
  (rThing2.split('\n').find((l) => /Thing/.test(l)) || '').trim().slice(0, 70));
dartBarrelSvc.proc.kill('SIGKILL');
// 再补三遒（2026-09-23，riverpod / bloc 实测挖出）：part 库结构 + mason 模板占位符
const dartPartTmp = path.join(os.tmpdir(), `codeatlas-dartpart-${process.pid}`);
const { out: dartPartOut } = scanProject(dartPartTmp, {
  'pubspec.yaml': 'name: demo_app\n',
  'lib/root.dart': "import 'src/widget.dart';\n\npart 'src/pane.dart';\n\nclass Root { Widget? w; }\n",
  'lib/src/widget.dart': 'class Widget { int id = 1; }\n',
  'lib/src/pane.dart': "part of '../root.dart';\n\nclass Pane { Root? r; Widget? w; }\n",
}, 'dart');
const dartPartB = readBundle(dartPartOut);
const paneF = dartPartB.files.find((f) => /pane\.dart$/.test(f.path));
check(Boolean(paneF) && paneF.lib === 'lib/root.dart' && paneF.partOf === '../root.dart'
  && Array.isArray(paneF.libImports) && paneF.libImports.includes('src/widget.dart'),
  '⑯ Dart：part 文件挂上库（lib / libImports）',
  JSON.stringify({ lib: paneF?.lib, partOf: paneF?.partOf, libImports: paneF?.libImports }));
const dartPartSvc = spawnMcp(dartPartOut);
await dartPartSvc.ready;
const rPaneRoot = await dartPartSvc.call('refs', { name: 'Root', direction: 'in' });
check(/\[(有支撑|backed)\]/.test(rPaneRoot) && !/\[(仅同名|same name only)\]/.test(rPaneRoot),
  '⑯ Dart：同库（part 组）里的引用算“有支撑”',
  (rPaneRoot.split('\n').find((l) => /Root/.test(l)) || '').trim().slice(0, 70));
const rPaneWidget = await dartPartSvc.call('refs', { name: 'Widget', direction: 'in' });
check(/\[(有支撑|backed)\]/.test(rPaneWidget) && !/\[(仅同名|same name only)\]/.test(rPaneWidget),
  '⑯ Dart：库的 import 撑得住 part 文件里的引用（part 不能写 import）',
  (rPaneWidget.split('\n').find((l) => /Widget/.test(l)) || '').trim().slice(0, 70));
dartPartSvc.proc.kill('SIGKILL');
// 废砖块模板（bloc 的 bricks/ 实测 3 条坏 import）：`{{name.snakeCase()}}_page.dart` 这种占位符不采
const dartTmplTmp = path.join(os.tmpdir(), `codeatlas-darttmpl-${process.pid}`);
const { out: dartTmplOut } = scanProject(dartTmplTmp, {
  'lib/gen.dart': "import '{{name.snakeCase()}}_page.dart';\nimport 'dart:math';\n\nclass Gen { num x = pi; }\n",
}, 'dart');
const dartTmplB = readBundle(dartTmplOut);
const genF = dartTmplB.files.find((f) => /gen\.dart$/.test(f.path));
const allImports = dartTmplB.files.flatMap((f) => f.imports || []);
check(Boolean(genF) && JSON.stringify(genF.imports) === JSON.stringify(['dart:math'])
  && !allImports.some((i) => /[{}"']/.test(i)),
  '⑯ Dart：mustache 模板占位符的 import 不采（无坏 import）',
  JSON.stringify(allImports));

// ---------------------------------------------------------------------------
// ⑰ 2026-09-23（第三轮遗留小项）：Bash 的 source 依赖边 + 命令名引用
//（以前 bash 只有“文件级函数”，跨文件一条边都没有）
const shTmp = path.join(os.tmpdir(), `codeatlas-bashsrc-${process.pid}`);
const { out: shOut } = scanProject(shTmp, {
  'lib/helper.sh': 'helper() {\n  echo hi\n}\n',
  // 主脚本写到 4 行：引擎对“没有文件级成员的脚本”有个 >=4 行才合成 module 节点的规矩，
  // 不够 4 行的话 main.sh 就没有节点、文件级引用也就没处挂（这规矩本身是旧行为，不是 bash 的 bug）
  'main.sh': '#!/bin/sh\n\nsource ./lib/helper.sh\nhelper\n',
  'dyn.sh': '#!/bin/sh\nsource "$DIR/helper.sh"\n',
}, 'bash');
const shB = readBundle(shOut);
const shMain = shB.files.find((f) => f.path === 'main.sh');
const shDyn = shB.files.find((f) => f.path === 'dyn.sh');
check((shMain?.imports || []).includes('./lib/helper.sh') && (shDyn?.imports || []).length === 0,
  '⑰ Bash：source 字面量进 import、动态路径（$DIR/…）不猜',
  JSON.stringify([shMain?.imports, shDyn?.imports]));
const shSvc = spawnMcp(shOut);
await shSvc.ready;
const rSh = await shSvc.call('refs', { name: 'helper', direction: 'in' });
check(/\[(有支撑|backed)\]/.test(rSh) && !/\[(仅同名|same name only)\]/.test(rSh),
  '⑰ Bash：source 进来的调用算“有支撑”', (rSh.split('\n').find((l) => /helper/.test(l)) || '').trim().slice(0, 70));
shSvc.proc.kill('SIGKILL');

// ---------------------------------------------------------------------------
// ⑱ 2026-09-23（终检重扫挖出的）：C/C++ 的 `#include "lib/util.h"` 是**按 -I 根目录**解析的——
// 目标文件在 `third_party/lib/include/lib/util.h`，前缀对不上但**后缀**对得上（≥2 段才走这条，单名不认）。
check(importMatchesTarget('lib/util.h', mt('third_party/lib/include/lib/util.h', '', ''))
  && importMatchesTarget('jemalloc/internal/tsd_types.h', mt('deps/jemalloc/include/jemalloc/internal/tsd_types.h', '', ''))
  && !importMatchesTarget('other/thing.h', mt('third_party/lib/include/lib/util.h', '', '')),
  '⑱ C 的 include 根：目标路径以 import 路径结尾（≥2 段）算指到，不相干不算');
const cIncTmp = path.join(os.tmpdir(), `codeatlas-cinc-${process.pid}`);
const { out: cIncOut } = scanProject(cIncTmp, {
  'third_party/lib/include/lib/util.h': 'typedef struct UtilCtx { int n; } UtilCtx;\nint helper(int a);\n',
  'src/main.c': '#include "lib/util.h"\n\nint run(void) { UtilCtx c; c.n = 1; return helper(c.n); }\n',
}, 'c');
const cIncSvc = spawnMcp(cIncOut);
await cIncSvc.ready;
const rUtil = await cIncSvc.call('refs', { name: 'UtilCtx', direction: 'in' });
check(/\[(有支撑|backed)\]/.test(rUtil) && !/\[(仅同名|same name only)\]/.test(rUtil),
  '⑱ C 的 include 根：跨目录 include 进来的类型算“有支撑”', (rUtil.split('\n').find((l) => /UtilCtx/.test(l)) || '').trim().slice(0, 70));
cIncSvc.proc.kill('SIGKILL');

// ⑲ 2026-09-23（终检重扫挖出的）：C/C++ 的 **include 闭包**（≤2 跳）—— A include 的 B 又 include 了 C，
// A 也能撑住 C 里的类型（实测 redis 的 tsdn_t、fmt 的 Char 全在被间接 include 的头文件里）。
const cCloTmp = path.join(os.tmpdir(), `codeatlas-cclo-${process.pid}`);
const { out: cCloOut } = scanProject(cCloTmp, {
  'include/deep/core.h': 'typedef struct DeepCtx { int n; } DeepCtx;\n',
  'include/mid/mid.h': '#include "deep/core.h"\n',
  'src/main.c': '#include "mid/mid.h"\n\nint run(void) { DeepCtx c; c.n = 1; return c.n; }\n',
}, 'c');
const cCloSvc = spawnMcp(cCloOut);
await cCloSvc.ready;
const rDeep = await cCloSvc.call('refs', { name: 'DeepCtx', direction: 'in' });
check(/\[(有支撑|backed)\]/.test(rDeep) && !/\[(仅同名|same name only)\]/.test(rDeep),
  '⑲ C 的 include 闭包（≤2 跳）：间接 include 进来的类型算“有支撑”', (rDeep.split('\n').find((l) => /DeepCtx/.test(l)) || '').trim().slice(0, 70));
cCloSvc.proc.kill('SIGKILL');

// ② 顶层函数（JS 里是“类型”）也要给 file:line —— 只给边不给行号时 AI 还得自己翻文件
const topTmp = path.join(os.tmpdir(), `codeatlas-topfn-${process.pid}`);
const { out: topOut } = scanProject(topTmp, {
  'tpl.js': 'export function inner() { return 1; }\nexport function user() { const a = `${inner()}`; const b = inner(); return a + b; }\n',
});
const tf = spawnMcp(topOut);
await tf.ready;
const rInner = await tf.call('refs', { name: 'inner', direction: 'in' });
check(/tpl\.js:2\t(调用|call)/.test(rInner),
  '② 顶层函数（类型）也给调用位置（以前位置被“只留成员名”的筛选筛掉）',
  (rInner.split('\n').find((l) => /调用 \/ 访问位置|Call \/ access sites/.test(l)) || '').trim().slice(0, 60));
// ④ 两个“被引”不同义：成员回答里要说清哪个是**该类型**的数（实测样本上两个数并排容易被读成矛盾）
const mOwner = bundle.types.find((t) => (t.memberList || []).some((m) => m.n && m.n.length >= 4));
if (mOwner) {
  const mn = mOwner.memberList.find((m) => m.n && m.n.length >= 4).n;
  const r = await call('refs', { name: mn });
  check(/该类型|that type/.test(r),
    '④ 成员回答标明“被引 N 次”是**该类型**的数（不是本成员的位置数）',
    (r.split('\n').find((l) => /被引|referenced/.test(l)) || '').trim().slice(0, 60));
} else {
  check(true, '④ 成员回答的类型级数字标注', '这份 bundle 里没有带名字的成员，跳过');
}
tf.proc.kill('SIGKILL');

// ⑳ 2026-09-23：dsh（DeepSeek Harness）接入 —— `mcp --print-config --client dsh` 吐 Cordis patch YAML。
// 字段名照 dsh 官方示例（serverName / transport / command / args / cwd）；
// 2026-09-23 晚：本机 DSH Desktop 已装，配置已端到端验过（服务进程真的被拉起、工具注册）——
// 这道门继续钉住配置结构，防以后改坏。
{
  const dshOutDir = path.join(os.tmpdir(), `codeatlas-dsh-${process.pid}`);
  const dshYaml = execFileSync(NODE, [path.join(ROOT, 'src', 'cli.mjs'), 'mcp', '--print-config', '--client', 'dsh', '--out', dshOutDir], { encoding: 'utf8' });
  const cliAbs = path.join(ROOT, 'src', 'cli.mjs');
  check(/^- insert:/m.test(dshYaml) && /name: '@deepseek-ai\/dsh-mcp-client'/.test(dshYaml)
    && /serverName: codeatlas/.test(dshYaml) && /transport: stdio/.test(dshYaml)
    && dshYaml.includes(cliAbs) && dshYaml.includes(dshOutDir) && /- --out/.test(dshYaml),
    '⑳ dsh 接入配置：`mcp --print-config --client dsh` 吐 Cordis patch YAML（关键字段齐全）',
    (dshYaml.split('\n').find((l) => /command:/.test(l)) || '').trim().slice(0, 70));
  // 默认（不带 --client）仍然是 mcpServers JSON —— 老客户端不受影响
  const defOut = execFileSync(NODE, [path.join(ROOT, 'src', 'cli.mjs'), 'mcp', '--print-config', '--out', dshOutDir], { encoding: 'utf8' });
  check(defOut.includes('"mcpServers"') && defOut.includes('"code-atlas"'),
    '⑳ 不带 --client 时仍是 mcpServers JSON（Chatbox / Claude Desktop 老路径不变）',
    (defOut.split('\n').find((l) => /mcpServers/.test(l)) || '').trim().slice(0, 60));
}

// ㉑ 2026-09-23（用户点菜）：监控模式下的文件变化指示 ——
// watch 把“第几趟 / 重解析几个 / 改了哪些”写进 bundle.source.watch；MCP 检测到 bundle 更新后
// 在下一个工具结果尾部提示“请重查”（只提示一次）；overview 展示“图在自动跟进”。
{
  const watchTmp = path.join(os.tmpdir(), `codeatlas-watch-${process.pid}`);
  const watchRoot = path.join(watchTmp, 'proj');
  const watchOut = path.join(watchTmp, 'out');
  fs.rmSync(watchTmp, { recursive: true, force: true });
  fs.mkdirSync(watchRoot, { recursive: true });
  fs.writeFileSync(path.join(watchRoot, 'a.js'), 'export function alpha() { return 1; }\n');
  const watchProc = spawn(NODE, [path.join(ROOT, 'src', 'cli.mjs'), 'scan', watchRoot, '--watch', '--out', watchOut, '--no-open', '--port', String(5210 + (process.pid % 200))], { stdio: 'pipe', windowsHide: true });
  watchProc.stdout.on('data', () => {});
  watchProc.stderr.on('data', () => {});
  const readWB = () => { try { return JSON.parse(fs.readFileSync(path.join(watchOut, 'bundle.json'), 'utf8')); } catch { return null; } };
  const waitFor = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const r = fn(); if (r) return r; if (Date.now() - t0 > ms) return null; await new Promise((s) => setTimeout(s, 300)); } };
  const w1 = await waitFor(() => { const b2 = readWB(); return b2?.source?.watch?.pass >= 1 ? b2 : null; });
  check(Boolean(w1) && w1.source.watch.reason === 'initial' && Number.isInteger(w1.source.watch.reparsed),
    '㉑ 监控：首扫把趟信息写进 bundle（pass / reason / reparsed）', JSON.stringify(w1?.source?.watch || null));
  fs.appendFileSync(path.join(watchRoot, 'a.js'), 'export function beta() { return 2; }\n');
  const w2 = await waitFor(() => { const b2 = readWB(); return b2?.source?.watch?.pass > (w1?.source?.watch?.pass || 0) ? b2 : null; });
  check(Boolean(w2) && w2.source.watch.reason === 'change' && w2.source.watch.reparsed >= 1
    && Array.isArray(w2.source.watch.changed) && w2.source.watch.changed.includes('a.js'),
    '㉑ 监控：改动后自动重扫（趟数+1 · 重解析 ≥1 · 改动清单含 a.js）', JSON.stringify(w2?.source?.watch || null));
  watchProc.kill('SIGKILL');
  await new Promise((s) => setTimeout(s, 1000));

  const watchSvc = spawnMcp(watchOut);
  await watchSvc.ready;
  const wOv = await watchSvc.call('overview', {});
  check(/监控模式|Watch mode/.test(wOv),
    '㉑ 监控：overview 显示“这张图在自动跟进”', (wOv.split('\n').find((l) => /监控模式|Watch mode/.test(l)) || '').trim().slice(0, 80));
  execFileSync(NODE, [path.join(ROOT, 'src', 'cli.mjs'), 'scan', watchRoot, '--out', watchOut], { stdio: 'pipe' });
  const wL1 = await watchSvc.call('list', {});
  check(/🔁/.test(wL1) && /重新查询|re-query/.test(wL1),
    '㉑ 图更新后：下一个工具结果带“已更新、请重查”提示', (wL1.split('\n').find((l) => /🔁/.test(l)) || '').trim().slice(0, 90));
  const wL2 = await watchSvc.call('list', {});
  check(!/🔁/.test(wL2), '㉑ 提示只出现一次（再下一个调用不带）');
  watchSvc.proc.kill('SIGKILL');
}

// ㉒ 2026-09-23（dsh 评估报告里能优化的三条）：
// ① map 在没有 facets 的项目上必须显式警告（以前静默退化成热榜）；配了 facets 才出 systems 层；
// ② 热榜每条带 id（行首数字）—— 短名/通用名也能直接 symbol/refs，不再“看得见、查不动”；
// ③ 文档自述的工具数与实现一致（四份文档的工具表行数 == tools/list）。
{
  // ①a 没有 facets → 警告 + draft-facets 指引
  const noFacTmp = path.join(os.tmpdir(), `codeatlas-nofacets-${process.pid}`);
  const { out: noFacOut } = scanProject(noFacTmp, { 'a.js': 'export function alpha() { return 1; }\n' });
  const noFacSvc = spawnMcp(noFacOut);
  await noFacSvc.ready;
  const noFacMap = await noFacSvc.call('map', { budget: 4000 });
  check(/没有系统分组规则|No system grouping/.test(noFacMap) && /draft-facets/.test(noFacMap),
    '㉒ map：无 facets 时显式警告并给 draft-facets 指引（不再静默退化）',
    (noFacMap.split('\n').find((l) => /facets/.test(l)) || '').trim().slice(0, 90));
  noFacSvc.proc.kill('SIGKILL');

  // ①b 有 facets → systems 层出现
  const facTmp = path.join(os.tmpdir(), `codeatlas-facets-${process.pid}`);
  const { out: facOut } = scanProject(facTmp, {
    'atlas.facets.json': '{ "systems": [ { "name": "core", "paths": ["core/**"] }, { "name": "ui", "paths": ["ui/**"] } ] }\n',
    'core/a.js': 'export function alpha() { return 1; }\n',
    'ui/b.js': 'export function beta() { return 2; }\n',
  });
  const facSvc = spawnMcp(facOut);
  await facSvc.ready;
  const facMap = await facSvc.call('map', { budget: 4000 });
  check(/## 系统|## Systems/.test(facMap) && /\[(core|ui)\]/.test(facMap),
    '㉒ map：配了 facets 就出 systems 层', (facMap.split('\n').find((l) => /系统|Systems/.test(l)) || '').trim().slice(0, 70));
  facSvc.proc.kill('SIGKILL');

  // ② 热榜带 id，且 id 能直接查（用主 bundle）
  const ovNow = await call('overview', {});
  const hotIdLine = ovNow.split('\n').find((l) => /^\s+\d+\t/.test(l)) || '';
  const hotId = (hotIdLine.match(/^\s+(\d+)\t/) || [])[1] || '';
  const rById = hotId ? await call('refs', { name: hotId }) : '';
  check(Boolean(hotId) && !/匹配到|matched \d+ symbols?/.test(rById) && rById.length > 20,
    '㉒ overview 热榜每条带 id，且 refs(id) 直接查得通（短名不再“查不动”）',
    hotIdLine.trim().slice(0, 70));

  // ③ 文档工具数与实现一致：四份文档的工具表行名集合 == tools/list 的名字集合
  const liveNames = (await req('tools/list', {})).result.tools.map((t) => t.name);
  const docToolNames = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n')
    .map((l) => (l.match(/^\|\s*`([a-z][a-z-]*)\(?/) || [])[1])
    .filter((n) => n && liveNames.includes(n));
  const perDoc = {};
  let docsOk = true;
  for (const f of ['README.md', 'README_CN.md', 'USAGE.md', '使用说明.md']) {
    const got = docToolNames(f);
    perDoc[f] = got.length;
    if (got.length !== liveNames.length || new Set(got).size !== liveNames.length) docsOk = false;
  }
  check(docsOk, '㉒ 文档工具数与实现一致（四份文档的工具表行 == tools/list 的工具集合）',
    JSON.stringify({ 'tools/list': liveNames.length, ...perDoc }));
}

// ㉓ 2026-09-23（dsh 复验第二轮）：
// ① file() 的类型清单**不许静默截断** —— 自报数量必须 == 行内条目数（复验里那条“22 个”实为与 src/mcp.mjs 的 61 个串了文件，本门把它锁死）；
// ② overview 页脚的工具清单从 TOOLS 动态生成（原来手写 5 个，漏了 impact / map / list）；
// ③ map 页脚分清“内容已全部输出（预算未触顶）”与“撞预算截断”。
{
  const fBig = await call('file', { path: 'src/mcp.mjs' });
  const tline = fBig.split('\n').find((l) => /^(类型|Types) \d+/.test(l)) || '';
  const nSelf = Number((tline.match(/^(?:类型|Types) (\d+)/) || [])[1] || 0);
  const nEntries = (tline.match(/\[[a-z]+\]/g) || []).length;   // 每个条目都带 [kind]
  check(nSelf > 20 && nEntries === nSelf,
    '㉓ file()：类型清单自报数量 == 行内条目数（不静默截断）', `自报 ${nSelf} · 行内 ${nEntries}`);

  const digLine = ((await call('overview', {})).split('\n').find((l) => /深入用|Dig deeper/.test(l)) || '');
  const missing = ['search', 'symbol', 'refs', 'subgraph', 'map', 'impact', 'file', 'list'].filter((x) => !digLine.includes(x));
  check(missing.length === 0, '㉓ overview 页脚的工具清单从 TOOLS 生成（不再手写漏掉 impact / map / list）',
    missing.length ? `缺：${missing.join(', ')}` : digLine.trim().slice(0, 90));

  const mpBig = await call('map', { budget: 80000 });
  check(/内容已全部输出|everything was emitted/.test(mpBig),
    '㉓ map 页脚：预算未触顶时明说“内容已全部输出”', (mpBig.split('\n').find((l) => /token/.test(l)) || '').trim().slice(0, 90));
  const mpSmall = await call('map', { budget: 350 });
  check(/在此截断|cut off here/.test(mpSmall),
    '㉓ map 页脚：撞预算时明说“内容在此截断”', (mpSmall.split('\n').find((l) => /token/.test(l)) || '').trim().slice(0, 90));
}

// ㉔ 2026-09-23（dsh 建议）：AI 技能说明书 —— `.dsh/skills/codeatlas/SKILL.md`。
// 硬约束照 dsh 加载器源码（dsh-skill-filesystem）：首行 --- / 闭合 --- / name 为 kebab-case /
// description 非空字符串 / 旧式调用字段会直接报错；内容上不写死工具前缀（serverName 可配）、不抄工具清单。
// 门用纯 node 复刻关键检查（不依赖 dsh，任何机器可跑；带 dsh 的真验收见提交说明）。
{
  const skillPath = path.join(ROOT, '.dsh', 'skills', 'codeatlas', 'SKILL.md');
  const raw = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, 'utf8') : '';
  check(Boolean(raw), '㉔ 技能说明书存在：.dsh/skills/codeatlas/SKILL.md', skillPath);
  const sLines = raw.split('\n');
  const closeIdx = sLines.findIndex((l, i) => i > 0 && l === '---');
  const fm = sLines[0] === '---' && closeIdx > 0 ? sLines.slice(1, closeIdx).join('\n') : '';
  const sName = (fm.match(/^name: (.+)$/m) || [])[1] || '';
  const sDesc = (fm.match(/^description: (.+)$/m) || [])[1] || '';
  check(sLines[0] === '---' && closeIdx > 0 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sName) && sDesc.length > 20,
    '㉔ 技能 frontmatter：首行 ---、有闭合 ---、name 为 kebab-case、description 非空', `name=${sName} · desc ${sDesc.length} 字`);
  check(!/disableModelInvocation|modelInvocable|userInvocable/.test(fm),
    '㉔ 技能 frontmatter：没有旧式调用字段（写了会被 dsh 直接忽略）', fm.split('\n').map((x) => x.slice(0, 30)).join(' · ').slice(0, 80));
  check(!/mcp__[a-z0-9-]+__/.test(raw),
    '㉔ 技能正文不写死工具全名（只允许 `mcp__<serverName>__…` 这种占位符写法）',
    (raw.match(/mcp__[a-z0-9-]+__/) || ['(无)'])[0]);
  check(/impact/.test(raw) && /exclude/.test(raw) && /facets/.test(raw) && /🔁/.test(raw),
    '㉔ 技能正文保留关键提示（impact 开场 / exclude / facets 警告 / 🔁 重查）');
}

// ㉕ 2026-09-23（AI 实测反馈的三条修复）：
// ① 跳过目录报“体量”（vendor/ 3 个文件数出来；overview 里有“一级目录的实际体量”）；
// ② 样板降级：快照戳 / refs 图例 / impact 完整说明只在（本会话）首次出现，之后压成一行或省略；
// ③ list / file 带上文件头注释的“半句话”（briefDoc 接到了这两处）。
{
  const fbTmp = path.join(os.tmpdir(), `codeatlas-feedback-${process.pid}`);
  const { out: fbOut } = scanProject(fbTmp, {
    'a.js': '/** 演示模块：干这个的 */\nexport function alpha() { return 1; }\n',
    'b.js': "import { alpha } from './a.js';\nexport function beta() { return alpha(); }\n",
    'vendor/v1.js': 'export const x1 = 1;\n',
    'vendor/v2.js': 'export const x2 = 2;\n',
    'vendor/sub/v3.js': 'export const x3 = 3;\n',
  });
  const fbBundle = readBundle(fbOut);
  check(fbBundle.stats?.skipped?.rootDirs?.vendor?.files === 3,
    '㉕ 跳过目录的体量被数出来（vendor/ 3 个文件）', JSON.stringify(fbBundle.stats?.skipped?.rootDirs));
  const fbSvc = spawnMcp(fbOut);
  await fbSvc.ready;
  const fbOv = await fbSvc.call('overview', {});
  check(/一级目录的实际体量|Top-level dirs by real size/.test(fbOv) && /vendor\/ 3 (文件|files)/.test(fbOv),
    '㉕ overview：跳过目录带上体量（vendor/ 3 文件）', (fbOv.split('\n').find((l) => /体量|real size/.test(l)) || '').trim().slice(0, 90));
  const fbL1 = await fbSvc.call('list', {});
  const fbL2 = await fbSvc.call('list', {});
  check(/演示模块：干这个的/.test(fbL1),
    '㉕ list：文件行带上文件头注释的“半句话”', (fbL1.split('\n').find((l) => /a\.js/.test(l)) || '').trim().slice(0, 90));
  check(/(快照|snapshot)/.test(fbL1) && !/(快照|snapshot)/.test(fbL2),
    '㉕ 快照戳只在（本会话）首次非 overview 结果上（第二次没有）', `1st:${/(快照|snapshot)/.test(fbL1)} 2nd:${/(快照|snapshot)/.test(fbL2)}`);
  const fbFileRes = await fbSvc.call('file', { path: 'a.js' });
  check(/说明：演示模块|Doc: 演示模块/.test(fbFileRes),
    '㉕ file：带上文件头注释摘要（“说明：”行）', (fbFileRes.split('\n')[1] || '').trim().slice(0, 70));
  const fbR1 = await fbSvc.call('refs', { name: 'alpha' });
  const fbR2 = await fbSvc.call('refs', { name: 'alpha' });
  check(/边尾的标签|tag after each edge/.test(fbR1) && !/边尾的标签|tag after each edge/.test(fbR2),
    '㉕ refs 图例只出现一次（之后不再重复）', `1st:${/边尾的标签|tag after each edge/.test(fbR1)} 2nd:${/边尾的标签|tag after each edge/.test(fbR2)}`);
  const fbI1 = await fbSvc.call('impact', { name: 'alpha', depth: 1 });
  const fbI2 = await fbSvc.call('impact', { name: 'alpha', depth: 1 });
  check(/要注意的|Worth knowing/.test(fbI1) && !/要注意的|Worth knowing/.test(fbI2) && /口径同本会话首次|same caveats as the first/.test(fbI2),
    '㉕ impact 完整说明只出现一次，之后压成一行口径', `1st:${/要注意的|Worth knowing/.test(fbI1)} 2nd:${/口径同本会话首次|same caveats as the first/.test(fbI2)}`);
  fbSvc.proc.kill('SIGKILL');
}

// ㉖ 2026-09-23（AI 实测反馈第二批）：
// ① 包名/路径别名只收**图内**清单（以前自己走全树、读每个文件，且不遵守跳过规则 —— 图外 176 个包名泄进图内）；
// ② 子进程起不来时说清“引擎跑不起来”，不逐门刷“退出码 null”。
{
  const pkTmp = path.join(os.tmpdir(), `codeatlas-pkgscope-${process.pid}`);
  const { out: pkOut } = scanProject(pkTmp, {
    'package.json': '{ "name": "in-graph-app" }\n',
    'tsconfig.json': '{ "compilerOptions": { "baseUrl": "./src", "paths": { "~/*": ["*"] } } }\n',
    'src/a.js': 'export const a = 1;\n',
    'vendor/package.json': '{ "name": "vendor-pkg" }\n',
    'vendor/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["*"] } } }\n',
  });
  const pkBundle = readBundle(pkOut);
  check(pkBundle.source.packages.some((p) => p.name === 'in-graph-app') && !pkBundle.source.packages.some((p) => p.name === 'vendor-pkg'),
    '㉖ 包名发现遵守跳过规则（被排除目录里的 package.json 不进图）', JSON.stringify(pkBundle.source.packages));
  check((pkBundle.source.aliases || []).some((x) => x.dir === 'src') && !(pkBundle.source.aliases || []).some((x) => x.prefix === '@/' || (x.dir || '').startsWith('vendor')),
    '㉖ 路径别名同理：只收图内 tsconfig（vendor/ 的不算）', JSON.stringify(pkBundle.source.aliases));

  // ② 子进程起不来：一句说清 + bundle 标 spawn（NODE_BIN 指向不存在的文件来模拟）
  const bnTmp = path.join(os.tmpdir(), `codeatlas-spawnfail-${process.pid}`);
  fs.rmSync(bnTmp, { recursive: true, force: true });
  const bnRoot = path.join(bnTmp, 'proj');
  fs.mkdirSync(bnRoot, { recursive: true });
  fs.writeFileSync(path.join(bnRoot, 'a.js'), 'export function alpha() { return 1; }\n');
  let bnOutText = '';
  try {
    bnOutText = String(execFileSync(NODE, [path.join(ROOT, 'src', 'cli.mjs'), 'scan', bnRoot, '--out', path.join(bnTmp, 'out')], {
      stdio: 'pipe', encoding: 'utf8', env: { ...process.env, NODE_BIN: path.join(bnTmp, 'no-such-node.exe') },
    }));
  } catch (e) { bnOutText = String(e.stdout || '') + String(e.stderr || ''); }
  check(/起不了解析子进程|Cannot spawn the parse child/.test(bnOutText) && (bnOutText.match(/没解析成功|failed to parse/g) || []).length === 0 && /引擎跑不起来|Engine cannot run/.test(bnOutText),
    '㉖ 子进程起不来：一句话说清“引擎跑不起来”（不逐门刷“退出码 null”）', (bnOutText.split('\n').find((l) => /引擎跑不起来|Engine cannot run/.test(l)) || '').trim().slice(0, 80));
  const bnBundle = readBundle(path.join(bnTmp, 'out'));
  check((bnBundle.source.failedLanguages || []).every((x) => x.spawn) && !/null/.test(JSON.stringify(bnBundle.source.failedLanguages || [])),
    '㉖ bundle 里失败原因标成“子进程起不来”（不是“退出码 null”）', JSON.stringify((bnBundle.source.failedLanguages || [])[0] || null));
}

console.log(`\n${failed.length ? `✗ ${failed.length} 项未通过：${failed.join(', ')}` : '✓ 全部通过'}（bundle: ${outDir}）`);
child.kill('SIGKILL');
process.exitCode = failed.length ? 1 : 0;
