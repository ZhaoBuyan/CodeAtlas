#!/usr/bin/env node
/**
 * Code Atlas CLI
 *
 *   atlas <路径>                      零配置入口：目录/源码/程序集/jar 都能直接丢进来
 *   atlas scan  <目录...>             只扫描源码目录
 *   atlas ingest <目标>               没有源码的目标（.dll/.exe/.jar）先反编译再扫
 *   atlas serve [--out dist] [--port 5173]
 *
 * 扫描完成后默认起本地服务并打开浏览器（--no-open 可关）。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanToDisk, workerExtract, draftFacets, VERSION } from './scan.mjs';
import { LANGUAGES } from './languages.mjs';
import { ingest } from './ingest.mjs';
import { startMcp, listToolsText } from './mcp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, '..', 'web');
const DEFAULT_PORT = 5173;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      const v = inline !== undefined ? inline : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
      opts[k] = v;
    } else opts._.push(a);
  }
  return opts;
}

const nf = (n) => Number(n || 0).toLocaleString('en-US');
const bytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
const fmtError = (err) => {
  const msg = String(err?.message || err);
  return msg.includes('\n') ? `错误：\n${msg}` : `错误：${msg}`;
};

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
function printScanReport(b, out) {
  console.log(`\nCode Atlas v${VERSION} · 扫描完成（${(b.source.scanMs / 1000).toFixed(2)}s）\n`);
  const langs = Object.entries(b.languages)
    .sort((a, c) => c[1].loc - a[1].loc)
    .map(([id, s]) => `${id} ${nf(s.files)}文件 / ${nf(s.loc)}行`).join('   ');
  console.log(`  语言      ${langs}`);
  const kinds = {};
  for (const t of b.types) kinds[t.kind] = (kinds[t.kind] || 0) + 1;
  console.log(`  类型      ${nf(b.totals.types)} 个   ${Object.entries(kinds).sort((a, c) => c[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
  const ek = b.stats.edgeKinds || {};
  console.log(`  依赖图    ${nf(b.totals.edges)} 条边   ${Object.entries(ek).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
  const nsCount = b.stats.namespaces;
  console.log(`  命名空间  ${nsCount <= 1 ? '1 个（这门语言不用命名空间，看目录 / 系统分组）' : `${nf(nsCount)} 个`}`);
  printSystems(b);
  console.log(`  代码/注释 ${nf(b.totals.code)} / ${nf(b.totals.comment)} 行（空行 ${nf(b.totals.blank)}）`);
  const unsup = b.stats.skipped?.unsupported || {};
  const unsupTotal = Object.values(unsup).reduce((a, c) => a + c, 0);
  if (unsupTotal) {
    const detail = Object.entries(unsup).sort((a, c) => c[1] - a[1]).slice(0, 6).map(([e, n]) => `${e} ${n}`).join(' · ');
    console.log(`  未支持语言  ${nf(unsupTotal)} 个文件被跳过（${detail}）`);
  }
  // “支持但这次没扫”：和“根本不支持”分开报，免得看起来像是工具做不到
  const oos = b.stats.skipped?.outOfScope || {};
  const oosTotal = Object.values(oos).reduce((a, c) => a + c, 0);
  if (oosTotal) {
    const detail = Object.entries(oos).sort((a, c) => c[1] - a[1]).slice(0, 8).map(([id, n]) => `${id} ${n}`).join(' · ');
    console.log(`  语言范围外  ${nf(oosTotal)} 个文件没扫（${detail}）—— 想扫就加语言：启动器里勾选，或 --lang auto,json`);
  }
  console.log(`  版本戳    ${b.source.labels.join(', ')}${b.source.git ? ` @ ${b.source.git.commit}${b.source.git.dirty ? ' (有未提交改动)' : ''}` : ' （非 git 仓库，用文件时间戳）'}`);
  console.log(`  未解析引用 unknown ${nf(b.unresolved.unknown)} / ambiguous ${nf(b.unresolved.ambiguous)}`);
  if (b.totals.parseErrors) console.log(`  解析异常  ${nf(b.totals.parseErrors)} 处 / ${nf(b.totals.parseErrorFiles)} 个文件（语法树没解析干净，这些文件的数据可能不全）`);
  if (b.source.failures.length) console.log(`  解析失败  ${b.source.failures.length} 个文件`);
  console.log(`\n  输出      ${out}  ${bytes(fs.statSync(out).size)}\n`);

  const hubs = [...b.types].sort((a, c) => c.fanIn - a.fanIn).slice(0, 5);
  if (hubs.length) {
    console.log('  扇入最高的类型（被依赖最多）');
    for (const h of hubs) console.log(`    ${String(h.fanIn).padStart(5)}  ${h.fqn}  (${h.kind})`);
  }
  const all = (function flat(node, out = []) { for (const c of node.children) { out.push(c); flat(c, out); } return out; })(b.namespaces);
  if (b.stats.namespaces > 1) {
    const bigNs = all.sort((a, c) => c.allLoc - a.allLoc).slice(0, 5);
    if (bigNs.length) {
      console.log('\n  最大的命名空间（含子包）');
      for (const n of bigNs) console.log(`    ${nf(n.allLoc).padStart(7)} 行  ${n.path}  (${n.allTypes} 类型)`);
    }
  } else {
    // 模块化语言（TS/JS/Python…）没有命名空间，按顶层目录看
    const dirs = {};
    for (const f of b.files) {
      const d = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '(根目录)';
      dirs[d] = (dirs[d] || 0) + f.loc;
    }
    const top = Object.entries(dirs).sort((a, c) => c[1] - a[1]).slice(0, 5);
    if (top.length) {
      console.log('\n  最大的顶层目录');
      for (const [d, loc] of top) console.log(`    ${nf(loc).padStart(7)} 行  ${d}`);
    }
  }
  console.log('');
}

function printSystems(b) {
  const systems = b.facets?.systems || [];
  if (!systems.length || !systems.some((s) => s.name !== '(未分类)')) return;
  if (!b.facets.configFile) {
    console.log('  系统分组  没有规则（可选：在 configs/<目录名>.facets.json 里按目录/命名空间定义自己的系统）');
    return;
  }
  console.log(`  系统分组  ${b.facets.configFile}（${systems.length} 个）`);
  for (const s of systems) {
    console.log(`      ${String(s.loc).padStart(7)} 行  ${String(s.types).padStart(4)} 类型  ${s.name}`);
  }
}

function printIngestReport(res) {
  const b = res.bundle;
  console.log(`\nCode Atlas v${VERSION} · ${res.tool ? '反编译 + 扫描' : '扫描'}\n`);
  console.log(`  目标      ${res.original}`);
  for (const n of res.notes) console.log(`  步骤      ${n}`);
  if (res.sourceDir) console.log(`  产物目录  ${res.sourceDir}`);
  console.log('');
  console.log(`  文件      ${nf(b.totals.files)}   类型 ${nf(b.totals.types)}   依赖边 ${nf(b.totals.edges)}   代码/注释 ${nf(b.totals.code)} / ${nf(b.totals.comment)}`);
  if (b.totals.compilerGenerated) console.log(`  生成物    ${nf(b.totals.compilerGenerated)} 个编译器生成类型（已打标签，界面默认隐藏）`);
  if (b.totals.parseErrors) console.log(`  解析异常  ${nf(b.totals.parseErrors)} 处 / ${nf(b.totals.parseErrorFiles)} 个文件`);
  console.log(`  版本戳    ${res.tool ? '（反编译产物，不是 git 源）' : b.source.labels.join(', ') + (b.source.git ? ` @ ${b.source.git.commit}` : '（非 git 目录）')}`);
  printSystems(b);
  console.log(`\n  输出      ${res.out}  ${bytes(fs.statSync(res.out).size)}`);
  if (res.tool) {
    const gen = b.totals.compilerGenerated || 0;
    console.log('\n  提醒：反编译产物的结构可信，但里面混着编译器生成物（闭包类 / 内部数组 / 状态机）——');
    console.log(`        ${gen ? `已自动识别 ${gen} 个并打上 compiler-generated 标签，界面里默认隐藏（可取消勾选再看）` : '本包没识别到明确的编译器生成物'}。`);
    console.log('        另外反编译产物没有源码注释（“说明”会是空的），行数含语法糖展开、比源码略高。');
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// 本地服务
// ---------------------------------------------------------------------------
function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch { /* 打不开就算了，URL 已经打印出来 */ }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

