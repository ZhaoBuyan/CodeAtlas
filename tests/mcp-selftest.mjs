/**
 * MCP 自检：用和真实客户端一样的 stdio JSON-RPC 协议驱动 src/mcp.mjs，把每个工具都跑一遍。
 *   node tests/mcp-selftest.mjs [dist 目录，默认 dist]
 *
 * 注意：测试输入是从**这个 bundle 自己**里挑的（最热门的类型、最大的文件），
 * 所以换任何项目跑都成立 —— 不再硬编码某个项目的类名。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

const map600 = await call('map', { budget: 600 });
check(map600.length > 80 && map600.length / 4 < 600 * 1.4, 'map（token 预算）', `约 ${Math.ceil(map600.length / 4)} token / 预算 600`);

const impact = await call('impact', { name: String(hottest.id), depth: 2 });
check(/影响面|Impact/.test(impact) && /第 1 层|没有已知的引用者|Level 1|no known referrers/.test(impact), 'impact（影响面）', impact.split('\n')[0].slice(0, 70));
const impactMiss = await call('impact', { name: 'zzz-this-does-not-exist' });
check(/找不到|No symbol|not found/i.test(impactMiss), 'impact（找不到时给提示）', impactMiss.split('\n')[0].slice(0, 50));

console.log(`\n${failed.length ? `✗ ${failed.length} 项未通过：${failed.join(', ')}` : '✓ 全部通过'}（bundle: ${outDir}）`);
child.kill('SIGKILL');
process.exitCode = failed.length ? 1 : 0;
