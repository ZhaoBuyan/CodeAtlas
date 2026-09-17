/**
 * 语法包冒烟测试：把 WASM_ROOTS 里的每个 wasm 都真加载 + 真解析一遍，分清能用 / 不能用。
 *   node tests/probe-abi.mjs
 *
 * 历史：这条脚本原来是"ABI 兼容性审计"——当年运行时锁在 web-tree-sitter 0.20.8（ABI ≤ 14），
 * 比它新的 wasm 能加载但一解析就崩，所以要逐个筛。升到 0.27（支持 ABI 15/16、单门内存约 11 MB）之后，
 * 那类筛选需求基本消失，现在它的作用是：换了语法包来源 / 自己编了新 wasm 之后，快速确认全都能用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Parser, Language, LANGUAGE_VERSION, MIN_COMPATIBLE_VERSION } from 'web-tree-sitter';
import { WASM_ROOTS } from '../src/languages.mjs';

await Parser.init();
// 这两个常量要等运行时初始化后才有效（0.27 里是懒赋值的 live binding）
const abiRange = (Number.isFinite(LANGUAGE_VERSION) && Number.isFinite(MIN_COMPATIBLE_VERSION))
  ? `语法 ABI ${MIN_COMPATIBLE_VERSION}~${LANGUAGE_VERSION}`
  : '语法 ABI 区间（本次没取到，不影响下面结果）';

/** 把两个来源下的 wasm 都列出来：主来源是 <语言>/tree-sitter-<语言>.wasm，vendor 是平铺的 */
function listWasms() {
  const out = [];
  for (const root of WASM_ROOTS) {
    if (!fs.existsSync(root)) continue;
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory()) {
        for (const f of fs.readdirSync(path.join(root, e.name))) {
          if (f.endsWith('.wasm')) out.push({ label: `${e.name}/${f}`, p: path.join(root, e.name, f), root: path.basename(root) });
        }
      } else if (e.name.endsWith('.wasm')) {
        out.push({ label: `${e.name}`, p: path.join(root, e.name), root: path.basename(root) });
      }
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

const files = listWasms();
const ok = [];
const bad = [];
for (const f of files) {
  let note = 'ok';
  try {
    const lang = await Language.load(f.p);
    const p = new Parser();
    p.setLanguage(lang);
    const tree = p.parse('a');
    if (!tree || !tree.rootNode) note = '解析返回空';
    tree?.delete();
    p.delete();
  } catch (e) {
    note = String(e?.message || e).slice(0, 60).replace(/\s+/g, ' ') || '（错误信息为空）';
  }
  const tag = `${f.label}${f.root === 'wasm' ? '（vendor）' : ''}`;
  (note === 'ok' ? ok : bad).push(note === 'ok' ? tag : `${tag} → ${note}`);
}

console.log(`\n运行时：web-tree-sitter（${abiRange}）`);
console.log(`\n可用（${ok.length}）：`);
console.log('  ' + ok.join('\n  '));
console.log(`\n不可用（${bad.length}）：`);
console.log('  ' + (bad.length ? bad.join('\n  ') : '（无）'));
