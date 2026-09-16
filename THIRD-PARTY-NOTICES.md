# 第三方组件与许可证

Code Atlas 本身是 MIT（见 [LICENSE](LICENSE)）。发行版里还带着别人的东西，这里逐个说清是谁的、什么许可、原文怎么写的。

> 这份文件的规矩：**第三方的许可证原文照抄，一个字不改**；只加"这是谁、用在哪、从哪来"的说明。
>
> 怎么核对：`node_modules/<包名>/LICENSE` 就是 npm 依赖的原文来源；`licenses/*.txt` 是 Node.js / .NET / WebView2 的原文；`payload.json`（启动器解包后的目录里）记录了这一版包里带了哪些组件。

## 完全版额外内置的东西

### Node.js

- **是什么**：完全版（`CodeAtlas.exe`）内置了 `node.exe` 作为引擎运行时，这样用户什么都不用装。
- **许可**：MIT（但 Node 官方 LICENSE 里还附带了它自己内置组件（npm / OpenSSL / ICU / V8 等）的许可证清单，所以文件很长）
- **版权**：Copyright Node.js contributors. All rights reserved. Copyright Joyent, Inc. and other Node contributors. All rights reserved.
- **许可证原文**：整份随附在 [`licenses/Node.js-LICENSE.txt`](licenses/Node.js-LICENSE.txt)（取于 nodejs/node `v24.18.0`，一字未改）

## 引擎的依赖

### web-tree-sitter

- **是什么**：在 Node 里加载并使用 tree-sitter 的 WebAssembly 语法包（`node_modules/web-tree-sitter`）。
- **许可**：MIT
- **原文**（`node_modules/web-tree-sitter/LICENSE`）：

```text
The MIT License (MIT)

Copyright (c) 2018-2021 Max Brunsfeld

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### tree-sitter 语法包（tree-sitter-wasms）

- **是什么**：各个语言的语法被预编译成 `.wasm`，由 npm 包 `tree-sitter-wasms` 汇总分发；我们只带支持的那 24 个（`payload.json` 里有清单）。
- **许可**：Unlicense（公有领域）
- **原作者**：每个语法包由各自社区维护（`tree-sitter/tree-sitter-*`、`tree-sitter-grammars/tree-sitter-*` 等仓库，多为 MIT）。`tree-sitter-wasms` 只做汇总打包。
- **原文**（`node_modules/tree-sitter-wasms/LICENSE`）：

```text
This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <https://unlicense.org>
```

### d3

- **是什么**：前端（树形图 / 树状列表 / 依赖图 / 依赖矩阵）用的可视化库，只带 `d3.min.js` 一个文件。
- **许可**：ISC
- **原文**（`node_modules/d3/LICENSE`）：

```text
Copyright 2010-2023 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

## 启动器的依赖

### Microsoft.Web.WebView2（.NET 包）

- **是什么**：把地图嵌进窗口用的 WebView2 控件（Edge 内核）。**运行时的 WebView2 是 Windows 系统组件**，不随我们分发。
- **许可**：Microsoft 软件许可条款
- **原文**：整份随附：[`licenses/WebView2-LICENSE.txt`](licenses/WebView2-LICENSE.txt)、[`licenses/WebView2-NOTICE.txt`](licenses/WebView2-NOTICE.txt)（取自 NuGet 包 1.0.3351.48，一字未改）

### .NET 运行时（仅完全版内置）

- **是什么**：完全版是 self-contained 发布，`CodeAtlas.exe` 里带了 .NET 运行时；精简版不带（要求机器上装了 .NET 9 桌面运行时）。
- **许可**：随 .NET 发行版附带的 Microsoft 软件许可条款
- **原文**：整份随附：[`licenses/dotnet-LICENSE.txt`](licenses/dotnet-LICENSE.txt)（取自本机构建用的 .NET 9 SDK，一字未改）

## 我们刻意没带的

- `ilspycmd` / `sfextract` / `cfr.jar`（反编译 .dll / .exe / .jar 用的）：它们不是单文件工具（本体在 `~/.dotnet/tools/.store/…`，还依赖 .NET 工具宿主），所以不打进包；用到时会提示安装命令。
