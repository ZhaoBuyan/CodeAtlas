/**
 * 把「引擎跑起来需要的东西」打成一个 zip，供启动器构建时嵌进 exe。
 *
 *   node tools/build-payload.mjs              # 带 node.exe（完全版）
 *   node tools/build-payload.mjs --no-node    # 不带（精简版：要求系统装 Node.js）
 *   node tools/build-payload.mjs --node <node.exe 路径>
 *
 * 产出：
 *   launcher/payload.zip        （完全版用）
 *   launcher/payload-lite.zip   （精简版用）
 *
 * 只放"跑起来真的要读的文件"：src / web / configs / 需要的 wasm / d3.min.js /
 * web-tree-sitter 运行时 / 声明文件。测试、node_modules 里用不到的部分、dist 一概不进去。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LANGUAGES, WASM_ROOTS, resolveWasm } from '../src/languages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const args = process.argv.slice(2);
const withNode = !args.includes('--no-node');
const nodeArg = args.includes('--node') ? args[args.indexOf('--node') + 1] : null;
const outName = withNode ? 'payload.zip' : 'payload-lite.zip';
const OUT_ZIP = path.join(ROOT, 'launcher', outName);
const STAGE = path.join(ROOT, 'build', 'payload');

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const copy = (list) => {
  for (const [from, to] of list) {
    const src = path.isAbsolute(from) ? from : path.join(ROOT, from);
    if (!fs.existsSync(src)) throw new Error(`打包缺文件：${src}${path.isAbsolute(from) ? '' : '（先 npm install？）'}`);
    const dst = path.join(STAGE, to || from);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
};

/** 整个目录树照搬（用于 vendor/jre 这种几百个文件的运行时；路径与仓库里一致） */
const copyDir = (fromRel) => {
  const src = path.join(ROOT, fromRel);
  if (!fs.existsSync(src)) throw new Error(`打包缺目录：${src}`);
  const walk = (dir, base) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]);
  copy(walk(src, '').map((p) => [`${fromRel}/${p}`, null]));
};

