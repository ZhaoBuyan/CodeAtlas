/**
 * 模块名归一 —— 扫描器（名字解析）与 MCP（引用证据分档）**共用同一套口径**。
 *
 * 为什么单独一个文件：这两处以前各写一份，而它们必须判得一样 —— 否则会出现
 * “解析时按 A 口径接到了 f1，读的时候按 B 口径说这条边没有支撑”这种自相矛盾。
 *
 * 用途：
 *   · 扫描期 `resolveName()` 用它做 **import 消歧**（同名两处 + 第三方调用时，看引用方 import 的是哪个模块）；
 *   · 读期 `evidenceOf()` 用它判“这条边有没有 import 支撑”。
 */

/** 源码后缀：判“import 是否指到这个文件”时用来去掉尾部扩展名（'util.log-or-console' 这种不能被当成扩展名切掉） */
export const SRC_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'java', 'cs', 'kt', 'kts', 'go', 'rs', 'rb', 'php',
  'lua', 'swift', 'scala', 'ex', 'exs', 'zig', 'hcl', 'tf', 'sol', 'tla', 'res', 're', 'ml', 'mli', 'graphql', 'gql',
  'sh', 'bash', 'ps1', 'el', 'c', 'h', 'hpp', 'cpp', 'cc', 'dart', 'jl', 'pl', 'r', 'json', 'yaml', 'yml', 'toml', 'html',
]);

export function basename(p) {
  return String(p).split('/').pop();
}

/** 模块名归一：'x/y/util.log-or-console.js' 与 './util.log-or-console' 都算 'util.log-or-console' */
export function moduleKey(p) {
  const b = basename(String(p || ''));
  const m = b.match(/\.([A-Za-z0-9]+)$/);
  return m && SRC_EXT.has(m[1].toLowerCase()) ? b.slice(0, -m[0].length) : b;
}

/**
 * 引用方的一条 import 字符串，能不能算“指到了目标的命名空间 / 包 / 模块”？
 * 命名空间语言（C# `using MuSync.Models;`、Java/Kotlin `import a.b.C`）的 import 名字**不是文件名**，
 * 光按 moduleKey 比会永远比不上（实测：一个 C# 项目 53 条边全部塌成“仅同名”）。所以这里一并认：
 *   · 目标的命名空间就是 import 的名字（`using MuSync.Models` ↔ ns `MuSync.Models`）
 *   · 其中一个是另一个的前缀（`using MuSync` ↔ ns `MuSync.Models`；或反过来）
 *   · import 的名字就是目标的限定名（`import a.b.C` ↔ fqn `a.b.C`）
 *   · **包 / 模块路径前缀**：import 的是包（`django.db.models`），而目标文件在那个包里
 *     （`django/db/models/fields/related.py`）。这是 Python 里最常见的形态 —— `from django.db import models`
 *     只会被记成 `django.db`（被 import 的符号名采不到），所以只能按路径前缀认。
 *     不认它的话，实测 Django 上 **79%** 的边会落到“仅同名”。
 */
export function importMatchesTarget(rawImport, target) {
  const imp = String(rawImport || '').replace(/[;,]+$/, '').replace(/^['"]|['"]$/g, '').trim();
  if (!imp) return false;
  const ns = target.ns || '';
  const fqn = target.fqn || '';
  if (fqn && imp === fqn) return true;
  if (ns) {
    if (imp === ns) return true;
    if (imp.startsWith(`${ns}.`) || ns.startsWith(`${imp}.`)) return true;
  }
  // 相对路径那种 import（'./f1.js' / '../util'）走模块名这条路：比目标文件的模块名
  if (target.path && moduleKey(imp) === moduleKey(target.path)) return true;
  // 包 / 模块路径前缀（见文件头最后一条）：目标的**目录**以它开头就算“指到了”
  const tPath = String(target.path || '').replace(/\\/g, '/');
  if (tPath && !/\s/.test(imp)) {
    const dir = tPath.slice(0, tPath.lastIndexOf('/') + 1);
    for (const v of importPathVariants(imp)) {
      if (v.length < 2) continue;                 // 太短的（'a' 之类）不认，避免乱匹配
      if (dir.startsWith(`${v}/`)) return true;
      if (tPath === v || tPath.startsWith(`${v}.`)) return true;
    }
  }
  return false;
}

/** import 字符串的可能路径形态：原样 / 点换斜杠 / 去掉源码扩展名（'./x/y.js' → 'x/y'） */
function importPathVariants(imp) {
  const norm = imp.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\.+/, '');
  const out = new Set([norm, norm.replace(/\./g, '/')]);
  const m = norm.match(/\.([A-Za-z0-9]+)$/);
  if (m && SRC_EXT.has(m[1].toLowerCase())) out.add(norm.slice(0, -(m[1].length + 1)));
  return [...out].filter(Boolean);
}
