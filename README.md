# Code Atlas

把**任意源码目录**扫成一份可读的中间数据（`bundle.json`），然后用浏览器翻图。
目标：一份数据同时服务两种消费者 —— 人（探索、建立心智模型）和 AI（查询、省 token）。

形态：**CLI + 本地网页**（零上传，代码不出本机）。

## 快速开始

**方式一：启动器（日常用这个）**

双击仓库根目录的 `CodeAtlas.exe` → 把文件夹或文件拖进输入框（或点「文件夹…」「文件…」）→ 点「开跑」。

- **地图直接嵌在窗口里**（WebView2，Edge 内核）：和浏览器里看的是同一套页面、同一份观感；
- 扫描过程的日志就在地图下方（点「看日志」/「看地图」切换）；
- 「在浏览器打开」按钮留给想开第二个窗口对照的时候；
- 关窗口 = 停服务。

启动器需要机器上有 **WebView2 运行时**（Win11 自带；Win10 装了新版 Edge 也有）。没有的话不会报错，会自动用系统浏览器打开页面。

```bash
CodeAtlas.exe                                # 图形界面
CodeAtlas.exe --auto "C:/path/to/repo"       # 开窗后直接跑（可做成快捷方式）
CodeAtlas.exe --headless --path <目标> --out dist-test --log launcher-test.log   # 无界面自检
```

**方式二：命令行（零配置）**

```bash
npm install

# 把路径丢进来就行：源码目录 / 程序集 / jar 都认；完事自动开浏览器
node src/cli.mjs "C:/path/to/your/repo"
node src/cli.mjs "C:/path/to/App.dll"
```

**方式三：细分命令**

```bash
node src/cli.mjs scan   <目录...> [--out dist] [--lang auto] [--maxkb 1024] [--exclude a,b] [--facets 规则.json] [--open]
node src/cli.mjs ingest <目录|.dll|.exe|.jar> [--out dist] [--work ingest/<名>] [--dll "App*.dll"] [--decompiler cfr.jar] [--open]
node src/cli.mjs serve  [--out dist] [--port 5173]
```

- `--no-open` 不自动开浏览器；`--port` 端口被占用会自动往后找
- `--lang` 只扫指定语言：`--lang csharp` / `--lang typescript,lua`
- `--exclude` 追加要跳过的目录名（默认已跳过 node_modules / bin / obj / dist / build / target / vendor / .git 等）
- `--maxkb` 单文件大小上限

## 启动器（`CodeAtlas.exe`）

- 是个 .NET 9 WinForms 小外壳：只负责找到引擎（`node` + `src/cli.mjs`）、把路径递过去、把日志和网址给你。
- **勾选要扫的语言**：工具栏上的「语言：自动」按钮 → 弹窗勾选（23 门代码语言 + 5 种文件级格式），选完记住。默认「自动」= 所有代码语言、配置文件格式不扫。
  语言表由引擎提供（`node src/cli.mjs langs`），启动器不自己维护一份——加语言只要改 `languages.mjs`。
  选的语言写进 `launcher.config.json` 的 `Langs`（逗号分隔；空 = 自动）。注意这是**全局设置**，不跟项目走。
- 需要装了 **Node.js**（引擎是 Node 写的）；不需要 .NET SDK（但需要 .NET 9 运行时，.NET 9 SDK 自带）。
- 配置在 `launcher.config.json`（node 路径 / 端口 / 输出目录 / 上次的路径），首次运行自动生成——node 不在 PATH 里就改这个文件。
- 重新构建：`dotnet publish launcher/CodeAtlas.Launcher.csproj -c Release -o .`
- 自检（无界面跑一遍引擎，看接线对不对）：`CodeAtlas.exe --headless --path <目标> --out dist-test --log launcher-test.log`
  （加 `--extract` 可以只验证内置引擎的释放；加 `--list-langs` 只验证语言表接线）

## 打包发行（两个版本）

没有安装器，就是一个 exe，想放哪放哪。

| 版本 | 构建产物 | 体积 | 机器上要先有什么 |
| --- | --- | --- | --- |
| **完全版** | `publish-sc/CodeAtlas.exe` | 82 MB | 什么都不用装（内置 Node 24 + 引擎） |
| **精简版** | `publish-lite/CodeAtlas-lite.exe` | 4.5 MB | .NET 9 桌面运行时 + Node.js |

