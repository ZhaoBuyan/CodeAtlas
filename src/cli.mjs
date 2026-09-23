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
import { t, sysLabel, isUnclassified, LANG } from './i18n.mjs';
import { scanToDisk, watchScan, workerExtract, draftFacets, VERSION } from './scan.mjs';
import { LANGUAGES } from './languages.mjs';
import { ingest } from './ingest.mjs';
import { startMcp, listToolsText } from './mcp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, '..', 'web');
const DEFAULT_PORT = 5173;

/** 把 URL 路径拼到目录里，并确认结果没跑出这个目录（挡 ../ 穿越）；越界返回 null */
function insideDir(dir, rel) {
  const base = path.resolve(dir);
  const p = path.resolve(base, rel);
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

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
  return msg.includes('\n') ? t(`错误：\n${msg}`, `Error:\n${msg}`) : t(`错误：${msg}`, `Error: ${msg}`);
};

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
function printScanReport(b, out) {
  console.log(t(`\nCode Atlas v${VERSION} · 扫描完成（${(b.source.scanMs / 1000).toFixed(2)}s）\n`, `\nCode Atlas v${VERSION} · scan finished (${(b.source.scanMs / 1000).toFixed(2)}s)\n`));
  const langs = Object.entries(b.languages)
    .sort((a, c) => c[1].loc - a[1].loc)
    .map(([id, s]) => t(`${id} ${nf(s.files)}文件 / ${nf(s.loc)}行`, `${id} ${nf(s.files)} files / ${nf(s.loc)} lines`)).join('   ');
  console.log(`${t('  语言      ', '  Languages   ')}${langs}`);
  const kinds = {};
  for (const ty of b.types) kinds[ty.kind] = (kinds[ty.kind] || 0) + 1;
  const kindsText = Object.entries(kinds).sort((a, c) => c[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / ');
  console.log(t(`  类型      ${nf(b.totals.types)} 个   ${kindsText}`, `  Types       ${nf(b.totals.types)}   ${kindsText}`));
  const ek = b.stats.edgeKinds || {};
  const ekText = Object.entries(ek).map(([k, v]) => `${k} ${v}`).join(' / ');
  console.log(t(`  依赖图    ${nf(b.totals.edges)} 条边   ${ekText}`, `  Graph       ${nf(b.totals.edges)} edges   ${ekText}`));
  const nsCount = b.stats.namespaces;
  console.log(t(
    `  命名空间  ${nsCount <= 1 ? '1 个（这门语言不用命名空间，看目录 / 系统分组）' : `${nf(nsCount)} 个`}`,
    `  Namespaces  ${nsCount <= 1 ? '1 (this language has no namespaces — use directories / system groups)' : `${nf(nsCount)}`}`,
  ));
  printSystems(b);
  console.log(t(`  代码/注释 ${nf(b.totals.code)} / ${nf(b.totals.comment)} 行（空行 ${nf(b.totals.blank)}）`, `  Code/comm.  ${nf(b.totals.code)} / ${nf(b.totals.comment)} lines (blank ${nf(b.totals.blank)})`));
  const unsup = b.stats.skipped?.unsupported || {};
  const unsupTotal = Object.values(unsup).reduce((a, c) => a + c, 0);
  if (unsupTotal) {
    const detail = Object.entries(unsup).sort((a, c) => c[1] - a[1]).slice(0, 6).map(([e, n]) => `${e} ${n}`).join(' · ');
    console.log(t(`  未支持语言  ${nf(unsupTotal)} 个文件被跳过（${detail}）`, `  Unsupported ${nf(unsupTotal)} files skipped (${detail})`));
  }
  // “支持但这次没扫”：和“根本不支持”分开报，免得看起来像是工具做不到
  const oos = b.stats.skipped?.outOfScope || {};
  const oosTotal = Object.values(oos).reduce((a, c) => a + c, 0);
  if (oosTotal) {
    const detail = Object.entries(oos).sort((a, c) => c[1] - a[1]).slice(0, 8).map(([id, n]) => `${id} ${n}`).join(' · ');
    console.log(t(
      `  语言范围外  ${nf(oosTotal)} 个文件没扫（${detail}）—— 想扫就加语言：启动器里勾选，或 --lang auto,json`,
      `  Out of scope ${nf(oosTotal)} files not scanned (${detail}) — add languages to include them: tick them in the launcher, or --lang auto,json`,
    ));
  }
  // 被默认跳过表命中的目录：列出来，免得“图里少了东西”只能靠猜（monorepo 的 packages/ 就是这么发现的）
  const ignDirs = Object.entries(b.stats.skipped?.ignoredDirs || {}).sort((a, c) => c[1] - a[1]);
  if (ignDirs.length) {
    // 注意：截断后缀要**按语言**拼 —— 写在中性字符串里会让英文输出漏出"…共 N 种"（实测过）
    const detail = ignDirs.slice(0, 8).map(([n, c]) => `${n} ${c}`).join(' · ')
      + (ignDirs.length > 8 ? t(` …共 ${ignDirs.length} 种`, ` … ${ignDirs.length} in total`) : '');
    console.log(t(
      `  跳过目录  ${detail}（默认表 + 项目规则；里面的源码不会进这张图）`,
      `  Skipped dirs ${detail} (default list + project rules; source inside them is not in this map)`,
    ));
    // 一级被跳过目录的“体量”（数出来的文件数；.git 不数）—— AI 实测反馈：只列名字会让人把图里文件数当仓库规模
    const rDirs = Object.entries(b.stats.skipped?.rootDirs || {}).sort((a, c) => (c[1]?.files || 0) - (a[1]?.files || 0));
    if (rDirs.length) {
      const rDetail = rDirs.slice(0, 6).map(([n, v]) => `${n} ${v.capped ? '≥' : ''}${nf(v.files)}`).join(' · ')
        + (rDirs.length > 6 ? t(` …共 ${rDirs.length} 个一级目录`, ` … ${rDirs.length} top-level dirs`) : '');
      console.log(t(
        `  一级目录体量  ${rDetail}（文件数；未进图；.git 未数）`,
        `  Top-level dir sizes  ${rDetail} (file counts; not in the map; .git skipped)`,
      ));
    }
  }
  // 项目自己的规则（atlas.ignore / .gitignore）也点名：写了规则却没生效，一眼能看出来
  const ignSrc = b.stats.skipped?.ignoreSources || [];
  if (ignSrc.length) {
    const pDirs = Object.entries(b.stats.skipped?.projectDirs || {}).sort((a, c) => c[1] - a[1]);
    const pDetail = pDirs.slice(0, 6).map(([n, c]) => `${n} ${c}`).join(' · ');
    // 读了几份：子目录自带的 .gitignore 也算了（只有名字时看不出读了 3 份还是 1 份）
    const ignFiles = b.stats.skipped?.ignoreFiles || 0;
    const srcText = ignSrc.join(' + ') + (ignFiles > ignSrc.length ? `${t('（共 ', ' (')}${ignFiles}${t(' 份）', ' files)')}` : '');
    const srcTextEn = ignSrc.join(' + ') + (ignFiles > ignSrc.length ? ` (${ignFiles} files)` : '');
    console.log(t(
      `  项目规则  ${srcText} · ${b.stats.skipped.ignorePatterns} 条${pDetail ? ` · 目录 ${pDetail}` : ''}${b.stats.skipped.projectFiles ? ` · 文件 ${b.stats.skipped.projectFiles} 个` : ''}${b.stats.skipped.ignoreNegations ? `（有 ${b.stats.skipped.ignoreNegations} 条 ! 例外暂不支持）` : ''}`,
      `  Project   ${srcTextEn} · ${b.stats.skipped.ignorePatterns} pattern(s)${pDetail ? ` · dirs ${pDetail}` : ''}${b.stats.skipped.projectFiles ? ` · ${b.stats.skipped.projectFiles} file(s)` : ''}${b.stats.skipped.ignoreNegations ? ` (${b.stats.skipped.ignoreNegations} "!" negation(s) not supported yet)` : ''}`,
    ));
  }
  console.log(`${t('  版本戳    ', '  Revision    ')}${b.source.labels.join(', ')}${b.source.git ? ` @ ${b.source.git.commit}${b.source.git.dirty ? t(' (有未提交改动)', ' (uncommitted changes)') : ''}` : t(' （非 git 仓库，用文件时间戳）', ' (not a git repo — using file timestamps)')}`);
  console.log(`${t('  未解析引用 ', '  Unresolved  ')}unknown ${nf(b.unresolved.unknown)} / ambiguous ${nf(b.unresolved.ambiguous)}`);
  if (b.totals.parseErrors) console.log(t(`  解析异常  ${nf(b.totals.parseErrors)} 处 / ${nf(b.totals.parseErrorFiles)} 个文件（语法树没解析干净，这些文件的数据可能不全）`, `  Parse errors ${nf(b.totals.parseErrors)} spots / ${nf(b.totals.parseErrorFiles)} files (parse tree had errors; data in those files may be incomplete)`));
  if (b.totals.nonUtf8Files) console.log(t(`  编码存疑  ${nf(b.totals.nonUtf8Files)} 个文件可能不是 UTF-8（注释 / 字符串会显示成乱码；存成 UTF-8 再扫一次就好了）`, `  Encoding?  ${nf(b.totals.nonUtf8Files)} files are probably not UTF-8 (comments / strings will look like mojibake; save them as UTF-8 and re-scan)`));
  if (b.source.failures.length) console.log(t(`  解析失败  ${b.source.failures.length} 个文件`, `  Parse failed ${b.source.failures.length} files`));
  if (b.source.failedLanguages && b.source.failedLanguages.length) {
    const fl = b.source.failedLanguages.map((x) => x.lang).join(t('、', ', '));
    // 全部是“子进程起不来”：一句话说清是**引擎跑不起来**，不是代码解析不了（AI 实测反馈：以前只有退出码 1 和一堆空行）
    if (b.source.failedLanguages.every((x) => x.spawn)) {
      console.log(t(`  ⚠ 引擎跑不起来  ${b.source.failedLanguages.length} 门语言全部没解析（${String(b.source.failedLanguages[0].reason).slice(0, 80)}）—— **不是你的代码问题**；检查 Node / 权限 / 沙箱环境后重试`,
        `  ⚠ Engine cannot run  all ${b.source.failedLanguages.length} languages failed (${String(b.source.failedLanguages[0].reason).slice(0, 80)}) — **not your code's fault**; check Node / permissions / sandbox and retry`));
    } else {
      console.log(t(`  ⚠ 语言未解析  ${fl}（这一门这次没进地图：${b.source.failedLanguages[0].reason.slice(0, 60)}）`, `  ⚠ Language failed: ${fl} (this language did not make it into the map: ${b.source.failedLanguages[0].reason.slice(0, 60)})`));
    }
  }
  console.log(`\n${t('  输出      ', '  Output      ')}${out}  ${bytes(fs.statSync(out).size)}\n`);

  const hubs = [...b.types].sort((a, c) => c.fanIn - a.fanIn).slice(0, 5);
  if (hubs.length) {
    console.log(t('  扇入最高的类型（被依赖最多）', '  Most depended-on types'));
    for (const h of hubs) console.log(`    ${String(h.fanIn).padStart(5)}  ${h.fqn}  (${h.kind})`);
  }
  const all = (function flat(node, out = []) { for (const c of node.children) { out.push(c); flat(c, out); } return out; })(b.namespaces);
  if (b.stats.namespaces > 1) {
    const bigNs = all.sort((a, c) => c.allLoc - a.allLoc).slice(0, 5);
    if (bigNs.length) {
      console.log(t('\n  最大的命名空间（含子包；行数 = 类型区间合计）', '\n  Largest namespaces (incl. subpackages; lines = type ranges)'));
      for (const n of bigNs) console.log(t(`    ${nf(n.allLoc).padStart(7)} 行  ${n.path}  (${n.allTypes} 类型)`, `    ${nf(n.allLoc).padStart(7)} lines  ${n.path}  (${n.allTypes} types)`));
    }
  } else {
    // 模块化语言（TS/JS/Python…）没有命名空间，按顶层目录看
    const dirs = {};
    for (const f of b.files) {
      const d = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : t('(根目录)', '(root)');
      dirs[d] = (dirs[d] || 0) + f.loc;
    }
    const top = Object.entries(dirs).sort((a, c) => c[1] - a[1]).slice(0, 5);
    if (top.length) {
      console.log(t('\n  最大的顶层目录（行数 = 整文件）', '\n  Largest top-level directories (whole files)'));
      for (const [d, loc] of top) console.log(t(`    ${nf(loc).padStart(7)} 行  ${d}`, `    ${nf(loc).padStart(7)} lines  ${d}`));
    }
  }
  console.log('');
}

function printSystems(b) {
  const systems = b.facets?.systems || [];
  // 注意：这里比较的是**数据值**（bundle 里系统名是扫描时就定下的中性值，或老 bundle 里的中文），
  // 不能用翻译后的字符串去比 —— 比较只认 isUnclassified（中英两种写法都认）。
  // 否则英文模式下永远判不出“只有未分类”→ 报告里会多打一段没意义的系统分组。
  if (!systems.length || !systems.some((s) => !isUnclassified(s.name))) return;
  if (!b.facets.configFile) {
    console.log(t('  系统分组  没有规则（可选：在 configs/<目录名>.facets.json 里按目录/命名空间定义自己的系统）', '  Systems     no rules (optional: define your own in configs/<dir>.facets.json by directory / namespace)'));
    return;
  }
  console.log(t(`  系统分组  ${b.facets.configFile}（${systems.length} 个；行数 = 各类型区间合计）`, `  Systems     ${b.facets.configFile} (${systems.length}; lines = sum of type ranges)`));
  for (const s of systems) {
    console.log(t(`      ${String(s.loc).padStart(7)} 行  ${String(s.types).padStart(4)} 类型  ${sysLabel(s.name)}`, `      ${String(s.loc).padStart(7)} lines  ${String(s.types).padStart(4)} types  ${sysLabel(s.name)}`));
  }
}

function printIngestReport(res) {
  const b = res.bundle;
  console.log(t(`\nCode Atlas v${VERSION} · ${res.tool ? '反编译 + 扫描' : '扫描'}\n`, `\nCode Atlas v${VERSION} · ${res.tool ? 'decompile + scan' : 'scan'}\n`));
  console.log(`${t('  目标      ', '  Target      ')}${res.original}`);
  for (const n of res.notes) console.log(`${t('  步骤      ', '  Step        ')}${n}`);
  if (res.sourceDir) console.log(`${t('  产物目录  ', '  Artifacts   ')}${res.sourceDir}`);
  console.log('');
  console.log(t(`  文件      ${nf(b.totals.files)}   类型 ${nf(b.totals.types)}   依赖边 ${nf(b.totals.edges)}   代码/注释 ${nf(b.totals.code)} / ${nf(b.totals.comment)}`, `  Files       ${nf(b.totals.files)}   types ${nf(b.totals.types)}   edges ${nf(b.totals.edges)}   code/comment ${nf(b.totals.code)} / ${nf(b.totals.comment)}`));
  if (b.totals.compilerGenerated) console.log(t(`  生成物    ${nf(b.totals.compilerGenerated)} 个编译器生成类型（已打标签，界面默认隐藏）`, `  Generated   ${nf(b.totals.compilerGenerated)} compiler-generated types (tagged; hidden in the UI by default)`));
  if (b.totals.parseErrors) console.log(t(`  解析异常  ${nf(b.totals.parseErrors)} 处 / ${nf(b.totals.parseErrorFiles)} 个文件`, `  Parse errors ${nf(b.totals.parseErrors)} spots / ${nf(b.totals.parseErrorFiles)} files`));
  console.log(`${t('  版本戳    ', '  Revision    ')}${res.tool ? t('（反编译产物，不是 git 源）', '(decompiled artifacts — not a git source tree)') : b.source.labels.join(', ') + (b.source.git ? ` @ ${b.source.git.commit}` : t('（非 git 目录）', ' (not a git directory)'))}`);
  printSystems(b);
  console.log(`\n${t('  输出      ', '  Output      ')}${res.out}  ${bytes(fs.statSync(res.out).size)}`);
  if (res.tool) {
    const gen = b.totals.compilerGenerated || 0;
    console.log(t('\n  提醒：反编译产物的结构可信，但里面混着编译器生成物（闭包类 / 内部数组 / 状态机）——', '\n  Note: the structure of decompiled output is trustworthy, but it contains compiler-generated types (closures / internal arrays / state machines) —'));
    console.log(t(`        ${gen ? `已自动识别 ${gen} 个并打上 compiler-generated 标签，界面里默认隐藏（可取消勾选再看）` : '本包没识别到明确的编译器生成物'}。`, `        ${gen ? `${gen} were detected and tagged compiler-generated; hidden in the UI by default (untick to see them)` : 'none were clearly detected in this assembly'}.`));
    console.log(t('        另外反编译产物没有源码注释（“说明”会是空的），行数含语法糖展开、比源码略高。', '        Also, decompiled output has no source comments (so descriptions will be empty), and line counts include syntactic sugar — slightly higher than the original source.'));
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
  if (!fs.existsSync(bundlePath)) throw new Error(t(`找不到 ${bundlePath}，先扫描一次`, `cannot find ${bundlePath} — run a scan first`));

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      // 非法百分号编码（如 /%zz）：浏览器不会发，但扫描器 / 插件 / 手敲会。
      // 不接住的话 URIError 会停掉整个进程（实测），地图就“突然打不开”了 —— 回 400 就好。
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('400 bad request');
      return;
    }
    let file;
    if (url === '/' || url === '/index.html') {
      // 把语言注入页面：前端靠 window.CODEATLAS_LANG 决定显示哪一套文案
      //（同一份 bundle，切语言只改显示、不用重扫）
      const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8')
        .replace('</head>', `<script>window.CODEATLAS_LANG = ${JSON.stringify(LANG)};</script>\n</head>`);
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    else if (url === '/data/bundle.json') file = bundlePath;
    else if (url === '/data/bundle.meta') {
      // 监控模式靠它判断“bundle 变了没”：每次只回几十字节，比每 2.5 秒拉 3 MB 的 bundle 便宜得多
      let st;
      try { st = fs.statSync(bundlePath); } catch { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404'); return; }
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end(`${Math.round(st.mtimeMs)}-${st.size}`);
      return;
    }
    else if (url === '/web/meta') {
      // 网页文件指纹：页面每 2.5 秒拿它对一次，改了（app.js / index.html / style.css）就自己重载
      const stamp = ['app.js', 'index.html', 'style.css'].map((f) => {
        try { const s = fs.statSync(path.join(WEB_DIR, f)); return `${f}:${Math.round(s.mtimeMs)}-${s.size}`; } catch { return `${f}:x`; }
      }).join('|');
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end(stamp);
      return;
    }
    else if (url === '/vendor/d3.js') file = path.join(HERE, '..', 'node_modules', 'd3', 'dist', 'd3.min.js');
    else if (url.startsWith('/web/')) file = insideDir(WEB_DIR, url.slice(5));
    else file = insideDir(WEB_DIR, url.replace(/^\/+/, ''));
    // file 可能是 null（想往外爬，比如 /../package.json）→ 当成“不存在”处理
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
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
      console.error(t(`起服务失败：${err.message}`, `could not start the server: ${err.message}`));
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
        console.log(t(`\n  ✔ 已启动并打开浏览器：${url}`, `\n  ✔ Started — opening your browser: ${url}`));
        openBrowser(url);
      } else {
        console.log(t(`\n  ✔ 已启动：${url}`, `\n  ✔ Started: ${url}`));
      }
      console.log(t(`    （bundle: ${bundlePath}）`, `    (bundle: ${bundlePath})`));
      console.log(t('    （窗口别关，关掉服务就停了）\n', '    (keep this window open — closing it stops the server)\n'));
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
  console.log(t(`  正在处理：${path.resolve(target)}`, `  Working on: ${path.resolve(target)}`));
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
  const scanOpts = {
    roots,
    outDir: opts.out || 'dist',
    lang: opts.lang || 'auto',
    maxKb: Number(opts.maxkb || 1024),
    excludes: opts.exclude ? String(opts.exclude).split(',').map((s) => s.trim()).filter(Boolean) : [],
    facets: opts.facets || null,
    // 增量：默认关（全量）；加 --incremental 才按文件复用上次的解析结果
    incremental: opts.incremental !== undefined,
    // 遵守项目自己的 .gitignore：默认关，--gitignore 才读（启动器上有对应的勾选框）
    gitignore: opts.gitignore !== undefined,
  };
  // --watch：持续扫描（启动器里那个「内构监控」）—— 先分趟把地图长出来，然后一直监听、改了自动重扫。
  // ⚠ 这个分支**不会返回**（事件循环里挂着 watcher）；停止请强杀进程。
  if (opts.watch) {
    await watchScan(scanOpts);
    // 与 scan 那条一样：--no-open 只是不弹系统浏览器，服务照起（启动器靠 stdout 里那个 URL 把地图嵌进窗口）
    startServer({ outDir: path.resolve(scanOpts.outDir), port: Number(opts.port || DEFAULT_PORT), open: opts['no-open'] === undefined, host: opts.host });
    // ⚠ 这里**故意永不 resolve**：CLI 收尾时对 scan / ingest 会 `flushAndExit(0)`（process.reallyExit），
    // 这个函数一返回，监控进程就被当场硬杀（实测：日志停在“监控中”之后什么都没有）。
    // 挂住它，轮询定时器就能一直跑；停监控请强杀进程。
    await new Promise(() => {});
    return;
  }
  const result = await scanToDisk(scanOpts);
  printScanReport(result.bundle, result.out);
  if (opts.open !== undefined) {
    startServer({ outDir: result.outDir, port: Number(opts.port || DEFAULT_PORT), open: true, host: opts.host });
  }
}

async function cmdIngest(argv) {
  const opts = parseArgs(argv);
  const target = opts._[0];
  if (!target) {
    console.error(t('用法：atlas ingest <目录|.dll|.exe|.jar> [--out dist] [--work ingest/<名>] [--dll "App*.dll"] [--decompiler cfr.jar] [--facets 配置.json]', 'Usage: atlas ingest <dir|.dll|.exe|.jar> [--out dist] [--work ingest/<name>] [--dll "App*.dll"] [--decompiler cfr.jar] [--facets config.json]'));
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
  console.log(t(`\nCode Atlas 支持的语言：${code.length} 门代码语言 + ${fileLevel.length} 种文件级格式\n`, `\nCode Atlas supported languages: ${code.length} code languages + ${fileLevel.length} file-level formats\n`));
  console.log(t('代码语言（默认扫这些）：', 'Code languages (scanned by default):'));
  for (const l of code) console.log(`  ${l.id.padEnd(12)} ${l.label.padEnd(14)} ${l.exts.join(' ')}`);
  console.log(t('\n文件级格式（默认不扫，显式指定才扫）：', '\nFile-level formats (off by default — name them explicitly to scan):'));
  for (const l of fileLevel) console.log(`  ${l.id.padEnd(12)} ${l.label.padEnd(14)} ${l.exts.join(' ')}`);
  console.log(t('\n用法：--lang auto（默认，所有代码语言） · --lang csharp,typescript · --lang auto,json\n', '\nUsage: --lang auto (default, all code languages) · --lang csharp,typescript · --lang auto,json\n'));
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
    console.error(t('用法：atlas draft-facets <目录> [--out 文件] [--json] [--lang auto] [--maxkb 1024] [--by namespace --bundle 输出目录]', 'Usage: atlas draft-facets <dir> [--out file] [--json] [--lang auto] [--maxkb 1024] [--by namespace --bundle <out dir>]'));
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
  console.log(t(`\n${res.by === 'namespace' ? '按命名空间' : '按目录结构'}草拟了 ${res.preview.length} 个系统（共 ${res.files} 个文件）：\n`, `\nDrafted ${res.preview.length} systems from ${res.by === 'namespace' ? 'namespaces' : 'directory structure'} (${res.files} files):\n`));
  for (const p of res.preview) console.log(`  ${p.name.padEnd(18)} ${String(p.files).padStart(5)} ${p.unit || t('个文件', 'files')}`);
  for (const n of res.notes) console.log(`  · ${n}`);
  console.log(`\n${json}`);
  console.log(opts.out ? t(`已写入：${path.resolve(opts.out)}\n`, `Written to: ${path.resolve(opts.out)}\n`) : t('（加 --out <文件> 就能写出来）\n', '(pass --out <file> to write it out)\n'));
}

/** mcp：把 bundle 变成 AI 能查的接口（stdio JSON-RPC —— stdout 只能走协议，日志走 stderr） */
function cmdMcp(argv) {
  const opts = parseArgs(argv);
  if (opts['list-tools'] !== undefined) {
    console.log(`\nCode Atlas MCP · ${path.join(path.resolve(opts.out || 'dist'), 'bundle.json')}\n`);
    console.log(listToolsText());
    console.log(t('\n接入客户端：command=node，args=[<绝对路径>/src/cli.mjs, mcp, --out, <绝对路径>/dist]\n（Chatbox / Claude Desktop 用 `mcp --print-config`；dsh 用 `mcp --print-config --client dsh`）\n', '\nTo hook up a client: command=node, args=[<abs>/src/cli.mjs, mcp, --out, <abs>/dist]\n(Chatbox / Claude Desktop: `mcp --print-config`; dsh: `mcp --print-config --client dsh`)\n'));
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
    if (String(opts.client || '').toLowerCase() === 'dsh') { printDshConfig(cli, out); return; }
    console.log(t('\n把下面这段粘进 MCP 客户端（Chatbox / Claude Desktop 等）的 mcpServers 配置里：\n', '\nPaste this into mcpServers in your MCP client (Chatbox / Claude Desktop, …):\n'));
    console.log(JSON.stringify({ mcpServers: { 'code-atlas': { command: 'node', args: [cli, 'mcp', '--out', out] } } }, null, 2));
    console.log(t('\n说明：路径已写成绝对路径（客户端的工作目录不确定，相对路径会找不到）。', '\nNote: paths are absolute — clients start in an unknown working directory, so relative paths would break.'));
    console.log(t('     换项目只要改 --out 指向那个项目的输出目录；想同时看多个项目就配多份（名字不同）。\n', '     To switch projects just change --out; to watch several at once, add more entries (different names).\n'));
    return;
  }
  startMcp({ bundlePath: path.join(opts.out || 'dist', 'bundle.json') });
}

/**
 * dsh（DeepSeek Harness）的接入配置：它的 MCP 客户端是个 Cordis 插件（`@deepseek-ai/dsh-mcp-client`），
 * 配置形态是 overlay patch YAML。字段名照官方示例（serverName / transport / command / args / cwd）——
 * 见 dsh 官方仓库 `docs/user/guide/mcp-memory.zh.md` 与 `packages/mcp/mcp-client/README.zh.md`。
 * ⚠ 本机没装 dsh：这段**未经端到端验证**（自检里只钉住关键字段），验证清单见工作文档。
 */
function printDshConfig(cli, out) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;   // YAML 单引号串：内部的 ' 翻倍
  // 跑在真 node 下就把 node 的绝对路径写进去（dsh 是桌面应用，PATH 里未必有 node）；否则退回 'node'
  const nodeCmd = /^node(\.exe)?$/i.test(path.basename(process.execPath)) ? process.execPath : 'node';
  const zh = `\n# CodeAtlas → dsh（DeepSeek Harness）· 由 Code Atlas v${VERSION} 生成\n#\n# 用法：\n#   ① 先扫一次要查的项目（生成 bundle.json）：\n#        ${nodeCmd} ${q(cli)} scan <项目目录> --out ${q(out)}\n#   ② 把下面这段（从 - insert: 开始）并入 dsh 的 patch 文件 ——\n#        全机生效：$DSH_HOME/cordis.patch.yml；只对一个 profile：$DSH_HOME/profiles/<名字>/cordis.patch.yml\n#        （不要覆盖已有文件，里面可能已有别的 patch；合并即可）\n#   ③ 重启 dsh：工具会以 mcp__codeatlas__overview / __refs / __impact / … 出现\n#        （serverName=codeatlas 决定这段前缀；想换名字就两边一起改）\n#\n# 备注：command 写的是 node 的绝对路径（dsh 是桌面应用，PATH 里未必有 node）；换机器时照着改。本机未装 dsh，未端到端验证。\n- insert:\n    - id: codeatlas\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: codeatlas\n        transport: stdio\n        command: ${q(nodeCmd)}\n        args:\n          - ${q(cli)}\n          - mcp\n          - --out\n          - ${q(out)}\n        cwd: !!js process.cwd()\n`;
  const en = `\n# CodeAtlas → dsh (DeepSeek Harness) · generated by Code Atlas v${VERSION}\n#\n# How to use:\n#   1) Scan the project once first (produces bundle.json):\n#        ${nodeCmd} ${q(cli)} scan <project dir> --out ${q(out)}\n#   2) Merge the block below (from \`- insert:\`) into dsh's patch file —\n#        machine-wide: $DSH_HOME/cordis.patch.yml; single profile: $DSH_HOME/profiles/<name>/cordis.patch.yml\n#        (do not overwrite an existing file — merge it in)\n#   3) Restart dsh: tools show up as mcp__codeatlas__overview / __refs / __impact / …\n#        (the serverName below decides that prefix)\n#\n# Note: if \`node\` is not on PATH, replace command with the absolute path to node.exe.\n# Not verified end-to-end here — dsh is not installed on this machine.\n- insert:\n    - id: codeatlas\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: codeatlas\n        transport: stdio\n        command: ${q(nodeCmd)}\n        args:\n          - ${q(cli)}\n          - mcp\n          - --out\n          - ${q(out)}\n        cwd: !!js process.cwd()\n`;
  console.log(t(zh, en));
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
const HELP_ZH = `Code Atlas v${VERSION}

最简单：把路径丢进来就行（源码目录、程序集、jar 都认）
  atlas "C:/path/to/project"         扫描并打开浏览器
  atlas "C:/path/to/App.dll"         反编译 + 扫描
  atlas "C:/path/to/game.jar"        反编译 jar + 扫描

细分命令：
  atlas scan   <目录...>            只扫描源码目录（--incremental：只重解析改过的文件；--watch：持续扫描，改了自动重扫；--gitignore：按项目 .gitignore 跳过；额外规则可写在目标根的 atlas.ignore 里）
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

// 英文帮助：和上面的中文版成对，由 t() 二选一（两份都写在调用点上，改文案时能同时看到）
const HELP_EN = `Code Atlas v${VERSION}

Easiest: just pass a path (source directory, assembly or jar all work)
  atlas "C:/path/to/project"         scan and open the browser
  atlas "C:/path/to/App.dll"         decompile + scan
  atlas "C:/path/to/game.jar"        decompile the jar + scan

Subcommands:
  atlas scan   <dir...>              scan source directories only (--incremental: re-parse changed files; --watch: keep scanning; --gitignore: also skip what the project's .gitignore ignores; extra rules can go in atlas.ignore at the target root)
  atlas ingest <dir|.dll|.exe|.jar>  decompile first, then scan (for targets without source)
  atlas serve                        start the local server (no re-scan)
                                      binds 127.0.0.1 only by default (no firewall prompt, not exposed on the LAN);
                                      to view it from your LAN/phone: --host 0.0.0.0
  atlas langs                        list the supported languages (--json for machines)
  atlas draft-facets <dir>           draft a grouping config from the directory structure (--out writes it; --by namespace --bundle dist uses namespaces)

Common options:
  --out <dir>       output directory (default dist)
  --port <port>     local server port (default 5173, walks forward if taken)
  --no-open         do not open the browser automatically
  --lang <lang>     only scan the given languages (csharp / typescript / java / lua / auto)
  --facets <file>   system/module grouping rules (default: <target>/atlas.facets.json or configs/<dirname>.facets.json)
  --exclude a,b     extra directory names to skip
  --work <dir>      where decompiled output goes (default ingest/<name>)`;

const HELP = t(HELP_ZH, HELP_EN);

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
  console.error(t(`未知选项：${first}\n\n${HELP}`, `Unknown option: ${first}\n\n${HELP}`));
  process.exit(1);
} else {
  // 第一个参数是路径 -> 零配置入口
  run = () => cmdAuto([first, ...rest]);
}

// 注意：serve 是同步函数，auto/scan/ingest 是异步的 —— 统一用 Promise.resolve 包一层再接 catch。
// ⚠ 必须写成 `.then(() => run())`：直接 `Promise.resolve(run())` 的话，**同步抛出**（如 serve 找不到
// bundle）发生在参数求值阶段，压根进不了下面的 catch —— 用户看到的是 Node 堆栈（file:///C:/Users/…）。
await Promise.resolve()
  .then(() => run())
  .then(() => {
    // scan / ingest 跑完即退（serve / mcp / auto 要保持存活，不能退）
    if (first === 'scan' || first === 'ingest') flushAndExit(0);
  })
  .catch((err) => {
    console.error(`\n${fmtError(err)}\n`);
    process.exit(1);
  });
