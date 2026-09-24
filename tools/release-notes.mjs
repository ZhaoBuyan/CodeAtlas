/**
 * 从 CHANGELOG.md 里抽出**指定版本**那一节，写成 Release 正文文件。
 *
 * 为什么要有这个脚本（而不是手写正文 CV/ 到工作文档里）：
 *   `工作文档/` 在 `.git/info/exclude` 里**不进仓库**，而发布是 **CI（GitHub Actions）** 干的 ——
 *   checkout 之后根本看不到那个目录。于是以前的 `ci.yml` 只能用 `generate_release_notes`
 *   （自动生成的提交列表），和项目一贯的"策展口径"（用户看得见的变化 + 如实写局限）不是一回事。
 *   `CHANGELOG.md` 是**在仓库里**、且本来就是按版本分节、本来就写给用户看的 —— 拿它当唯一来源，
 *   正文与更新日志就不可能漂移（这也是 `modules.mjs` 那条"别两处各写一份"的同一条纪律）。
 *
 * 用法：
 *   node tools/release-notes.mjs <版本，如 1.7.0 或 v1.7.0> [输出文件]
 *   不传输出文件 → 打到 stdout。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 仓库 slug，只用于正文末尾那行 Full Changelog 对比链接。
 * `package.json` 的 name 是 `code-atlas`（npm 包名），和 GitHub 上的 `ZhaoBuyan/CodeAtlas` 不是一回事，
 * 所以不从那推导；要换仓库/换组织就改这一处（或用 CODEATLAS_REPO_SLUG 覆盖）。
 */
const REPO_SLUG = process.env.CODEATLAS_REPO_SLUG || 'ZhaoBuyan/CodeAtlas';

const raw = process.argv[2];
if (!raw) {
  console.error('用法：node tools/release-notes.mjs <版本，如 1.7.0 或 v1.7.0> [输出文件]');
  process.exit(2);
}
const version = String(raw).replace(/^v/, '').trim();
const outFile = process.argv[3];

const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const lines = changelog.split(/\r?\n/);

// 找 `## <version>（…）` 这一节的起止（到下一个 `## ` 为止）
const startRe = new RegExp(`^##\\s+v?${version.replace(/\./g, '\\.')}(\\s|$|（|\\()`);
let start = -1;
for (let i = 0; i < lines.length; i++) {
  if (startRe.test(lines[i])) { start = i; break; }
}
if (start < 0) {
  console.error(`✗ CHANGELOG.md 里找不到版本 ${version} 的小节（期望形如 "## ${version}（…）"）`);
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (/^##\s+/.test(lines[i])) { end = i; break; }
}

// CHANGELOG 的小节正文以**空行**开头（`## 1.7.0（…）` 之后那行是空的），
// 直接拼进正文会让标题后面多出两个空行 —— 去掉开头的空行，只留标题与正文之间那一行。
const section = lines.slice(start + 1, end);
while (section.length && section[0].trim() === '') section.shift();
while (section.length && section[section.length - 1].trim() === '') section.pop();

// GitHub 用 `generate_release_notes: true` 时会自动在末尾加一行对比链接
// （"**Full Changelog**: …/compare/v1.5.0...v1.6.0"）。改成 body_path 之后那行就没了 ——
// v1.7.0 因此成了唯一没有它的版本。这里自己补上，口径与 GitHub 一致。
// 前一个版本直接从 CHANGELOG 的小节顺序读（比调 git describe 稳：CI 里不用 fetch tag）。
let prev = null;
for (let i = start + 1; i < lines.length; i++) {
  const m = /^##\s+v?([0-9][0-9.]*)/.exec(lines[i]);
  if (m) { prev = m[1]; break; }
}
const fullChangelog = prev
  ? `**Full Changelog**: https://github.com/${REPO_SLUG}/compare/v${prev}...v${version}`
  : '';
if (!prev) console.error('⚠ CHANGELOG 里找不到更早的版本号 —— 这次不生成 Full Changelog 行');

const body = [`# CodeAtlas v${version}`, '', ...section, ...(fullChangelog ? ['', fullChangelog] : [])].join('\n').trim() + '\n';

if (outFile) {
  fs.writeFileSync(outFile, body);
  console.error(`✓ 已写出 v${version} 的 Release 正文 → ${outFile}（${body.split('\n').length} 行）`);
} else {
  process.stdout.write(body);
}