function startServer({ outDir, port = DEFAULT_PORT, open = true, host = '127.0.0.1' }) {
  const bundlePath = path.join(path.resolve(outDir), 'bundle.json');
  if (!fs.existsSync(bundlePath)) throw new Error(`找不到 ${bundlePath}，先扫描一次`);

  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let file;
    if (url === '/' || url === '/index.html') file = path.join(WEB_DIR, 'index.html');
    else if (url === '/data/bundle.json') file = bundlePath;
    else if (url === '/vendor/d3.js') file = path.join(HERE, '..', 'node_modules', 'd3', 'dist', 'd3.min.js');
    else if (url.startsWith('/web/')) file = path.join(WEB_DIR, url.slice(5));
    else file = path.join(WEB_DIR, url.replace(/^\/+/, ''));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`404 ${url}`);
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });

  let tryPort = port;
  const attempt = () => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && tryPort < port + 10) { tryPort++; attempt(); return; }
      console.error(`起服务失败：${err.message}`);
    });
    // 只绑回环地址（而不是 0.0.0.0）：
    // ① 更安全：地图只给本机看，不会暴露到局域网；
    // ② **不给 Windows 防火墙弹窗的机会**——监听所有网卡时 Windows 必须问一次
    //    “是否允许 Node.js 通信”，而我们的 node.exe 在 %LocalAppData% 里、每换一次引擎包
    //    路径就变（包指纹），于是“每次开跑都要同意一次”。回环监听不需要任何防火墙规则。
    // 想让局域网也能看（手机、另一台电脑）再加 --host 0.0.0.0。
    server.listen(tryPort, host, () => {
      const url = `http://localhost:${tryPort}`;
      if (open) {
        console.log(`\n  ✔ 已启动并打开浏览器：${url}`);
        openBrowser(url);
      } else {
        console.log(`\n  ✔ 已启动：${url}`);
      }
      console.log(`    （bundle: ${bundlePath}）`);
      console.log('    （窗口别关，关掉服务就停了）\n');
    });
  };
  attempt();
  return server;
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------
/** 零配置入口：目录 / 源码 / 程序集 / jar 都能直接丢进来 */
async function cmdAuto(argv) {
  const opts = parseArgs(argv);
  const target = opts._[0];
  const outDir = opts.out || 'dist';
  console.log(`\nCode Atlas v${VERSION}`);
  console.log(`  正在处理：${path.resolve(target)}`);
  const res = await ingest({
    target,
    outDir,
    work: opts.work,
    lang: opts.lang || 'auto',
    dll: opts.dll,
    decompiler: opts.decompiler,
    facets: opts.facets || null,
    maxKb: Number(opts.maxkb || 1024),
    incremental: opts.incremental !== undefined,
  });
  printIngestReport(res);
  // --no-open 的意思是不弹系统浏览器，服务照起（启动器靠这个 URL 把地图嵌进窗口）
  startServer({ outDir, port: Number(opts.port || DEFAULT_PORT), open: opts['no-open'] === undefined, host: opts.host });
}

