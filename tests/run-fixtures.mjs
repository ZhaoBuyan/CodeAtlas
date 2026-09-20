/**
 * 语言回归测试：把 tests/fixtures/<语言>/ 下的样例扫一遍，检查抽取结果。
 *   node tests/run-fixtures.mjs
 *
 * 目的：Java / Python / Kotlin / Lua 这些本机没有项目的语言，靠样例保证配置是对的；
 * 以后改 languages.mjs 或扫描器，跑一下就看出有没有退化。
 */
import { EXTRA_CASES } from './fixtures-cases2.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
// 注意：在 Chatbox 里跑时 process.execPath 指向 Chatbox.exe（Electron），不是真 node。
// 所以一律用 PATH 里的 node。
const NODE = process.env.NODE_BIN || 'node';

/**
 * 每个语言单独起一个进程扫描。
 * 原因：同一个进程里装多了语法包会崩（全 19 门上连跑是时好时坏，12 门能出结果但退出必崩）。
 * 门数越少越稳，而真实项目一般 1~3 门语言 —— 隔离进程既贴合实际、也更稳。
 * 注意：别拿“19 门能跑完”当结论，那是侥幸（实测同一条命令 4 次全崩）。
 */
function scanOne(dir, lang, rootAbs, extra = []) {
  const srcDir = rootAbs || path.join(HERE, 'fixtures', dir);
  const outDir = path.join(HERE, '.out', dir);
  try {
    execFileSync(NODE, [
      path.join(ROOT, 'src', 'cli.mjs'), 'scan', srcDir,
      '--lang', lang, '--out', outDir, ...extra,
    ], { stdio: 'pipe' });
  } catch (e) {
    // 有的语法包在进程退出时会崩（bundle 已经写好），只要产物在就算成功
    const p = path.join(outDir, 'bundle.json');
    if (!fs.existsSync(p)) throw e;
  }
  return JSON.parse(fs.readFileSync(path.join(outDir, 'bundle.json'), 'utf8'));
}

// ---- git 热度用例的两个根目录 ----
// 必须现造：tests/fixtures/ 里的目录**永远在 CodeAtlas 自己的仓库里**，
// 拿它当“非 git 目录”会读到父仓库的 git 信息，当“git 仓库”也只能看到父仓库的历史。
const TMPROOT = path.join(os.tmpdir(), `codeatlas-fixtures-${process.pid}`);
const GIT_FIXTURE = path.join(TMPROOT, 'git-heat');
const PLAIN_FIXTURE = path.join(TMPROOT, 'no-git');
const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
function makeGitFixture() {
  fs.rmSync(GIT_FIXTURE, { recursive: true, force: true });
  fs.mkdirSync(GIT_FIXTURE, { recursive: true });
  fs.writeFileSync(path.join(GIT_FIXTURE, 'a.js'), 'function alpha(x) { return x + 1; }\n');
  fs.writeFileSync(path.join(GIT_FIXTURE, 'b.js'), 'function beta(y) { return y * 2; }\n');
  git(GIT_FIXTURE, ['init', '-q']);
  git(GIT_FIXTURE, ['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', 'add', '.']);
  git(GIT_FIXTURE, ['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', 'commit', '-qm', 'first']);
  // 第二次提交只碰 a.js（加一行注释，类型数不变）—— 于是 a.js 改动 2 次、b.js 1 次
  fs.appendFileSync(path.join(GIT_FIXTURE, 'a.js'), '\n// touched again\n');
  git(GIT_FIXTURE, ['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', 'add', 'a.js']);
  git(GIT_FIXTURE, ['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', 'commit', '-qm', 'second']);
  // c.js 写了但没提交 —— 图里要能看出来它是“未提交”
  fs.writeFileSync(path.join(GIT_FIXTURE, 'c.js'), 'function gamma(z) { return z; }\n');
}
function makePlainFixture() {
  fs.rmSync(PLAIN_FIXTURE, { recursive: true, force: true });
  fs.mkdirSync(PLAIN_FIXTURE, { recursive: true });
  fs.writeFileSync(path.join(PLAIN_FIXTURE, 'solo.js'), 'function solo(x) { return x; }\n');
}
makeGitFixture();
makePlainFixture();

