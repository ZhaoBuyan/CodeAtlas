/**
 * 前端**颜色入口**的安全测试（2026-09-25）。
 *   node tests/probe-web-color.mjs
 *
 * 为什么需要它：`web/app.js` 里 facets 的 `color` 会拼进 `innerHTML` 的 `style="background:…"`，
 * 而这个色来自**被扫仓库里的 `atlas.facets.json`**（不可信输入）—— 恶意仓库写
 * `"red;background-image:url(javascript:…)"` 就能在打开页面时执行脚本。
 * 引擎侧（`src/scan.mjs` 的 `safeFacetColor`）已经过滤一遍，但**旧 bundle 里可能已经带着脏值**
 * （bundle.json 是可被替换的本地文件），所以前端必须自己再挡一道。
 *
 * 这里不装浏览器：把 `web/app.js` 里那三个**纯函数**（`COLOR_RE` / `safeColor` / `sysColorMap`）
 * 抠出来求值，直接对攻击串做断言；另加两条"源码形状"断言 —— 两个 `sysColors` 入口都必须走
 * `sysColorMap()`，不许有人再直接 `new Map(... s.color ...)`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'web', 'app.js');
const src = fs.readFileSync(file, 'utf8');

/** 抠出一个具名函数（从头开始配平大括号）；`const X = …` 这种单行定义另有 `lineOf` */
function fnOf(name) {
  const header = `function ${name}`;
  const i = src.indexOf(header);
  if (i < 0) throw new Error(`web/app.js 里找不到 ${header}`);
  let depth = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  throw new Error(`${header} 的大括号不配平`);
}
const lineOf = (re, what) => {
  const m = src.match(re);
  if (!m) throw new Error(`web/app.js 里找不到 ${what}`);
  return m[0];
};

const mod = new Function(
  `${lineOf(/^const COLOR_RE = .*$/m, 'COLOR_RE')}
   ${fnOf('safeColor')}
   ${fnOf('sysColorMap')}
   return { safeColor, sysColorMap };`)();
const { safeColor, sysColorMap } = mod;

let bad = 0;
const check = (ok, what) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) bad++; };

// ① 注入串一律拒绝
const ATTACKS = [
  'red;background-image:url(javascript:alert(document.domain))',
  '#fff"onmouseover="alert(1)',
  'expression(alert(1))',
  'url(#x)',
  'red}body{background:url(javascript:1)',
  'javascript:alert(1)',
  '#58a6ff;',
  'rgb(1,2,3)',
  '"',
  '',
  null,
  42,
  { toString: () => 'red' },
];
for (const a of ATTACKS) check(safeColor(a) === null, `拒绝 ${JSON.stringify(a) === undefined ? String(a) : JSON.stringify(a)}`);

// ② 合法色值放行（功能不能因为这道闸坏掉）
for (const [v, want] of [['#58a6ff', '#58a6ff'], ['#FFF', '#FFF'], ['#12345678', '#12345678'], ['red', 'red'], ['rebeccapurple', 'rebeccapurple'], ['  red  ', 'red']]) {
  check(safeColor(v) === want, `放行 ${JSON.stringify(v)}`);
}

// ③ `sysColorMap` 必须把脏色挡在表外（等价于"页面永远不会拿到它"）
const evil = 'red;background-image:url(javascript:alert(1))';
const map = sysColorMap({ facets: { systems: [{ name: 'evil', color: evil }, { name: 'ok', color: '#58a6ff' }, { name: 'nocolor' }] } });
check(![...map.values()].includes(evil), 'sysColorMap 里没有注入色');
check(map.get('ok') === '#58a6ff', 'sysColorMap 保留了合法色');
check(!map.has('nocolor'), 'sysColorMap 丢掉没有颜色的系统');

// ④ 源码形状：两个入口都走 sysColorMap()，且没有别处直接从 b.facets 取 color
const viaHelper = src.match(/state\.sysColors = sysColorMap\(b\)/g) || [];
check(viaHelper.length === 2, `sysColors 的两个入口都走 sysColorMap()（实际 ${viaHelper.length} 处）`);
check(!/state\.sysColors = new Map\(\(b\.facets/.test(src), '没有人绕过 sysColorMap 直接建表');
check(/return safeColor\(state\.sysColors\.get\(key\)\)/.test(src), 'hashColor 出口再兜一道 safeColor()');

console.log(bad ? `\n${bad} 处不通过` : '\n✓ 全部通过');
process.exitCode = bad ? 1 : 0;
