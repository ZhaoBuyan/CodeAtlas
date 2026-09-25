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
    dir: 'ocaml-cross',
    lang: 'ocaml',
    // 跨文件**值**引用（2026-09-24）：OCaml 最要紧的一类依赖 —— 函数级跨模块。
    // 模块里的值默认**不发节点**（全量会让图涨 3.6 倍、还混 8.5% 垃圾名），
    // 改成"按需候选"：只有真被限定名引用指到的值才留节点。
    // 这个夹具同时 pin 住两件事：
    //   ① `Env.normalize` 被 `use.ml` 引用 → 值节点要在、边要跨文件
    //   ② `Env.unused_local_helper` **没人引用** → 不许在图上留节点（裁剪不能静默失效）
    files: 2,
    types: 3,                                   // Env[module] + Env.normalize[value] + use.ml[module]
    names: ['Env', 'normalize', 'use'],
    kinds: { module: 2, value: 1 },
    importsMin: 0,
    docs: 0,
    membersMin: 1,
    // 名字口径：names / edgeWeights 都按 `t.name` 比（合成模块节点的 name 是去扩展名的 `use`，
    // 它的 fqn 才是 `use.ml`）；限定名的价值在 fqn，这里按简单名指代即可。
    edgeWeights: [['use', 'normalize', 'ref', 1]],
    errorsMax: 0,
  },
  {
    dir: 'ocaml',
    lang: 'ocaml',
    // 2026-09-17 起顶层 let 也能取名了 → 跟 Go/C/Rust 一样会合成一个 module 节点装上它们
    // 2026-09-24 加 Meta（模块里的 type t）与 uses_meta（引用 Meta.t），pin 住三件事：
    //   ① 模块里的类型登记成**限定名** `Meta.t`；② 模块自己的节点不能丢；③ `Meta.t` 能解析到对的类型
    types: 7,
    names: ['color', 'point', 'Shape', 'sample', 'Meta', 'uses_meta', 't'],
    kinds: { type: 4, module: 3 },
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
    // 多行 import ( … ) 的回归门（gin 实测暴露）：单行 + 括号块两种写法都要拆成**多条**目标，
    // 整块（带括号 / 引号 / 换行的字符串）一条都不许留下。
    importsMin: 3,
    importsInclude: ['os', 'fmt', 'strings'],
    importsAtomic: true,
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
    // use 树的回归门（ripgrep 实测暴露）：花括号树要展开成**每条完整路径**，
    // 别名（as _）与 self 都要处理好，且不许留下带括号的碎片。
    importsMin: 5,
    importsInclude: ['std::fmt', 'std::collections::HashMap', 'std::io::Write', 'crate::geom', 'crate::geom::area_of'],
    importsAtomic: true,
    packagesInclude: [['fixture_rust', '']],
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
  {
    // Dart（2026-09-23 新支持）：三个实测到的坑各挡一处 ——
    // ① 类名不是 `name` 字段（裸 identifier / type_identifier 子节点）→ nameOf 钩子；
    // ② 字段/构造函数/**抽象方法**都包在 declaration 里（`double area();` 也是）→ membersOf 钩子；
    // ③ 返回类型写在名字**前面**（通用现则③找的是参数表后面）→ returnTypeOf 钩子。
    dir: 'dart',
    lang: 'dart',
    types: 5,
    names: ['Shape', 'Walkable', 'Circle', 'Kind', 'sample'],
    kinds: { class: 2, mixin: 1, enum: 1, module: 1 },
    extends: ['Circle -> Shape', 'Circle -> Walkable'],
    importsMin: 1,
    importsInclude: ['dart:math'],
    importsAtomic: true,
    docs: 2,
    memberSigs: [
      ['Shape', 'area', '(): double'],      // 抽象方法：declaration → function_signature
      ['Circle', 'area', '(): double'],
      ['sample', 'helper', '(int a): int'],
      ['Circle', 'radius', ': double'],      // 字段的类型在 identifier_list 前面
    ],
    membersMin: 10,
    errorsMax: 0,
  },
  {
    // Dart 的 part/part-of 库结构（2026-09-23）：riverpod 实测里未支撑边的大头 ——
    // part 文件**不能写 import**，库的 imports 对全库可见（libImports）；同库文件互引连 import 都不需要（lib）。
    dir: 'dart-parts',
    lang: 'dart',
    files: 3,
    types: 3,
    names: ['Root', 'Widget', 'Pane'],
    kinds: { class: 3 },
    importsMin: 1,
    importsInclude: ['src/widget.dart'],
    importsAtomic: true,
    docs: 3,
    membersMin: 4,
    partLibs: {
      'lib/root.dart': { lib: 'lib/root.dart' },
      'lib/src/pane.dart': { lib: 'lib/root.dart', partOf: '../root.dart', libImports: ['src/widget.dart'] },
    },
    edgeWeights: [['Pane', 'Root', 'ref', 1], ['Pane', 'Widget', 'ref', 1]],
    errorsMax: 0,
  },
  {
    // Markdown 进图（2026-09-24）：把**标题层级**变成可查的节。
    // AI 实测把这条列为"最大的现成增量" —— `.md` 不进图时只能整份读，进了图就能按节查。
    // 这个夹具 pin 四件事：
    //   ① 每个 `#`/`##`/`###` 各是一节，名字是**标题文本**（h1 不含 `#`）
    //   ② 名字里的格式化标记要剥掉（`` `CodeAtlas.exe` `` → `CodeAtlas.exe`）
    //   ③ **无标题的 section 不造节点**（YAML frontmatter 会被包成一个空 section）
    //   ④ 代码块 / 链接里的东西**不算引用**（硬接就是噪声）
    dir: 'markdown',
    lang: 'markdown',
    types: 5,                                  // 5 个标题 = 5 节
    names: ['文档样例', '第一节', '第一节的子节', '第二节', '含格式化标记的一节'],
    kinds: { section: 5 },
    importsMin: 0,
    docs: 0,
    membersMin: 0,
    errorsMax: 0,
  },
  // ↓ 2026-09-24：语言"族"（`family`）的两道门。这一整类回归**原来没有门** ——
  //   引擎一度按"语言 id 相等"过滤跨语言解析（为灭掉 `c → ocaml` 的撞名边），
  //   把同一套模块系统里**真的依赖**一起切了：实测 ant-design 丢 3,086 条跨文件边
  //   （`tsx→ts` 2,701、`ts→tsx` 669 …）、vuetify 丢 2,522 条、abseil 丢 `cpp→c` 106 条。
  //   两个夹具各钉住一族：族**内**必须接上（下面这两条边），族**外**仍然不接。
  {
    dir: 'family-js',
    lang: 'typescript,tsx',        // 同一次扫描里放进两种语言，才测得到跨语言解析
    types: 2,
    names: ['Wheel', 'View'],
    kinds: { interface: 1, function: 1 },
    // `.tsx` 里的 `View` 引用 `.ts` 里的 `Wheel` —— 这条边就是被误伤的那一类
    edgeWeights: [['View', 'Wheel', 'ref', 1]],
    errorsMax: 0,
  },
  {
    dir: 'family-c',
    lang: 'c,cpp',
    types: 3,
    names: ['Shape', 'ShapeHolder', 'shape'],
    kinds: { type: 1, class: 1, module: 1 },
    // C++ 侧的结构体引用 C 侧定义的结构体（`.h` 会被按内容嗅探成 C 或 C++，两者共用头文件）
    edgeWeights: [['ShapeHolder', 'Shape', 'ref', 1]],
    errorsMax: 0,
  },
  {
    dir: 'family-jvm',
    lang: 'java,kotlin',
    types: 2,
    names: ['Widget', 'Panel'],
    kinds: { class: 2 },
    // Kotlin 侧引用 Java 侧定义的类 —— 同一个 JVM 类路径，混合工程里这是真依赖
    // （实测不认这条：akka 丢 `java↔scala` 6,517 条、kotlin 工程丢 `kotlin↔java` 487/233 条）
    edgeWeights: [['Panel', 'Widget', 'ref', 1]],
    errorsMax: 0,
  },
  {
    // 函子参数是**抽象前缀**（2026-09-25）：`module Make (Client : T) = … Client.t …` 里的
    // `Client` 是调用方传进来的模块，源码里没有实现 —— 让 `Client.t` 掉进后缀档，它就会黏上
    // **任何** fqn 以 `.Client.t` 结尾的候选（真项目实测：`stdlib/map.ml` 的 `Ord.t` 接到了
    // `testsuite/…/functors.ml`，真源码 → 测试目录共 **16 条**这种错边）。
    // 这一道门同时钉两头（只钉"错边没了"会把"后缀档整个被删"当成通过）：
    //   ① `uses_pair → Pair.t` **必须还在**（同文件里的真 `Pair`，后缀档还得工作）；
    //   ② `Make.t → Decoy.Client.t` **必须没有**（前缀是函子参数 → 放弃）。
    dir: 'ocaml-abstract',
    lang: 'ocaml',
    types: 9,
    names: ['t', 'Pair', 'uses_pair', 'Make', 'Decoy', 'Client'],
    kinds: { type: 5, module: 4 },
    importsMin: 0,
    docs: 0,
    membersMin: 0,
    edgeWeights: [['uses_pair', 't', 'ref', 1]],
    // 负向/正向都按**限定名**写：这个夹具里的 fqn 都带文件模块前缀（`abstract.ml` → `Abstract`）
    refEdges: [
      ['Abstract.uses_pair', 'Abstract.Pair.t', true],       // ① 同文件里的真 `Pair` —— 后缀档还得工作
      ['Abstract.Make.t', 'Abstract.Decoy.Client.t', false], // ② 前缀是函子参数 → 放弃，不许黏到 Decoy 上
    ],
    errorsMax: 0,
  },
  {
    // 文件模块里的成员 + 模块别名（2026-09-25 查出**两个真 bug**，都是"图上少边、还不报错"）：
    //   ① `fileModuleNamespace`（`lib.ml` 就是模块 `Lib`）把文件名并进节点 ns → 本文件里
    //      `module M = struct let iter … end` 的 `iter` 在图上叫 `Lib.M.iter`。裁剪"按需候选"时
    //      按"引用名是 fqn 的后缀"比，而别的文件写的是 `M.iter` / `Lib.M.iter` ——
    //      `Lib.M.iter` 确实以 `.Lib.M.iter` 结尾，但 `M.iter`（去掉文件前缀那个）不是 →
    //      真节点被当垃圾剪掉，整条真依赖直接丢。
    //   ② 模块别名 `module B = M`：`B.iter` 指右边那个模块。不认这条，限定名会掉进后缀档撞上
    //      "别人文件里同名嵌套模块"（实测 `stdlib/string.ml:30 module B = Bytes` 的 `B.create`
    //      接到了 `testsuite/…/mctest.ml` 的 `Mctest.B.create`）。
    // 钉住两头：本文件里 `B.iter` 必须接到 `Lib.M.iter`（别名接对）；
    //          跨文件 `Lib.M.iter` 必须接到（文件模块里的成员要能指到）；
    //          而 `refer.ml` 里那个同名的 `C.iter` **不许**被当成 `C` 的成员接过去。
    dir: 'ocaml-nested',
    lang: 'ocaml',
    types: 11,                                  // Lib.M / Lib.M.iter / Lib.B / via_alias / Lib.C / Lib.top + 引用的值
    names: ['M', 'B', 'C', 'iter', 'via_alias', 'via_missing_alias', 'top'],
    kinds: { module: 6, value: 5 },
    importsMin: 0,
    docs: 0,
    membersMin: 0,
    // 别名解析：`module B = M` → `B.iter` 接到 `Lib.M.iter`（同文件那一档）
    refEdges: [
      ['Lib.via_alias', 'Lib.M.iter', true],
      ['Lib.M.iter', 'Refer.C.iter', false],     // 文件模块里的成员不许被同名嵌套模块抢走
    ],
    // 两条 unresolved：`Lib.B.iter`（refer.ml 里没有别名 B）与 `C.iter`（别名右边不在图里）
    errorsMax: 0,
  },
];