const CASES = [
  {
    dir: 'csharp',
    lang: 'csharp',
    types: 10,
    names: ['Animal', 'Dog', 'IWalker', 'Mood', 'Point', 'Nested', 'Size', 'FileOnlyHelper', 'WithPrimaryCtor', 'MultiLineDoc'],
    kinds: { class: 6, interface: 1, enum: 1, record: 2 },
    extends: ['Dog -> Animal', 'WithPrimaryCtor -> Animal'],
    importsMin: 2,
    docs: 3,
    // 回归：多行 /// 块必须整块进来（tree-sitter 把 /// 的每行各算一个 comment 节点，
    // 只取最近那行时，以 </summary> 收尾的块会变成空壳 —— MuSync 上实测丢过 25 个类型的说明）
    docContains: { MultiLineDoc: ['第一段在这里', '第二段也要在', '在这里。第二段也要在', '空格——就像'] },
    // 回归：分节线不算“说明”（Dog 上方是 `── 分节线 ──`、IWalker 上方是 `── 接口 ────────`）
    docNull: ['Dog', 'IWalker'],
    memberSigs: [
      // 参数表 + 返回类型（C# 的返回类型在 returns 字段上，无参方法也要拿到 "()"）
      ['Animal', 'Greet', '(string tone, int times): string'],
      ['IWalker', 'Walk', '(): void'],
      // 属性：类型来自 type 字段（`Name: string`，没有参数表）
      ['Animal', 'Name', ': string'],
    ],
    membersMin: 7,
    errorsMax: 0, // 主构造函数 / file 修饰符 / 原始字符串都要能被预处理掉
  },
  {
    dir: 'typescript',
    lang: 'typescript',
    types: 7,
    names: ['Shape', 'Figure', 'Circle', 'Id', 'Kind', 'helper', 'Base'],
    kinds: { interface: 1, class: 3, type: 1, enum: 1, function: 1 },
    extends: ['Circle -> Figure', 'Figure -> Base'],
    importsMin: 1,
    docs: 2,
    memberSigs: [['Figure', 'scale', '(k: number)'], ['Shape', 'area', '(): number']],
    // 顶层函数是**类型**（不是成员）：JS/TS 的参数表挂在类型自己身上
    typeSigs: [['helper', '(a: number)']],
    membersMin: 4,
    errorsMax: 0,
  },
  {
    dir: 'tsx',
    lang: 'tsx',
    types: 3,
    names: ['Button', 'Panel', 'PanelProps'],
    kinds: { function: 1, class: 1, interface: 1 },
    importsMin: 1,
    docs: 1,
    typeSigs: [['Button', '({ label }: { label: string })']],
    membersMin: 1,
    errorsMax: 0, // JSX 能解析干净才说明 tsx 语法挂对了
  },
  {
    // .vue：只解析 <script> / <script setup>（模板、样式不看），语法借 TSX；行号必须指回 .vue 原文
    // CRLF 与“开始标签跨行”是两个容易翻车的 case，都在这里断言
    dir: 'vue',
    lang: 'vue',
    types: 7,
    names: ['Props', 'greet', 'pretty', 'crlfFn', 'fromSetup', 'double'],
    kinds: { interface: 1, function: 5, module: 1 },
    docs: 1,
    typeSigs: [['greet', '(name: string): string'], ['double', '(n: number): number']],
    errorsMax: 0,
    typeLines: [
      ['greet', 'Comp.vue', 11],
      ['pretty', 'Comp.vue', 15],
      ['crlfFn', 'Crlf.vue', 6], // CRLF 文件：行号不能漂
      ['double', 'MultiTag.vue', 9], // 开始标签跨行：不能按行切
      ['fromSetup', 'Dual.vue', 6],
    ],
  },
  {
    // monorepo：packages/ 是 pnpm / yarn workspaces / lerna / Nx 的源码根，不能再当构建目录跳过
    dir: 'monorepo',
    lang: 'javascript',
    types: 2,
    names: ['startApp'],
    filesMin: 2,
  },
  {
    // 锁文件：即使勾了 json，机器生成的锁文件也不该进图（这里还有一条 files=1 的硬断言）
    dir: 'lockfile',
    lang: 'auto,json',
    types: 1,
    names: ['compute'],
    files: 1,
  },
  {
    dir: 'javascript',
    lang: 'javascript',
    types: 3,
    names: ['Widget', 'make', 'Base'],
    kinds: { class: 2, function: 1 },
    extends: ['Widget -> Base'],
    importsMin: 1,
    docs: 1,
    typeSigs: [['make', '(x)']],
    membersMin: 2,
    errorsMax: 0,
  },
  {
    dir: 'java',
    lang: 'java',
    types: 6,
    names: ['Shape', 'Circle', 'Drawable', 'Color', 'Point', 'Nested'],
    kinds: { class: 3, interface: 1, enum: 1, record: 1 },
    extends: ['Circle -> Shape'],
    importsMin: 1,
    docs: 1,
    memberSigs: [['Circle', 'compareTo', '(Circle other): int'], ['Shape', 'area', '(): double']],
    typeSigs: [['Point', '(int x, int y)']], // record 主构造函数也挂在类型上
    membersMin: 4,
    errorsMax: 0,
    namespace: 'fixture.sample',
  },
  {
    dir: 'python',
    lang: 'python',
    types: 3,
    names: ['Animal', 'Dog', 'sample'],
    kinds: { class: 2, module: 1 },
    extends: ['Dog -> Animal'],
    importsMin: 2,
    docs: 2, // docstring
    memberSigs: [['Animal', 'eat', '(self, food)'], ['Animal', 'speak', '(self)']],
    membersMin: 4,
    errorsMax: 0,
  },
  {
    dir: 'kotlin',
    lang: 'kotlin',
    types: 4,
    names: ['Shape', 'Circle', 'Registry', 'Color'],
    kinds: { class: 3, object: 1 },
    extends: ['Circle -> Shape'],
    importsMin: 1,
    docs: 1,
    memberSigs: [['Registry', 'register', '(s: Shape)'], ['Shape', 'area', '(): Double']],
    membersMin: 4,
    errorsMax: 0,
    namespace: 'fixture.sample',
  },
  {
    dir: 'lua',
    lang: 'lua',
    types: 1,
    names: ['sample'],
    kinds: { module: 1 },
    docs: 0,    membersMin: 2,
    errorsMax: 0,
  },
  {
    // git 热度：现造的仓库（见上面 makeGitFixture）——a.js 被两次提交碰过、b.js 一次、c.js 没提交过
    dir: 'git-heat',
    rootAbs: GIT_FIXTURE,
    lang: 'javascript',
    types: 3,
    files: 3,
    errorsMax: 0,
    gitChanges: { 'a.js': 2, 'b.js': 1 },
    gitUntracked: ['c.js'],
  },
  {
    // 非 git 目录：不该带 files[].git（不是“全 0”，而是“不知道”）
    dir: 'no-git',
    rootAbs: PLAIN_FIXTURE,
    lang: 'javascript',
    types: 1,
    files: 1,
    errorsMax: 0,
    gitNone: true,
  },
  {
    // 自选跳过：atlas.ignore（目录 + 通配 + 注释 + 一条 ! 例外）+ 可选 .gitignore
    dir: 'ignore-rules',
    lang: 'javascript',
    skipRules: {
      absent: ['ingest/inner.js', 'skip.gen.js'],
      present: ['keep.js', 'legacy/old.js'],
      absentWithGitignore: ['legacy/old.js'],
    },
  },
];