```bash
npm run publish        # 两个版本都出（= publish:sc + publish:lite）
npm run publish:sc     # 只出完全版
npm run publish:lite   # 只出精简版
```

原理一句话：引擎（`src` / `web` / `configs` / 28 个语法包 wasm / d3）先由 `tools/build-payload.mjs`
打成 zip，构建时作为 `<EmbeddedResource>` 整个嵌进 exe；**首次运行**解到
`%LocalAppData%\CodeAtlas\engine\<版本-包大小>\`，之后直接用，不再重复解。
完全版比精简版多出来的就是包里的 `node.exe`（88 MB）。

- 解包目录：完全版约 120 MB / 精简版约 32 MB（删掉它会自动重新释放）；
  超过 7 天没动过的旧解包目录会在下次启动时顺手清掉，免得换个版本就多留 120 MB。
- `dist/` 和 `ingest/` 落在 **exe 旁边**（引擎目录只当缓存，不往里写用户数据）。
- **更新方式：换 exe**。新 exe 的版本/包大小不同 → 自动重新释放配套引擎。
- 打包只带**我们支持的 28 门语言**的 wasm（tree-sitter-wasms 里其他 8 个不进去，省约 12 MB）。
- 第三方组件与许可证：见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)（解包目录里也放了一份）。
- 反编译工具（`ilspycmd` / `sfextract` / `cfr.jar`）**不打进包**，用到时按提示装。
- 开发模式不受影响：exe 旁边就有 `src/cli.mjs` 时（比如把 exe 放进仓库里），直接用仓库里的引擎，不碰内置的。

## 没有源码也能扫（ingest）

```bash
# .NET 程序集 -> ILSpy 反编译 -> 扫描
node src/cli.mjs ingest "bin/Release/net9.0-windows10.0.19041.0/win-x64/App.dll" --out dist-app --open

# 目录：里面有源码就直接扫；只有发行产物就按目录名找程序集
node src/cli.mjs ingest "C:/path/to/published-app" --out dist-app --dll "MyApp*.dll"

# Java jar（需要 java + cfr/vineflower）
node src/cli.mjs ingest "game.jar" --decompiler "C:/tools/cfr.jar"
```

已知限制：

- **.NET 单文件发行版（PublishSingleFile）自动解包**：需要 `dotnet tool install -g sfextract`（已接好，指个 exe 就直接出图）。没装会提示；临时办法是把压缩版单文件程序**跑一次**，宿主会解包到 `%TEMP%\.net\<应用>\<id>\`。
- .jar 需要 Java 运行时 + cfr/vineflower（`--decompiler` 指定路径，或放到 `%USERPROFILE%\.code-atlas\cfr.jar`）。
- 反编译产物没有源码注释，所以“说明”是空的；行数含语法糖展开（实测比源码高 ~6%），界面上会明确标出来。
- **编译器生成物自动识别**：形如 `<PrivateImplementationDetails>`、`_003C...`（ILSpy 转义）、`__InlineArray`、`__DisplayClass` 的类型会自动打上 `compiler-generated` 标签，反编译产物默认在界面里隐藏（可取消勾选看）。

## C# 语法预处理（反编译产物友好）

内置的 tree-sitter-c_sharp 是 2023 年版，不认 C# 11/12 部分新语法，会把整段标成 ERROR。
`src/preprocess.mjs` 在解析前做等值改写（**行号、行数不变**，字符串/注释里绝不乱动）：

| 语法 | 处理 |
| --- | --- |
| `"""..."""` 原始字符串 | 改写为 `@"..."`（`"` 双写） |
| `class Foo(...)` 主构造函数 | 去掉参数表（不影响类型/成员/继承结构） |
| `file class Foo`（C# 11 file 修饰符） | 换成 `internal` |
| `void* p`（不安全指针） | 换成 `nint`（解析等价） |
| 局部变量名叫 `required` | 改名 `required_`（只在明显是标识符的位置） |

实测：一个几万行的 C# 项目（含反编译产物）解析异常从 78 处降到 **0**。

## 给 AI 用：MCP 查询层

扫完之后，AI 不需要把源码/bundle 塞进上下文，而是**按需问一小块**：

```bash
node src/cli.mjs mcp --out dist        # stdio JSON-RPC，给 MCP 客户端连
```

提供的工具：

