/**
 * 语法包内存探针：一门门加载（并真解析一个样例文件），逐行记内存，用来看
 * "一次加载多少门语法包会把进程撑爆"，以及"用完就释放"能不能把峰值压住。
 *
 *   node tests/probe-grammars.mjs                  # 全部保持加载（默认，真实扫描就是这个行为）
 *   node tests/probe-grammars.mjs --release         # 每门用完立刻释放（对照）
 *   node tests/probe-grammars.mjs csharp,lua,rust   # 只试这几门
 *
 * 逐行 appendFileSync 落盘（tests/.out/probe-grammars.log）：进程被 OOM 杀掉时，
 * 缓冲在管道里的 stdout 会丢，落盘的那份还看得到死在哪一门。
 */
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from 'web-tree-sitter';
import { LANGUAGES, resolveWasm } from '../src/languages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const args = process.argv.slice(2);
const release = args.includes('--release');
const useGc = args.includes('--gc');
const only = args.find((a) => !a.startsWith('--'));
const langs = Object.values(LANGUAGES).filter((l) => !only || only.split(',').includes(l.id));

/** 拿到一个手动 GC 的句柄（不用命令行 --expose-gc 也能拿到） */
const gc = (() => {
  if (!useGc) return null;
  try {
    v8.setFlagsFromString('--expose-gc');
    const f = vm.runInNewContext('gc');
    return typeof f === 'function' ? f : null;
  } catch { return null; }
})();

const LOG_DIR = path.join(HERE, '.out');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG = path.join(LOG_DIR, 'probe-grammars.log');
fs.writeFileSync(LOG, '', 'utf8');
const say = (s) => { fs.appendFileSync(LOG, s + '\n'); console.log(s); };
const mb = (n) => (n / 1048576).toFixed(0).padStart(6);

/** 在 tests/fixtures 里找一门语言的样例文件（没有就返回 null，那就只加载不解析） */
function findSample(lang) {
  const dir = path.join(HERE, 'fixtures');
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(dir, d.name))) {
      if (lang.exts.includes(path.extname(f).toLowerCase())) return path.join(dir, d.name, f);
    }
  }
  return null;
}

await Parser.init();
say(`模式：${release ? '用完就释放' : '全部保持加载（= 真实扫描的行为）'}${useGc ? ' + 手动 GC' : ''} · 共 ${langs.length} 门`);
say('  语言          rss(MB)  external(MB)  arrayBuffers(MB)');
if (useGc && !gc) say('  ⚠ 没拿到 GC 句柄，--gc 无效');
const kept = [];
let peak = 0;
for (const lang of langs) {
  const wasm = resolveWasm(lang);
  if (!fs.existsSync(wasm)) { say(`  ${lang.id.padEnd(12)} 缺 wasm（打包时被裁掉了），跳过`); continue; }
  let note = '';
  try {
    let p = new Parser();
    let language = await Language.load(wasm);
    p.setLanguage(language);
    const sample = findSample(lang);
    if (sample) p.parse(fs.readFileSync(sample, 'utf8'));
    else note = '  （没找到样例文件，只加载）';
    const m1 = process.memoryUsage();
    peak = Math.max(peak, m1.rss);
    if (release) {
      try { p.delete(); } catch { }
      p = null;
      language = null;
      if (gc) gc();
    } else kept.push(p);
    const m = process.memoryUsage();
    say(`  ${lang.id.padEnd(12)} ${mb(m.rss)} ${mb(m.external).padStart(13)} ${mb(m.arrayBuffers).padStart(16)}${note}`);
  } catch (e) {
    say(`  ${lang.id.padEnd(12)} 失败：${e.message}`);
  }
}
say(`\n加载完成 · 峰值 rss = ${mb(peak)} MB · 当前 rss = ${mb(process.memoryUsage().rss)} MB`);
kept.length = 0;