async function cmdScan(argv) {
  const opts = parseArgs(argv);
  const roots = opts._.length ? opts._ : ['.'];
  const result = await scanToDisk({
    roots,
    outDir: opts.out || 'dist',
    lang: opts.lang || 'auto',
    maxKb: Number(opts.maxkb || 1024),
    excludes: opts.exclude ? String(opts.exclude).split(',').map((s) => s.trim()).filter(Boolean) : [],
    facets: opts.facets || null,
    // 增量：默认关（全量）；加 --incremental 才按文件复用上次的解析结果
    incremental: opts.incremental !== undefined,
  });
  printScanReport(result.bundle, result.out);
  if (opts.open !== undefined) {
    startServer({ outDir: result.outDir, port: Number(opts.port || DEFAULT_PORT), open: true, host: opts.host });
  }
}

async function cmdIngest(argv) {
  const opts = parseArgs(argv);
  const target = opts._[0];
  if (!target) {
    console.error('用法：atlas ingest <目录|.dll|.exe|.jar> [--out dist] [--work ingest/<名>] [--dll "App*.dll"] [--decompiler cfr.jar] [--facets 配置.json]');
    process.exit(1);
  }
  const res = await ingest({
    target,
    outDir: opts.out || 'dist',
    work: opts.work,
    lang: opts.lang || 'auto',
    dll: opts.dll,
    decompiler: opts.decompiler,
    facets: opts.facets || null,
    maxKb: Number(opts.maxkb || 1024),
    incremental: opts.incremental !== undefined,
  });
  printIngestReport(res);
  if (opts.open !== undefined) {
    startServer({ outDir: res.outDir, port: Number(opts.port || DEFAULT_PORT), open: true, host: opts.host });
  }
}