| 工具 | 干什么 |
| --- | --- |
| `overview()` | 项目概览：规模、系统划分、被依赖最多的符号、最大的文件 |
| `search(query, scope?, kind?)` | 按名字找符号：**默认连成员名一起搜**（搜 `OnPaint` 能找到“谁定义了这个方法”）；`scope=type\|member` 只看一边。返回 id 供后续工具用 |
| `symbol(name)` | 一个类型的全部细节：说明、文件:行、成员清单、基类、依赖数、所属系统 |
| `refs(name, in/out)` | 谁引用它 / 它引用谁（改代码前的影响面） |
| `subgraph(name, depth)` | 依赖子图（“改这里会牵连什么”） |
| `file(path)` | 一个文件的类型、导入、行数、解析异常 |

接入客户端（以 Chatbox / Claude Desktop 这类配置为例，路径用绝对路径）：

```json
{
  "mcpServers": {
    "code-atlas": {
      "command": "node",
      "args": ["C:/path/to/CodeAtlas/src/cli.mjs", "mcp", "--out", "C:/path/to/CodeAtlas/dist"]
    }
  }
}
```

两个细节：

- 输出是**紧凑文本**而不是 JSON —— 同样的问题 token 更少，AI 也更好读；
- bundle 是快照，会过时。MCP 每次调用前会查 mtime，**重新扫描过就自动换新的**，不会拿隔夜数据回答。

自检：`node tests/mcp-selftest.mjs [dist]`（用真实 stdio 协议把每个工具跑一遍）。

## 调试工具

```bash
npm test                                          # 语言 fixtures 回归（23 门，各自独立进程）
npm run probe                                     # 打印各语言 tree-sitter 实际解析出的节点名
node tests/probe-file.mjs <文件> [--lang csharp]   # 单文件探针：ERROR 在哪、哪些声明认得出来
node tests/probe-abi.mjs                           # 审计哪些语法包能用 / 用不了
node tests/probe-grammars.mjs [--release] [--gc]   # 语法包内存探针（多语法包崩在哪儿，逐行落盘）
node src/cli.mjs langs [--json]                    # 看支持哪些语言（--json 给程序读）
```

## 界面能干什么

- **分组方式**（左侧）：系统 / 模块（按规则）· 目录 · 命名空间 · **文件** · 平铺。
- **分组层级**：1/2/3/4 层或全部 —— 层级越深，分组越细，色块和分组数跟着变多（目录/命名空间分组专用）。
- **着色**：**按文件**（默认，颜色多、同文件的类型同色）· 按分组（系统分组时用规则里配的颜色）· 按类型类别。颜色由色相 hash 生成，不限于 10 色，同一项每次打开都是同一颜色。
- **视图**：树形图（面积）· 树状列表（可折叠、带比例条）· **依赖图（力导向）** · **依赖矩阵（模块间）**
  - **依赖图**：点和线看“谁和谁连在一起”；点大小=代码量、颜色跟着色方式；拖动调位、滚轮缩放、悬停高亮邻居；节点超过 120 个时自动隐藏无依赖的、超过 400 个只画连接最多的（顶部会写明）
  - **依赖矩阵**：行/列=当前分组（目录/系统…），格子颜色深浅=两个组之间的依赖条数，对角线=组内耦合；抬头直接告诉你“耦合最紧的是 A → B（N 条）”
- **面积代表**：代码行 / 总行数 / 复杂度 / 成员数 / fanIn。
- **着色**：按分组（系统配色来自规则文件）或按类型类别。
- **下钻**：点分组名、边框或左侧图例 → 只看这一组；面包屑返回。
- **说明**：从源码注释（C# 的 `/// summary`、Java/TS 的块注释）抽出来的说明，**类型级和成员级都抽**，显示在检查器和悬停提示里；注释与声明之间必须只有空行（否则会被判成上一个声明的注释）；没有注释会明说"源码里没有注释说明"，不编。
- **依赖高亮**：悬停或选中一个类型，会立刻把它引用了谁、被谁引用提亮，并用连线指出来（引用边蓝线、继承边橙线，线粗=次数），其余色块压暗。
- **依赖聚焦**（勾选框）：只看选中类型 + 它的关联项，关系网本身变大变清楚（左上角会提示还在显示多少个）。
- **抬头一行**写着当前图表的编码含义（分组方式/层级/面积代表什么/怎么着色），选中时还显示该类型的引用计数；边指向当前分组之外时也会提示。
- **检查器**：类型详情 + 说明 + 文件:行（可复制）+ 成员 + 被谁引用 / 引用了谁（可点击跳转，会自动回到能看到它的分组）。
- **筛选**：类型类别勾选 · **语言勾选**（本次扫到的语言，只列实际存在的；只有一种语言时这个面板不出现）· 最小代码行滑块（滤掉小碎片）。
- **搜索（类型 + 成员）**：输入框连**成员名**一起搜（例：搜 `OnPaint` 能找到“谁定义了这个方法”，连 `OnPaintBackground` 这种带前缀的也命中）；命中成员时结果里会写清“命中成员 X（method）· 文件:行”和“命中类型名”的区别。搜索内容本身也在 permalink 里（`q=`）。
- **permalink**：视图状态在地址栏（`#by=&v=&g=&t=&m=&c=&q=&l=`，`v=graph`/`v=matrix` 可直接分享依赖图/矩阵，`q=`/`l=` 分享搜到的词和语言筛选），可分享、可复现。

