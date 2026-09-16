# Code Atlas — 进展与后续（工作交接文件）

> 这份文件是"从对话里搬出来"的项目状态：任何新会话（哪怕上下文被压缩过）先读它，就能接着干。
> 最后更新：2026-09-17（第 2 部分 ✅；打包 ✅；多语法包崩溃 ✅；语言 23 门 ✅；**首次运行向导 ✅**）

## 这是什么

把任意代码库扫成一份**可读的中间数据**（`dist/bundle.json`），供**人**（浏览器翻图）和 **AI**（MCP 查询）使用。
本地优先：源码不出机器；工具只处理数据，不分发被扫代码。

四个入口：

| 入口 | 命令 / 操作 | 给谁用 |
| --- | --- | --- |
| 启动器 | 双击 `CodeAtlas.exe`（拖路径 → 开跑，地图内嵌在窗口里） | 日常用 |
| CLI 零配置 | `node src/cli.mjs "<目录或文件>"` | 命令行 |
| 本地网页 | `node src/cli.mjs serve --out dist [--port 5173]` | 对照/分享 |
| MCP | `node src/cli.mjs mcp --out dist`（配置见 `--print-config`） | AI 客户端 |

## 已经做完的

**① 数据入口（ingest）**
- 目录（源码）直接扫；单个源码文件 → 扫它所在目录并说明；
- `.dll/.exe`（.NET 程序集）→ ILSpy 反编译；**单文件发行版** → sfextract 解包 → 反编译；
- `.jar` → 需 Java + cfr/vineflower（已实现未实测）；发行目录 → 按目录名找程序集（`--dll`）；
- `ingest` 自动匹配 `configs/<程序集名>.facets.json`。

**② 反编译噪声收拾**
- 编译器生成物自动识别（`<>` / `_003C` / `__InlineArray` …）打 `compiler-generated` 标签，界面默认隐藏、画布上画淡；
- 顶栏提示"反编译产物 · 无源码注释 · 行数含语法糖展开"；
- C# 语法预处理（`src/preprocess.mjs`，**行号行数不变**，字符串/注释有掩码保护）：`"""` 原始字符串、主构造函数、`file` 修饰符、`void*`、局部变量名 `required`；
- 效果：一个几万行的 C# 项目解析异常 78 → **0**，反编译产物也 0。

**③ AI 接口（MCP）**
- `src/mcp.mjs`：stdio JSON-RPC，6 个工具 `overview / search / symbol / refs / subgraph / file`，输出紧凑文本；
- 每次调用查 bundle mtime，**重新扫过就自动重载**；
- `--list-tools`、**`--print-config`**（一键打印可粘贴配置）；
- 自检 `node tests/mcp-selftest.mjs [dist]`：11 项，**跟项目无关**（输入从 bundle 里挑），已过。

**④ 语言覆盖：23 门代码语言 + 5 种文件级格式**
- 代码：C# · TypeScript · TSX · JavaScript · Java · Python · Kotlin · Lua · Go · Rust · C · C++ · PHP · Swift · Scala · Shell · Zig · Solidity · OCaml；
- 文件级（`optIn`，默认不扫，`--lang json,yaml` 或 `--lang auto,json`）：JSON · YAML · TOML · CSS · HTML；
- 回归：`node tests/run-fixtures.mjs` → **19/19 全绿**（每门语言独立进程扫）；
- 用不了：Dart（ABI 15）· Ruby · Elm · QL（运行时锁在 web-tree-sitter 0.20.8）；Vue / Objective-C / Elixir 刻意不做（原因见 README）；
- 审计：`node tests/probe-abi.mjs`；单文件探针：`node tests/probe-file.mjs <文件>`；节点名探针：`node tests/probe-nodes.mjs [--wasm X.wasm 文件]`。