/**
 * langs：把语言表打印出来。
 * 启动器用它填"勾选语言"的列表 —— 语言表只有 languages.mjs 一份，界面不另抄一份（抄了迟早会漂移）。
 * --json 给程序读，不加就是给人看的。
 */
function cmdLangs(argv) {
  const opts = parseArgs(argv);
  const all = Object.values(LANGUAGES);
  const code = all.filter((l) => !l.optIn);
  const fileLevel = all.filter((l) => l.optIn);
  if (opts.json !== undefined) {
    console.log(JSON.stringify(all.map((l) => ({ id: l.id, label: l.label, optIn: !!l.optIn, exts: l.exts })), null, 2));
    return;
  }
  console.log(`\nCode Atlas 支持的语言：${code.length} 门代码语言 + ${fileLevel.length} 种文件级格式\n`);
  console.log('代码语言（默认扫这些）：');
  for (const l of code) console.log(`  ${l.id.padEnd(12)} ${l.label.padEnd(14)} ${l.exts.join(' ')}`);
  console.log('\n文件级格式（默认不扫，显式指定才扫）：');
  for (const l of fileLevel) console.log(`  ${l.id.padEnd(12)} ${l.label.padEnd(14)} ${l.exts.join(' ')}`);
  console.log('\n用法：--lang auto（默认，所有代码语言） · --lang csharp,typescript · --lang auto,json\n');
}

/**
 * 内部命令（不是给用户敲的）：扫描时父进程按语言起子进程，子进程执行的入口。
 * 只干一件事：解析一门语言，把原始数据写进 --emit 文件。
 */
async function cmdExtractWorker(argv) {
  const opts = parseArgs(argv);
  await workerExtract({ work: opts.work, lang: opts.lang, emit: opts.emit });
  // 结果已经落盘（writeFileSync）。接下来必须**硬退**，不能让它走正常退出：
  // 实测（2026-09-17，web-tree-sitter 0.27 + Node 24）——只要是在进程内退出，不管走
  // process.exit(0) 还是 process.reallyExit(0)，退出阶段都会撞：
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
  // （退出码 0xC0000409）；此时 emit 已经写好，父进程看不到差异，但退出码不可信。
  // 只有 OS 级的 SIGKILL 能干净结束：代价是退出码恒为 1，所以**父进程只能靠 emit 在不在判断成败**
  // （scan.mjs 里就是这么写的，别改成只看退出码）。
  // 想要“退出码可信”得把解析搬进 worker_threads 用 terminate() 结束——那是架构改动，先记在 ROADMAP。
  try { process.kill(process.pid, 'SIGKILL'); } catch { /* 不行就正常退 */ }
  process.exit(0);
}