## 分组规则（facets）

"按系统 / 模块看"靠一份规则文件，默认按顺序自动找：

1. `--facets <文件>` 指定
2. `<扫描根>/atlas.facets.json`
3. 本项目 `configs/<扫描目录名>.facets.json`

```json
{
  "exclude": ["third_party"],
  "systems": [
    { "name": "界面层", "color": "#f778ba", "files": ["*Form.cs"] },
    { "name": "业务模块", "color": "#58a6ff", "paths": ["Modules/**", "Services/**"] },
    { "name": "工具与基础设施", "color": "#bc8cff", "paths": ["Utils/**"], "namespaces": ["YourApp.Utils*"] }
  ]
}
```

- 规则按顺序匹配，**第一条命中生效**；没命中的进 `(未分类)`。
- `paths` / `files` / `namespaces` 都是 glob（`**` 跨层级），匹配对象 = 文件相对路径 / 文件名 / 命名空间 / 完整限定名。
- `exclude` 追加要跳过的目录（在默认忽略表之外）。

## bundle 结构（schema `code-atlas/1`）

| 字段 | 内容 |
| --- | --- |
| `source` | 扫描根、文件数、**版本戳**（git commit + 是否有未提交改动；非 git 时用时间戳）、扫描耗时 |
| `languages` | 每种语言的文件数 / 行数 |
| `files[]` | 路径、语言、LOC / 代码 / 注释 / 空行、导入列表、所属命名空间 |
| `types[]` | 名称、`fqn`、类别、命名空间、`dir`、`system` + `systemRule`（命中的分组规则）、**`doc`**（源码注释里的说明）、文件 + 行号、LOC、成员统计与列表、基类、复杂度、fanIn / fanOut |
| `namespaces` | 包树（含自底向上的汇总：行数 / 类型数） |
| `edges[]` | 类型级依赖边：`ref`（引用）/ `inherit`（继承）+ 权重 |
| `nsEdges[]` | 命名空间级依赖边（给包依赖图用） |
| `unresolved` | 名字解析失败的计数（unknown / ambiguous）——**置信度信号** |
| `facets` | 系统分组结果：用了哪个规则文件、每个系统的类型数 / 行数 / 文件数、未分类计数 |

## 设计原则

1. **结构 = 解析结果，依赖 = 统计推断**。类型 / 成员 / LOC 来自 tree-sitter 语法树，可信；引用边来自标识符匹配，会漏会错，界面上明确标注，不假装一样权威。
2. **带版本戳**。bundle 记下源头 commit 和生成时间，人和 AI 都能知道这是哪一版的数据。
3. **本地优先**。源码不出本机，bundle 也在本地；工具只处理数据，不分发任何被扫代码。
4. **引擎与宿主解耦**。引擎只产出 `bundle.json`；浏览器 / 未来的 MCP / 编辑器扩展都是消费者，换宿主不动引擎。

## 协议

MIT（见 [LICENSE](LICENSE)）。

## 支持读什么（输入）

| 你给它什么 | 它做什么 | 状态 |
| --- | --- | --- |
| **目录（有源码）** | 直接扫；多语言混排一次扫完 | ✅ |
| **单个源码文件** | 没有"单文件的图"这回事，会扫它**所在的目录**并告知 | ✅ |
| **.dll / .exe（.NET 程序集）** | ILSpy 反编译成 .cs 再扫 | ✅ 实测 |
| **.exe（.NET 单文件发行版）** | sfextract 解包 → 反编译 → 扫 | ✅ 实测 |
| **目录（只有发行产物）** | 按目录名找程序集；也可 `--dll "App*.dll"` 指定 | ✅ |
| **.jar（Java）** | 需 Java 运行时 + cfr/vineflower（`--decompiler` 指定） | ⚠️ 已实现未实测 |