**⑤ 界面**
- 分组方式：系统/模块（需规则文件）· 目录 · 命名空间 · 文件 · 平铺，配"分组层级"；
- 着色：按文件（默认，色最多）· 按分组（用规则里配的色）· 按类型类别；颜色按 key hash 生成，不限 10 色；
- 视图：树形图 · 树状列表 · **依赖图（力导向）** · **依赖矩阵（模块间）**；
- 依赖高亮（悬停/选中就点亮邻居并连线）+ 依赖聚焦（只看选中项及其关联）；
- 检查器：说明（从源码注释抽，成员级也抽）· 文件:行 · 成员 · 被谁引用/引用了谁 · 系统徽章（悬停看命中的规则）；
- permalink：`#by=&v=&g=&t=&m=&c=`（`v=graph`/`v=matrix` 可分享）；
- 启动器：内嵌 WebView2 地图、日志可切换、`--auto <路径>`、`--headless`（无界面自检）、窗口尺寸按 DPI/屏幕夹紧。

## 待办（用户已拍板的顺序）

1. **第 2 部分：UI 里勾选语言 + 搜索增强**
   - [x] **语言勾选（启动器）**：工具栏「语言：自动」按钮 → 弹窗勾选 23 门代码语言 + 5 种文件级格式（另有「仅代码语言 / 全选 / 清空」）；
     语言表来自新命令 `node src/cli.mjs langs [--json]`（不在 C# 里另拄一份）；选择存 `launcher.config.json` 的 `Langs`（空 = 自动），`Engine.Start` 拼成 `--lang`；
     `CodeAtlas.exe --headless --list-langs` 可单独验证这条接线。已验证：模拟点击全流程 + 勾 C# 真跑出地图，bundle 里 `scanOptions.lang = csharp`；回归 19/19 绿。
     顺带修的诚实性瑕疵：被语言范围排掉的文件以前被算进「未支持语言」，现在单独报「**语言范围外**」（`stats.skipped.outOfScope`）。
   - [x] **搜索增强（成员名）**：web 的 `matchType()` 与 MCP 的 `toolSearch()` 现在都连成员名一起搜（`memberList` 是全量的，不漏）；web 结果面板会标“命中成员 X（method）· 文件:行”/“命中类型名”；MCP `search` 新增 `scope`（`any`/`type`/`member`），成员条目输出 `Owner.member\t[kind]\t文件:行\t（定义在 <id> Owner）`——工具数仍是 6。
     已验证：无头 Edge 搜 `OnPaint` → 某个 C# 项目命中 3 个类型（都是重写了 OnPaint 的控件类）；MCP 自检两个 bundle 均 13/13 通过。
     顺带：搜索词进了 permalink（`q=`），`Esc` 清空仍有效。
   - [x] **地图侧栏「语言」面板**：只列本次扫到的语言 + 文件数（显示名跟着 `bundle.languages[].label`，由引擎写进 bundle），默认全选（全选=不过滤）、只一种语言时隐藏；走 `files[].lang` 过滤，不重扫，也进了 permalink（`l=csharp,lua`）。
