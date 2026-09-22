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
export function importMatchesTarget(rawImport, target, ctx) {
  let imp = String(rawImport || '').replace(/[;,]+$/, '').replace(/^['"]|['"]$/g, '').trim();
  if (!imp) return false;
  // 通配导入（`import kotlinx.coroutines.*` / `use std::collections::*` / Scala 的 `a.b._`）：
  // 去掉通配尾巴按包比 —— 实测 coroutines 上大量跨包引用卡在这里（通配串一个目标也撞不上）
  const impBase = imp.replace(/(?:\.\*|::\*|\._)$/, '');
  if (impBase !== imp) imp = impBase;
  const ns = target.ns || '';
  const fqn = target.fqn || '';
  // PHP 的命名空间分隔符是 `\`（`GuzzleHttp\Client`）、其它语言是 `.` —— 比命名空间 / 限定名时两边都归一成 `.`
  //（不归一的话 PHP 的 use 一条也对不上：实测 guzzle 上 import 口径只有 2%）
  const dot = (s) => String(s).replace(/\\/g, '.');
  if (fqn && (imp === fqn || dot(imp) === dot(fqn))) return true;
  if (ns) {
    const di = dot(imp), dn = dot(ns);
    if (di === dn) return true;
    if (di.startsWith(`${dn}.`) || dn.startsWith(`${di}.`)) return true;
  }
  // 相对路径那种 import（'./f1.js' / '../util'）走模块名这条路：比目标文件的模块名
  if (target.path && moduleKey(imp) === moduleKey(target.path)) return true;
  // Elixir：模块名是 CamelCase（`Phoenix.Controller`）、文件名是 snake_case（controller.ex）——
  // 对 .ex/.exs 目标做一次**大小写不敏感**的模块名比对（只对 Elixir 开：别的语言里大小写是有意义的）
  if (target.path && /\.exs?$/i.test(String(target.path))) {
    const tail = String(imp).split(/[./\\]/).filter(Boolean).pop() || '';
    if (tail && tail.toLowerCase() === moduleKey(target.path).toLowerCase()) return true;
  }
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
  // Rust 的 `use crate::flags::defs::FLAGS` 不写 crate 根，光比模块名 / 前缀都对不上：
  // `::` 当分隔符按**段后缀**比 —— 导入的段是目标路径（去扩展名）的后缀、或目标目录的后缀；
  // 再让一步：去掉导入最后一段（`::FLAGS` 这种“模块::符号”尾巴）再比。只对 .rs 目标开这一档。
  // 依据：ripgrep 实测（2026-09-22）—— 不认这一档时跨文件引用的有支撑是 0%。
  if (tPath.toLowerCase().endsWith('.rs') && imp.includes('::')) {
    const low = (x) => x.toLowerCase();
    const pathSegs = tPath.split('/').filter(Boolean);
    pathSegs[pathSegs.length - 1] = pathSegs[pathSegs.length - 1].replace(/\.[^.]+$/, '');
    const pathL = pathSegs.map(low);
    let impSegs = imp.split('::').join('/').split('/').filter(Boolean).map(low);
    if (impSegs[0] === 'crate') impSegs = impSegs.slice(1);      // `crate::x` → 相对那条路径比（crate 根不写在 import 里）
    const isSuffix = (a, b) => a.length > 0 && a.length <= b.length && a.every((x, i) => x === b[b.length - a.length + i]);
    if (isSuffix(impSegs, pathL) || isSuffix(impSegs, pathL.slice(0, -1))
      || isSuffix(impSegs.slice(0, -1), pathL) || isSuffix(impSegs.slice(0, -1), pathL.slice(0, -1))) return true;
  }
  // ③ 仓库内“包名自引用”（ant-design / ripgrep / gin 实测）：import 写的是**仓库自身某个包的名字** ——
  //   · `antd` / `@scope/pkg`（package.json）· `grep_matcher::Matcher`（Cargo.toml 的 crate 名）
  //   · `github.com/gin-gonic/gin/render`（go.mod 的 module 路径）
  // 裸名字：只证明“目标与引用方同属这个包”、不指向具体文件（最弱的一档）；
  // 带子路径：子路径要真的落在那个位置才算（`/` 子路径直接对目录；`::` 是 Rust 的模块 / 符号，
  // 只有一段时当符号名，回到“同 crate”那一档；多段时去掉最后一段再对）。
  // 实测：ant-design 上 3,364 条“仅同名”的引用方 import 就是包名 `antd`；ripgrep 上 `grep_matcher::Matcher` 这类跨 crate 引用同理。
  if (ctx?.packages?.length) {
    for (const p of ctx.packages) {
      if (!p?.name) continue;
      const base = p.dir ? `${p.dir}/` : '';
      if (imp === p.name) { if (tPath.startsWith(base)) return true; continue; }
      const sep = imp.startsWith(`${p.name}/`) ? '/' : imp.startsWith(`${p.name}::`) ? '::' : null;
      if (!sep) continue;
      let rest = imp.slice(p.name.length + sep.length);
      if (sep === '::') rest = rest.split('::').join('/');
      if (sep === '::' && !rest.includes('/')) { if (tPath.startsWith(base)) return true; continue; }   // `crate::Item`：符号名
      const cuts = [rest];
      if (sep === '::') cuts.push(rest.slice(0, rest.lastIndexOf('/')));
      for (const c of cuts) {
        if (!c) continue;
        for (const prefix of [`${base}${c}`, `${base}src/${c}`]) {   // 后者是 Rust 的常见布局（crate 根在 src/ 下）
          if (tPath === prefix || tPath.startsWith(`${prefix}/`) || tPath.startsWith(`${prefix}.`)) return true;
        }
      }
    }
  }
  // ③b TS/JS 的路径别名（tsconfig / jsconfig 的 paths）：`@/x` → `<baseUrl>/x`，再按路径前缀比
  if (ctx?.aliases?.length) {
    for (const a of ctx.aliases) {
      if (!a?.prefix || !imp.startsWith(a.prefix)) continue;
      const cand = `${a.dir}/${imp.slice(a.prefix.length)}`.replace(/\/+/g, '/');
      if (tPath === cand || tPath.startsWith(`${cand}/`) || tPath.startsWith(`${cand}.`)) return true;
    }
  }
  return false;
}

/** import 字符串的可能路径形态：原样 / 点换斜杠 / 双冒号换斜杠 / 去掉源码扩展名（'./x/y.js' → 'x/y'） */
function importPathVariants(imp) {
  const norm = imp.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\.+/, '');
  const out = new Set([norm, norm.replace(/\./g, '/'), norm.replace(/::/g, '/')]);
  const m = norm.match(/\.([A-Za-z0-9]+)$/);
  if (m && SRC_EXT.has(m[1].toLowerCase())) out.add(norm.slice(0, -(m[1].length + 1)));
  return [...out].filter(Boolean);
}
