/**
 * ingest：把"不是源码的东西"变成能扫的源码目录。
 *
 *   目录里有源码        -> 直接扫
 *   .dll / .exe（.NET）  -> 启动器内置的 ILSpy 反编译（开发模式下回退到 ilspycmd）
 *   .jar（Java）         -> cfr 反编译；java 与 cfr.jar 优先用自带的 vendor/（完全版内置，用户不用装）
 *   单文件发行版 .exe    -> 解包（启动器内置 SingleFileExtractor；开发模式回退到 sfextract）
 *
 * 设计原则：ingest 只负责"把产物变源码"，产出的目录就是普通源码目录，
 * 后面全部走同一个 scan；反编译这件事本身不污染中间数据，只记进 source.ingest。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanToDisk } from './scan.mjs';
import { LANGUAGES, languageForExt } from './languages.mjs';
import { t } from './i18n.mjs';

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_EXTS = new Set(Object.values(LANGUAGES).flatMap((l) => l.exts));
const SKIP_ASM = /^(System|Microsoft|netstandard|WindowsBase|mscorlib|PresentationFramework|PresentationCore|Accessibility|UIAutomation)/i;

/**
 * 子进程输出解码：先按 UTF-8；**不是合法 UTF-8 就按 GBK 再解一次**。
 * 为什么需要：Windows 上 java.exe 的启动器早期报错（例如 “Invalid or corrupt jarfile <路径>”）是按
 * **系统代码页**（中文机器 = GBK）输出的，JVM 的 stdout/stderr.encoding 参数管不到它 —— 实测中文路径会变乱码。
 * 修在读的一侧最省事，而且对“外部工具按本地代码页说话”这类情况普遍有效。
 */
function dec(buf) {
  if (buf == null) return '';
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  const s = b.toString('utf8');
  if (!s.includes('\uFFFD')) return s;
  try { return new TextDecoder('gbk').decode(b); } catch { return s; }
}

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { ...opts, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return { ...r, stdout: dec(r.stdout), stderr: dec(r.stderr) };
};

// ---------------------------------------------------------------------------
// 工具探测
// ---------------------------------------------------------------------------

export function findIlspy() {
  // 首选启动器自带的（零安装）：启动器启动引擎时把自己的路径放进 CODEATLAS_SELF。
  // 开发模式（node src/cli.mjs）没这个变量 → 下面照旧找 ilspycmd。
  const self = process.env.CODEATLAS_SELF;
  if (self && fs.existsSync(self)) {
    return { cmd: self, argsPrefix: ['--decompile'], label: t('Code Atlas 内置（ICSharpCode.Decompiler）', 'built into Code Atlas (ICSharpCode.Decompiler)'), builtin: true };
  }
  const cands = [
    process.env.ILSPYCMD,
    'ilspycmd',
    path.join(os.homedir(), '.dotnet', 'tools', 'ilspycmd.exe'),
    path.join(os.homedir(), '.dotnet', 'tools', 'ilspycmd'),
  ].filter(Boolean);
  for (const c of cands) {
    if (c.includes(path.sep) && !fs.existsSync(c)) continue;
    const r = run(c, ['--version']);
    if (!r.error && r.status === 0) return { cmd: c, argsPrefix: [], label: 'ilspycmd ' + String(r.stdout || '').trim().split('\n')[0] };
  }
  return null;
}