2. [x] **打包发行（两个版本，不做安装器）**
   - 做法：两版都是**单文件 exe**，没有安装器：
     `publish-sc/CodeAtlas.exe`（82 MB，self-contained + 内置 Node 24，什么都不用装）、
     `publish-lite/CodeAtlas-lite.exe`（4.5 MB，要求 .NET 9 桌面运行时 + 系统 Node.js）。
   - 引擎包：`tools/build-payload.mjs` 把引擎（src/web/configs/28 个 wasm/d3/web-tree-sitter）打成 zip，
     构建时用 `-p:CodeAtlasPayload=<zip>` 作为 `<EmbeddedResource>` 嵌进 exe；**首次运行**解到
     `%LocalAppData%\CodeAtlas\engine\<版本-包指纹>\`（完全版 120 MB / 精简版 32 MB），之后直接用；
     7 天没动过的旧解包目录下次启动顺手清掉。构建命令：`npm run publish`（= `publish:sc` + `publish:lite`）。
   - 关键实现：`Payload` 类（`launcher/Program.cs`）+ `Engine.FindDevRoot()/Resolve()/PickNode()`（仓库模式优先，
     其次内置）；node 优先用内置的（配置里写死才用配置的）；`dist/`、`ingest/` 落在 **exe 旁边**（不写进缓存目录）。
   - 已验证：仓库外放一份完全版 → `--headless --extract` 释放 46 个文件、node 指向内置 node.exe；
     **PATH 清空**后用内置 node 直接扫成功（真不依赖系统 Node）；模拟点击「开跑」→ 地图正常嵌窗（截图）。
     精简版：45 个文件 / 32.1 MB、node = 系统 `node`（ok）；两版缓存目录共存不互删。
   - 新文件：`tools/build-payload.mjs`、`THIRD-PARTY-NOTICES.md`（第三方许可证原文照拄，也在解包目录里）。
3. [x] **修多语法包崩溃（按语言分进程）** —— 实测：每门语法包加载后常驻 ~150–180 MB，0.20.8 放不掉（Parser.delete 无效 / Language.delete 不存在 / GC 无效）。
   改法：`src/scan.mjs` 拆成 `extractFiles()`（子进程里跑解析）+ `mergeParts()`（局部 id 平移合并）+ `workerExtract()`；
   `scan()` 里每门语言 `spawnSync` 一个子进程（`cli.mjs __extract`，写完 emit 文件就硬退），父进程只建索引/写 bundle。
   已验：19 门语言一次扫 **exit=0 + bundle 正常**（以前必崩或扫不完）；真项目对拍与重构前**逐项一致**
   （54 文件/106 类型/254 边/9730 代码行/4783 unknown，类型名集合与边集合完全一致）；语言回归 19/19；MCP 自检两个 bundle 过；点「开跑」地图正常。
   新增 `tests/probe-grammars.mjs`（`npm run probe:mem`）作为诊断工具。
4. [x] **补语言（第 1 批）**：新增 **ReScript / TLA+ / SystemRDL / Emacs Lisp**（节点名均从 `tests/probe-nodes.mjs` 实测）——引擎里现有的 24 门变 28 个 profile，回归 **23/23 绿**。
   顺带改了 `nameOf`：wrapper 分支支持 `pattern` 字段与 ID 兜底（ReScript 的 let / SystemRDL 的 id），副作用是 OCaml 顶层 `let` 从此也有名字→多一个合成 module 节点（已更新期望值，跟 Go/C/Rust 一致）。
   剩下（ABI 审计：36 个里 32 个能加载）：“能加载但缺 profile”只剩 `embedded_template`（模板，价值低）；难的三门：`objc`（.m 跟 MATLAB 撞）、`elixir`（全 call 节点）、`vue`（要内嵌 JS）；4 个加载即坏的：`dart` `/`elm` `ql` `ruby`（运行时锁在 0.20.8）。
5. [x] **首次运行向导（项目设置）**：启动器工具栏「项目设置…」→ 三步：① 选目标 ② 选语言（复用 LangPicker）③ **按目录草拟分组规则**（可取消勾选 / 改名 / 换色）→ 保存并开跑。
   - 草拟在引擎里：新命令 `atlas draft-facets <目录> [--out 文件] [--json]`（只看目录结构、不解析代码，秒出；目录太集中会自动退到第 2 层；`vendor/third_party/reference*` 这类目录名自动建议排除；顶层散文件归到最后一条「根目录」规则）。
   - 规则默认写 `%LocalAppData%\CodeAtlas\configs\<项目名>.facets.json`（私有），另给「写进项目目录 atlas.facets.json」勾选；启动器把路径记进 `launcher.config.json` 的 `Projects`，并用 `--facets` 显式传下去。
   - 「再打开=零操作」：`Projects` 里已有记录的项目不弹向导；没记录才弹（不做自动开跑）。
   - 已验：无头 `--draft-facets` 可用；从零跟向导点到底 → 写出规则文件（**camelCase，引擎认得**）→ 开跑后地图按 6 个系统分组；第二次启动只看到主窗、不再弹向导。
   - 待办：草拟目前**只看目录**，按命名空间/类型再细化留作后续（扫完一遍后做更准）。
6. [x] **增量扫描**（`--incremental`，默认全量；启动器工具栏勾「增量」）：按文件存上次的解析结果（`<输出目录>/.scan-cache.json`，带引擎指纹/语言/maxKb 校验），没变的文件直接复用；
   跨文件的“谁引用谁”仍整体重算（设计如此）。已验：第二次全复用（不再起子进程）、改一个文件只重解析它一个、**增量产出与全量逐项一致**（类型细节/边集合）。
   坑：`cmdAuto`→`ingest()` 那三处 `scanToDisk` 也要传 incremental，否则启动器勾了没效果（实际踩过）。
