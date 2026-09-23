/**
 * 解析前预处理：把语法不支持的写法换成等价写法，让语法树能解析干净。
 *
 * 谁在用：C# 挂着 `preprocess: 'csharp'`（只剩“局部变量叫 required”那一条必需改写），
 *         `.vue` 挂着 `preprocess: 'vue'`（把 <script> 之外的内容空格化，借 TSX 语法解析）。
 * 2026-09-17 升级到 web-tree-sitter 0.27 + tree-sitter-wasm@2.0.1 后，C# 当年需要的 12 种改写里
 * 有 11 种语法自己就能吃下了（那几个函数保留导出 —— 语法包再落后就能挂回去）。
 *
 * 两条铁律：
 *   1. 只做"不改变行号、不改变行数"的替换 —— 否则 bundle 里的行号就不再指向真实源码。
 *   2. 不碰字符串 / 注释里的内容 —— 用一个极简词法掩码判断"这段在不在代码里"。
 */

/** 极简词法掩码：1 = 代码位置，0 = 字符串 / 字符 / 注释里 */
export function codeMask(src) {
  const mask = new Uint8Array(src.length).fill(1);
  let i = 0;
  while (i < src.length) {
    const c = src[i], c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      mask.fill(0, i, j);
      i = j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close < 0 ? src.length : close + 2;
      mask.fill(0, i, end);
      i = end;
      continue;
    }
    if (c === '@' && c2 === '"') {
      let j = i + 2;
      while (j < src.length) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { j += 2; continue; }
          break;
        }
        j++;
      }
      const end = Math.min(src.length, j + 1);
      mask.fill(0, i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      const end = Math.min(src.length, j + 1);
      mask.fill(0, i, end);
      i = end;
      continue;
    }
    i++;
  }
  return mask;
}

/** 括号配对（从 '(' 开始找对应 ')'），失败返回 -1；跳过字符串里的括号 */
function matchParen(src, open, mask) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (mask[i] === 0) continue;
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
    else if (ch === '\n' && depth === 0) return -1;
  }
  return -1;
}

/**
 * C# 11 原始字符串：""" ... """ / $""" ... """ / """" ... """"
 * 内置的 tree-sitter-c_sharp（2023 年版本）不认它，会把整段标成 ERROR，
 * 连带把后面的声明也搅乱。改写成逐字字符串 @"..."（内部 " 双写），文字与行数完全保留。
 */
