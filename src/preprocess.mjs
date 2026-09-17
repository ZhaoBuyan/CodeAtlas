/**
 * 解析前预处理：把语法不支持的写法换成等价写法，让语法树能解析干净。
 *
 * ⚠️ 目前**没有语言在用它**（2026-09-17 升级到 web-tree-sitter 0.27 + tree-sitter-wasm@2.0.1 后，
 *    新 C# 语法自己就能吃下当初需要改写的 12 种写法，实测 0 个 ERROR；而那些改写反而会
 *    把名为 required 的变量改成 required_，把名字弄错）。它作为通用机制留着，将来哪门语言的
 *    语法包又落后于语言版本时，在 profile 里加一行 `preprocess: 'xxx'` 就能重新挂上。
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
  return csharpRequiredIdentifier(src);
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

/** profile.preprocess 的取值 -> 具体实现 */
export const PREPROCESSORS = {
  csharp,
  csharpRawStrings,
};

export function preprocess(src, name) {
  const fn = PREPROCESSORS[name];
  return fn ? fn(src) : src;
}