7. [x] **AI 接口补强**（① ② ③）：① 启动器「MCP 配置」按钮一键复制（绝对路径 JSON，cli 新增 `--config-json`）；
   ② MCP 工具 `map(budget)` 按 token 预算导出骨架（系统→关键类型→关键成员）；③ MCP 工具 `impact(name, depth)` 影响面多跳 + 老实交代看不见的部分。工具数 6→8，自检 15 项全过。
   （④ 多项目单 server 用户定先不做。）
8. [x] 语言 `elixir`（第 24 门）：靠 profile 的 5 个钩子（nameOf/kindOf/memberKindOf/importKindOf+importTextOf/isDecision）——
   Elixir 的 defmodule/def 在语法树里都是 call 节点，节点类型表无效。回归 24/24 全绿。
   [x] 草拟规则**按命名空间**（`draft-facets --by namespace --bundle <输出目录>`）：用代码自己的模块层级分系统，
   官方补上"所有文件堆在一个目录"时按目录草拟等于没分的问题；会给诚实提示（没命名空间→建议用目录；系统<3 个→说层级太平）；
   顺手从 bundle 的文件路径里建议排除第三方目录。已验：MuSync 上分出 Utils39/Players20/Tests15/Win32Api8/Models5/顶层17，
   规则文件扫一遍确实生效。向导里的「用命名空间重新草拟」按钮**已加并验证**（模拟点击：点前 `Utils · 23 个文件 · Utils/**` → 点后 `Utils · 39 个类型 · MuSync.Utils*`；顺带修了 Namespaces 字段缺失导致规则被写丢的 bug）。
9. **文档**：[x] 新增 `docs/ai-mcp.md`（怎么接 AI 工具：一键复制/手工配置/各客户端贴哪里/8 个工具何时用/排错）；
   README 指过去；`使用说明.md` 补了“给 AI 用”和“增量”两节。
10. 其它（优先级低）：地图笔记/书签、键盘操作、版本号统一（启动器 0.3.0 vs 引擎 0.1.0）、CI。

## 协作约定（用户偏好，务必遵守）

- **做一部分，改一部分 README**；
- **UI 交互必须真的去点**（`EnumChildWindows` 找按钮 + `PostMessage BM_CLICK`；点开后会弹模态框的按钮**必须用 PostMessage**，用 SendMessage 会阻塞），别只测 `--auto` 这种捷径——"开跑点不了"就是这么漏掉的；
- 动功能前先审计列清单等拍板；**没有实锤证据不做"预防性"改动**；
- 做一步说一步，别原地打转烧 token；一段做完就是稳定版，直接提交（用户 2026-09-17 授权）；多行中文提交用 `git commit -F <文件>`，别 `git add -A`（用 `git add .` + `git status` 先看一眼）；
- 构建启动器前先退出正在运行的实例（不然 exe 被锁）；
- 测试：`node tests/run-fixtures.mjs`（23 门语言）+ `node tests/mcp-selftest.mjs`（MCP）。

## 已知坑 / 环境注意

