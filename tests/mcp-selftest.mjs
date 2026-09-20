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
import { freshnessNote } from '../src/mcp.mjs';

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

// 引用证据强度：refs 每条边挂一个标签（同文件 / import 有支撑 / 仅同名），
// overview 热点榜按“有证据的引用数”排 —— 免得好多“同名但无关”的边把没人真用的类型顶到第一
const refsAll = await call('refs', { name: String(hottest.id), direction: 'in', limit: 200 });
const tagCount = (refsAll.match(/\[(同文件|import|仅同名|same file|same name only)\]/g) || []).length;
const edgeCount = (refsAll.match(/×/g) || []).length;
check(edgeCount > 0 && tagCount === edgeCount, 'refs 每条边都标了引用证据强度', `${tagCount}/${edgeCount} 条带标签`);
const hasNameOnly = /\[(仅同名|same name only)\]/.test(refsAll);
check(!hasNameOnly || /别当真|do not trust it/.test(refsAll), 'refs 出现“仅同名”时会说明它不能当真', hasNameOnly ? '有仅同名边，已带说明' : '这个 bundle 里没有仅同名边');

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

// 每个工具结果末尾都挂快照时间（单点调用也能看出数据新不新）
const symTail = sym.split('\n').slice(-1)[0];
check(/(快照|snapshot).*UTC/.test(symTail), '非 overview 工具也带快照时间', symTail.slice(0, 60));

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

/** 现造一个临时项目并扫一次（同样限制在一门语言里：同一个进程装多门语法包会崩） */
function scanProject(tmpDir, files) {
  const root = path.join(tmpDir, 'proj');
  const out = path.join(tmpDir, 'out');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  execFileSync(NODE, [path.join(ROOT, 'src', 'cli.mjs'), 'scan', root, '--lang', 'javascript', '--out', out], { stdio: 'pipe' });
  return { root, out };
}

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

console.log(`\n${failed.length ? `✗ ${failed.length} 项未通过：${failed.join(', ')}` : '✓ 全部通过'}（bundle: ${outDir}）`);
child.kill('SIGKILL');
process.exitCode = failed.length ? 1 : 0;