function findJava() {
  // 先看仓库/引擎自带的裁剪运行时（完全版带它，用户什么都不用装）——路径跟打包脚本一致
  const bundled = path.join(PROJECT_ROOT, 'vendor', 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const cands = [bundled, 'java'];
  for (const c of cands) {
    if (c.includes(path.sep) && !fs.existsSync(c)) continue;
    const r = run(c, ['-version']);
    if (!r.error && r.status === 0) return { cmd: c, label: String(r.stderr || r.stdout || '').split('\n')[0].trim(), bundled: c === bundled };
  }
  return null;
}

/** 找 Java 反编译器（cfr / vineflower）：**显式指定 > 自带 > 环境变量 > 家目录** */
function findJarDecompiler(explicit) {
  const bundled = path.join(PROJECT_ROOT, 'vendor', 'cfr.jar');
  const cands = [
    // 显式指定优先：`--decompiler` 是用户明说的，自带那份只兵底
    //（原来写成自带优先，结果是“传了 --decompiler 也没用” —— 实测过）
    explicit,
    fs.existsSync(bundled) ? bundled : null,
    process.env.CFR_JAR,
    process.env.VINEFLOWER_JAR,
    path.join(os.homedir(), '.code-atlas', 'cfr.jar'),
    path.join(os.homedir(), '.code-atlas', 'vineflower.jar'),
  ].filter(Boolean);
  for (const c of cands) if (c.includes(path.sep) && fs.existsSync(c)) return c;
  return null;
}

// ---------------------------------------------------------------------------
// 目标识别
// ---------------------------------------------------------------------------

/** 目录里有没有可扫的源码 */
function hasSource(dir, depth = 3) {
  const stack = [[dir, 0]];
  while (stack.length) {
    const [d, level] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (level < depth && !e.name.startsWith('.') && e.name !== 'node_modules') stack.push([path.join(d, e.name), level + 1]);
      } else if (SOURCE_EXTS.has(path.extname(e.name).toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * 这是 .NET 托管程序集，还是原生宿主（单文件 bundle 的外壳）？
 * 不能靠搜 "BSJB" 字符串：单文件 bundle 里嵌着程序集，字节里也有 BSJB，会误判。
 * 正确做法是读 PE 可选头的数据目录表第 14 项（CLR 运行时头），为零就不是托管程序集。
 */
export function looksManaged(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const dos = Buffer.alloc(64);
    fs.readSync(fd, dos, 0, 64, 0);
    if (dos.readUInt16LE(0) !== 0x5a4d) return false; // 'MZ'
    const peOff = dos.readUInt32LE(0x3c);
    const pe = Buffer.alloc(24);
    fs.readSync(fd, pe, 0, 24, peOff);
    if (pe.readUInt32LE(0) !== 0x00004550) return false; // 'PE\0\0'
    const optOff = peOff + 24;
    const magicBuf = Buffer.alloc(2);
    fs.readSync(fd, magicBuf, 0, 2, optOff);
    const magic = magicBuf.readUInt16LE(0); // 0x10b=PE32, 0x20b=PE32+
    const ddOff = optOff + (magic === 0x20b ? 112 : 96);
    const clr = Buffer.alloc(8);
    fs.readSync(fd, clr, 0, 8, ddOff + 14 * 8);
    return clr.readUInt32LE(0) !== 0 && clr.readUInt32LE(4) !== 0;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * 没指定 --facets 时，自动找 configs/<程序集名>.facets.json。
 * 这样 `atlas ingest App.exe` 也能直接拿到系统分组，不用每次手写参数。
 */
function autoFacets(stem, explicit) {
  if (explicit) return { facets: explicit, note: null };
  const p = path.join(PROJECT_ROOT, 'configs', `${stem}.facets.json`);
  if (fs.existsSync(p)) return { facets: p, note: t(`分组规则：configs/${stem}.facets.json（自动匹配）`, `Grouping rules: configs/${stem}.facets.json (auto-matched)`) };
  return { facets: null, note: null };
}

/** 找单文件解包工具：优先启动器自带的（零安装），再找 sfextract */
function findSfextract() {
  const self = process.env.CODEATLAS_SELF;
  if (self && fs.existsSync(self)) {
    return { cmd: self, argsPrefix: ['--extract-bundle'], label: t('Code Atlas 内置（SingleFileExtractor）', 'built into Code Atlas (SingleFileExtractor)') };
  }
  const cands = [
    process.env.SFEXTRACT,
    path.join(os.homedir(), '.dotnet', 'tools', 'sfextract.exe'),
    path.join(os.homedir(), '.dotnet', 'tools', 'sfextract'),
    'sfextract',
  ].filter(Boolean);
  for (const c of cands) {
    if (c.includes(path.sep)) {
      if (fs.existsSync(c)) return { cmd: c, argsPrefix: [], label: 'sfextract' };
      continue;
    }
    const r = run(c, ['--help']);
    if (!r.error) return { cmd: c, argsPrefix: [], label: 'sfextract' };
  }
  return null;
}

/**
 * 不是 .NET 时的说明。原生可执行文件（C/C++ 编译，很多游戏本体属于这类）走的就是这里：
 * 它没有 CLR 头 → looksManaged() 为假 → 只能当"单文件发行版"去试，sfextract 会回一句
 * "Is not a .NET Core 3.x or greater executable."（而且退出码是 0）。
 * 这个错不能只说"可能不是 .NET 应用"——要直接说清楚是什么、以及为什么做不到。
 */
function notManagedError(target) {
  return new Error([
    t(`这不是 .NET 程序集：${path.basename(target)}`, `Not a .NET assembly: ${path.basename(target)}`),
    t('看起来是原生可执行文件（C/C++ 编译出来的，很多软件和游戏本体属于这一类）。', 'This looks like a native executable (compiled from C/C++ — most games and many apps are).'),
    '',
    t('反编译只支持这三类：', 'Decompilation only covers three kinds of targets:'),
    t('  ① .NET 程序集：.dll / 带 CLR 头的 .exe', '  1) .NET assemblies: .dll / .exe with a CLR header'),
    t('  ② .NET 单文件发行版：.NET Core 3.x 及以上打包出来的单个 exe', '  2) .NET single-file bundles: a single .exe packaged by .NET Core 3.x or newer'),
    t('  ③ Java 的 .jar（需要 Java 运行时 + cfr/vineflower）', '  3) Java .jar (needs a Java runtime + cfr/vineflower)'),
    '',
    t('原生程序里没有类型名、命名空间、方法签名这些元数据，要出这种图得先反汇编成近似 C 再解释', 'Native programs carry no type names, namespaces or method signatures, so getting a map out of them'),
    t('（IDA / Ghidra 那个量级的活），不在本工具的能力范围内。', 'means disassembling to approximate C first (IDA / Ghidra territory) — out of scope for this tool.'),
    t('例外：Unity 游戏的 <游戏名>_Data\\Managed\\*.dll 就是 .NET 程序集，直接指那个目录或文件就能扫。', 'Exception: in Unity games, <GameName>_Data\\Managed\\*.dll are .NET assemblies — point at that file or folder and it just works.'),
  ].join('\n'));
}

/**
 * 单文件发行版（PublishSingleFile）：先用 sfextract 解包，再反编译应用自己的程序集。
 * 这样"指一个发行版 exe 就能出图"就成立了。
 */
function decompileBundle(exe, workDir, notes) {
  const sf = findSfextract();
  if (!sf) {
    throw new Error([
      t(`${path.basename(exe)} 是 .NET 单文件发行版（原生宿主），程序集打在里面，要先用工具解包。`, `${path.basename(exe)} is a .NET single-file bundle (native host) — the assemblies are packed inside and need unpacking first.`),
      t('用启动器（CodeAtlas.exe）跑的话，解包是内置的；直接跑引擎才需要：dotnet tool install -g sfextract', 'The launcher (CodeAtlas.exe) does this built-in; running the engine directly needs: dotnet tool install -g sfextract'),
      t('或者：把同版本构建输出里的 .dll 直接丢进来（bin/Release/.../win-x64/App.dll）。', 'Or: point at the .dll from the matching build output (bin/Release/.../win-x64/App.dll).'),
    ].join('\n'));
  }
  const bundleDir = path.join(workDir, '_bundle');
  fs.mkdirSync(bundleDir, { recursive: true });
  const r = run(sf.cmd, [...sf.argsPrefix, exe, '-o', bundleDir]);
  if (r.status !== 0) {
    const out = String(r.stderr || r.stdout || '').trim();
    // 解包器对非 .NET 单文件的回话有两种形式（自带的和 sfextract 的措辞不同），两条路都给同一个清楚的说法
    if (/not a \.NET Core|不是 \.NET 单文件发行版|bundle 清单/i.test(out)) throw notManagedError(exe);
    throw new Error(t(`解包失败：${out.slice(0, 300)}`, `Unpacking failed: ${out.slice(0, 300)}`));
  }
  const dllCount = countFiles(bundleDir, '.dll');
  if (!dllCount) throw notManagedError(exe);
  notes.push(t(`解包单文件发行版：${path.basename(exe)} → ${dllCount} 个 dll（${sf.label}）`, `Unpacked single-file bundle: ${path.basename(exe)} → ${dllCount} dlls (${sf.label})`));

  const base = path.basename(exe).replace(/\.exe$/i, '');
  const preferred = path.join(bundleDir, `${base}.dll`);
  let assemblies;
  if (fs.existsSync(preferred)) {
    assemblies = [preferred];
  } else {
    assemblies = fs.readdirSync(bundleDir)
      .filter((n) => n.toLowerCase().endsWith('.dll') && !SKIP_ASM.test(n))
      .slice(0, 5)
      .map((n) => path.join(bundleDir, n));
  }
  if (!assemblies.length) {
    throw new Error([
      t(`解包出来了 ${dllCount} 个 dll，但没有应用自己的程序集（都是运行时/系统程序集？）`, `Unpacked ${dllCount} dlls, but none of them is the application's own assembly (all runtime/system assemblies?)`),
      t(`解包目录：${bundleDir}`, `Bundle directory: ${bundleDir}`),
      t('可以把里面的应用程序集直接指给我：atlas ingest "<那个 .dll>"', 'You can point me straight at the app assembly: atlas ingest "<that .dll>"'),
    ].join('\n'));
  }
  return decompileAssemblies(assemblies, path.join(workDir, 'src'), notes);
}

function listExes(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.exe')).map((n) => path.join(dir, n));
  } catch { return []; }
}
function pickAssemblies(dir, dllPattern, baseName) {
  let all = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.dll'));
  if (dllPattern) {
    const re = new RegExp(`^${String(dllPattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
    all = all.filter((n) => re.test(n));
  } else {
    const exact = all.find((n) => n.toLowerCase() === `${baseName.toLowerCase()}.dll`);
    if (exact) all = [exact];
    else {
      const own = all.filter((n) => !SKIP_ASM.test(n));
      all = own.length && own.length <= 5 ? own : [];
    }
  }
  // 只在真正的 .NET 程序集里挑。原生 dll（C/C++ 编译）挑出来只会让 ilspycmd 白跑一趟，
  // 而且会把报错引到"装 ilspycmd"上 —— 而那种目标装了也扫不了（比如指向 WeGame 这类安装目录）。
  return all.filter((n) => looksManaged(path.join(dir, n))).map((n) => path.join(dir, n));
}

// ---------------------------------------------------------------------------
// 反编译
// ---------------------------------------------------------------------------

function decompileAssemblies(assemblies, workDir, notes) {
  const ilspy = findIlspy();
  if (!ilspy) {
    throw new Error([
      t('这个目标需要反编译（.NET 程序集），但没找到可用的反编译器。', 'This target needs decompilation (.NET assembly), but no usable decompiler was found.'),
      t('用启动器（CodeAtlas.exe）跑的话，反编译是内置的，不需要装任何东西；', 'The launcher (CodeAtlas.exe) has one built in — nothing to install;'),
      t('如果是直接跑引擎（node src/cli.mjs），才需要装：dotnet tool install -g ilspycmd --version 9.1.0.7988', 'running the engine directly (node src/cli.mjs) needs: dotnet tool install -g ilspycmd --version 9.1.0.7988'),
    ].join('\n'));
  }
  notes.push(t(`反编译工具：${ilspy.label}`, `Decompiler: ${ilspy.label}`));
  let csCount = 0;
  for (const asm of assemblies) {
    const stem = path.basename(asm).replace(/\.(dll|exe)$/i, '');
    const out = path.join(workDir, stem);
    fs.mkdirSync(out, { recursive: true });
    const r = run(ilspy.cmd, [...ilspy.argsPrefix, asm, '-o', out, '-p']);
    if (r.status !== 0) {
      notes.push(t(`反编译失败（跳过）：${path.basename(asm)} — ${String(r.stderr || r.stdout || '').trim().split('\n').slice(0, 2).join(' ')}`, `Decompile failed (skipped): ${path.basename(asm)} — ${String(r.stderr || r.stdout || '').trim().split('\n').slice(0, 2).join(' ')}`));
      continue;
    }
    const n = countFiles(out, '.cs');
    csCount += n;
    notes.push(t(`反编译 ${path.basename(asm)} → ${n} 个 .cs（${path.relative(process.cwd(), out)}）`, `Decompiled ${path.basename(asm)} → ${n} .cs files (${path.relative(process.cwd(), out)})`));
  }
  if (!csCount) throw new Error(t('反编译没有产出任何 .cs 文件', 'Decompilation produced no .cs files'));
  return workDir;
}

function countFiles(dir, ext) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) stack.push(path.join(d, e.name));
      else if (path.extname(e.name).toLowerCase() === ext) n++;
    }
  }
  return n;
}

function decompileJar(jar, workDir, notes, decompilerPath) {
  const java = findJava();
  if (!java) {
    throw new Error([
      t('这个目标是 .jar，需要 Java 运行时才能反编译。', 'This target is a .jar — decompiling it needs a Java runtime.'),
      t('完全版（CodeAtlas.exe）自带一份裁剪过的运行时，不需要装；', 'The full edition (CodeAtlas.exe) ships a trimmed runtime — nothing to install;'),
      t('直接跑引擎（node src/cli.mjs）才需要装个 JRE。', 'only running the engine directly (node src/cli.mjs) needs a JRE.'),
    ].join('\n'));
  }
  const dec = findJarDecompiler(decompilerPath);
  if (!dec) {
    throw new Error([
      t('没找到 cfr.jar（Java 反编译器）。', 'cfr.jar not found (the Java decompiler).'),
      t('完全版内置了一份（vendor/cfr.jar）；直接跑引擎的话可以下 cfr.jar 放到 ' + path.join(os.homedir(), '.code-atlas', 'cfr.jar') + '，或用 --decompiler <路径> 指定。', 'The full edition has it bundled (vendor/cfr.jar); running the engine directly, download cfr.jar into ' + path.join(os.homedir(), '.code-atlas', 'cfr.jar') + ', or pass --decompiler <path>.'),
    ].join('\n'));
  }
  notes.push(t(`反编译工具：${path.basename(dec)} + ${java.label}${java.bundled ? '（自带）' : ''}`, `Decompiler: ${path.basename(dec)} + ${java.label}${java.bundled ? ' (bundled)' : ''}`));
  fs.mkdirSync(workDir, { recursive: true });
  // 注意用找到的那个 java（以前这里写死了 'java'，自带运行时形同虚设）
  // JVM 编码参数：让 **JVM 内部**（cfr 自己的输出 / 异常信息）走 UTF-8。
  // 注：java.exe 启动器的早期报错（jar 打不开之类）不归它管，那段靠 `dec()` 按 GBK 兜（实测过）。
  const jvmEnc = [
    '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
    '-Dsun.stdout.encoding=UTF-8',
    '-Dsun.stderr.encoding=UTF-8',
  ];
  const r = run(java.cmd, [...jvmEnc, '-jar', dec, jar, '--outputdir', workDir, '--silent', 'true']);
  if (r.status !== 0) throw new Error(t(`反编译 .jar 失败：${String(r.stderr || r.stdout || '').slice(0, 400)}`, `Decompiling the .jar failed: ${String(r.stderr || r.stdout || '').slice(0, 400)}`));
  notes.push(t(`反编译 ${path.basename(jar)} → ${countFiles(workDir, '.java')} 个 .java`, `Decompiled ${path.basename(jar)} → ${countFiles(workDir, '.java')} .java files`));
  return workDir;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {string} o.target        目标：目录 / .dll / .exe / .jar
 * @param {string} o.outDir        输出目录（默认 dist）
 * @param {string} o.work          反编译产物放哪（默认 ingest/<名字>）
 * @param {string} o.lang          scan 的语言
 * @param {string} o.dll           目录场景下限定要反编译的程序集（glob）
 * @param {string} o.decompiler    .jar 场景下的反编译器路径
 * @param {string} o.facets        分组规则文件
 */
export async function ingest(o) {
  if (!o.target) throw new Error(t('用法：atlas ingest <目录|.dll|.exe|.jar>', 'Usage: atlas ingest <dir|.dll|.exe|.jar>'));
  const target = path.resolve(o.target);
  if (!fs.existsSync(target)) throw new Error(t(`目标不存在：${target}`, `Target not found: ${target}`));
  const stat = fs.statSync(target);
  const baseName = stat.isDirectory() ? path.basename(target) : path.basename(target).replace(/\.[^.]+$/, '');
  const workDir = path.resolve(o.work || path.join('ingest', baseName));
  const notes = [];

  // 选中的是单个源码文件（比如直接点了 Loc.cs）：没有"单文件扫描"这个概念，就扫它所在目录，并明说
  if (!stat.isDirectory()) {
    const oneLang = languageForExt(path.extname(target).toLowerCase());
    if (oneLang) {
      const dir = path.dirname(target);
      notes.push(t(`目标是单个源码文件（${oneLang.label}）：${path.basename(target)}`, `Target is a single source file (${oneLang.label}): ${path.basename(target)}`));
      notes.push(t(`改为扫描它所在的目录：${dir}`, `Scanning its directory instead: ${dir}`));
      const q = autoFacets(path.basename(dir), o.facets);
      if (q.note) notes.push(q.note);
      const res = await scanToDisk({ roots: [dir], outDir: o.outDir, lang: o.lang, facets: q.facets, maxKb: o.maxKb, incremental: o.incremental, ingest: { original: target, tool: null, sourceDir: dir, notes } });
      return { bundle: res.bundle, out: res.out, original: target, tool: null, sourceDir: dir, notes };
    }
  }

  if (stat.isDirectory() && hasSource(target)) {
    notes.push(t('目录里已有可扫源码，跳过反编译', 'Directory already has source to scan — skipping decompilation'));
    const res = await scanToDisk({ roots: [target], outDir: o.outDir, lang: o.lang, facets: o.facets, maxKb: o.maxKb, incremental: o.incremental, ingest: { original: target, tool: null, sourceDir: target, notes } });
    return { ...res, sourceDir: target, tool: null, notes, original: target };
  }

  let sourceDir;
  let tool;
  if (target.toLowerCase().endsWith('.jar')) {
    tool = 'cfr/vineflower';
    sourceDir = decompileJar(target, workDir, notes, o.decompiler);
  } else {
    let assemblies = null;
    if (stat.isDirectory()) {
      assemblies = pickAssemblies(target, o.dll, baseName);
      if (assemblies.length) {
        tool = 'ilspycmd';
      } else {
        // 目录里可能只有单文件发行版
        const exes = listExes(target);
        const exact = exes.find((e) => path.basename(e, '.exe').toLowerCase() === baseName.toLowerCase());
        const pick = exact || exes[0];
        if (pick && !looksManaged(pick)) {
          tool = 'sfextract + ilspycmd';
          sourceDir = decompileBundle(pick, workDir, notes);
        }
      }
    } else if (looksManaged(target)) {
      assemblies = [target];
      tool = 'ilspycmd';
    } else {
      // 单个原生宿主 exe：单文件发行版
      tool = 'sfextract + ilspycmd';
      sourceDir = decompileBundle(target, workDir, notes);
    }

    if (!sourceDir && assemblies) sourceDir = decompileAssemblies(assemblies, workDir, notes);
    if (!sourceDir) {
      const dlls = (() => { try { return fs.readdirSync(target).filter((n) => n.toLowerCase().endsWith('.dll')); } catch { return []; } })();
      const nativeDlls = dlls.filter((n) => !looksManaged(path.join(target, n))).length;
      throw new Error([
        t(`没有什么可以分析的：${target}`, `Nothing to analyze here: ${target}`),
        t('目录里既没有源码，也没有可反编译的程序集。', 'This directory has neither source code nor assemblies we can decompile.'),
        nativeDlls ? t(`注意：这里能找到 ${nativeDlls} 个 .dll，但它们都不是 .NET 程序集（原生 C/C++ 编译），反编译工具也读不出结构。`, `Note: there are ${nativeDlls} .dll files here, but none is a .NET assembly (native C/C++ builds) — decompilers cannot read structure out of them.`) : '',
        t('办法：① 指向源码目录；② 指向 .dll（.NET 的）；③ 指向 .exe（.NET 单文件发行版会自动解包，需 sfextract）；④ --dll "App*.dll" 指定。', 'What to do: (1) point at a source directory; (2) point at a .NET .dll; (3) point at a .exe (.NET single-file bundles are unpacked automatically); (4) use --dll "App*.dll".'),
        t('注意：原生可执行文件 / 安装目录（C/C++ 编译，比如多数游戏与启动器）反编译不了。', 'Note: native executables / installed-app directories (C/C++ builds — most games and launchers) cannot be decompiled.'),
        t('例外：Unity 游戏的 <游戏名>_Data\\Managed\\*.dll 是 .NET 程序集，可以直接指它。', 'Exception: in Unity games, <GameName>_Data\\Managed\\*.dll are .NET assemblies — point straight at one.'),
      ].filter(Boolean).join('\n'));
    }
  }

  const q = autoFacets(stat.isDirectory() ? baseName : path.basename(target).replace(/\.[^.]+$/, ''), o.facets);
  if (q.note) notes.push(q.note);
  const res = await scanToDisk({ roots: [sourceDir], outDir: o.outDir, lang: o.lang, facets: q.facets, maxKb: o.maxKb, incremental: o.incremental, ingest: { original: target, tool, sourceDir, notes } });
  return { ...res, sourceDir, tool, notes, original: target };
}