- **已是 git 仓库**：2026-09-17 初始化，分支 `main`，初始提交 `16de1e9`（48 个文件）。**只本地，没加 remote**。`ROADMAP.md` 已入库（README 里引用了它）；`dist*/`、`node_modules/`、`ingest/`、启动器产物、`launcher.config.json` 都在 `.gitignore` 里。
- **改完 `src/` 或 `web/` 必须重新 `npm run publish`**：引擎是构建时快照进 exe 的，不重打的话 exe 里还是旧引擎（发布目录里的 exe 不会自动跟着源码变）。
- **把发行版 exe 放进仓库里跑，走的是“仓库模式”**（优先用旁边的源码，而不是内置引擎）—— 要验证内置引擎就把 exe 拷到仓库外再跑。
- **`atlas scan` 退出码**：以前用 `process.kill(pid,'SIGKILL')` 硬退，Windows 上会把“成功”变成 1；现在解析在子进程里、父进程很干净，`flushAndExit` 用 `process.reallyExit(code)` 就够。子进程自己降完结果就硬退（不看它的退出码）。
- **Windows 防火墙弹窗（已修）**：以前服务用 `server.listen(port)` 绑的是**所有网卡**，Windows 对非回环监听**必须**问一次“是否允许 Node.js 通信”；又因为完全版的 `node.exe` 在 `%LocalAppData%\CodeAtlas\engine\<版本-包指纹>\` 里，**每换一次引擎包路径就变**，于是“每次开跑都要同意”。
  修法：`server.listen(port, '127.0.0.1')`——回环流量根本不进防火墙，一个规则都不用建（实测：起服务前后规则数 6 → 6）；要给局域网/手机看再 `--host 0.0.0.0`。
  （用户机上当时已积了 3 条指向旧引擎路径的 node.exe 规则，无害；要清理就在“防火墙→允许应用通过防火墙”里删，需要管理员。）
- **git 会报一堆 LF→CRLF 警告**（`core.autocrlf=true`）：无害，只是噪。要消掉就加 `.gitattributes`（`* text=auto eol=lf`）——尚未做，等用户拍板。
- **本沙箱里的 `node` 不是真 node**：PowerShell 里 `node` 是个包装函数，实际跑 `Chatbox.exe`，里面是 **Electron 35 / Node 22 内核**（`process.execPath` 也指向 Chatbox.exe）。要真 node 就用全路径：`& 'C:\Program Files\nodejs\node.exe'`（v24.18.0）。
- **多语法包崩溃：已修（2026-09-17，改法=按语言分子进程）**：以前同进程装 12 门以上就会在退出阶段必崩（`Fatal process out of memory: Zone`）、19 门扫不完；根因是每门语法包常驻 ~150–180 MB 且 0.20.8 放不掉。现在父进程不装 wasm、解析都在子进程里，19 门一次扫 **exit=0 + bundle 正常**。诊断工具：`npm run probe:mem`。
- **PowerShell 里给 `--lang` 传逗号列表要加引号**：`--lang "a,b,c"`，不然 PowerShell 把逗号当数组分隔符，参数会被拆成多份（症状：报“目录不存在：csharp”）。
- **PowerShell 5.1 把无 BOM 的 UTF-8 脚本当 ANSI 读**：脚本里别写中文（会把引号吃掉）。调试脚本一律纯 ASCII，中文路径从命令行参数传；
- **别用管道/重定向跑 node**（`| Select-Object`、`> file` 会吞输出/EPIPE），要落盘就让脚本自己 `fs.writeFileSync`；
- `languages.mjs` 里**重复键会覆盖**（出现过旧的 zig/bash 占位配置盖掉新配置），排查"配了不生效"先 grep 语言 id；
- WebView2 初始化**必须在 UI（STA）线程**（放 `Task.Run` 会报 `RPC_E_CHANGED_MODE`）；残留的 `msedgewebview2.exe` 会占用户数据目录导致初始化卡死（现已按进程号隔离目录）；
- Swift 语法包在**进程退出阶段**必然崩（结果为完成态），CLI 用 flush + 硬退出绕过；这是语法包问题，升级运行时可解；
- 依赖边是**名字匹配级**推断（重名会误连），界面标注 unknown / ambiguous；反射、动态 import 拿不到。

## 关键文件

```
src/cli.mjs        CLI：零配置入口 / scan / ingest / serve / mcp
src/scan.mjs       扫描器：遍历 → tree-sitter 解析 → 提取 → 建索引 → bundle
src/languages.mjs  语言配置表（23 门代码 + 5 种文件格式）
src/preprocess.mjs C# 语法预处理（行号不变 + 字符串/注释掩码）
src/ingest.mjs     产物入口：ILSpy / sfextract / jar
src/mcp.mjs        MCP 服务（6 个工具）
web/               浏览器端（D3 树形图 / 树列表 / 依赖图 / 矩阵 + 检查器）
tools/build-payload.mjs  打包引擎：src/web/configs/28 个 wasm/d3 → zip（完全版多带 node.exe）
THIRD-PARTY-NOTICES.md   第三方组件与许可证（原文照拄，也在解包目录里）
publish-sc/ publish-lite/ 两个发行版构建产物（exe 单文件，不入库；npm run publish 重新生成）
launcher/          .NET WinForms 启动器（构建成根目录 CodeAtlas.exe）
    ├ Program.cs        主窗/语言勾选/引擎接线/项目记录（Projects）
    └ ProjectWizard.cs  首次运行向导（三步）+ 输入小弹窗
configs/           各项目的系统分组规则 <项目名>.facets.json
tests/             语言回归 + MCP 自检 + 三个探针
```
