# 把 Code Atlas 接到 AI 工具上（MCP 接入指南）

Code Atlas 自带一个 **MCP 服务**：接上之后，AI（Chatbox / Claude Desktop / Cursor / Windsurf / Cline…）
就能直接"查"你的代码库，而不是靠把文件塞进上下文——**省 token，而且答得准**。

> 一句话原理：`code-atlas` 这个 MCP 服务读的是你**已经扫出来的** `bundle.json`（那份中间数据），
> 所以它不会偷偷重扫、也不会上传任何东西——**全程本地**。

---

## 一、最快的方式：让启动器替你写配置（推荐）

1. 启动器（`CodeAtlas.exe`）里**先对这个项目点一次「开跑」**（扫出 `dist/bundle.json`）；
2. 点工具栏上的 **「MCP 配置」** 按钮；
3. 提示"已复制到剪贴板" → 把那几行 JSON **粘到 AI 客户端的 MCP 配置里**（各客户端位置见第三节）。

复制出来的内容长这样（路径都是**绝对路径**，不用你改）：

```json
{
  "mcpServers": {
    "code-atlas": {
      "command": "node",
      "args": [
        "C:\\path\\to\\CodeAtlas\\src\\cli.mjs",
        "mcp",
        "--out",
        "C:\\path\\to\\CodeAtlas\\dist"
      ]
    }
  }
}
```

> 完全版（内置 Node）用户注意：**`command` 也可以直接写内置的 `node.exe` 绝对路径**
> （`%LocalAppData%\CodeAtlas\engine\<某版本>\node.exe`），这样连"系统要装 Node"都不需要。
> 启动器复制的是 `node`（靠系统 PATH）；想要绝对路径就把上面那个 `node` 换成内置 node.exe 的完整路径。

## 二、手工方式 / 命令行用户

```bash
node src/cli.mjs mcp --out dist --print-config   # 打印带说明的配置
node src/cli.mjs mcp --out dist --config-json    # 只打印 JSON（方便脚本消费）
```

`--out` 就是**扫描输出目录**（默认 `dist`）。换了项目就改成对应的输出目录。

## 三、各客户端粘在哪

| 客户端 | 位置 |
|---|---|
| **Chatbox** | 设置 → MCP / 扩展 → 添加服务器（粘贴上面的 `mcpServers` 片段） |
| **Claude Desktop** | `claude_desktop_config.json`（Windows：`%APPDATA%\Claude\`）里的 `mcpServers` 字段 |
| **Cursor** | 设置 → MCP → Add new MCP server（或 `~/.cursor/mcp.json`） |
| **Windsurf / Cline / 其它** | 找 "MCP servers" 配置项，粘 `mcpServers` 片段即可 |

粘完**重启客户端**，应该能看到 `code-atlas` 这个 server 和它的 8 个工具。

## 四、接上之后能问什么（8 个工具）

| 工具 | 什么时候用 | 例子 |
|---|---|---|
| `overview` | 先看全局：有多少东西、常用入口 | "这个项目大概是什么结构？" |
| `search(query, scope?)` | 找符号，**默认连成员名一起搜** | "谁定义了 `OnPaint`？" |
| `symbol(name)` | 看某个类型的细节（成员/基类/被引用次数） | "`PlayerInfo` 有哪些成员？" |
| `refs(name, dir?)` | 谁引用它 / 它引用谁 | "谁在用 `Logger`？" |
| `subgraph(name, depth)` | 某处的依赖子图 | "`MainForm` 依赖了什么？" |
| `map(budget)` | **按 token 预算**导出一份骨架（系统 → 关键类型 → 关键成员） | "先用 4000 token 给我讲清整个库" |
| `impact(name, depth)` | **影响面**：改它会影响谁（多跳） | "改 `IPlayer` 会波及哪些地方？" |
| `file(path)` | 看某个文件里的类型清单 | "这个文件里有什么？" |

推荐的用法：**先 `map` 拿全局，再 `search` 定位，最后 `symbol` / `refs` / `impact` 深入**——
比让 AI 一个文件一个文件读要省几十倍 token。

## 五、它不知道的事（诚实说明）

- 依赖关系是**按名字静态匹配**出来的：动态调用、反射、字符串拼出来的名字**看不见**；
- `map` / `overview` 里会写明"有多少处引用没匹配上（unknown）/匹配到多个（ambiguous）"——那是真的不确定，不是装饰；
- 想让依赖更准：**先扫一遍**（`开跑`）再问，AI 读的就是最新那份 `bundle.json`（服务每次调用会检查文件有没有更新，自动重载）。

## 六、排错

| 现象 | 原因 / 处理 |
|---|---|
| 客户端里看不到 `code-atlas` | 配置没粘对位置，或没重启客户端；JSON 里**反斜杠要转义**（`\\`）——启动器复制的那份已经转义好了 |
| 连上但答"没有数据" | `--out` 指错了目录，或者那个项目还没扫过（先在启动器里「开跑」一次） |
| 报 `node` 找不到 | 系统没装 Node.js。用完全版：把 `command` 改成内置 `node.exe` 的绝对路径 |
| 改了代码但 AI 还是旧答案 | 重新扫一次（或勾上「增量」再开跑），服务会自动读新 bundle |
