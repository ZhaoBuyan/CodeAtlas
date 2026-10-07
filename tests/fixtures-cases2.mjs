/**
 * 第二批语言的 fixture 期望值（由 tests/.dump-expect.mjs 实测得出，不是我猜的）。
 * 单独放一个文件：run-fixtures.mjs 里那批是第一二批混着的，这样加语言只动这里。
 *
 * 说明：Go / Rust / C / C++ / Scala 的顶层函数会落到扫描器合成的 module 节点上，
 *       所以类型数里通常含一个 module。
 */
export const EXTRA_CASES = [
  {
    // Protobuf（2026-09-25 新加）：package / message / enum / service / 嵌套 message / import。
    // 实测要点（`工作文档\样本库\probe-any.mjs`，零 ERROR）：
    //   · 名字在 message_name / enum_name / service_name / rpc_name 上（没有 `name` 字段）→ 钩子；
    //   · `package atlas.widget.v1;` 节点文本是**整串**，命名空间要取 `full_ident`（专用钩子
    //     `namespaceNameOf` —— `nameOf` 已经被类型/成员占了）；
    //   · `import "widget.proto";` → import（引号里就是路径）；
    //   · 类型引用是 `message_or_enum_type`（`atlas.widget.v1.Widget`）→ 跨文件边是 import 档。
    dir: 'proto',
    lang: 'proto',
    types: 6,                                   // 2 message + 1 嵌套 message + 2 service + 1 enum
    names: ['Widget', 'Nested', 'Kind', 'WidgetService', 'Order', 'OrderService'],
    kinds: { message: 3, service: 2, enum: 1 },
    importsMin: 2,                              // widget.proto 的 timestamp + order.proto 的 widget.proto
    docs: 0,
    membersMin: 8,                              // 字段 + 枚举值 + rpc
    edgeWeights: [
      // 按**限定名**写：带包名的语言里简单名（Widget / Kind）会跨包撞
      ['atlas.widget.v1.WidgetService', 'atlas.widget.v1.Widget', 'ref', 6],
      ['atlas.shop.v1.Order', 'atlas.widget.v1.Widget', 'ref', 2],   // 跨文件（import 档）：字段 + rpc 返回类型
      ['atlas.widget.v1.Widget', 'atlas.widget.v1.Kind', 'ref', 2],
    ],
    errorsMax: 0,
  },
  {
    // R（2026-09-25 新加）：函数 / 参考类 / library 导入 / 跨文件引用。
    // 这门语法**没有**专门的函数与类节点（实测，见 profile 里 rKindOf/rNameOf/rMembersOf 的说明）：
    //   `f <- function(...)` 是 binary_operator(<-) 套 function_definition（name 字段是字面量
    //   `function`，不能当名字）；类走 `Widget <- setRefClass("Widget", …)`。
    // 钉三件事：① 函数/类的名字取**左边**那个 identifier；② 块级 `名字 <- function` 才算成员
    // （`w <- 值` 不许混进成员）；③ `source("widget.R")` 要变成 import，跨文件调用连成边。
    dir: 'r',
    lang: 'r',
    types: 4,                                   // class Widget + 三个 function
    names: ['Widget', 'make_widget', 'format_widget', 'show_all'],
    kinds: { class: 1, function: 3 },
    importsMin: 2,                              // library(stats) + source("widget.R")
    docs: 0,
    membersMin: 1,                              // Widget 的 describe
    edgeWeights: [
      ['show_all', 'make_widget', 'ref', 1],    // 跨文件调用（source 进来的）
      ['show_all', 'format_widget', 'ref', 1],
      ['make_widget', 'Widget', 'ref', 1],      // `Widget$new(...)` → 类引用
    ],
    errorsMax: 0,
  },
  {
    // PowerShell（2026-09-25 新加）：class / function / 参数 / 跨文件命令调用。
    // 这门语言的节点名全是实测出来的（`工作文档\样本库\probe-pwsh.mjs`）：
    //   · 类型 = class_statement / function_statement；
    //   · 成员 = class_property_definition（field）/ class_method_definition（method）；
    //   · 参数 = script_parameter（**不在通用参数表名单里**，不声明就一个成员都列不出来）；
    //   · 属性名带 `$`（`$Name`）、参数名带类型注解（`[string]$Name`）→ nameOf 钩子剥掉；
    //   · 依赖：跨文件靠**命令名**（`Get-Widget`），静态 import 是 `Import-Module -Name X`；
    //     `using namespace …` 在这门语法里是 `command` 节点（不是 using_statement）。
    dir: 'powershell',
    lang: 'powershell',
    types: 4,                                   // class Widget + 三个 function
    names: ['Widget', 'Get-Widget', 'Format-Widget', 'Show-All'],
    kinds: { class: 1, function: 3 },
    importsInclude: ['Pester'],
    importsMin: 1,
    docs: 0,
    membersMin: 6,
    // 成员名要**干净**：属性不带 `$`、参数不带 `[type]` 与默认值
    memberSigs: [['Widget', 'Describe', ''], ['Get-Widget', 'Size', '']],
    edgeWeights: [
      ['Show-All', 'Get-Widget', 'ref', 1],      // 跨文件命令名调用
      ['Show-All', 'Format-Widget', 'ref', 1],
      ['Get-Widget', 'Widget', 'ref', 1],        // `[Widget]::new(...)` → 类引用
    ],
    errorsMax: 0,
  },
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
  {
    // 只有 `.mli`、没有同名 `.ml`（2026-09-25）：接口里的 `val` 必须能成节点。
    // 以前它**走不到建节点那条路**（`emitOnDemandValue` 只在成员分支被调用，而
    // `value_specification` 不在 ocaml profile 的 `members` 表里）→ 整个接口文件在图上隐形：
    // 没有 `CSE.fundecl` 这种节点，别的文件写 `CSE.fundecl` 只能去撞同名嵌套模块。
    // 实测 3 个真样本里这样的文件有 152 个（典型 `asmcomp/CSE.mli` —— 实现是同名但在别的目录）。
    // 这个夹具钉两头：
    //   ① `Iface.normalize` / `Iface.describe` 是节点、引用接得上；
    //   ② **没人引用**的 `Iface.unused_helper` 不许进图（按需裁剪不能因为这次改动失效）。
    // 有同名 `.ml` 时"不许出现两个同 fqn 节点"由 ocaml-cross 夹具与自检保着。
    dir: 'ocaml-iface',
    lang: 'ocaml',
    types: 4,                                   // Iface.normalize / Iface.describe + 两个合成 module
    names: ['normalize', 'describe', 'iface', 'refer'],
    kinds: { value: 2, module: 2 },
    importsMin: 0,
    docs: 0,
    membersMin: 0,
    refEdges: [
      ['refer.ml', 'Iface.normalize', true],    // 引用方 → 接口里的 val
      ['refer.ml', 'Iface.describe', true],
    ],
    errorsMax: 0,
  },
  {
    // **`external` 声明**（2026-09-25）：OCaml 标准库里一大批最常用的函数是这么声明的
    // （`external length : 'a array -> int = "%array_length"`，语法树上是独立节点类型 `external`）。
    // profile 里以前没声明它 → 这些函数**一次都没进过图**，引用成批接不上：实测某真项目
    // `Array.length` 511 条、`String.length` 346 条、`Array.make` 253 条全落在 unknown。
    // 另钉"**同一文件里同名 `external` + `let` 只留一个节点**"（`Prims.wrap`）—— 两个都留会让
    // "全名命中"挑不出唯一，实测那正是 510 条 `Array.length` 被放弃的原因。
    // 第三头：**没人引用**的 external 不许进图（按需裁剪仍有效）。
    dir: 'ocaml-external',
    lang: 'ocaml',
    types: 4,                                   // Prims.len / Prims.wrap + 两个合成 module
    names: ['len', 'wrap', 'prims', 'refer'],
    kinds: { value: 2, module: 2 },
    importsMin: 0,
    docs: 0,
    membersMin: 0,
    refEdges: [
      ['refer.ml', 'Prims.len', true],
      ['refer.ml', 'Prims.wrap', true],         // 同名 external + let → 合并成一个节点，引用仍要接上
    ],
    errorsMax: 0,
  },
  // ---------------------------------------------------------------------------
  // A3 局部绑定名（2026-09-25）：**类名 / 模块名与另一个文件里的局部变量同名**时，裸名不该跨文件接上去。
  // 每个夹具都是"两头钉"：负向断言（`alpha` 那条边**不存在**）+ 正向对照（`gamma` 那条边**存在**）。
  // ⚠ 负向断言在**基线（A3 之前）上实测是有边的**（工作文档\A3-局部绑定名-2026-09-25.md 有记录），
  //   所以它们是真回归门，不是"本来就接不上"的空断言。
  // ---------------------------------------------------------------------------
  {
    // Kotlin：`val alpha` 是局部绑定；`alpha` 在 b.kt 里当**类型**用（Kotlin 只采类型位置的引用，
    // 值位置的裸名 `println(alpha)` 本来就不进引用表 —— 用值位置写夹具会得到一条空断言）。
    dir: 'a3-locals-kotlin',
    lang: 'kotlin',
    types: 3,
    names: ['alpha', 'gamma', 'Beta'],
    importsMin: 0,
    docs: 0,
    membersMin: 0,
    refEdges: [['Beta', 'alpha', false], ['Beta', 'gamma', true]],
    errorsMax: 0,
  },
  {
    // PHP：`$alpha` 是 variable_name（名字在它的 name 字段里，文本带 `$`）
    dir: 'a3-locals-php',
    lang: 'php',
    types: 3,
    names: ['alpha', 'gamma', 'Beta'],
    importsMin: 0,
    docs: 0,
    membersMin: 0,
    refEdges: [['Beta', 'alpha', false], ['Beta', 'gamma', true]],
    errorsMax: 0,
  },
  {
    // Ruby：局部变量是小写 identifier，撞的是**文件合成的 module 节点**（`alpha.rb` → 节点名/ fqn `alpha.rb`）
    // —— sinatra 上被砍掉的 23 条边就是这个形状。
    dir: 'a3-locals-ruby',
    lang: 'ruby',
    types: 3,
    names: ['Gamma', 'alpha', 'Beta'],
    importsMin: 0,
    docs: 0,
    membersMin: 0,
    refEdges: [['Beta', 'alpha.rb', false], ['Beta', 'Gamma', true]],
    errorsMax: 0,
  },
  {
    // Swift：`let alpha` 在函数体里是局部（类体里的同名属性**不算**，那条闸见 profile 的 only）
    dir: 'a3-locals-swift',
    lang: 'swift',
    types: 3,
    names: ['alpha', 'gamma', 'Beta'],
    importsMin: 0,
    docs: 0,
    membersMin: 0,
    refEdges: [['Beta', 'alpha', false], ['Beta', 'gamma', true]],
    errorsMax: 0,
  },
  {
    // Scala：`val alpha` 在函数里是局部（类体里的 `val` 是属性，不算 —— 同一道闸）
    dir: 'a3-locals-scala',
    lang: 'scala',
    types: 3,
    names: ['alpha', 'gamma', 'Beta'],
    importsMin: 0,
    docs: 0,
    membersMin: 0,
    refEdges: [['Beta', 'alpha', false], ['Beta', 'gamma', true]],
    errorsMax: 0,
  },
  {
    // OCaml：`localBindings` 声明了（`let … in` 的 let_binding + 函数参数），但这条夹具钉的是
    // **OCaml 的引用采集口径**：裸值引用（`value_path` 没有 module_path）在 refFilter 那一步就被丢掉了，
    // 图上只剩限定名（`A.helper`）—— 所以 A3 的裸名过滤在 OCaml 上**本来就不会改变任何一条边**
    // （实测 ocaml-ocaml 样本 0 变化；另用两文件小样本核实过：裸 `helper 1` 连 unresolved 都不计）。
    // 断言两件事：① 限定名照旧接得上（`b.ml -> A.helper`）；② 裸名 `b.ml -> helper` 不存在。
    // 哪天真放宽了 refFilter，这条夹具会红 —— 那时要重新评估 A3 在 OCaml 上的作用面。
    dir: 'a3-locals-ocaml',
    lang: 'ocaml',
    types: 5,
    names: ['alpha', 'gamma', 'helper', 'a', 'b'],
    importsMin: 0,
    docs: 0,
    membersMin: 0,
    refEdges: [['b.ml', 'A.helper', true], ['b.ml', 'helper', false]],
    errorsMax: 0,
  },
  {
    // **JavaScript：局部绑定按「作用域」而不是按「整个文件」**（2026-10-03）。
    // 同一个文件里两个函数：
    //   · `shadowed()` 里 `const alpha` → 那个 `alpha` 是变量，**不该**跨文件接到 a.js 的 `alpha`；
    //   · `genuine()` 里没有同名局部绑定 → 那个 `alpha` 是**真引用**，**必须**接得上。
    // 第二条是这轮新增的能力：老口径（A3 第一版把局部名按**文件**记）会把最热的那批真边一起砍掉 ——
    // 仓库自扫实测就是 `src/scan.mjs` / `mcp.mjs` / `languages.mjs` 里 68 条真的 `t('中文','English')`
    // 因为同文件别处有个局部 `const t` 而整批消失（见 工作文档\作用域局部名-2026-10-03.md）。
    //   · `c.js` 的 `const { alpha } = require('./a.js')` 是 **CommonJS 导入绑定**（不是局部变量）→
    //     `viaRequire → alpha` **必须**存在。实测 oss4-graphql-tools 上被误砍的 202 条里有 166 条是这种。
    dir: 'a3-locals-javascript',
    lang: 'javascript',
    types: 5,
    names: ['alpha', 'gamma', 'shadowed', 'genuine', 'viaRequire'],
    importsMin: 1,
    docs: 0,
    membersMin: 0,
    refEdges: [['shadowed', 'alpha', false], ['genuine', 'alpha', true], ['viaRequire', 'alpha', true]],
    errorsMax: 0,
  },
  {
    // **候选①：合成文件 module 节点只在"引用方真有一条以它命名的 import"时才参与裸名匹配**（2026-10-04）。
    // 三个文件都**没有函数/类声明** → 各有一个合成 module 节点（名字 = 文件名主干，fqn = 文件路径）：
    //   · `use.js` —— `const gamma = require('./gamma')`（导入绑定）→ 裸名 `gamma` **应该**接上 `gamma.js`；
    //   · `other.js` —— 没有任何 import → 裸名 `gamma` **不该**接上（这就是 numpy 28.8% / tokio 40%
    //     那类"名字撞文件名"的错边；依据不能是"包级 import 命中了包内某个文件"）。
    dir: 'synth-module-bare',
    lang: 'javascript',
    types: 3,
    // `names` 按**类型名**比（合成节点的名字是文件名主干）；边断言按 `fqn`（= 文件路径）比，见 refEdges
    names: ['gamma', 'use', 'other'],
    kinds: { module: 3 },
    importsMin: 1,
    docs: 0,
    membersMin: 0,
    refEdges: [['use.js', 'gamma.js', true], ['other.js', 'gamma.js', false]],
    errorsMax: 0,
  },
  {
    // **泛型（类型）参数不当跨文件引用**（2026-10-04）：A3 管的是**值**局部名（参数 / 变量），
    // 类型参数漏了 —— 实测 akka 上 `class Flow[In, Out, Mat]` 的 `Out` 被接到另一个测试文件里的
    // `case class Out`（权重 292/289/237…全是错边）、netty 的 `<K, V, T>` 同形。
    // 两头钉：`Beta<alpha>` 里的 `alpha` **不该**接到 a.java 的类 `alpha`；`gamma` 照旧接得上。
    dir: 'typeparam-java',
    lang: 'java',
    types: 3,
    names: ['alpha', 'gamma', 'Beta'],
    importsMin: 0,
    docs: 0,
    membersMin: 0,
    refEdges: [['Beta', 'alpha', false], ['Beta', 'gamma', true]],
    errorsMax: 0,
  },
  {
    // **名字已被 import 绑定 → 不许回落到同名匹配**（精度轮，2026-10-04）。
    // `import org.junit.jupiter.api.alpha;` 之后裸名 `alpha` **已经有主**（绑给了那条 import，而图里没有它
    // 指向的类）→ 不该再接到 alpha.java 的类上。实测这正是 spring-boot 上 **10,751 条**错边的形状：
    // `@Test`（`import org.junit.jupiter.api.Test`）被接到另一个模块里叫 `Test` 的测试夹具类上。
    // 两头钉：`alpha` 不许接；`gamma`（没被任何 import 绑定）照旧接得上。
    dir: 'import-bound-name',
    lang: 'java',
    types: 3,
    names: ['alpha', 'gamma', 'Beta'],
    importsMin: 1,
    docs: 0,
    membersMin: 0,
    refEdges: [['Beta', 'alpha', false], ['Beta', 'gamma', true]],
    errorsMax: 0,
  },
  {
    // **局部变量身上的成员名不算跨文件引用**（精度轮，2026-10-04）：`holder.Metadata()` 里的 `Metadata`
    // 是**成员名**、不是类型引用。实测这是 efcore 上最大的一类错边（`… → Query.Metadata ×597`、
    // `→ Query.List ×662`，回源码看全是 `principalEntityBuilder.Metadata` 这种属性访问）。
    // 两头钉：`Metadata` 不许接；`gamma`（普通类型引用，前面不是点号）必须接得上。
    dir: 'member-of-local',
    lang: 'java',
    types: 3,
    names: ['Metadata', 'gamma', 'User'],
    importsMin: 0,
    docs: 0,
    membersMin: 0,
    refEdges: [['User', 'Metadata', false], ['User', 'gamma', true]],
    errorsMax: 0,
  },
  {
    // **OCaml 的 `open M` 记成 import**（精度轮 3，2026-10-04）：以前 `imports: {}` → `open` 一个都不记，
    // 于是 OCaml 的 34,000+ 条跨文件边**全落在 unique 档**（0% import 口径）——
    // 档位分不出"有 open 撑着"和"纯按名字猜"。
    // 两头钉：边照样在（refEdges），档位必须是 **import**（refTiers）—— 改前实测是 unique（反向对照过）。
    dir: 'ocaml-open',
    lang: 'ocaml',
    types: 3,
    names: ['value', 'alpha', 'beta'],
    importsMin: 1,
    docs: 0,
    membersMin: 0,
    refEdges: [['beta.ml', 'Alpha.value', true]],
    refTiers: [['beta.ml', 'Alpha.value', 'import']],
    errorsMax: 0,
  },
  {
    // **限定名全名命中 = 依据**（精度轮 4，2026-10-04）：源码里写的就是完整限定名（`Alpha.value`），
    // 命中的又是注册的全名 → 这条边与"同命名空间 / import 能指到"同级，不该落 unique 档。
    // ⚠ 与上一个夹具的区别：这里**故意不写 `open`** —— 依据完全来自限定名本身。
    // 实测：ocaml 真项目里 `Buffer.t` / `Sys.opaque_identity` / `Variables.t` 全是这种形状，
    // 改之前 17,986 条 unique 边里有 17,870 条是它。
    dir: 'ocaml-qualified',
    lang: 'ocaml',
    types: 3,
    names: ['value', 'alpha', 'beta'],
    importsMin: 0,
    docs: 0,
    membersMin: 0,
    refEdges: [['beta.ml', 'Alpha.value', true]],
    refTiers: [['beta.ml', 'Alpha.value', 'import']],
    errorsMax: 0,
  },
  {
    // **项目级 global usings 也是依据**（精度轮 5，2026-10-04）：C# 的 `using` 不只在文件里 ——
    // `*.csproj` 的 `<Using Include="X" />`（EF Core 全仓都这么写）与 `Directory.Build.props` 对**整个项目**可见。
    // 夹具：`use.cs`（ns `Gamma`）**故意不写 using**，裸写 `Widget`（在 `Alpha.Beta`）——
    // 全靠同目录 `Proj.csproj` 里那行 `<Using Include="Alpha.Beta" />`。
    // 改前实测是 unique 档（反向对照过），改后必须是 **import**。
    // 实测代价：不认它的话 efcore 一个样本有 **13,133 条**真实引用被当成"没依据"。
    dir: 'csharp-project-using',
    lang: 'csharp',
    types: 2,
    names: ['Widget', 'User'],
    importsMin: 0,
    docs: 0,
    membersMin: 0,
    refEdges: [['Gamma.User', 'Alpha.Beta.Widget', true]],
    refTiers: [['Gamma.User', 'Alpha.Beta.Widget', 'import']],
    errorsMax: 0,
  },
  {
    // **裸名必须在作用域里**（精度轮 6，2026-10-05，C#/Java）：跨命名空间、又没有任何 import 覆盖的裸名
    // 在语义上根本指不到目标（编译都过不去）→ 只能是名字巧合。
    // 夹具两头钉：`gamma.User`（**无 import**）→ 不许接；`gamma.User2`（有 `import alpha.beta.Widget`）→ 必须接、且是 import 档。
    // 反向对照过：旧引擎上 `gamma.User → alpha.beta.Widget` 是 unique 档、**存在**。
    // 实测收益：aspnetcore 一个样本砍掉 11,034 条（`Assert` 2781 · `Compiler` 627 · `IServiceCollection` 568 …全是框架名撞测试类）。
    dir: 'java-ns-scope',
    lang: 'java',
    types: 3,
    names: ['ScopeWidget', 'ScopeUser', 'ScopeUser2'],
    importsMin: 1,
    docs: 0,
    membersMin: 0,
    refEdges: [['gamma.ScopeUser', 'alpha.beta.ScopeWidget', false], ['gamma.ScopeUser2', 'alpha.beta.ScopeWidget', true]],
    refTiers: [['gamma.ScopeUser2', 'alpha.beta.ScopeWidget', 'import']],
    errorsMax: 0,
  },
  {
    // **泛型方法调用里的成员名不算引用**（精度轮 7，2026-10-05）：`e.MemberName<int>()` 里 `MemberName`
    // 包在 `generic_name` 里 —— 第 2 轮那道闸只看"前一个兄弟是不是 `.`"，于是漏了
    // （实测 efcore 上 `e.Property<int>("Id")` 就是它）。两头钉：`MemberName` 不许接；普通类型引用 `PlainType` 必须接。
    dir: 'csharp-generic-member',
    lang: 'csharp',
    types: 3,
    names: ['MemberName', 'PlainType', 'User'],
    importsMin: 0,
    docs: 0,
    membersMin: 0,
    refEdges: [['Gamma.User', 'Gamma.MemberName', false], ['Gamma.User', 'Gamma.PlainType', true]],
    errorsMax: 0,
  },
  {
    // **Rust：裸名跨文件必须有 `use`**（精度轮 7）：`ScopeWidget` 没被 use（源码里故意不写）→ 不许接；
    // `ScopePlain` 有 `use crate::alpha::ScopePlain;` → 必须接且是 import 档。
    // 实测收益：rust-analyzer 一个样本砍掉 1 万多条（`Option`/`Debug`/`Clone` 撞 `test-utils/src/minicore.rs`
    // 那份"假标准库"），tokio 1,632 条、ripgrep 148 条。
    // 顺带修了共享匹配器里一条过宽的规则：以前 `use crate::alpha::ScopePlain;` 会给 **alpha.rs 里所有节点**
    // 做依据（"去掉最后一段再比"）→ 现在要求"导入最后一段 == 目标名"（glob `::*` 例外）。
    dir: 'rust-scope',
    lang: 'rust',
    types: 3,
    names: ['ScopeWidget', 'ScopePlain', 'lib'],
    importsMin: 1,
    docs: 0,
    membersMin: 0,
    refEdges: [['lib.rs', 'ScopeWidget', false], ['lib.rs', 'ScopePlain', true]],
    refTiers: [['lib.rs', 'ScopePlain', 'import']],
    errorsMax: 0,
  },
  {
    // **import 进来的符号名也算"名字已经有主"**（精度轮 8，2026-10-05）：JS/TS/Python 以前只记 import 的
    // **路径**，于是第 1 轮那条"名字被 import 绑定 → 不许回落同名匹配"的闸对它们形同虚设
    // （实测 ant-design 的 `render` ×92 · `button` ×68、django 的 `DTModel` ×142）。
    // 夹具两头钉：`render` 来自**外部包** → 不许接 `alpha.ts::render`；`Plain` 来自 `./alpha` → 必须接且 import 档。
    dir: 'ts-import-binds',
    lang: 'typescript',
    types: 3,
    names: ['Plain', 'use', 'render'],
    importsMin: 2,
    docs: 0,
    membersMin: 0,
    refEdges: [['use', 'render', false], ['use', 'Plain', true]],
    refTiers: [['use', 'Plain', 'import']],
    errorsMax: 0,
  },
  {
    // Python 的同一条（`from elsewhere import render` / `from .alpha import Plain`）——
    // 注意 Python 里只有**类/模块**成图节点，所以夹具用类而不是函数。
    dir: 'py-import-binds',
    lang: 'python',
    types: 3,
    names: ['Plain', 'beta', 'render'],
    importsMin: 2,
    docs: 0,
    membersMin: 0,
    refEdges: [['beta.py', 'render', false], ['beta.py', 'Plain', true]],
    refTiers: [['beta.py', 'Plain', 'import']],
    errorsMax: 0,
  },
  {
    // **符号名的依据必须来自"引进了这个名字的那条 import"**（精度轮 9，2026-10-05）。
    // 关键场景：`render` 从**外部包**引入，而 `./alpha` **同目录里也有个 `render`** ——
    // 相对导入现在会（正确地）路径匹配上 alpha.ts，但不许拿它给 `render` 做依据 ✗。
    // 第 8 轮撤掉这条加严，就是因为当时相对目录导入解析不到、一严就误砍真边；
    // 第 9 轮把相对路径导入按引用方目录解析补进 importMatchesTarget 之后才敢开（读期同口径）。
    dir: 'ts-import-strict',
    lang: 'typescript',
    types: 3,
    names: ['render', 'Plain', 'use'],
    importsMin: 2,
    docs: 0,
    membersMin: 0,
    refEdges: [['use', 'render', false], ['use', 'Plain', true]],
    refTiers: [['use', 'Plain', 'import']],
    errorsMax: 0,
  },
  {
    // **Scala 的包嵌套可见**（精度轮 10，2026-10-05）：在 `package a.b.c` 里 `a.b.c.X` 与外层包直接可见，
    // 别的包必须 `import` → 档位与 C# 相同（`ns+ancestors`）。
    // 实测 akka：删掉 2,373 条（`Throwable` 531 · `config` 456 · `Map` 366 · `System` 216 ·
    // `FiniteDuration` 154 —— 源码里 `import scala.concurrent.duration._`，说明它的 `FiniteDuration`
    // 是标准库的、不是 `akka.remote` 那个 ✗）。
    // 夹具两头钉：没 import 的 `gamma.ScopeUser` 不许接、有 import 的 `gamma.ScopeUser2` 必须接且 import 档。
    dir: 'scala-ns-scope',
    lang: 'scala',
    types: 3,
    names: ['ScopeWidget', 'ScopeUser', 'ScopeUser2'],
    importsMin: 1,
    docs: 0,
    membersMin: 0,
    refEdges: [['gamma.ScopeUser', 'alpha.beta.ScopeWidget', false], ['gamma.ScopeUser2', 'alpha.beta.ScopeWidget', true]],
    refTiers: [['gamma.ScopeUser2', 'alpha.beta.ScopeWidget', 'import']],
    errorsMax: 0,
  },
  {
    // **Kotlin 没有外层包自动可见**（精度轮 10）：裸名只能同包或 import（外加 `kotlin.*` 默认导入，真身在图外）
    // → 档位与 Java 相同（`ns`）。实测 ktor：删掉 594 条（`Map` 207 · `Deprecated` 200 · `Array` 50 ✗）。
    dir: 'kotlin-ns-scope',
    lang: 'kotlin',
    types: 3,
    names: ['ScopeWidget', 'ScopeUser', 'ScopeUser2'],
    importsMin: 1,
    docs: 0,
    membersMin: 0,
    refEdges: [['gamma.ScopeUser', 'alpha.beta.ScopeWidget', false], ['gamma.ScopeUser2', 'alpha.beta.ScopeWidget', true]],
    refTiers: [['gamma.ScopeUser2', 'alpha.beta.ScopeWidget', 'import']],
    errorsMax: 0,
  },
  {
    // **Go：跨包必须写限定名**（精度轮 11，2026-10-05）—— 裸名只可能指**同包**的声明（或点导入，那也有 import 依据），
    // 所以"跨包 + 零依据"的裸名匹配只能是同名巧合 ✗（档位与 Java/Kotlin 同：`ns`）。
    // 两头钉：同包跨文件的 `gamma.Helper` **必须在**（证明没把 Go 的真边一起砍），
    // 跨包的 `alpha.ScopeWidget` **必须不在**。实测：etcd −564 · grpc-go −419 · prometheus −378 · caddy −46。
    dir: 'go-ns-scope',
    lang: 'go',
    types: 3,
    names: ['ScopeWidget', 'Helper'],
    importsMin: 0,
    docs: 0,
    membersMin: 0,
    refEdges: [['gamma/user.go', 'alpha.ScopeWidget', false], ['gamma/user.go', 'gamma.Helper', true]],
    errorsMax: 0,
  },
  {
    // **Dart：裸名跨文件必须有 `import`**（精度轮 11）—— Dart 没有"同包自动可见"，
    // 同一个库的 `part` 那条由 hasImportBacking 的 lib 组判定放行 ✓。档位与 Rust 同（`import-only`）。
    // 实测：riverpod −842 · bloc −325，全是跨库同名 ✗。
    dir: 'dart-import-scope',
    lang: 'dart',
    types: 3,
    names: ['ScopeWidget', 'Use', 'Use2'],
    importsMin: 1,
    docs: 0,
    membersMin: 0,
    refEdges: [['Use', 'ScopeWidget', true], ['Use2', 'ScopeWidget', false]],
    refTiers: [['Use', 'ScopeWidget', 'import']],
    errorsMax: 0,
  },
  {
    // **按证据距离消歧**（精度轮 13，2026-10-05）：裸名 `Widget` 有两个同名候选 ——
    // 本文件**自己 include** 的 `nsa::Widget`（**直接**依据）与只在 include **闭包**里的 `nsb::Widget`（**间接**依据）。
    // 以前"多候选都有依据"就**弃权**（旧引擎上这条边根本不存在 → 反向对照 ✓）；现在挑依据最近的那份。
    // 实测来源：sqlite `src/btree.c → src/btreeInt.h::BtShared` ×95 被聚合文件 `sqlite3.c` 挤掉而消失。
    // ⚠ 顺序教训也钉在这儿：这一步必须排在 `sameNs`/`sameRoot` **之后**（第一版放前面，
    //   把 sqlite 那 10 条 Java **同包**真解顶掉了 ✗）。
    dir: 'cpp-direct-import',
    lang: 'cpp',
    types: 4,
    names: ['Widget'],
    importsMin: 3,
    docs: 0,
    membersMin: 0,
    refEdges: [['use.cpp', 'nsa.Widget', true], ['use.cpp', 'nsb.Widget', false]],
    refTiers: [['use.cpp', 'nsa.Widget', 'import']],
    errorsMax: 0,
  },
  {
    // **TS/TSX/Vue：裸名跨文件必须有 `import`**（精度轮 14，2026-10-05 —— 用户政策"猜的边不要"）。
    // 依据：ES 模块里裸名只能是本文件声明的、或 `import` 进来的（全局只能来自 ambient 声明）。
    // 两头钉：`beta.ts` 有 import → **必须接**；`gamma.ts` 没 import → **不许接**。
    // **反向对照**：旧引擎上 `gamma.useWrong → alpha.ts::ScopeWidget` 是 `[unique]`（存在）。
    // 风险面量过：TS/JS/Vue 的 2,248 条 unique 里目标落在 `.d.ts` 的是 **0 条** ✓。
    // ⚠ `.js`（javascript profile）**故意不一起上**：非模块脚本之间共享全局是常见写法，风险另行量。
    // 实测收益：ant-design **−871** · vuejs −513 · vuetify −285 · nest −140 · graphql-tools −38，
    // 全部落在 `unique` 档、**`import` 档一条没掉** ✓。
    dir: 'ts-scope-only',
    lang: 'typescript',
    types: 3,
    names: ['ScopeWidget', 'use', 'useWrong'],
    importsMin: 1,
    docs: 0,
    membersMin: 0,
    refEdges: [['use', 'ScopeWidget', true], ['useWrong', 'ScopeWidget', false]],
    refTiers: [['use', 'ScopeWidget', 'import']],
    errorsMax: 0,
  },
  {
    // **传递 include 链算依据（只影响档位，不影响选边）**（精度轮 15，2026-10-05）：
    // `nsa::Widget` 定义在 **3 跳以外**（use.cpp → mid1.hpp → mid2.hpp → deep.hpp），
    // C/C++ 语义上"经过任意层 include 都可见" ⇒ 这条边该记 `import` 档，而不是"猜的"。
    // **反向对照**：旧引擎上这条边**存在**、但档位是 `unique` ✗。
    // ⚠ 解析仍按 ≤2 跳的闭包挑候选（换传递会丢真边：sqlite 曾丢 `btree.c → btreeInt.h::BtShared` ×95）
    // ⇒ 本轮验收硬指标是"**边集加 0 删 0**"，实测 8 个样本全部满足 ✓。
    // 实测收益：redis `import` **+366** · fmt +116 · abseil +22 · cpp-json +7 · sqlite +4（升档，抽样全是真的）。
    dir: 'cpp-deep-include',
    lang: 'cpp',
    types: 4,
    names: ['Widget', 'Widget2'],
    importsMin: 3,
    docs: 0,
    membersMin: 0,
    refEdges: [['use.cpp', 'nsa.Widget', true], ['usefar.cpp', 'nsa.Widget2', false]],
    refTiers: [['use.cpp', 'nsa.Widget', 'import']],
    errorsMax: 0,
  },
  {
    // **`.js` 上闸只对"是模块"的文件**（精度轮 16，2026-10-05）：JS 里**没有 import 的文件是全局脚本**，
    // 脚本之间共享全局是**真语义**（jQuery 插件、`window.foo = …`）✗ 不能砍；
    // 有 import 的文件就是模块，模块里裸名必须有 import ✓。
    // 两头钉：`UseScript`（脚本，没 import）→ **必须接**；`UseModule`（模块，有 import 但没引它）→ **不许接**。
    // **反向对照**：旧引擎上 `UseModule → shared.js::ScopeWidget` 是 `[unique]`（存在）✗。
    // 风险面量过：`.js` 的跨文件 unique 边 375 条 = 模块内 **171**（上闸安全 ✓）+ 脚本内 **204**（有风险 ⇒ 不判 ✓）。
    // 实测收益：rescript −78 · express −17 · graphql-js −15 · ant-design −1 · vuejs −1，**`import` 档一条没掉** ✓。
    dir: 'js-script-global',
    lang: 'javascript',
    types: 3,
    names: ['ScopeWidget', 'UseModule', 'UseScript'],
    importsMin: 1,
    docs: 0,
    membersMin: 2,
    refEdges: [['UseScript', 'ScopeWidget', true], ['UseModule', 'ScopeWidget', false]],
    errorsMax: 0,
  },
  {
    // **PHP：裸类名只解析到当前命名空间**（精度轮 17，2026-10-05）：PHP 命名空间**不可嵌套**、
    // 没有外层自动可见 ⇒ 用别的命名空间的类必须 `use` 或写全限定名（限定名走另一条路）。
    // 档位与 Java/Kotlin 相同（`ns`）。
    // 为什么 PHP 可上闸而不用担心"裸函数名回落全局"：本 profile 的 types **只发
    // class/interface/trait/enum**（没有函数节点）✓。
    // 两头钉：有 `use` 的必须接（import 档）；**同命名空间**的 `Gamma.Helper` 必须接（真边，不许砍）；
    // 没 `use` 的跨命名空间 `Alpha\Beta.ScopeWidget` 不许接。
    // **反向对照**：旧引擎上 `Gamma.ScopeUser2 → Alpha\Beta.ScopeWidget` 是 `[unique]`（存在）✗。
    // 实测收益：symfony **−330**（删 328、加 0，全部 `unique` 档、**`import` 档 0 变化** ✓）· guzzle −15 · laravel 0。
    dir: 'php-ns-scope',
    lang: 'php',
    types: 4,
    names: ['ScopeWidget', 'ScopeUser', 'ScopeUser2', 'Helper'],
    importsMin: 1,
    docs: 0,
    membersMin: 2,
    refEdges: [['Gamma.ScopeUser', 'Alpha\\Beta.ScopeWidget', true], ['Gamma.ScopeUser2', 'Alpha\\Beta.ScopeWidget', false], ['Gamma.ScopeUser2', 'Gamma.Helper', true]],
    refTiers: [['Gamma.ScopeUser', 'Alpha\\Beta.ScopeWidget', 'import']],
    errorsMax: 0,
  },
  {
    // **Zig：裸名跨文件必须有 `@import` 依据**（精度轮 18，2026-10-05）。
    // Zig 里跨文件引用**只能**先 `@import("x.zig")` 再写限定名（`alpha.ScopeWidget`，走限定名那条路）；
    // 光秃秃的裸名跨文件根本编不过 ⇒ "跨文件 + 零依据"只能是同名巧合 ✗。
    // 两头钉：`usebare.zig`（导入的是 other.zig，却裸写 ScopeWidget）→ **不许接** alpha.zig 的 ScopeWidget；
    // 同时它**导入的** other.zig 必须接（import 档 ✓，证明没把真边一起砍）。
    // **反向对照**：旧引擎上 `usebare.zig → ScopeWidget` 是 `[unique]`（存在）✗。
    // ⚠ 顺带查清"是不是没提取 import"：**不是** —— 走 `importKindOf: zigImportKind` 抓 `@import(…)`，
    //   zls 102 个 zig 文件里 78 个有 imports ✓。
    // 实测收益：`oss3-zls` 1,706 → **1,066（−640）**，全落 `unique` 档、**`import` 档 0 变化**、加 0；
    //   抽样全是撞名（字段 `arena` · 局部 `Function` · 字段 `path` · 测试里的 `A`）✓。
    dir: 'zig-import-scope',
    lang: 'zig',
    types: 6,
    names: ['ScopeWidget', 'Other'],
    importsMin: 2,
    docs: 0,
    membersMin: 0,
    refEdges: [['usebare.zig', 'ScopeWidget', false], ['usebare.zig', 'other.zig', true]],
    errorsMax: 0,
  },
  {
    // **include 名解析：同目录是"优先"不是"必须"**（精度轮 20，2026-10-05）。
    // 旧代码写成 `hit = hit.filter(同目录)` —— 一旦**没有**同目录候选就把列表**清空** ✗ ⇒ 这条 include 丢掉、
    // 那个文件进不了闭包（全语料 **70 个文件**如此 ✗，例：abseil `#include "absl/base/config.h"` 有 3 个同 stem 候选都不在
    // 引用方目录 ⇒ `absl/base/internal/cpu_detect.h` 闭包为空）。
    // 修法：同目录**有才收窄**；仍多候选时按**路径后缀**（include 是相对包含根写的）挑，再不行取**路径段数最少**的。
    // 夹具两头钉：`nsb::Widget` 在 b/thing.hpp（经 mid1.hpp **两跳可达**）→ **必须存在且 import 档**；
    // 同名的 `nsa::Widget`（a/thing.hpp，不在链上）→ **不许接**。
    // **反向对照**：旧引擎上 `use.cpp → nsb.Widget` **根本不存在**（中间那条 include 因候选被清空而断链 ✗）。
    dir: 'cpp-include-suffix',
    lang: 'cpp',
    types: 4,
    names: ['Widget'],
    importsMin: 2,
    docs: 0,
    membersMin: 0,
    refEdges: [['use.cpp', 'nsb.Widget', true], ['use.cpp', 'nsa.Widget', false]],
    refTiers: [['use.cpp', 'nsb.Widget', 'import']],
    errorsMax: 0,
  },
  {
    // **facets 的 `color` 过滤**（安全，2026-09-25）：`color` 来自仓库里的 `atlas.facets.json`，
    // 是不可信输入，而它会被前端拼进 `style="background:…"` —— 恶意仓库写
    // `"red;background-image:url(javascript:…)"` 就能在**打开页面时执行脚本**，把本地读到的
    // bundle 外传（"全本地、不上传"的承诺直接破）。
    // 引擎侧只保留**十六进制色值**与**纯字母颜色名**，被丢掉的色退回默认灰（未分类色 `#6e7681`）；
    // 前端 `safeColor()` 还有同样一道闸兜旧 bundle。
    dir: 'facets-color',
    lang: 'javascript',
    types: 4,
    names: ['One', 'Two', 'Three', 'Four'],
    importsMin: 0,
    docs: 4,
    membersMin: 0,
    facetColors: [
      ['evil', '#6e7681'],            // `red;background-image:url(javascript:…)` → 丢弃 → 退回默认灰（未分类色）
      ['evilquote', '#6e7681'],       // `#fff"onmouseover="alert(1)` → 丢弃 → 默认灰
      ['okhex', '#58a6ff'],           // 十六进制 → 原样保留
      ['okname', 'rebeccapurple'],    // 纯字母颜色名 → 原样保留
    ],
    errorsMax: 0,
  },
];