/** 找真 node.exe：绝不接受 Electron 冒充的那种（本沙箱里 `node` 就是 Chatbox） */
function findRealNode() {
  const candidates = [];
  if (nodeArg) candidates.push(nodeArg);
  if (/node\.exe$/i.test(process.execPath) && !/chatbox|electron/i.test(process.execPath)) candidates.push(process.execPath);
  candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'));
  candidates.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'));
  if (process.env.NODE_BIN) candidates.push(process.env.NODE_BIN);
  for (const c of candidates) {
    if (!c || !fs.existsSync(c)) continue;
    if (/chatbox|electron/i.test(c)) continue;
    if (!/node\.exe$/i.test(c)) continue;
    return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
console.log(`\nCode Atlas · 打包引擎（${withNode ? '完全版：带 node.exe' : '精简版：不带 node'}）\n`);

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// 1) 引擎代码与前端
const srcFiles = fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.mjs')).map((f) => [`src/${f}`, null]);
const webFiles = fs.readdirSync(path.join(ROOT, 'web')).map((f) => [`web/${f}`, null]);
copy([...srcFiles, ...webFiles, ...listConfigs()]);

/**
 * configs/：默认只带 **git 跟踪的** 那部分。
 * 各人自己的项目分组规则是私有的（已 gitignore），不该跟着 exe 发给别人；
 * 要全带（自己用）就加 --all-configs。
 */
function listConfigs() {
  const dir = path.join(ROOT, 'configs');
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (args.includes('--all-configs')) return all.map((f) => [`configs/${f}`, null]);
  try {
    const tracked = execFileSync('git', ['ls-files', 'configs'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean).map((p) => path.basename(p));
    const kept = all.filter((f) => tracked.includes(f));
    if (kept.length !== all.length) {
      console.log(`  configs：带 ${kept.length} 个（跳掉 ${all.length - kept.length} 个未入库的私有规则；自己用要全带上就加 --all-configs）`);
    }
    return kept.map((f) => [`configs/${f}`, null]);
  } catch {
    console.log('  configs：git 不可用，按目录里的全带');
    return all.map((f) => [`configs/${f}`, null]);
  }
}

// 2) 顶层说明性文件（许可证 / 第三方声明 / 版本信息）
copy([
  ['package.json', null],
  ['LICENSE', null],
  ['THIRD-PARTY-NOTICES.md', null],
  // 两份用户说明书也放一份（用户拍板：反正要重打载荷，顺带打进去，解包目录里东西就齐了）。
  // 注意：启动器没有“打开该目录”的入口，所以这**不是给用户看的渠道**，只是自带一份而已。
  ['USAGE.md', null],
  ['使用说明.md', null],
]);
// 第三方许可证原文（Node.js 那份 154 KB，是官方原文件，所以单独放目录）
copy(fs.readdirSync(path.join(ROOT, 'licenses')).map((f) => [`licenses/${f}`, null]));

// 3) 前端要用的 d3（只取发布用的那一个文件）
copy([['node_modules/d3/dist/d3.min.js', null]]);

// 4) 引擎唯一的裸依赖：web-tree-sitter（package.json + ESM 入口 + 运行时 wasm + 许可证）
//    注意：0.27 的文件名是 web-tree-sitter.js / web-tree-sitter.wasm（旧版叫 tree-sitter.js / tree-sitter.wasm）
copy([
  ['node_modules/web-tree-sitter/package.json', null],
  ['node_modules/web-tree-sitter/web-tree-sitter.js', null],
  ['node_modules/web-tree-sitter/web-tree-sitter.wasm', null],
  ['node_modules/web-tree-sitter/LICENSE', null],
]);

// 5) 语法包：只带语言表里用到的那几个（105 个里用不到的省一大截）
//    两个来源分别归位：主来源 → node_modules/tree-sitter-wasm/out/，自己补的 → vendor/wasm/
//    路径必须与 languages.mjs 里 WASM_ROOTS 保持一致，否则运行时找不到
const langs = Object.values(LANGUAGES);
const wasms = [...new Set(langs.map((l) => l.wasm))];
const wasmCopies = wasms.map((w) => {
  const src = resolveWasm({ wasm: w });
  const i = WASM_ROOTS.findIndex((r) => src.startsWith(r + path.sep));
  if (i < 0) throw new Error(`语法包不在已知来源里：${w}`);
  return [`${rel(WASM_ROOTS[i])}/${w}`, null];
});
copy(wasmCopies);
copy([
  ['node_modules/tree-sitter-wasm/LICENSE', null],
  ...fs.readdirSync(path.join(ROOT, 'vendor', 'wasm'))
    .filter((f) => f.startsWith('LICENSE'))
    .map((f) => [`vendor/wasm/${f}`, null]),
]);

// 6) Java 反编译链路：自带的裁剪运行时（**只进完全版**）+ cfr.jar（两份都带；精简版要扫 .jar 仍需自己装 Java）
//    vendor/jre 是用 tools/build-jre.mjs 从 JDK 裁出来的（只含 java.base + java.logging，实测能跑 cfr）
if (withNode) {
  copyDir('vendor/jre');
} else {
  console.log('  Java 运行时：精简版不带（要扫 .jar 得自己装 Java）');
}
copy([['vendor/cfr.jar', null]]);
copy([['licenses/CFR-LICENSE.txt', null]]);

// 7) node.exe（完全版）
let nodeInfo = null;
if (withNode) {
  const nodeExe = findRealNode();
  if (!nodeExe) throw new Error('找不到真正的 node.exe（用 --node <路径> 指定）');
  const version = execFileSync(nodeExe, ['--version'], { encoding: 'utf8' }).trim();
  copy([[nodeExe, 'node.exe']]);
  nodeInfo = { version, source: nodeExe };
  console.log(`  node.exe：${nodeExe}（${version}）`);
} else if (/chatbox/i.test(process.execPath)) {
  console.log(`  注意：用来跑这个脚本的“node”其实是 ${path.basename(process.execPath)}（Electron 冒充的），精简版无所谓，但别拿它当 node 用`);
}

// 7) 元信息（出问题时能一眼看出这个包里是什么）
const meta = {
  built: new Date().toISOString(),
  edition: withNode ? 'full' : 'lite',
  node: nodeInfo,
  languages: langs.map((l) => l.id),
  wasms,
  javaRuntime: withNode ? 'vendor/jre（jlink: java.base + java.logging）' : null,
  javaDecompiler: 'vendor/cfr.jar',
};
fs.writeFileSync(path.join(STAGE, 'payload.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');

// 8) 数一下、打成 zip
const walk = (dir, base = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]);
const files = walk(STAGE);
const bytes = files.reduce((a, f) => a + fs.statSync(path.join(STAGE, f)).size, 0);
console.log(`  暂存：${files.length} 个文件 / ${(bytes / 1048576).toFixed(1)} MB`);

fs.rmSync(OUT_ZIP, { force: true });
const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${STAGE}', '${OUT_ZIP}')`;
execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' });
const zipBytes = fs.readFileSync(OUT_ZIP);
const zipMb = zipBytes.length / 1048576;

// 指纹：启动器用它给“释放目录”命名。用内容哈希而不是文件大小——
// 否则改了引擎但 zip 大小碰巧一样时，会继续用旧的解包目录（实际踩过）。
const stamp = crypto.createHash('sha256').update(zipBytes).digest('hex').slice(0, 16);
fs.writeFileSync(`${OUT_ZIP}.stamp`, stamp, 'utf8');
console.log(`\n  ✓ ${rel(OUT_ZIP)}  ${zipMb.toFixed(1)} MB（未压缩 ${(bytes / 1048576).toFixed(1)} MB）  指纹 ${stamp}`);
console.log(`    构建启动器：dotnet publish launcher/CodeAtlas.Launcher.csproj -c Release -r win-x64 ` +
  `--self-contained ${withNode ? 'true' : 'false'} -p:PublishSingleFile=true ` +
  `${withNode ? '-p:EnableCompressionInSingleFile=true ' : ''}-p:CodeAtlasPayload=${outName} ` +
  `${withNode ? '' : '-p:CodeAtlasEdition=lite '}-o ${withNode ? 'publish-sc' : 'publish-lite'}\n`);
