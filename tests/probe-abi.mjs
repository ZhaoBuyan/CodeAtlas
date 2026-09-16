/**
 * 语法兼容性审计：当前运行时是 web-tree-sitter 0.20.8（ABI ≤ 14），
 * 比它新的 wasm 能"加载"但一解析就崩。这个脚本把每个 wasm 都真解析一下，分清能用/不能用。
 *   node tests/probe-abi.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'web-tree-sitter';
import { WASM_DIR } from '../src/languages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
await Parser.init();

const files = fs.readdirSync(WASM_DIR).filter((f) => f.endsWith('.wasm')).sort();
const ok = [];
const bad = [];
for (const f of files) {
  let note = 'ok';
  try {
    const lang = await Parser.Language.load(path.join(WASM_DIR, f));
    const p = new Parser();
    p.setLanguage(lang);
    const tree = p.parse('a');
    if (!tree || !tree.rootNode) note = '解析返回空';
    tree?.delete();
    p.delete();
  } catch (e) {
    note = String(e?.message || e).slice(0, 60).replace(/\s+/g, ' ');
  }
  (note === 'ok' ? ok : bad).push(`${f.replace('tree-sitter-', '').replace('.wasm', '')}${note === 'ok' ? '' : ' → ' + note}`);
}
console.log(`\n可用（${ok.length}）：`);
console.log('  ' + ok.join('  '));
console.log(`\n不可用（${bad.length}）：`);
console.log('  ' + bad.join('\n  '));