/**
 * draft-facets：按目录结构草拟一份系统分组规则（不解析代码，秒出）。
 *   atlas draft-facets <目录>              人看的预览 + 草案 JSON
 *   atlas draft-facets <目录> --out 文件     写文件（首次运行向导走的就是这条）
 *   atlas draft-facets <目录> --json        只输出 JSON（给程序读）
 *   atlas draft-facets <目录> --by namespace --bundle <输出目录>   用命名空间草拟（要先扫过一遍）
 */
function cmdDraftFacets(argv) {
  const opts = parseArgs(argv);
  const target = opts._[0];
  if (!target) {
    console.error('用法：atlas draft-facets <目录> [--out 文件] [--json] [--lang auto] [--maxkb 1024] [--by namespace --bundle 输出目录]');
    process.exit(1);
  }
  const res = draftFacets({ roots: [target], lang: opts.lang, maxKb: opts.maxkb, by: opts.by, bundle: opts.bundle });
  const json = JSON.stringify(res.config, null, 2) + '\n';
  if (opts.out) {
    const abs = path.resolve(opts.out);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, json);
  }
  if (opts.json !== undefined) { process.stdout.write(JSON.stringify(res, null, 2) + '\n'); return; }   // 给程序读：连预览和提示一起给
  console.log(`\n${res.by === 'namespace' ? '按命名空间' : '按目录结构'}草拟了 ${res.preview.length} 个系统（共 ${res.files} 个文件）：\n`);
  for (const p of res.preview) console.log(`  ${p.name.padEnd(18)} ${String(p.files).padStart(5)} ${p.unit || '个文件'}`);
  for (const n of res.notes) console.log(`  · ${n}`);
  console.log(`\n${json}`);
  console.log(opts.out ? `已写入：${path.resolve(opts.out)}\n` : '（加 --out <文件> 就能写出来）\n');
}

/** mcp：把 bundle 变成 AI 能查的接口（stdio JSON-RPC —— stdout 只能走协议，日志走 stderr） */
function cmdMcp(argv) {
  const opts = parseArgs(argv);
  if (opts['list-tools'] !== undefined) {
    console.log(`\nCode Atlas MCP · ${path.join(path.resolve(opts.out || 'dist'), 'bundle.json')}\n`);
    console.log(listToolsText());
    console.log('\n接入客户端：command=node，args=[<绝对路径>/src/cli.mjs, mcp, --out, <绝对路径>/dist]\n');
    return;
  }
  if (opts['config-json'] !== undefined) {
    // 只吐 JSON（给启动器的"一键复制 MCP 配置"用，不用去正则里抠）
    const cli = path.resolve(fileURLToPath(import.meta.url));
    const out = path.resolve(opts.out || 'dist');
    console.log(JSON.stringify({ mcpServers: { 'code-atlas': { command: 'node', args: [cli, 'mcp', '--out', out] } } }, null, 2));
    return;
  }
  if (opts['print-config'] !== undefined) {
    const cli = path.resolve(fileURLToPath(import.meta.url));
    const out = path.resolve(opts.out || 'dist');
    console.log('\n把下面这段粘进 MCP 客户端（Chatbox / Claude Desktop 等）的 mcpServers 配置里：\n');
    console.log(JSON.stringify({ mcpServers: { 'code-atlas': { command: 'node', args: [cli, 'mcp', '--out', out] } } }, null, 2));
    console.log('\n说明：路径已写成绝对路径（客户端的工作目录不确定，相对路径会找不到）。');
    console.log('     换项目只要改 --out 指向那个项目的输出目录；想同时看多个项目就配多份（名字不同）。\n');
    return;
  }
  startMcp({ bundlePath: path.join(opts.out || 'dist', 'bundle.json') });
}

function cmdServe(argv) {
  const opts = parseArgs(argv);
  startServer({
    outDir: opts.out || 'dist',
    port: Number(opts.port || DEFAULT_PORT),
    open: opts['no-open'] === undefined,
    host: opts.host,
  });
}