export function csharpRawStrings(src) {
  return src.replace(/(\$?)("""+)([\s\S]*?)\2/g, (m, dollar, quotes, body) => `${dollar}@"${body.replace(/"/g, '""')}"`);
}

/**
 * C# 12 主构造函数：internal class RpcManager(SteamStatusManager m) : Base(x) { ... }
 * 去掉参数表 —— 我们要的是类型 / 成员 / 继承这些结构，主构造参数不影响它们。
 * 只处理 class / struct：record 的位置参数是语法支持的，不能动。
 */
export function csharpPrimaryConstructors(src) {
  const mask = codeMask(src);
  const re = /\b(class|struct)\s+[A-Za-z_]\w*(\s*<[^<>{}();]*>)?\s*\(/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (mask[m.index] !== 1) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open, mask);
    if (close < 0) continue;
    out += src.slice(last, open); // 直接把 '(' 到 ')'（含）整段删掉
    last = close + 1;
  }
  return out + src.slice(last);
}

/** C# 11 的 file 修饰符（file class Foo）：语法不认，等值换成 internal */export function csharpFileModifier(src) {
  const mask = codeMask(src);
  const re = /(^|\n)([ \t]*)file\s+(?=(?:sealed\s+|static\s+|abstract\s+|partial\s+)*(?:class|struct|record|interface|enum|delegate)\b)/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (mask[m.index + m[1].length] !== 1) continue;
    out += src.slice(last, m.index) + `${m[1]}${m[2]}internal `;
    last = m.index + m[0].length;
  }
  return out + src.slice(last);
}

/**
 * C# 组合预处理：只留还必须做的那一条。
 *
 * 2026-09-17 换了新语法包（tree-sitter-wasm@2.0.1）后实测：原始字符串 / 主构造函数 /
 * file 修饰符 / void* 等 12 项新语法都能原生解析（0 个 ERROR），对应的四个改写函数因此不再
 * 参与组合（保留导出，将来语法包再落后可以挂回去）。
 * 只剩 required 这一条必须留着：局部变量名叫 required 时（`required = 1;`），新旧语法都会
 * 先把它当修饰符关键字 → 整句变成 ERROR。实测：一个真项目（54 个 C# 文件）里就有一个这样的文件，
 * 不改写就有 3 处解析异常。
 */
export function csharp(src) {
  return csharpConditionalDirectives(csharpRequiredIdentifier(src));
}

/**
 * C# 的条件编译指令（`#if / #else / #elif / #endif`）**只留空行**（行号不动）。
 * 为什么：语法包对“多个 #if 块叠在一起”的恢复很差 —— 实测 Newtonsoft.Json 的 TestFixtureBase.cs
 *（4 个 #if 块 + 后面跟 namespace）整个 namespace 被吞进一个 ERROR 节点，8 个类型全丢了命名空间，
 * 连带 294 条跨文件引用被标成“仅同名”。两个分支的代码本来就会进语法树（preproc_if 的两个分支都在），
 * 去掉指令行不改变提取结果，只是让语法包别在这上面翻车。
 */
export function csharpConditionalDirectives(src) {
  const mask = codeMask(src);
  const lines = src.split('\n');
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = line.search(/\S/);
    if (at >= 0 && /^#\s*(if|else|elif|endif)\b/.test(line.slice(at)) && mask[pos + at] === 1) lines[i] = '';
    pos += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * void*（不安全指针）旧语法不认；解析上 nint 与之等价，换掉就行。
 * 反编译产物里 ILSpy 为 P/Invoke 生成大量 `void* x = ptr;`，不换就一片 ERROR。
 */
export function csharpPointerTypes(src) {
  const mask = codeMask(src);
  const re = /\bvoid\s*\*/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (mask[m.index] !== 1) continue;
    out += src.slice(last, m.index) + 'nint';
    last = m.index + m[0].length;
  }
  return out + src.slice(last);
}

/**
 * C# 11 把 required 变成了修饰符关键字，旧语法于是把"局部变量叫 required"的文件解析错。
 * 只在明显是标识符的位置改名（后面跟 = ; ,），不碰修饰符用法（修饰符后面一定是类型/名字）。
 */
export function csharpRequiredIdentifier(src) {
  const mask = codeMask(src);
  const re = /\brequired\b(?=\s*[=;,])/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (mask[m.index] !== 1) continue;
    out += src.slice(last, m.index) + 'required_';
    last = m.index + m[0].length;
  }
  return out + src.slice(last);
}

/**
 * C# 里把 `async` **当标识符用**时，语法包会把它当修饰符关键字 → 整个文件塌进一个 ERROR 节点。
 *
 * 为什么单列这一条（2026-09-23 实测，66 样本全量扫出来的）：
 * 它不是"某几行报错"，而是**整棵树废掉**——`EFCore.Specification.Tests/LoadTestBase.cs`（5,609 行）
 * 只因为第 171 行 `public virtual async Task Load_collection(…, bool async)` 的参数名叫 async，
 * 就变成 root=ERROR：抽出 **0 个类 / 3 个方法**（真实是 32 个类 / 129 个方法），
 * 连带 2,036 处解析异常。改名后 root=compilation_unit、ERROR 归零、类与方法全部恢复。
 * 影响面实测：efcore **454 个文件**、aspnetcore 51 个、newtonsoft 1 个含这种写法 ——
 * 这些文件此前在图上基本是隐形的。同一批里还系统测过 27 个上下文关键字（await/var/dynamic/
 * nameof/record/init/partial/yield/when/where/… ），**只有 async 会塌整棵树**；nint/nuint 只造成
 * 局部 ERROR、根节点仍正常，不值得为它冒改名的风险。
 *
 * 用法：**不在默认预处理链里**（见 `csharp()` 的注释）—— 由 `scan.mjs` 在"原样解析出了 ERROR"时
 * 才作为**兜底候选**试一次，并且只在真的减少 ERROR 时才采纳。这样误判的代价有上界。
 *
 * 判据：**后面跟的不是标识符字符**（字母 / 下划线 / `@`）的 `async` 就是标识符，改名；
 * 后面跟着标识符字符的是**修饰符**（`async Task` / `async void` / `async IAsyncEnumerable<T>` /
 * `async` 单独一行后接 `Task`），必须保留。反过来，作标识符用时后面一定是 `,` `)` `=` `;` `?` `.`
 * 或行尾，绝不会直接跟字母。
 *
 * ⚠ 试过的三种写法，只有这一种同时满足"能修"和"不误伤"（实测，见下表）：
 * ```
 *                                   参数 bool async    async void M()   真文件(原本 0 ERROR)
 *   \s*[A-Z]   排除                        1→0              0→1              0→1   ✗ 误伤
 *   [ \t]*[A-Z] 排除                       1→0              0→1              0→1   ✗ 误伤（且跨行漏判）
 *   后面跟标识符就保留（本实现）                1→0              0→0              0→0   ✓
 * ```
 * 关键点：**`\s` 要能跨行**（`async` 单独一行后接返回类型是合法写法），而且 **`void` 是小写**，
 * 所以"排除大写开头"这类判据一定漏。按"后面是不是标识符字符"判才自洽。
 *
 * ⚠ 替换目标用 `_asyncKw`（前导下划线，C# 里合法且几乎不可能与真名撞车）：
 * 试过 `async_`（样本库里有 8 处 `Async_xxx` 方法名，撞车）和注入零宽字符
 * （web-tree-sitter 不认，实测反而解析更差）。这个改写的**产物只喂给解析器**，
 * 不进 bundle，所以不必与源码逐字一致；行号也不动（不增删换行）。
 */
export function csharpAsyncIdentifier(src) {
  const mask = codeMask(src);
  const re = /\basync\b(?![\s]*[@A-Za-z_])/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (mask[m.index] !== 1) continue;
    out += src.slice(last, m.index) + '_asyncKw';
    last = m.index + m[0].length;
  }
  return out + src.slice(last);
}

/**
 * .vue 单文件组件：把 <script> / <script setup> 之外的一切换成空格，只把 script 里的代码留给 TSX 语法。
 *
 * 两条铁律（和本文件开头一样）：
 *   1. **逐字节对齐** —— 输出与输入等长、换行原样保留，所以行号 / 列号 / file:line 全部指回 .vue 原文；
 *   2. **按标签边界切，不按行** —— prettier 格式化后开始标签会折行（<script 换行 setup 换行 lang="ts" 换行 >），
 *      按行处理会漏掉中间几行，解析直接崩。这里用 [^>]* 跨行吃掉整个开始标签，再从 </script 截断。
 *
 * 没有 <script> 的 .vue → 整份变空格 → 解析出 0 个类型 / 0 个错误（符合预期）；
 * 模板 + 样式块不参与解析（要的是组件里的 JS/TS，不是模板）。
 */
export function vue(src) {
  const out = new Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    out[i] = c === '\n' || c === '\r' ? c : ' ';
  }
  // 开始标签必须落在行首（允许缩进）：这样模板 / 字符串里偶然出现的 "<script" 不会被当真标签
  const re = /^[ \t]*<script\b[^>]*>/gim;
  let m;
  while ((m = re.exec(src))) {
    const bodyStart = m.index + m[0].length;
    const close = src.toLowerCase().indexOf('</script', bodyStart);
    const bodyEnd = close < 0 ? src.length : close;
    for (let i = bodyStart; i < bodyEnd; i++) out[i] = src[i];
    if (close < 0) break;
    re.lastIndex = bodyEnd + 1;
  }
  return out.join('');
}

/** profile.preprocess 的取值 -> 具体实现 */
export const PREPROCESSORS = {
  csharp,
  csharpRawStrings,
  vue,
};

export function preprocess(src, name) {
  const fn = PREPROCESSORS[name];
  return fn ? fn(src) : src;
}
