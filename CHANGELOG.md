# 更新日志

> 只写**用户能看到的变化**。技术细节见提交记录。

## 1.0.0（2026-09-17）

首个正式版本。

**扫什么**
- 24 门代码语言：C# / TypeScript / TSX / JavaScript / Java / Python / Kotlin / Lua / Go / Rust / C / C++ /
  PHP / Swift / Scala / Shell / Zig / Solidity / OCaml / ReScript / TLA+ / SystemRDL / Emacs Lisp / Elixir
  （外加 JSON / YAML / TOML / CSS / HTML 这些文件级格式，默认不扫、要显式勾）
- 源码目录直接扫；`.dll` / `.exe`（含单文件）/ `.jar` 会先反编译再扫
- 反编译产物的标题会注明"无源码注释"，不假装和源码一样

**看什么**
- 四个视图：树形图 / 树状列表 / 依赖图 / 依赖矩阵；配色、分组、代码行或文件数都能切
- 搜索支持**成员名**（搜 `OnPaint` 能找到"谁定义了这个方法"）
- 点方块看检查器：类型信息、成员、依赖、依赖高亮；地址栏是 permalink，可分享

**怎么用**
- **启动器**（`CodeAtlas.exe`，免安装）：工具栏「项目设置…」向导三步走完就能开跑
  （选项目 → 选语言 → 自动草拟一套系统分组规则），配过的项目下次打开不用重配
- 「增量」勾选框：只重新解析改过的文件（默认关＝每次全量）
- 「MCP 配置」按钮：一键把"让 AI 读这个项目"的配置复制到剪贴板

**给 AI 用**
- 内置 MCP 服务，8 个工具：overview / search / symbol / refs / subgraph / file / map / impact
- `map(budget)`：按 token 预算导出骨架；`impact(name, depth)`：改它会影响谁（多跳）
- 接入步骤见《使用说明》第五节

**稳定性**
- 解析按语言分进程：某门语言出问题只丢那一门，不会连累整体
- 本地服务只绑 `127.0.0.1`，不会弹 Windows 防火墙、也不会暴露给局域网
- 出错会说人话；未预期的异常写 `crash.log` 到 exe 旁边，不会无声消失

**两个发行版**
- 完全版 `CodeAtlas.exe`（约 83 MB）：自带 Node 运行时，什么都不用装
- 精简版 `CodeAtlas-lite.exe`（约 5 MB）：需要机器上有 .NET 9 桌面运行时 + Node.js
