# Code Atlas

> English version: [README.md](README.md)

**文档地图（本仓库）**

| 文件 | 是什么 |
| --- | --- |
| [README_CN.md](README_CN.md) · [README.md](README.md) | 本文 —— 它是什么、怎么搭起来的、能做什么 / 不能做什么（参考手册） |
| [使用说明.md](使用说明.md) · [USAGE.md](USAGE.md) | **给使用者**的逐步指引：第一次跑、怎么看图、接 AI、排错 |
| [CHANGELOG.md](CHANGELOG.md) | 每个版本改了什么 |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) + [licenses/](licenses/) | 随包分发的第三方组件与许可证原文（一字未改） |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | 发版怎么走（跑测试 → 两个 exe → 打 `v*` tag 时建 Release） |

哪块看哪节：**能力与边界** → 「支持读什么（输入）」「默认跳过什么」「读不了什么」；
**MCP 那层** → 「给 AI 用」；**日常怎么用** → [使用说明.md](使用说明.md)。

把**任意源码目录**扫成一份可读的中间数据（`bundle.json`），然后用浏览器翻图。
目标：一份数据同时服务两种消费者 —— 人（探索、建立心智模型）和 AI（查询、省 token）。

形态：**CLI + 本地网页**（零上传，代码不出本机）。

## 它是什么

四条取向：

- **本地优先**：不注册、不上传、不调云服务；断网照用，代码不出机器；
- **免安装**：一个单文件 exe（完全版自带 Node 运行时），双击就用，不用装 Node、不用配环境；
- **一份数据两个消费者**：同一份 `bundle.json`，**人**用浏览器翻图（树形图 / 树状列表 / 依赖图 / 依赖矩阵），
  **AI** 用 MCP 查（9 个工具，含 token 预算导出与影响面分析）——不用为了给 AI 用再跑一遍解析；
- **诚实优先**：不确定的地方一律标注（依赖边是静态名字匹配、未匹配/歧义引用各有计数、反编译产物注明"无源码注释"），
  宁可显示"不知道"，也不假装权威。

## 灵感来源