文字说明：启动器里拖文件夹进来，或者把 `.dll / .exe / .jar` 拖进来都行，**不用告诉它这是哪种**。

### 认识的语言（23 门代码语言）

| 语言 | 后缀 | 状态 |
| --- | --- | --- |
| C# | `.cs` | ✅ 实测（一个 54 文件 / 106 类型的项目） |
| TypeScript | `.ts` `.mts` `.cts` | ✅ 实测（一个 114 文件 / 367 类型的项目） |
| TSX | `.tsx` | ✅ 实测（JSX 必须用单独的 tsx 语法） |
| JavaScript | `.js` `.mjs` `.cjs` `.jsx` | ✅ 实测 |
| Java | `.java` | ✅ fixtures 回归 |
| Python | `.py` | ✅ fixtures（含 docstring） |
| Kotlin | `.kt` `.kts` | ✅ fixtures |
| Lua | `.lua` | ✅ fixtures（无类型声明 → 合成 module 节点） |
| Go | `.go` | ✅ fixtures（struct / interface 区分） |
| Rust | `.rs` | ✅ fixtures（trait/struct/enum/impl） |
| C | `.c` `.h` | ✅ fixtures（typedef 不重复计数） |
| C++ | `.cpp` `.cc` `.cxx` `.hpp` `.hxx` | ✅ fixtures（含继承） |
| PHP | `.php` | ✅ fixtures（class/interface/trait/enum + extends/implements） |
| Swift | `.swift` | ✅ fixtures（class/struct/enum/protocol 分开认） |
| Scala | `.scala` `.sc` | ✅ fixtures（class/object/trait） |
| Shell | `.sh` `.bash` `.zsh` | ✅ fixtures（无类型 → module 节点） |
| Zig | `.zig` | ✅ fixtures（const X = struct/enum） |
| Solidity | `.sol` | ✅ fixtures（contract/interface + 继承） |
| OCaml | `.ml` `.mli` | ✅ fixtures（module/type；顶层 let 会合成 module 节点） |
| ReScript | `.res` | ✅ fixtures（module / type / variant） |
| TLA+ | `.tla` | ✅ fixtures（module + operator / variable） |
| SystemRDL | `.rdl` | ✅ fixtures（addrmap / reg / field；内联匿名组件显示为 `(anonymous)`） |
| Emacs Lisp | `.el` | ✅ fixtures（无类型概念 → 顶层函数/变量挂在合成的 module 节点上） |

**目前用不了的**（我们的运行时锁在 tree-sitter 0.20.8，它们的语法包要求更新的 ABI）：`Dart`、`Ruby`、`Elm`、`QL`。
`Vue` 单文件组件、`Objective-C`（`.m` 与 MATLAB 扩名冲突）、`Elixir`（语法全部用 call 表达，通用提取器不好区分）暂未支持，原因已记录。
审计命令：`node tests/probe-abi.mjs`（把每个语法包真解析一遍，分清能用 / 用不了）。

**文件级格式（默认不开，要看就显式指定）**：`JSON` `.json` · `YAML` `.yaml .yml` · `TOML` `.toml` · `CSS` `.css` · `HTML` `.html .htm` —— 这些没有"类型"可言，只会以文件为单位出现在图上（合成 module 节点）：

```bash
node src/cli.mjs scan ./repo --lang auto,json,yaml   # 代码语言 + JSON/YAML
node src/cli.mjs scan ./repo --lang json,yaml        # 只看配置文件
node src/cli.mjs scan ./repo --lang cs               # 只看 C#
```

**语法包内存与“分进程解析”**：每门 tree-sitter 语法包一加载就常驻约 150–180 MB，而且 `web-tree-sitter` 0.20.8 **没有释放接口**（`Parser.delete()` 无效、`Language.delete` 不存在、手动 GC 也没用 —— 都实测过，见 `tests/probe-grammars.mjs`）。所以同进程里装十几门就是 GB 级：扫描中途会 OOM、退出阶段（V8 析构）必崩。
注意这**不是“内存不够”**：本机 Node 能分配到 50 GB+ 才叫不够。

