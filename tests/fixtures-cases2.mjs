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
    // `const Point = struct {…}` 里的方法参数不属于这个 const（嵌套类型要停下不往下找）
    memberSigs: [['Point', 'dist', '(self: Point): i32'], ['sample', 'helper', '(a: i32): i32']],
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
    // Solidity 的返回类型节点文本是 "returns (uint256)"，展示时要只留类型本身
    memberSigs: [['Shape', 'area', ': uint256'], ['Circle', 'radius', ': uint256']],
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
    memberSigs: [['sample', 'my-double', '(x)']],   // 参数表是函数声明里第一个 list（钩子）
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
    // 参数表藏在内层 call 里（`def area(x)` → call(def, arguments(call(area, arguments(x))))）
    memberSigs: [['Shape', 'area', '(%{kind: :circle, r: r})'], ['Utils', 'scale', '(v, k)']],
    membersMin: 4,
    errorsMax: 0,
  },
  // SystemRDL（2026-09-17 补回）：wasm 是我们自己用 emscripten 编的（见 vendor/wasm/ 与 languages.mjs 里的说明）
  {
    dir: 'systemrdl',
    lang: 'systemrdl',
    // 内联的 reg/field 本来就是匿名的，显示为 (anonymous)（类型名不参与 names 校验）
    types: 3,
    names: ['my_map'],
    kinds: { component: 3 },
    importsMin: 0,
    docs: 2,
    membersMin: 2,
    errorsMax: 0,
  },
  {
    dir: 'go',
    lang: 'go',
    types: 4,
    names: ['Animal', 'Dog', 'Walker', 'sample'],
    kinds: { struct: 2, interface: 1, module: 1 },
    ns: 'fixture',
    importsMin: 1,
    docs: 2,
    // 方法有两个 parameter_list（接收者在前），必须走 parameters 字段拿"真的那个"
    memberSigs: [['Animal', 'Name', ': string'], ['sample', 'helper', '(n int): int']],
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
    memberSigs: [['Circle', 'new', '(radius: f64): Self'], ['Shape', 'area', '(&self): f64']],   // return_type 字段
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
    // 参数表在 function_declarator 里（要往下找）；成员名不能把参数表拼进来（declarator 里取真名）
    memberSigs: [['Shape', 'name', ': char'], ['sample', 'helper', '(int a): int']],
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
    memberSigs: [['Circle', 'area', '(): double'], ['Point', 'x', ': int']],
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
    memberSigs: [['Circle', '__construct', '(float $radius)'], ['Shape', 'area', '(): float']],
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
    memberSigs: [['Circle', 'area', ': Double']],   // 夹具里的函数没有参数，只有返回类型
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
    memberSigs: [['Registry', 'register', '(s: Shape): Unit'], ['Helper', 'helper', '(a: Int): Int']],
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
    memberSigs: [['Circle', 'initialize', '(radius)'], ['sample', 'helper', '(a)']],
    membersMin: 10,    // Shape 4 / Circle 4（含 attr_accessor 的两个）/ sample 2；写死数字，少一个就报错
    errorsMax: 0,
  },
  {
    // HCL / Terraform（2026-09-17）：没有类概念，图上的节点是 block
    //（kind = resource / data / module / variable / output / locals / terraform），成员是块里的 attribute。
    // 名字取**最后一个标签**（取全地址如 aws_instance.web 会让引用侧对不上、一条边都没有——实测过）。
    dir: 'hcl',
    lang: 'hcl',
    types: 7,
    names: ['terraform', 'region', 'locals', 'web', 'ubuntu', 'network', 'ip'],
    kinds: { resource: 1, data: 1, module: 1, variable: 1, output: 1, locals: 1, terraform: 1 },
    membersMin: 13,   // 各块的 attribute 总数（实测 13）
    errorsMax: 0,
  },
  {
    // GraphQL（SDL，2026-09-17）：type / interface / union / enum / scalar / input / schema / directive 都是节点，
    // 成员是 field（参数单独算 argument）、enum 值是 value；`implements` 与 union 成员连成继承边。
    // 两个实测坑：① `implements A & B` 在语法树里是**左递归嵌套**（collectBaseNames 改成递归才拿全 A 与 B）；
    // ② `name` 是**子节点不是字段**（必须走 nameOf 钩子）；enum 值的名字还深一层。
    dir: 'graphql',
    lang: 'graphql',
    types: 12,
    names: ['schema', 'Query', 'Node', 'Timestamped', 'Post', 'User', 'Mutation', 'SearchResult', 'Role', 'DateTime', 'PostInput', 'auth'],
    kinds: { type: 4, interface: 2, schema: 1, union: 1, enum: 1, scalar: 1, input: 1, directive: 1 },
    extends: ['Query -> Node', 'Query -> Timestamped', 'Post -> Node', 'Post -> Timestamped', 'SearchResult -> Post', 'SearchResult -> User'],
    docs: 2,          // schema 上的注释 + Query 上的 description
    // 字段参数是 arguments_definition；返回类型没有字段名，靠"参数表后面那个类型节点"拿
    memberSigs: [['Query', 'latest', '(limit: Int = 10, after: String): [Post!]!']],
    typeSigs: [['auth', '(role: Role!)']],
    membersMin: 24,
    errorsMax: 0,
  },
];
