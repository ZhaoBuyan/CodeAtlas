/**
 * 语言回归测试：把 tests/fixtures/<语言>/ 下的样例扫一遍，检查抽取结果。
 *   node tests/run-fixtures.mjs
 *
 * 目的：Java / Python / Kotlin / Lua 这些本机没有项目的语言，靠样例保证配置是对的；
 * 以后改 languages.mjs 或扫描器，跑一下就看出有没有退化。
 */
import { EXTRA_CASES } from './fixtures-cases2.mjs';
import fs from 'node:fs';
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
function scanOne(dir, lang) {
  const outDir = path.join(HERE, '.out', dir);
  try {
    execFileSync(NODE, [
      path.join(ROOT, 'src', 'cli.mjs'), 'scan', path.join(HERE, 'fixtures', dir),
      '--lang', lang, '--out', outDir,
    ], { stdio: 'pipe' });
  } catch (e) {
    // 有的语法包在进程退出时会崩（bundle 已经写好），只要产物在就算成功
    const p = path.join(outDir, 'bundle.json');
    if (!fs.existsSync(p)) throw e;
  }
  return JSON.parse(fs.readFileSync(path.join(outDir, 'bundle.json'), 'utf8'));
}

const CASES = [
  {
    dir: 'csharp',
    lang: 'csharp',
    types: 9,
    names: ['Animal', 'Dog', 'IWalker', 'Mood', 'Point', 'Nested', 'Size', 'FileOnlyHelper', 'WithPrimaryCtor'],
    kinds: { class: 5, interface: 1, enum: 1, record: 2 },
    extends: ['Dog -> Animal', 'WithPrimaryCtor -> Animal'],
    importsMin: 2,
    docs: 2,
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
    membersMin: 1,
    errorsMax: 0, // JSX 能解析干净才说明 tsx 语法挂对了
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
];

const results = [];
for (const c of [...CASES, ...EXTRA_CASES]) {
  const b = scanOne(c.dir, c.lang);
  const checks = [];
  const push = (ok, msg) => checks.push({ ok, msg });

  if (c.types != null) push(b.totals.types === c.types, `类型数 ${b.totals.types}（期望 ${c.types}）`);
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
  if (c.docs != null) {
    const n = b.types.filter((t) => t.doc).length + b.types.reduce((a, t) => a + (t.memberList || []).filter((m) => m.d).length, 0);
    push(n >= c.docs, `说明条数 ${n}（期望 ≥ ${c.docs}）`);
  }
  if (c.membersMin != null) {
    const n = b.types.reduce((a, t) => a + Object.values(t.members).reduce((x, y) => x + y, 0), 0);
    push(n >= c.membersMin, `成员数 ${n}（期望 ≥ ${c.membersMin}）`);
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
