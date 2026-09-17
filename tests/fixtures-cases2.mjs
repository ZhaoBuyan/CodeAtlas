/**
 * 第二批语言的 fixture 期望值（由 tests/.dump-expect.mjs 实测得出，不是我猜的）。
 * 单独放一个文件：run-fixtures.mjs 里那批是第一二批混着的，这样加语言只动这里。
 *
 * 说明：Go / Rust / C / C++ / Scala 的顶层函数会落到扫描器合成的 module 节点上，
 *       所以类型数里通常含一个 module。
 */
export const EXTRA_CASES = [
  {
    dir: 'bash',
    lang: 'bash',
    types: 1,
    names: ['sample'],
    kinds: { module: 1 },
    importsMin: 0,
    docs: 0,
    membersMin: 4,
    errorsMax: 0,
  },
  {
    dir: 'zig',
    lang: 'zig',
    types: 3,
    names: ['Color', 'Point', 'sample'],
    kinds: { enum: 1, struct: 1, module: 1 },
    importsMin: 0,
    docs: 2,
    membersMin: 9,
    errorsMax: 0,
  },
  {
    dir: 'solidity',
    lang: 'solidity',
    types: 3,
    names: ['Shape', 'Circle', 'IThing'],
    kinds: { contract: 2, interface: 1 },
    extends: ['Circle -> Shape', 'Shape -> IThing'],
    importsMin: 1,
    docs: 1,
    membersMin: 6,
    errorsMax: 0,
  },
  {
    dir: 'ocaml',
    lang: 'ocaml',
    // 2026-09-17 起顶层 let 也能取名了 → 跟 Go/C/Rust 一样会合成一个 module 节点装上它们
    types: 4,
    names: ['color', 'point', 'Shape', 'sample'],
    kinds: { type: 2, module: 2 },
    importsMin: 0,
    docs: 2,
    membersMin: 6,
    errorsMax: 0,
  },
  // ↓ 2026-09-17 新增：下面四门的节点名都是从 tests/probe-nodes.mjs 实测出来的
  {
    dir: 'rescript',
    lang: 'rescript',
    types: 3,
    names: ['Utils', 'shape', 'sample'],
    kinds: { module: 2, type: 1 },
    importsMin: 0,
    docs: 1,
    membersMin: 2,
    errorsMax: 0,
  },
  {
    dir: 'elisp',
    lang: 'elisp',
    types: 1,
    names: ['sample'],
    kinds: { module: 1 },
    importsMin: 0,
    docs: 0,
    membersMin: 2,
    errorsMax: 0,
  },
  {
    dir: 'tlaplus',
    lang: 'tlaplus',
    types: 1,
    names: ['Sample'],
    kinds: { module: 1 },
    importsMin: 0,
    docs: 0,
    membersMin: 5,
    errorsMax: 0,
  },
  {
    dir: 'elixir',
    lang: 'elixir',
    // Elixir 全靠 profile 里的钩子（defmodule/def 在语法树里都是 call 节点）
    types: 2,
    names: ['Shape', 'Utils'],
    kinds: { module: 2 },
    importsMin: 1,
    docs: 0,
    membersMin: 4,
    errorsMax: 0,
  },
  // ⚠️ SystemRDL 暂时缺席（2026-09-17 升级时挂起）：它的 wasm 要自己用 emscripten 编，
  // 本机三条路都被网络挡住（见 ROADMAP 附录 A.12）。wasm 放进 vendor/wasm/ 后，
  // 把 languages.mjs 里那段注释掉的 profile 恢复，再把下面这个用例取消注释即可。
  // {
  //   dir: 'systemrdl',
  //   lang: 'systemrdl',
  //   // 内联的 reg/field 本来就是匿名的，显示为 (anonymous)（类型名不参与 names 校验）
  //   types: 3,
  //   names: ['my_map'],
  //   kinds: { component: 3 },
  //   importsMin: 0,
  //   docs: 2,
  //   membersMin: 2,
  //   errorsMax: 0,
  // },
  {
    dir: 'go',
    lang: 'go',
    types: 4,
    names: ['Animal', 'Dog', 'Walker', 'sample'],
    kinds: { struct: 2, interface: 1, module: 1 },
    ns: 'fixture',
    importsMin: 1,
    docs: 2,
    membersMin: 4,
    errorsMax: 0,
  },
  {
    dir: 'rust',
    lang: 'rust',
    types: 6,
    names: ['Shape', 'Circle', 'Kind', 'sample'],
    kinds: { impl: 2, trait: 1, struct: 1, enum: 1, module: 1 },
    importsMin: 1,
    docs: 2, // 样例里只有两处 ///
    membersMin: 4,
    errorsMax: 0,
  },
  {
    dir: 'c',
    lang: 'c',
    types: 3,
    names: ['Shape', 'Color', 'sample'],
    kinds: { type: 2, module: 1 },
    importsMin: 2,
    docs: 1,
    membersMin: 3,
    errorsMax: 0,
  },
  {
    dir: 'cpp',
    lang: 'cpp',
    types: 5,
    names: ['Shape', 'Circle', 'Point', 'Kind', 'sample'],
    kinds: { class: 2, struct: 1, enum: 1, module: 1 },
    extends: ['Circle -> Shape'],
    importsMin: 2,
    docs: 1,
    membersMin: 5,
    errorsMax: 0,
  },
  {
    dir: 'php',
    lang: 'php',
    types: 5,
    names: ['Shape', 'Circle', 'Drawable', 'Color', 'sample'],
    kinds: { class: 2, interface: 1, enum: 1, module: 1 },
    ns: 'Fixture',
    extends: ['Circle -> Shape'], // 接口 ShapeInterface 在别的程序集里，解析不到是正常的
    importsMin: 1,
    docs: 1,
    membersMin: 5,
    errorsMax: 0,
  },
  {
    dir: 'swift',
    lang: 'swift',
    types: 5,
    names: ['Shape', 'Circle', 'Point', 'Kind', 'sample'],
    kinds: { protocol: 1, class: 1, struct: 1, enum: 1, module: 1 },
    extends: ['Circle -> Shape'],
    importsMin: 1,
    docs: 2,
    membersMin: 4,
    errorsMax: 0,
  },
  {
    // Scala 的语法包特别大：单进程扫没问题，混在别的语言后面扫会 OOM，
    // 所以 fixture 测试一律"一门语言一个进程"（见 run-fixtures.mjs 里 scanOne）。
    // 2026-09-17 升级语法包后：新的 Scala 语法认得出 Scala 3 的 enum 了，所以多出一个 Kind（enum）——
    // 这是语法包变强的结果，不是回归（types 5 → 6）。
    dir: 'scala',
    lang: 'scala',
    types: 6,
    names: ['Shape', 'Circle', 'Registry', 'Point', 'Helper', 'Kind'],
    importsMin: 1,
    errorsMax: 2, // 语法包对 Scala 3 的部分新语法还认不全
    membersMin: 4,
  },
  {
    // Ruby（2026-09-17 加，跟着运行时升级一起）：module 当命名空间、class 当类型；
    // attr_reader/accessor 与 require/include 都走 ruby* 钩子（它们在语法树里都是 call）。
    // 文件级那两个方法（walk / helper）落在合成的 module 节点上——跟 Python / Lua 一样。
    dir: 'ruby',
    lang: 'ruby',
    types: 3,
    names: ['Shape', 'Circle', 'sample'],
    kinds: { class: 2, module: 1 },
    extends: ['Circle -> Shape'],
    importsMin: 2,     // require 'json' + include Walkable
    docs: 2,           // 类上一条注释 + initialize 上一条
    membersMin: 10,    // Shape 4 / Circle 4（含 attr_accessor 的两个）/ sample 2；写死数字，少一个就报错
    errorsMax: 0,
  },
];