[kolulu23/Zedema](https://github.com/kolulu23/Zedema)

## 快速开始

**方式一：启动器（日常用这个）**

双击仓库根目录的 `CodeAtlas.exe` → 把文件夹或文件拖进输入框（或点「文件夹…」「文件…」）→ 点「扫描」。

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
node src/cli.mjs serve  [--out dist] [--port 5173] [--host 0.0.0.0]   # 默认只绑 127.0.0.1
node src/cli.mjs langs                      # 看支持哪些语言（--json 给程序读）
node src/cli.mjs draft-facets <目录> [--out 规则.json]   # 按目录结构草拟一份系统分组规则
node src/cli.mjs mcp    [--out dist] [--print-config]    # 给 AI 用的 MCP 服务
```

- `--no-open` 不自动开浏览器；`--port` 端口被占用会自动往后找
- `--lang` 只扫指定语言：`--lang csharp` / `--lang typescript,lua`
- `--exclude` 追加要跳过的目录名（默认已跳过 node_modules / bin / obj / dist / build / target / vendor / .git 等）
- `--maxkb` 单文件大小上限
- 同样的命令也装成全局 CLI：`npm i -g .` → `atlas scan <目录>`（`atlas` 这个别名在 `package.json` 的 `bin` 里；不装的话 `node src/cli.mjs …` 完全等价）

## 启动器（`CodeAtlas.exe`）

- 是个 .NET 9 WinForms 小外壳：只负责找到引擎（`node` + `src/cli.mjs`）、把路径递过去、把日志和网址给你。
- **首次配置一个项目（项目设置向导）**：工具栏「项目设置…」→ 三步走完就行：
  ① 选目标（目录 / `.dll` / `.exe` / `.jar`） ② 选语言 ③ **按目录结构自动草拟一套「系统分组规则」**（可取消勾选、改名、换色）→ 保存并扫描。
  规则默认写到 `%LocalAppData%\CodeAtlas\configs\<项目名>.facets.json`（**私有**，不进你的项目）；勾上「写进项目目录」就写 `<项目>/atlas.facets.json`（跟项目走、能共享）。
  配过的项目会记住（语言 + 规则），**下次打开不再弹向导、也不用重配**（再打开 = 零操作）。
  CLI 等价物：`node src/cli.mjs draft-facets <目录> [--out 文件]`——只看目录结构、不解析代码，秒出。
- **不会再弹防火墙**：本地服务只绑 `127.0.0.1`（回环流量不走 Windows 防火墙），所以"是否允许 Node.js 通信"那个系统弹窗不会出现。
  想让局域网 / 手机也能看：`atlas serve --host 0.0.0.0`（那种情况下 Windows 正常问你一次，允许即可）。
- **两个顺手的开关**：工具栏「**增量**」勾选框（默认关＝每次全量；勾上只重新解析改过的文件）、
  「**MCP 配置**」按钮（一键把"让 AI 读这个项目"的配置复制到剪贴板——粘进客户端即可，见 [使用说明.md](使用说明.md) 第五节）。
  语言表由引擎提供（`node src/cli.mjs langs`），启动器不自己维护一份——加语言只要改 `languages.mjs`。
  选的语言写进 `launcher.config.json` 的 `Langs`（逗号分隔；空 = 自动）。注意这是**全局设置**，不跟项目走。
- **界面语言**：工具栏「增量」右边那个按钮（`界面：中文` / `UI: English`）点一下即可切，并记入 `launcher.config.json`。
  它管的面包括：启动器（运行日志 / 状态栏 / 对话框 / 报错）、引擎的扫描输出、MCP 九个工具的输出，以及网页地图。
  切语言**不需要重新扫描**（bundle 里存的是中性值，显示层按语言映射）。不开启动器的人用环境变量
  `CODEATLAS_LANG=en` 指定（环境变量优先级最高；`en` 开头就算英文）。
- 需要装了 **Node.js**（引擎是 Node 写的）；不需要 .NET SDK（但需要 .NET 9 运行时，.NET 9 SDK 自带）。
- 配置在 `launcher.config.json`（node 路径 / 端口 / 输出目录 / 上次的路径），首次运行自动生成——node 不在 PATH 里就改这个文件。
- 重新构建：`dotnet publish launcher/CodeAtlas.Launcher.csproj -c Release -o .`
- 自检（无界面跑一遍引擎，看接线对不对）：`CodeAtlas.exe --headless --path <目标> --out dist-test --log launcher-test.log`
  （加 `--extract` 可以只验证内置引擎的释放；加 `--list-langs` 只验证语言表接线）

### 内构快照 / 内构监控

启动器上那个按钮是**双态**的：点一下从「内构快照」切到「内构监控」。
监控模式下你改代码，浏览器里的图会**自己更新** —— 引擎每 1.5 秒巡检一次，发现改动就**增量重扫**
（只重新解析改动过的文件），按钮上会显示「上次更新 HH:MM」。
监控期间「扫描」会被禁用（避免两条路同时写 bundle），点「停止」会连子进程一起收掉。
**MCP 那边也跟着走**：MCP 服务会在 bundle 变化时自动重载，并在更新后的**第一个工具结果**尾部带上
「🔁 图在这次调用之前更新过……请重新查询」——AI 不会拿更新前的旧结论继续答你（这条只提示一次）。

## 打包发行（两个版本）

没有安装器，就是一个 exe，想放哪放哪。

> **官方下载**：每个版本的两个 exe 都挂在 [GitHub Releases](https://github.com/ZhaoBuyan/CodeAtlas/releases)
> （CI 从打 tag 的那个提交构建；下面表里的路径只是本地构建的产物位置）。

| 版本 | 构建产物 | 体积 | 机器上要先有什么 |
| --- | --- | --- | --- |
| **完全版** | `publish-sc/CodeAtlas.exe` | 104.3 MB | 什么都不用装（内置 Node 24 + 引擎 + 裁剪版 Java 运行时） |
| **精简版** | `publish-lite/CodeAtlas-lite.exe` | 10.1 MB | .NET 9 桌面运行时 + Node.js |

```bash
npm run publish        # 两个版本都出（= publish:sc + publish:lite）
npm run publish:sc     # 只出完全版
npm run publish:lite   # 只出精简版
```

原理一句话：引擎（`src` / `web` / `configs` / 32 个语法包 wasm / d3）先由 `tools/build-payload.mjs`
打成 zip，构建时作为 `<EmbeddedResource>` 整个嵌进 exe；**首次运行**解到
`%LocalAppData%\CodeAtlas\engine\<版本-包指纹>\`，之后直接用，不再重复解
（目录名用的是**包内容指纹**而不是大小：内容变了但大小没变时也会重新解，避得用错旧引擎）。
完全版比精简版多出来的就是包里的 `node.exe`（88 MB）和那份裁剪版 Java 运行时（约 30 MB）。

- 解包目录：完全版约 163 MB / 精简版约 45 MB（删掉它会自动重新释放）；
  不是当前版本的旧解包目录会在**每次启动**时自动清掉（只留**当前在用的 + 最近用过的那个**），免得换个版本就多留一百多 MB。
- `dist/` 和 `ingest/` 落在 **exe 旁边**（引擎目录只当缓存，不往里写用户数据）。
- **更新方式：换 exe**。新 exe 的版本 / **包内容指纹**不同 → 自动重新释放配套引擎。
- 打包只带**我们支持的 29 门代码语言 + 6 种文件级格式**的 wasm（汇总包里用不到的那些不进去）。
- 第三方组件与许可证：见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)（解包目录里也放了一份）。
- **反编译在完全版里无需安装**：扫 `.dll` / `.exe` 用链接进启动器的反编译器（ILSpy 引擎）；扫 `.jar` 用自带的裁剪版 Java 运行时 + cfr.jar —— 都不需要先装 ilspycmd / sfextract / Java。精简版不带 Java 运行时（它本来就要求 .NET 9 + Node），扫 `.jar` 仍需自己装 Java。
- 开发模式不受影响：exe 旁边就有 `src/cli.mjs` 时（比如把 exe 放进仓库里），直接用仓库里的引擎，不碰内置的。
- **发版流程**：打 tag 推上去就行 —— `git tag v1.4.0 && git push origin v1.4.0`（**推单个 tag，别用 `--tags`** ——
  那会把本地的备份 / 实验标签（`backup/*`）一起推上去）。CI 会先跑测试，
  然后打两个 exe 并挂到 GitHub Release 当下载资产（见 [.github/workflows/ci.yml](.github/workflows/ci.yml)）。
- **版本号有三个地方，必须一起改**：`launcher/CodeAtlas.Launcher.csproj` 的 `<Version>`（exe 与窗口标题显示的就是它）、
  `src/scan.mjs` 的 `VERSION`（bundle 元数据 + 增量缓存指纹）、`package.json` 的 `version`。

## 没有源码也能扫（ingest）

```bash
# .NET 程序集 -> ILSpy 反编译 -> 扫描
node src/cli.mjs ingest "bin/Release/net9.0-windows10.0.19041.0/win-x64/App.dll" --out dist-app --open

# 目录：里面有源码就直接扫；只有发行产物就按目录名找程序集
node src/cli.mjs ingest "C:/path/to/published-app" --out dist-app --dll "MyApp*.dll"

# Java jar（完全版自带运行时 + cfr；--decompiler 可覆盖）
node src/cli.mjs ingest "game.jar" --decompiler "C:/tools/cfr.jar"
```

已知限制：

- **原生可执行文件（C/C++ 编译）反编译不了**：它们没有 CLR 头，不是 .NET 程序集，里面也没有类型名 / 命名空间 / 方法签名，只有机器码；要出这种图得先反汇编成近似 C 再解释（IDA / Ghidra 那个量级的活），不在本工具的能力范围内。
  指到这类文件时会直接说明「这不是 .NET 程序集」，并列出能扫的三类。
  **例外：Unity 游戏**——`<游戏名>_Data\Managed\*.dll` 就是 .NET 程序集，直接指那个目录或那个 dll 就能扫。
- **反编译不用装东西（完全版）**：扫 `.dll` / `.exe` 用启动器**内置**的反编译器（ILSpy 引擎链接进 exe）；
  扫 `.jar` 用**自带的裁剪版 Java 运行时 + cfr**——都不需要你先去装 ilspycmd / sfextract / Java。
  精简版不带 Java 运行时（它本来就要求机器上有 .NET 9 + Node），所以扫 `.jar` 仍需自己装 Java；
  直接跑引擎（`node src/cli.mjs`）也仍是开发模式：扫 `.dll` / `.jar` 需要自己装工具。
- 反编译产物没有源码注释，所以“说明”是空的；行数含语法糖展开（实测比源码高约 6%），界面上会明确标出来。
- **编译器生成物自动识别**：形如 `<PrivateImplementationDetails>`、`_003C...`（ILSpy 转义）、`__InlineArray`、`__DisplayClass` 的类型会自动打上 `compiler-generated` 标签，反编译产物默认在界面里隐藏（可取消勾选看）。

## C# 语法（不再需要预处理了）

以前内置的 tree-sitter-c_sharp 是 2023 年版，不认 C# 11/12 的部分新语法，会把整段标成 ERROR，
所以 `src/preprocess.mjs` 会在解析前做等值改写（行号/行数不变，不碰字符串与注释）。

**2026-09-17 升级语法包后这套改写已停用**：新的 C# 语法自己就认得那些写法，实测 12 项（原始字符串、
主构造函数、`file` 修饰符、`void*`、集合表达式、`required` 成员、`scoped ref`、静态抽象成员、
lambda 默认参数、raw 插值字符串、变量名叫 `required`…）**全是 0 个 ERROR**；而旧的改写还会把名叫
`required` 的变量改成 `required_`，反而把名字弄错。`src/preprocess.mjs` 作为通用机制留在仓库里
（哪门语言的语法包又落后于语言版本时，在 profile 里加一行 `preprocess: 'xxx'` 就能重新挂上），目前没有语言用它。

## 给 AI 用：MCP 查询层

> **接入步骤（哪个按钮、各客户端粘在哪、9 个工具分别什么时候用、排错）见 [使用说明.md](使用说明.md) 第五节（英文版：[USAGE.md](USAGE.md)）。**
> 懒人版：启动器里扫一次 → 点工具栏「MCP 配置」→ 粘进 AI 客户端即可。

扫完之后，AI 不需要把源码/bundle 塞进上下文，而是**按需问一小块**：

```bash
node src/cli.mjs mcp --out dist        # stdio JSON-RPC，给 MCP 客户端连
```

> **时效提醒**：MCP 客户端不会自动重载服务器 —— 升级 CodeAtlas 后请**重启客户端**；
> 数据本身是每次调用现读的，重扫不必重连。

提供的工具：

| 工具 | 干什么 |
| --- | --- |
| `overview()` | 项目概览：规模、系统划分、被依赖最多的符号、最大的文件 |
| `list(path?, limit?)` | **按目录浏览**：不传 `path` 就列扫描根，传了就列那一层的目录 / 文件（含文件数、类型数、行数）。**还不知道任何名字时从这里起手** —— 输出里的路径和文件名可以直接喂给 `file()` / `search()` |
| `search(query, scope?, kind?)` | 按名字找符号：**默认连成员名一起搜**（搜 `OnPaint` 能找到“谁定义了这个方法”）；`scope=type\|member` 只看一边。命中带**签名**（参数表 + 返回类型），同名重载分得清。返回 id 供后续工具用 |
| `symbol(name, neighbors?)` | 一个类型的全部细节：说明、签名、文件:行、成员清单（**带参数表与返回类型**）、基类、**被引用多少次 / 引用别人多少次**、所属系统 |
| `refs(name, in/out)` | 谁引用它 / 它引用谁（改代码前的影响面）；每条边带 `×引用次数` 与证据强度。**也接受成员名或 `类型.成员`** —— 这时给的是所属类型与它的引用方（超集），**并且直接列出成员级的“调用 / 访问位置”（`file:line`，按名字匹配：同名的其它成员会混进来；声明处不算调用点）***所属类型**与它的引用方（超集），并告诉你下一步怎么找精确调用点 |
| `subgraph(name, depth)` | 依赖子图（“改这里会牵连什么”） |
| `file(path, types?)` | 一个文件的类型、导入、行数（**有解析异常时标注**）；`types:"count"` 只给计数与分类，不列名字 |
| `map(budget)` | 按 token 预算导出**骨架**（系统 → 关键类型 → 关键成员）——让 AI 先拿到全局，省 token；没配分组规则的项目会**明说**并退化成“引用最多的类型”清单 |
| `impact(name, depth)` | **影响面分析**：沿“谁引用它”多跳展开，并**单列会被波及的测试文件**（按路径认），以及说明哪些看不见（动态调用/反射） |

每个工具单次列出的条目都有上限，超了会写明「前 N / 共 M」（`search` 20 · `symbol` 成员 40 · `subgraph` 每层 40 · `list` 40 —— 用 `limit` / `members` 调大）。
每个工具结果的末尾都会挂一条**快照时间（UTC）**，所以单点调用也能看出数据新不新。

接入客户端（以 Chatbox / Claude Desktop 这类配置为例）——**启动器的「MCP 配置」按钮拷出来的就是这个形状**
（路径都是绝对路径，`command` 已经指向实际解析到的 `node.exe`，`env` 是当前界面语言）：

```json
{
  "mcpServers": {
    "code-atlas": {
      "command": "C:/path/to/node.exe",
      "args": ["C:/path/to/CodeAtlas/src/cli.mjs", "mcp", "--out", "C:/path/to/CodeAtlas/dist"],
      "env": { "CODEATLAS_LANG": "zh" }
    }
  }
}
```

> **dsh（DeepSeek Harness）用户**：不用手改 JSON —— `node src/cli.mjs mcp --print-config --client dsh`
> 会直接吐一段现成的 Cordis patch YAML（字段照官方 `@deepseek-ai/dsh-mcp-client` 示例，路径同样是绝对路径），
> 并入 `$DSH_HOME/cordis.patch.yml`（或 `profiles/<名字>/cordis.patch.yml`）即可。
> ✅ 已在本机 DSH Desktop 上**端到端验证**：patch 写进 profile 的用户 patch 层后**热加载**生效（不用重启，
> 保存后几秒 MCP 服务进程就起来了），工具以 `mcp__codeatlas__*` 注册。

四个细节：

- 输出是**紧凑文本**而不是 JSON —— 同样的问题 token 更少，AI 也更好读；
- **工具输出跟界面语言走**：拷出来的配置里带 `CODEATLAS_LANG`，所以 AI 拿到的答案和你的界面同一种语言
  （环境变量优先；删掉它就是中文）；
- bundle 是快照，会过时。MCP 每次调用前会查 mtime，**重新扫描过就自动换新的**，不会拿隔夜数据回答；
  快照戳只在**首个**非 overview 结果上打（图更新后会再打一次），后面的调用不再重复 —— 省 token；
  两次调用之间图若更新过（监控模式 / 手动重扫），**下一个工具结果尾部会带一条「🔁 图已更新、请重查」**
  （只提示一次，不刷屏）；
- **图里的文件在磁盘上变了，`overview` 会点出来**：
  `⚠ 快照后 3 个已纳入图里的文件有改动（其中 1 个仅时间戳变化）—— 未反映在图里`。
  它只把**已经纳入图里**的文件重新看一遍（不遍历目录），所以**新增**的文件它看不见 —— 但「图里有、磁盘上已经没了」
  它会点出来（`另有 N 个已不在磁盘`）；
  新增的文件要重新扫描才进图；
- **不需要的部分让调用方自己排**：`overview` / `search` / `refs` / `map` / `impact` 都接受一个可选的 `exclude`
  （逗号分隔的路径，如 `"tests/fixtures, vendor"`）。引擎不认识“你项目里哪些是样例数据 / 生成物”，
  所以这个判断交给调用方：多段项按**连续段序列**匹配、单段项按目录段或文件名主干、大小写不敏感、不做通配；
  每次调用带、用完即弃。**排除了多少当场写在名单后面**（整份被排空时写“全被排除”，不是 `0 个`），
  而「规模」这类**项目事实不受影响**。（`list` / `symbol` / `file` 不带这个参数 —— 浏览类工具加了会让人误判“这里没有”。）
- **给 AI 的说明书随仓库走**：`.dsh/skills/codeatlas/SKILL.md` —— 一页“schema 里看不到的东西”：
  开场顺序（`list` → `impact(入口函数)` → `symbol`）、别拿被引热榜当全貌、歧义名字用数字 id 直查、
  `facets` 警告与「🔁 请重查」怎么读、什么时候干脆别用图。dsh 在仓库里开会话就自动发现；其它读 SKILL.md
  的代理工具，把它拷到自己项目的 `.dsh/skills/` 或 `.agents/skills/`（或用户级同名目录）即可。

`symbol` 另有一个可选参数 **`neighbors: true`**（**默认关**）：追加「被谁引用 / 引用了谁 / 相关测试文件」三行，
各给前 5 个（抬头与 `refs` 同一个口径）；要证据标签与完整列表仍去 `refs`。不带它时输出**一个字节不变**。
- **接上就知道边界**：`initialize` 会带一段 `instructions`（这份数据怎么用、哪里不可信）；
  `overview` 的第一屏还直接给出**扫描根目录**（AI 自己拼绝对路径去读源文件用）、**数据快照**（生成时间 / 语言范围 / 单文件上限 / 是否增量）
  和**可信度前提**（依赖边是名字匹配，并报未匹配与同名歧义的数量）。

自检：`node tests/mcp-selftest.mjs [dist]`（用真实 stdio 协议把每个工具跑一遍）。

## 调试工具

```bash
npm test                                          # 语言 fixtures 回归（38 个用例，各自独立进程）
npm run probe                                     # 打印各语言 tree-sitter 实际解析出的节点名
node tests/probe-file.mjs <文件> [--lang csharp]   # 单文件探针：ERROR 在哪、哪些声明认得出来
node tests/probe-abi.mjs                           # 语法包冒烟（两个来源里的 wasm 全加载 + 全解析一遍）
node tests/probe-grammars.mjs [--release] [--gc]   # 语法包内存探针（多语法包崩在哪儿，逐行落盘）
node src/cli.mjs langs [--json]                    # 看支持哪些语言（--json 给程序读）
```

## 界面能干什么

- **分组方式**（左侧）：系统 / 模块（按规则）· 目录 · 命名空间 · **文件** · 平铺。
- **分组层级**：1/2/3/4 层或全部 —— 层级越深，分组越细，色块和分组数跟着变多（目录/命名空间分组专用）。
- **着色**：**按文件**（默认，颜色多、同文件的类型同色）· **按 git 热度**（改得越多越亮，未提交的文件带亮边框）· 按分组（系统分组时用规则里配的颜色）· 按类型类别。颜色由色相 hash 生成，不限于 10 色，同一项每次打开都是同一颜色。
- **视图**：树形图（面积）· 树状列表（可折叠、带比例条）· **依赖图（力导向）** · **依赖矩阵（模块间）**
  - **依赖图**：点和线看“谁和谁连在一起”；点大小=代码量、颜色跟着色方式；拖动调位、滚轮缩放、悬停高亮邻居；节点超过 120 个时自动隐藏无依赖的、超过 400 个只画连接最多的（顶部会写明）
  - **依赖矩阵**：行/列=当前分组（目录/系统…），格子颜色深浅=两个组之间的依赖条数，对角线=组内耦合；抬头直接告诉你“耦合最紧的是 A → B（N 条）”
- **面积代表**：代码行 / 总行数 / 复杂度 / 成员数 / fanIn。
- **下钻**：点分组名、边框或左侧图例 → 只看这一组；面包屑返回。
- **成员签名**：从语法树里抽**参数表与返回类型**（`area(int, int): double`；属性就是它的类型），
  同名重载不再长得一模一样；JS/TS 的顶层函数、`record` 主构造函数这类"类型自己带参数"的也显示在类型那一行。
  语法树里取不到就什么都不写——**空着 = 没抽到，不等于"没有参数"**。
- **说明**：从源码注释（C# 的 `/// summary`、Java/TS 的块注释）抽出来的说明，**类型级和成员级都抽**，显示在检查器和悬停提示里；注释与声明之间必须只有空行（否则会被判成上一个声明的注释）；没有注释会明说"源码里没有注释说明"，不编。
- **依赖高亮**：悬停或选中一个类型，会立刻把它引用了谁、被谁引用提亮，并用连线指出来（引用边蓝线、继承边橙线）——
  **一条引用画一根线**：A 被 B、C 各引用 3 次，就从 A 的中心散出 6 根（B 三根、C 三根），
  根数直接就是引用次数（抬头也会写“连线 N 根 = 引用次数”）；其余色块压暗。
- **依赖聚焦**（勾选框）：只看选中类型 + 它的关联项，关系网本身变大变清楚（左上角会提示还在显示多少个）。
- **抬头一行**写着当前图表的编码含义（分组方式/层级/面积代表什么/怎么着色），选中时还显示该类型的引用计数；边指向当前分组之外时也会提示。
- **检查器**：类型详情 + 说明 + 文件:行（可复制）+ 成员（**带签名：参数表 + 返回类型**）+ 被谁引用 / 引用了谁（可点击跳转，会自动回到能看到它的分组）。
- **筛选**：类型类别勾选 · **语言勾选**（本次扫到的语言，只列实际存在的；只有一种语言时这个面板不出现）· 最小代码行滑块（滤掉小碎片）。
- **搜索（类型 + 成员）**：输入框连**成员名**一起搜（例：搜 `OnPaint` 能找到“谁定义了这个方法”，连 `OnPaintBackground` 这种带前缀的也命中）；命中成员时结果里会写清“命中成员 X（method）· 文件:行”和“命中类型名”的区别。搜索内容本身也在 permalink 里（`q=`）。
- **permalink**：视图状态在地址栏（`#by=&v=&g=&t=&m=&c=&q=&l=`，`v=graph`/`v=matrix` 可直接分享依赖图/矩阵，`q=`/`l=` 分享搜到的词和语言筛选），可分享、可复现。

- **地图右下角「取消选中」**：点一下清掉选中，右侧详情跟着清空（选中项也会从网址里去掉）。
- **缩放 / 平移**：滚轮放大缩小；**右键拖动移动画布**（左键留给选中/钻取）；右下角 **「回正」**一下回到全图。
  文字会跟着一起放大。点选模块不会把倍率跳回去。
- **网页自己重载**：改了 `web/` 下的文件后，已打开的页面会自己刷新，不用手动按 F5。

## 分组规则（facets）

"按系统 / 模块看"靠一份规则文件，默认按顺序自动找：

1. `--facets <文件>` 指定
2. `<扫描根>/atlas.facets.json`
3. 本项目 `configs/<扫描目录名>.facets.json`

懒得手写？**让工具草拟一份**：启动器「项目设置…」向导的第三步，或者
`node src/cli.mjs draft-facets <目录> --out 输出.json`（只看目录结构、不解析代码，秒出；结果里有 `_comment` 说明格式，直接改就行）。

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
| `files[]` | 路径、语言、LOC（整文件）/ 代码 / 注释 / 空行、导入列表、所属命名空间、`isTest`（**按路径**认出是测试文件时才带这个键）、**`uses`**（落在**类型之外**的调用 / 访问位置，比如脚本末尾的 `main()`；只在非空时带这个键） |
| `types[]` | 名称、`fqn`、类别、命名空间、`dir`、`system` + `systemRule`（命中的分组规则）、**`doc`**（源码注释里的说明）、**`p` / `r`**（签名：参数表 / 返回类型，抽不到就没有这两个键）、文件 + 行号、LOC（该类型的区间）、成员统计与列表（**列表里每条是 `k` 类别 / `n` 名字 / `l` 行号 / `d` 说明，以及同样的 `p` / `r` 签名**）、基类、复杂度、fanIn / fanOut、**`uses`**（该类型内的**调用 / 访问位置**：`n` 名字 / `l` 行号 / `c` 1=调用 0=成员访问；只在非空时带这个键；按名字匹配，边界同 `refs`） |
| `namespaces` | 包树（含自底向上的汇总：行数 / 类型数） |
| `edges[]` | 类型级依赖边：`ref`（引用）/ `inherit`（继承）+ **权重（= 引用次数，同一个名字在同一个类型里出现几次）** |
| `nsEdges[]` | 命名空间级依赖边（给包依赖图用） |
| `unresolved` | 名字解析失败的计数（unknown / ambiguous）——**置信度信号** |
| `facets` | 系统分组结果：用了哪个规则文件、每个系统的类型数 / 行数 / 文件数、未分类计数 |

## 设计原则

1. **结构 = 解析结果，依赖 = 统计推断**。类型 / 成员 / LOC 来自 tree-sitter 语法树，可信；引用边来自标识符匹配，会漏会错，界面上明确标注，不假装一样权威。
2. **带版本戳**。bundle 记下源头 commit 和生成时间，人和 AI 都能知道这是哪一版的数据。
3. **本地优先**。源码不出本机，bundle 也在本地；工具只处理数据，不分发任何被扫代码。
4. **引擎与宿主解耦**。引擎只产出 `bundle.json`；浏览器 / 未来的 MCP / 编辑器扩展都是消费者，换宿主不动引擎。

## 支持读什么（输入）

| 你给它什么 | 它做什么 | 状态 |
| --- | --- | --- |
| **目录（有源码）** | 直接扫；多语言混排一次扫完 | ✅ |
| **单个源码文件** | 没有"单文件的图"这回事，会扫它**所在的目录**并告知 | ✅ |
| **.dll / .exe（.NET 程序集）** | 启动器**内置的反编译器**（ILSpy 的库；直接跑引擎才回退到 `ilspycmd`）→ .cs → 扫 | ✅ 实测 |
| **.exe（.NET 单文件发行版）** | 内置 SingleFileExtractor 解包 → 反编译 → 扫 | ✅ 实测 |
| **目录（只有发行产物）** | 按目录名找程序集；也可 `--dll "App*.dll"` 指定 | ✅ |
| **.jar（Java）** | 完全版 `vendor/` 里**自带裁剪版 Java 运行时 + cfr**，不需要装任何东西 → .java → 扫（精简版仍需机器上有 Java） | ✅ 实测（2.1 MB 的 jar → 732 文件 / 1,015 类型 / 9,751 条边） |
| **其它** | 原生可执行文件（C/C++/Go/Rust 编出来的 exe/dll、`.so`/`.dylib`）、压缩包（`.zip`/`.nupkg`/`.apk`）→ 明确拒绝，并告诉你它支持哪三类 | ❌ |

文字说明：启动器里拖文件夹进来，或者把 `.dll / .exe / .jar` 拖进来都行，**不用告诉它这是哪种**。

**读不了的**：原生可执行文件（C/C++ 编译出来的 exe/dll —— 很多软件、游戏本体都是这类）。
它没有 CLR 头、不是 .NET 程序集，里面也没有类型名 / 命名空间 / 方法签名这些元数据，只认机器码；
反编译只支持三类：**.NET 程序集**、**.NET 单文件发行版**、**Java .jar**（详见下面「没有源码也能扫」的已知限制）。
Unity 游戏是例外：`<游戏名>_Data\Managed\*.dll` 就是 .NET 程序集，直接指它就能扫。

### 认识的语言（29 门代码语言）

| 语言 | 后缀 | 状态 |
| --- | --- | --- |
| C# | `.cs` | ✅ 实测（一个 54 文件 / 106 类型的项目） |
| TypeScript | `.ts` `.mts` `.cts` | ✅ 实测（一个 114 文件 / 367 类型的项目） |
| TSX | `.tsx` | ✅ 实测（JSX 必须用单独的 tsx 语法） |
| Vue | `.vue` | ✅ 实测（**只解析 `<script>` / `<script setup>`**：模板与样式不参与；语法借 TSX，行号与原文对齐） |
| JavaScript | `.js` `.mjs` `.cjs` `.jsx` | ✅ 实测 |
| Java | `.java` | ✅ fixtures 回归 |
| Python | `.py` | ✅ fixtures（含 docstring） |
| Kotlin | `.kt` `.kts` | ✅ fixtures |
| Dart | `.dart` | ✅ 实测（bloc / riverpod：类名不是 `name` 字段、抽象方法包在 `declaration` 里；`package:` 入口按包对上） |
| Lua | `.lua` | ✅ fixtures（无类型声明 → 合成 module 节点） |
| Go | `.go` | ✅ fixtures（struct / interface 区分） |
| Rust | `.rs` | ✅ fixtures（trait/struct/enum/impl） |
| C | `.c` `.h` | ✅ fixtures + 实测（redis）（typedef 不重复计数；`.h` 会嗅内容：像 C++ 的头文件按 C++ 解析） |
| C++ | `.cpp` `.cc` `.cxx` `.hpp` `.hxx` | ✅ fixtures（含继承） |
| PHP | `.php` | ✅ fixtures（class/interface/trait/enum + extends/implements） |
| Swift | `.swift` | ✅ fixtures（class/struct/enum/protocol 分开认） |
| Scala | `.scala` `.sc` | ✅ fixtures（class/object/trait） |
| Shell | `.sh` `.bash` `.zsh` | ✅ fixtures + 实测（nvm）（无类型 → module 节点；`source` / `.` 变成 import，命令名变成引用） |
| Zig | `.zig` | ✅ fixtures（const X = struct/enum） |
| Solidity | `.sol` | ✅ fixtures（contract/interface + 继承） |
| OCaml | `.ml` `.mli` | ✅ fixtures（module/type；顶层 let 会合成 module 节点） |
| ReScript | `.res` | ✅ fixtures（module / type / variant） |
| Ruby | `.rb` `.rake` `.gemspec` | ✅ fixtures（class/module；`module` 当命名空间；`attr_*` 认成属性；`require`/`include` 连成依赖边） |
| HCL / Terraform | `.tf` `.tfvars` `.hcl` `.nomad` | ✅ fixtures（节点是 block：resource / data / module / variable / output / locals；成员是 attribute；引用连成依赖边） |
| GraphQL | `.graphql` `.graphqls` `.gql` | ✅ fixtures（type / interface / union / enum / scalar / input / schema / directive；字段是成员、参数单独算 argument；`implements` 与 union 成员连成继承边、`"""描述"""` 当"说明"） |
| TLA+ | `.tla` | ✅ fixtures（module + operator / variable） |
| SystemRDL | `.rdl` | ✅ fixtures（addrmap / reg / field 组件；wasm 是我们自己编的 —— 见下方说明） |
| Emacs Lisp | `.el` | ✅ fixtures（无类型概念 → 顶层函数/变量挂在合成的 module 节点上） |
| Elixir | `.ex` `.exs` | ✅ fixtures（module / function / struct；注：`defmodule`/`def` 在语法树里是 call 节点，靠专属钩子识别；`alias` 会计入导入，但暂不连成依赖边） |

**还没做 profile 的**（语法包能加载，缺的是我们这一层的支持）：`Dart`、`Elm`、`QL`、`Haskell`、`PowerShell`、`Julia`、`Vue`、`Svelte`…
`Vue` 单文件组件要先解决“解析内嵌 `<script>`”，`Objective-C` 的 `.m` 与 MATLAB 扩名冲突（只能靠开关指定），这两个是刻意先不做。
`TLA+` 的上游没有可直接用的 wasm，放在 `vendor/wasm/` 自己维护；`SystemRDL` 同理 —— 它是我们用 emscripten
（clang + wasm-ld，不需要 emcc）自己编的，wasm 也放 `vendor/wasm/`（配方见 `src/languages.mjs`）。
审计命令：`node tests/probe-abi.mjs`（把每个语法包真加载 + 真解析一遍，分清能用 / 用不了）。

**文件级格式（默认不开，要看就显式指定）**：`JSON` `.json` · `YAML` `.yaml .yml` · `TOML` `.toml` · `CSS` `.css` · `HTML` `.html .htm` —— 这些没有"类型"可言，只会以文件为单位出现在图上（合成 module 节点）：

**文档（`Markdown` `.md` `.markdown`，同样默认不开）**：把**标题层级**变成可查的节点 —— 每个 `##`/`###` 标题是一节（带行号），`.md` 进了图之后"读文档"就变成"查文档"：`search("发布")` 直接给到 README / CHANGELOG 里的那一节，不必整份读。

```bash
node src/cli.mjs scan ./repo --lang auto,json,yaml   # 代码语言 + JSON/YAML
node src/cli.mjs scan ./repo --lang json,yaml        # 只看配置文件
node src/cli.mjs scan ./repo --lang cs               # 只看 C#
```

**语法包与“分进程解析”**：升到 `web-tree-sitter` 0.27.0 之后，单门语法包加载后常驻约 **11 MB**（曾经是 150–180 MB），同进程里装 105 门也只是 1.2 GB 级别（实测：20 门共 104 MB、自然退出 exit=0）。
分进程**仍然保留**，但理由换成了**崩溃隔离**：语法包在特定输入上硬崩（wasm 层 abort，JS 拦不住）时，
只丢那一门、其余照常进地图。参考实测：老运行时同进程装 9 门必崩（退出码 `0xC0000409`），1–3 门正常。
注意这**不是“内存不够”**：本机 Node 能分配到 50 GB+ 才叫不够。

**所以扫描是这么跑的**：父进程只负责收集文件 / 建索引 / 写 bundle，**每门语言的解析都在自己的子进程里做**（每个子进程只装一门语法包）。

- 内存峰值 = 一门（约 50 MB），不再随语言数叠加上去；
- 某个子进程挂掉，只丢那一门（报告里会明说），其余语言照常进地图；
- 父进程不装 wasm，所以**退出干净、退出码正确** —— Swift/Scala 那类“退出时崩”也一并消失；
- 代价：多几次进程启动（每门约 0.2 s）。

调这个可以用：`npm run probe:mem`（语法包内存探针，逐行落盘）。

**语法包来源与规模**（用哪个就在 `src/languages.mjs` 里加 profile，一般 5–10 行）：

- 主来源：npm 包 `tree-sitter-wasm`（**105 个语法包**；当前运行时 `web-tree-sitter` 0.27.0，兼容语法 ABI 13–15）；
- 自己补的：`vendor/wasm/`（TLA+；SystemRDL 是自己用 emscripten 编的）；
- 全量冒烟：`npm run probe:abi` → 实测两个来源里的 wasm 全部能加载并解析。

加一门语言 = 在 `src/languages.mjs` 加一份 profile（节点类型 + 继承字段 + 复杂度分支表），
再往 `tests/fixtures/<语言>/` 丢一个样例、在 `tests/run-fixtures.mjs` 写期望值，然后 `npm test`。
节点名拿不准就先跑 `npm run probe`（打印 tree-sitter 实际解析出的节点名，别猜）。

**没有类型声明的文件**（脚本、顶层函数、Lua 模块）会自动合成一个 `module` 节点，
免得整份文件在图上消失；它的成员（函数/变量）挂在模块节点下。

### 默认跳过什么

- **目录**：`.git` `.svn` `node_modules` `bin` `obj` `dist` `build` `out` `target` `vendor` `.vs` `.vscode` `.idea` `.venv` `__pycache__` `coverage` `.next` `.nuxt` `publish*`；
  （**`packages/` 不在这里** —— 它是 pnpm / yarn workspaces / lerna / Nx / Turborepo 的源码根，跳过它会把 monorepo 扫成一张几乎空白的地图）
- **文件**：压缩 / 自动生成的 `*.min.js` `*.d.ts` `*.g.cs` `*.designer.cs` `*.generated.cs/ts` `*.freezed.dart` `*.g.dart`，
  以及**机器生成的锁文件**（`package-lock.json` `pnpm-lock.yaml` `yarn.lock` `bun.lockb` `*.lock` `Cargo.lock` `poetry.lock`
  `composer.lock` `Gemfile.lock` `go.sum` `gradle.lockfile` `.terraform.lock.hcl`、Yarn PnP 的 `.pnp.cjs`），还有 `*.snap` / `*.js.map` / `*.css.map`
  —— 这些没有分析价值，一个 `pnpm-lock.yaml` 就能吃掉整张图 97% 的“代码行”；
- **被跳过的目录会点名**：扫描报告里有一行「跳过目录 node_modules 312 · dist 4 …」，`overview` 里也会写 —— 免得“图里少了东西”只能靠猜；
- **单个文件 > 1MB**（`--maxkb` 可调）；
- **项目规则里写的**：`facets.json` 的 `exclude` 可以追加要忽略的目录（比如上游参考代码）；
  更推荐在**扫描目标根**放一份 **`atlas.ignore`** —— `目录名` / `目录名/`（只当目录）/ 通配（`*.gen.ts`）/ `#` 注释，一行一条，**存在才生效**；
  **项目自己的 `.gitignore` 默认就生效**（启动器「扫描范围」列表最后一项 **`.gitignore`** 默认勾上；命令行用 `--no-gitignore` 关掉）——
  **包括各个子目录自带的那份**，口径跟 git 一致：每份规则只管它所在的那棵子树（所以 monorepo 不会扫得缺东少西），
  进不去的目录也不再往下走。
  跳过了什么，报告里都会点名（连"读了几份规则文件"一起写；`!` 例外暂不支持，遇到了也会在报告里提示）。

### 扫描时要注意什么

- **语言选对，结果才干净**：默认 `auto` = 所有代码语言都扫、`JSON/YAML/TOML/CSS/HTML/Markdown` 这类文件级格式**不扫**（要看就显式写 `--lang auto,json`）。
  只勾项目真正用的语言明显更快，也不会把依赖目录里别的语言混进图里（启动器里有勾选框，写进全局的 `Langs`）。
- **文件编码按 UTF-8 读**：不是 UTF-8 的文件会被**认出来并标出来** —— 扫描报告、MCP 的 `overview`、网页顶部的 chip
  都会告诉你受影响的有几个文件（`totals.nonUtf8Files`）。这种文件即使语法树解析成功，注释 / 字符串也会是乱码
  （所以不会报“解析异常”）；转成 UTF-8 再扫一次就干净了。
- **增量扫描的前提**：`--incremental` 靠引擎指纹（版本 + `scan.mjs`/`languages.mjs`/`preprocess.mjs` 的 mtime）判断缓存能不能用。
  换了版本或改了这几处，缓存自动作废、本次按全量扫 —— 不会拿旧规则的结果骗你。
- **先看 `unknown` / `ambiguous` 两个数**：依赖边是**名字匹配**级别的，同名符号在多个作用域里会匹配不上或误连，这两个计数就是「这里我不敢确定」的信号。
  报告、界面和 `bundle.json` 里都带着；看结论前先看一眼这两个数大不大。
- **解析失败不静默**：某个文件解析出 ERROR、某门语言的语法包这次没跑起来，都只影响那一块，并且会在报告里点名。
- **大仓库建议**：① 先限定语言；② 单文件默认 1 MB 上限（`--maxkb` 可调），巨文件直接跳过；③ 跑第二遍时开增量。
- **源码不出机器**：本地服务只绑 `127.0.0.1`，MCP 走本地 stdio，扫描全程不联网（要局域网看图才用 `--host 0.0.0.0`）。
- **`dist/` 和 `ingest/` 落在 exe 旁边**：引擎解包目录（`%LocalAppData%\CodeAtlas\engine\<版本-指纹>\`）是缓存，删了会自动重新释放；不是当前版本的旧缓存会在每次启动时自动清掉（只留当前在用的 + 最近用过的那个）。

### 读不了什么（边界，说清楚）

1. **没支持的语言**（Dart / Haskell / Svelte…）会被跳过，但**不是静默忽略**——报告和界面上都会写「未支持语言 N 个文件（.dart 2 · .vue 1 …）」；
   同一条原则也用在**跳过的目录**上：网页抬头的 chip 写「跳过 10 类目录（10 个） · 规则跳了 3 个」，
   悬停能看到是哪几个目录、规则来自哪个文件（命令行报告与 MCP 的 `overview` 里也有同一份数据）；
   还有一种容易误会的：「我们支持、但这次没在扫描范围内」的文件（没勾那门语言，或者 JSON/YAML 这类默认不扫的格式），会单独报成「**语言范围外** N 个文件没扫」，不会被算成“不支持”；
2. **反编译产物**：没有源码注释（所以"说明"是空的）、行数比源码高（语法糖被展开）、会多出编译器生成物（已自动打标签并在界面默认隐藏）；
3. **静态分析的边界**：反射、动态 `import`、拼字符串调出来的方法**拿不到**；依赖边是名字匹配级别的，重名符号会误连（界面标着 unknown / ambiguous 计数）；
4. **不读**：二进制资源、图片、配置文件内容、运行时行为、git 历史。

## 功能一览（下面每一条都已做进当前版本，不是心愿单）

每个版本改了什么见 [CHANGELOG.md](CHANGELOG.md)。

- [x] v1：CLI 扫描 + 本地网页（树形图 / 树状列表 / 检查器 / permalink）
- [x] 分组层：系统规则（facets 配置）+ 目录 / 命名空间 / 平铺
- [x] MCP server（搜符号 / 找引用 / 导出子图），给 AI 用
- [x] 语言覆盖：29 门代码语言 + 6 种文件级格式（含 **Markdown 的标题层级**）
- [x] 依赖图视图（力导向）+ 包级依赖矩阵
- [x] 启动器里勾选要扫的语言（界面 + `--lang`）
- [x] 搜索增强：类型名 + 成员名（web 与 MCP 都支持）· 地图内按语言过滤
- [x] 打包：完全版（内置 Node）/ 精简版（要求系统 Node）两个单文件 exe，不做安装器
- [x] 首次运行向导（选项目 → 草拟分组规则 → 勾语言 → 保存并扫描；配过的项目再打开=零操作）
- [x] 增量扫描（`--incremental`，只重解析改过的文件；启动器有「增量」勾选框）
- [x] **没有源码也能扫**：`.dll / .exe`（含 .NET 单文件发行版）走启动器内置反编译器 · `.jar` 走自带裁剪 JRE + cfr —— 完全版什么都不用装
- [x] **解析底座换代**：web-tree-sitter 0.20 → 0.27，语法包换成 105 个全可用（单门语法内存从 150–180 MB 降到约 11 MB）
- [x] **把诚实当功能做**：unknown / ambiguous 计数、不是 UTF-8 的文件、未支持的语言、以及「支持但这次没在扫描范围内」的文件，全都单独报出来，不做静默丢弃
- [x] 同一个 exe 里带无界面自检与诊断（`--headless --path <目录> --log <文件>`、`--list-langs`、`draft-facets`）—— 别人报问题时用得上
- [x] AI 接口补强：一键复制 MCP 配置 · `map(budget)` 骨架导出 · `impact` 影响面（多跳 + 诚实说明）
- [x] 界面语言：中文 / English，覆盖启动器、引擎输出、MCP 工具与网页地图（切语言不用重扫）—— 文档也有成对的英文版（[USAGE.md](USAGE.md)）
- [x] **扫描范围**：工具栏那个下拉（原名「语言」）现在也能按项目自己的 `.gitignore` 跳（**含各子目录自带的那份**）；项目还可以用 `atlas.ignore` 自己声明跳什么 —— 跳过了什么一律进扫描报告
- [x] **成员签名**：`symbol` / `search` / 检查器里的成员带参数表与返回类型（`area(int, int): double`），同名重载能分得开
- [x] **引用次数**：依赖边的权重是真的引用次数 —— 地图上**每条引用画一根线**，其他地方的引用统计也按次数加权
- [x] 地图缩放 / 平移（滚轮 + 右键拖动 + 「回正」），抬头多一个提示跳过了什么的 chip

- **git 热度着色**：按文件的 git 改动次数着色，一眼看出最近改得最多的地方（未提交的文件带亮边框）
- **内构快照 / 内构监控**：启动器上的双态按钮；监控模式下改代码，图会自己增量更新（不重扫全库、不刷页面）
- **地图右下角「取消选中」**，且鼠标停在/点在模块名字上算命中该模块本身
- **引用证据强度**：`refs` 每条标出证据强度（同文件 / **有支撑**（引用方 import 的模块 / 命名空间 / 包能指到目标、C# / VB 父命名空间）/ 仅同名），
  `overview` 热点榜按有证据的引用次数排（“仅同名”里既有名字巧合、也可能有没认出来的真引用，不计入但别当成噪声一概丢掉）

## 协议

MIT（见 [LICENSE](LICENSE)）。