// ---------------------------------------------------------------------------
const HELP = `Code Atlas v${VERSION}

最简单：把路径丢进来就行（源码目录、程序集、jar 都认）
  atlas "C:/path/to/project"         扫描并打开浏览器
  atlas "C:/path/to/App.dll"         反编译 + 扫描
  atlas "C:/path/to/game.jar"        反编译 jar + 扫描

细分命令：
  atlas scan   <目录...>            只扫描源码目录（可加 --incremental：只重解析改过的文件）
  atlas ingest <目录|.dll|.exe|.jar> 没有源码的目标先反编译再扫
  atlas serve                       起本地服务（不重新扫描）
                                      默认只绑 127.0.0.1（不弹防火墙、也不暴露到局域网）；
                                      想让局域网/手机看：--host 0.0.0.0
  atlas langs                       看支持哪些语言（加 --json 给程序读）
  atlas draft-facets <目录>          按目录结构草拟一份分组规则（--out 写文件；--by namespace --bundle dist 则按命名空间）

常用选项：
  --out <目录>     输出目录（默认 dist）
  --port <端口>    本地服务端口（默认 5173，占用自动往后找）
  --no-open        不自动打开浏览器
  --lang <语言>    只扫指定语言（csharp / typescript / java / lua / auto）
  --facets <文件>  系统/模块分组规则（默认自动找 <目标>/atlas.facets.json 或 configs/<目录名>.facets.json）
  --exclude a,b    额外跳过的目录名
  --work <目录>    反编译产物放哪（默认 ingest/<名字>）`;

/**
 * 跑完主动退出：个别语法包（实测 Swift）在进程退出阶段的 wasm 析构会崩，
 * 而那时 bundle 和报告早已经写好 —— 先把输出落地再主动退，避免看起来"扫完崩了"。
 */
function flushAndExit(code = 0) {
  const done = () => {
    // 硬退出：个别语法包（实测 Swift/Scala）在 V8 释放 isolate 时会报一大堆 OOM 崩溃栈，
    // 而那时报告和 bundle 都已经写好了 —— 直接终止进程，绕过析构。
    //
    // 但别用 process.kill(pid, 'SIGKILL')：Windows 上它会把退出码变成 1，
    // 于是“扫描成功”看起来像失败（脚本 / CI 会被坑）。
    // process.reallyExit(code)：同样是立即结束、不跑 JS 析构，但退出码是对的。
    try {
      if (typeof process.reallyExit === 'function') { process.reallyExit(code); return; }
    } catch { /* 没有这个内部 API 就退回普通退出 */ }
    process.exit(code);
  };
  if (process.stdout.write('')) setImmediate(done);
  else process.stdout.once('drain', done);
}

const COMMANDS = { scan: cmdScan, serve: cmdServe, ingest: cmdIngest, mcp: cmdMcp, langs: cmdLangs, 'draft-facets': cmdDraftFacets, __extract: cmdExtractWorker };
const [first, ...rest] = process.argv.slice(2);

let run;
if (!first || first === 'help' || first === '--help' || first === '-h') {
  console.log(HELP);
  process.exit(0);
} else if (COMMANDS[first]) {
  run = () => COMMANDS[first](rest);
} else if (first.startsWith('--')) {
  console.error(`未知选项：${first}\n\n${HELP}`);
  process.exit(1);
} else {
  // 第一个参数是路径 -> 零配置入口
  run = () => cmdAuto([first, ...rest]);
}

// 注意：serve 是同步函数，auto/scan/ingest 是异步的 —— 统一用 Promise.resolve 包一层再接 catch
await Promise.resolve(run())
  .then(() => {
    // scan / ingest 跑完即退（serve / mcp / auto 要保持存活，不能退）
    if (first === 'scan' || first === 'ingest') flushAndExit(0);
  })
  .catch((err) => {
    console.error(`\n${fmtError(err)}\n`);
    process.exit(1);
  });
