/**
 * 从一份 JDK 裁出最小 Java 运行时，放进 vendor/jre/（用于 .jar 反编译，让完全版"什么都不用装"）。
 *
 *   node tools/build-jre.mjs --jdk "C:/path/to/jdk-25"
 *   （不给 --jdk 时按 PATH 里的 jlink 找；Windows 上常见于 C:/Program Files/Java/<版本>）
 *
 * 为什么是这两个模块（实测结论，别随手改）：
 *   - java.base      —— 必须；
 *   - java.logging   —— cfr 用到 java.util.logging.Formatter，只带 java.base 会 NoClassDefFoundError；
 *   - 实测能跑通：`<jre>/bin/java -jar vendor/cfr.jar some.jar --outputdir out` 成功出 .java。
 *
 * 体积：microsoft-jdk-25.0.4.1-windows-x64 裁完 = 92 个文件 / 30.1 MB（含 legal/ 15 个许可证原文，别删）。
 * 另外会把 lib/jvm.lib 删掉（1.2 MB，那是链接用的导入库，运行时不需要）。
 *
 * vendor/jre 已经提交进仓库了，构建时不需要跑这一步；换 JDK 版本 / 改模块列表时才需要重跑，
 * 跑完记得把 vendor/jre 一起提交（连同 legal/ 下的许可证原文）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(ROOT, 'vendor', 'jre');
const MODULES = 'java.base,java.logging';

const args = process.argv.slice(2);
const jdkArg = args.includes('--jdk') ? args[args.indexOf('--jdk') + 1] : null;
const jlink = jdkArg ? path.join(jdkArg, 'bin', process.platform === 'win32' ? 'jlink.exe' : 'jlink') : 'jlink';

if (!fs.existsSync(jlink) && jdkArg) {
  console.error(`找不到 jlink：${jlink}\n（--jdk 要指到 JDK 根目录，例如 C:/Users/you/jdk-25.0.4.1+1）`);
  process.exit(1);
}

console.log(`\n裁 Java 运行时 → vendor/jre\n  jlink：${jlink}\n  模块：${MODULES}\n`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

execFileSync(jlink, [
  '--add-modules', MODULES,
  '--strip-debug',
  '--no-header-files',
  '--no-man-pages',
  '--compress=zip-6',
  '--output', OUT,
], { stdio: 'inherit' });

// 链接用的导入库，运行时不需要（省 1.2 MB）
const jvmLib = path.join(OUT, 'lib', 'jvm.lib');
if (fs.existsSync(jvmLib)) fs.rmSync(jvmLib);

const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)); };
walk(OUT);
const mb = (files.reduce((s, f) => s + fs.statSync(f).size, 0) / 1048576).toFixed(1);
console.log(`\n完成：${files.length} 个文件 / ${mb} MB`);
console.log('检查：vendor/jre/bin/java.exe 在、vendor/jre/legal/ 在（许可证原文，别删）、lib/jvm.lib 已删。');
console.log('然后跑一次实测：node src/cli.mjs ingest <某个.jar>（应报"（自带）"）\n');