const results = [];
for (const c of [...CASES, ...EXTRA_CASES]) {
  const b = scanOne(c.dir, c.lang, c.rootAbs);
  const checks = [];
  const push = (ok, msg) => checks.push({ ok, msg });

  if (c.gitChanges != null || c.gitUntracked != null || c.gitNone) {
    const withGit = b.files.filter((f) => f.git);
    if (c.gitNone) push(withGit.length === 0, `非 git 目录不该带 files[].git（带了 ${withGit.length} 个）`);
    else {
      push(withGit.length === b.files.length, `每个文件都带 files[].git（${withGit.length}/${b.files.length}）`);
      const neg = withGit.filter((f) => typeof f.git.lastDaysAgo === 'number' && f.git.lastDaysAgo < 0);
      push(neg.length === 0, `lastDaysAgo 没有负数（负数 ${neg.length} 个）`);
      for (const [p, n] of Object.entries(c.gitChanges || {})) {
        const f = b.files.find((x) => x.path === p);
        const got = f && f.git ? f.git.changes : '（没有 git 字段）';
        push(!!f && f.git && f.git.changes === n, `${p} 改动次数 ${got}（期望 ${n}）`);
      }
      if (c.gitUntracked) {
        const got = b.files.filter((f) => f.git.untracked).map((f) => f.path).sort().join(', ');
        const want = [...c.gitUntracked].sort().join(', ');
        push(got === want, `未提交的文件：${got || '（无）'}（期望 ${want || '（无）'}）`);
      }
    }
  }

  if (c.types != null) push(b.totals.types === c.types, `类型数 ${b.totals.types}（期望 ${c.types}）`);
  if (c.files != null) push(b.files.length === c.files, `文件数 ${b.files.length}（期望 ${c.files}）`);
  if (c.filesMin != null) push(b.files.length >= c.filesMin, `文件数 ${b.files.length}（期望 ≥ ${c.filesMin}）`);
  if (c.typeLines) {
    for (const [name, file, line] of c.typeLines) {
      const t = b.types.find((x) => x.name === name);
      const got = t ? b.files[t.file].path : '';
      push(!!t && got.endsWith(file) && t.line === line, `${name} 的行号（${file}:${line}）`, t ? `${got}:${t.line}` : '没找到这个类型');
    }
  }
  if (c.names) {
    const got = new Set(b.types.map((t) => t.name));
    const missing = c.names.filter((n) => !got.has(n));
    push(missing.length === 0, missing.length ? `缺类型：${missing.join(', ')}` : `类型齐全（${c.names.length} 个）`);
  }
  if (c.kinds) {
    const got = {};
    for (const t of b.types) got[t.kind] = (got[t.kind] || 0) + 1;
    const bad = Object.entries(c.kinds).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${k}=${got[k] || 0}(期望${v})`);
    push(bad.length === 0, bad.length ? `类别不符：${bad.join(' ')}` : '类别正确');
  }
  if (c.extends) {
    const got = new Set(b.edges.filter((e) => e.kind === 'inherit').map((e) => `${b.types[e.from].name} -> ${b.types[e.to].name}`));
    const missing = c.extends.filter((x) => !got.has(x));
    push(missing.length === 0, missing.length ? `缺继承边：${missing.join(', ')}（现有 ${[...got].join(', ') || '无'}）` : `继承边正确（${c.extends.length} 条）`);
  }
  if (c.importsMin != null) {
    const n = b.files.reduce((a, f) => a + f.imports.length, 0);
    push(n >= c.importsMin, `import 条数 ${n}（期望 ≥ ${c.importsMin}）`);
  }
  // 自选跳过：atlas.ignore（存在才生效）+ 可选 .gitignore（--gitignore 才读）
  if (c.skipRules) {
    const files = b.files.map((f) => f.path);
    for (const p of c.skipRules.absent) push(!files.includes(p), `atlas.ignore 生效：${p} 不在图里`);
    for (const p of c.skipRules.present) push(files.includes(p), `${p} 还在图里`);
    const sk = b.stats.skipped || {};
    push((sk.ignoreSources || []).includes('atlas.ignore'), `规则来源进报告：${JSON.stringify(sk.ignoreSources)}`);
    push((sk.projectDirs || {})['ingest'] >= 1, `项目规则跳过的目录进报告：${JSON.stringify(sk.projectDirs || {})}`);
    push(sk.ignoreNegations === 1, `! 例外被计数：${sk.ignoreNegations}`);
    const b2 = scanOne(c.dir, c.lang, null, ['--gitignore']);
    const files2 = b2.files.map((f) => f.path);
    for (const p of c.skipRules.absentWithGitignore) push(!files2.includes(p), `--gitignore 生效：${p} 不在图里`);
    push((b2.stats.skipped.ignoreSources || []).includes('.gitignore'), `--gitignore 来源进报告：${JSON.stringify(b2.stats.skipped.ignoreSources)}`);
  }
  if (c.docs != null) {
    const n = b.types.filter((t) => t.doc).length + b.types.reduce((a, t) => a + (t.memberList || []).filter((m) => m.d).length, 0);
    push(n >= c.docs, `说明条数 ${n}（期望 ≥ ${c.docs}）`);
  }
  if (c.docContains) {
    for (const [name, parts] of Object.entries(c.docContains)) {
      const t = b.types.find((x) => x.name === name);
      const doc = (t && t.doc) || '';
      const missing = parts.filter((p) => !doc.includes(p));
      push(missing.length === 0, missing.length
        ? `${name} 的说明缺内容：${missing.join(' / ')}（实际 ${JSON.stringify(doc.slice(0, 60))}）`
        : `${name} 多行说明整块提取（${parts.length} 段都在）`);
    }
  }
  if (c.docNull) {
    for (const name of c.docNull) {
      const t = b.types.find((x) => x.name === name);
      const actual = t && t.doc ? ` —— 实际拿到 ${JSON.stringify(t.doc.slice(0, 40))}` : '';
      push(!!t && !t.doc, `${name} 没有说明（分节线不算说明）${actual}`);
    }
  }
  if (c.membersMin != null) {
    const n = b.types.reduce((a, t) => a + Object.values(t.members).reduce((x, y) => x + y, 0), 0);
    push(n >= c.membersMin, `成员数 ${n}（期望 ≥ ${c.membersMin}）`);
  }
  // 成员签名（参数表 + 返回类型）：同名重载靠它才分得开。
  // 注意：没抽到就什么都不写——所以断的是"含某个片段"，不是"等于"
  const sigOf = (x) => `${x.p || ''}${x.r ? `: ${x.r}` : ''}`;
  if (c.memberSigs) {
    for (const [owner, member, frag] of c.memberSigs) {
      // 同名类型可能有多个（Rust 的 `struct Circle` 与 `impl Circle` 就是两个）：全都找一遍
      const hits = b.types.filter((x) => x.name === owner)
        .flatMap((x) => (x.memberList || []).filter((m) => m.n === member));
      push(hits.some((m) => sigOf(m).includes(frag)),
        `${owner}.${member} 的签名含 "${frag}"（实际 ${hits.map(sigOf).join(' | ') || '（没这个成员）'}）`);
    }
  }
  // 类型自己的签名：JS/TS 的顶层函数、C#/Java 的 record 主构造函数都在这一档
  if (c.typeSigs) {
    for (const [name, frag] of c.typeSigs) {
      const t = b.types.find((x) => x.name === name);
      push(Boolean(t) && sigOf(t).includes(frag), `${name} 的签名含 "${frag}"（实际 ${t ? sigOf(t) || '（空）' : '（没这个类型）'}）`);
    }
  }
  if (c.errorsMax != null) {
    push(b.totals.parseErrors <= c.errorsMax, `解析异常 ${b.totals.parseErrors} 处（期望 ≤ ${c.errorsMax}）`);
  }
  if (c.namespace != null) {
    const got = new Set(b.types.map((t) => t.ns));
    push(got.has(c.namespace), `命名空间 ${[...got].join(', ')}（期望含 ${c.namespace}）`);
  }
  results.push({ dir: c.dir, checks });
}

// 现造的夹具用完就收（true 忽略删不掉的情况）
try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { /* 忽略 */ }

let failed = 0;
for (const r of results) {
  const bad = r.checks.filter((c) => !c.ok);
  failed += bad.length ? 1 : 0;
  console.log(`${bad.length ? '✗' : '✓'} ${r.dir.padEnd(11)} ${bad.length ? '' : '全部通过'}`);
  for (const c of (bad.length ? bad : r.checks)) console.log(`    ${c.ok ? '·' : '✗'} ${c.msg}`);
}
console.log(`\n${results.length - failed}/${results.length} 门语言通过`);
// 用 exitCode 而不是 process.exit()：后者会丢掉还没落盘的 stdout（重定向到文件/管道时很坑）
process.exitCode = failed ? 1 : 0;