**所以扫描是这么跑的**：父进程只负责收集文件 / 建索引 / 写 bundle，**每门语言的解析都在自己的子进程里做**（每个子进程只装一门语法包）。

- 内存峰值 = 一门（约 200 MB），不再随语言数叠加上去；
- 某个子进程挂掉，只丢那一门（报告里会明说），其余语言照常进地图；
- 父进程不装 wasm，所以**退出干净、退出码正确** —— Swift/Scala 那类“退出时崩”也一并消失；
- 代价：多几次进程启动（每门约 0.2 s）。

调这个可以用：`npm run probe:mem`（语法包内存探针，逐行落盘）。

**测试过的语法包共 32 个**（用哪个就加 profile，一般 5~10 行）：
`bash c c_sharp cpp css elisp elixir go html java javascript json kotlin lua objc ocaml php python rescript rust scala solidity swift toml tsx typescript vue yaml zig` 等。
**用不了的有 4 个**：`dart`（需要 ABI 15，当前运行时锁在 0.20.8）、`ruby`、`elm`、`ql`（加载即崩）。要支持它们得先升级 tree-sitter 运行时。

加一门语言 = 在 `src/languages.mjs` 加一份 profile（节点类型 + 继承字段 + 复杂度分支表），
再往 `tests/fixtures/<语言>/` 丢一个样例、在 `tests/run-fixtures.mjs` 写期望值，然后 `npm test`。
节点名拿不准就先跑 `npm run probe`（打印 tree-sitter 实际解析出的节点名，别猜）。

**没有类型声明的文件**（脚本、顶层函数、Lua 模块）会自动合成一个 `module` 节点，
免得整份文件在图上消失；它的成员（函数/变量）挂在模块节点下。

### 默认跳过什么

- **目录**：`.git` `.svn` `node_modules` `bin` `obj` `dist` `build` `out` `target` `vendor` `packages` `.vs` `.vscode` `.idea` `.venv` `__pycache__` `coverage` `.next` `.nuxt` `publish*`；
- **文件**：`*.min.js` `*.d.ts` `*.g.cs` `*.designer.cs` `*.generated.cs/ts` `*.freezed.dart`；
- **单个文件 > 1MB**（`--maxkb` 可调）；
- **项目规则里写的**：`facets.json` 的 `exclude` 可以追加要忽略的目录（比如上游参考代码）。

### 读不了什么（边界，说清楚）

1. **没支持的语言**（Vue / Dart / Ruby / Elm / QL …）会被跳过，但**不是静默忽略**——报告和界面上都会写「未支持语言 N 个文件（.rb 2 · .dart 1 …）」；
   还有一种容易误会的：「我们支持、但这次没在扫描范围内」的文件（没勾那门语言，或者 JSON/YAML 这类默认不扫的格式），会单独报成「**语言范围外** N 个文件没扫」，不会被算成“不支持”；
2. **反编译产物**：没有源码注释（所以"说明"是空的）、行数比源码高（语法糖被展开）、会多出编译器生成物（已自动打标签并在界面默认隐藏）；
3. **静态分析的边界**：反射、动态 `import`、拼字符串调出来的方法**拿不到**；依赖边是名字匹配级别的，重名符号会误连（界面标着 unknown / ambiguous 计数）；
4. **不读**：二进制资源、图片、配置文件内容、运行时行为、git 历史。

## 路线

细的排期和当前进度在仓库根目录的 `ROADMAP.md`（本文件只写功能本身）。

- [x] v1：CLI 扫描 + 本地网页（树形图 / 树状列表 / 检查器 / permalink）
- [x] 分组层：系统规则（facets 配置）+ 目录 / 命名空间 / 平铺
- [x] MCP server（搜符号 / 找引用 / 导出子图），给 AI 用
- [x] 语言覆盖：23 门代码语言 + 5 种文件级格式
- [x] 依赖图视图（力导向）+ 包级依赖矩阵
- [x] 启动器里勾选要扫的语言（界面 + `--lang`）
- [x] 搜索增强：类型名 + 成员名（web 与 MCP 都支持）· 地图内按语言过滤
- [x] 打包：完全版（内置 Node）/ 精简版（要求系统 Node）两个单文件 exe，不做安装器
- [ ] 首次运行向导 · 增量扫描 · AI 接口补强（MCP 配置一键复制 / token 预算导出 / 影响面分析）
