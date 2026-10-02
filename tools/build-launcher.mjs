/**
 * 构建「开发模式的启动器」—— 产物是仓库根的 CodeAtlas.exe（引擎直接读 exe 旁边的 src/）。
 *
 *   npm run launcher   →   node tools/build-launcher.mjs
 *
 * ⚠ 为什么不直接写 `dotnet publish ... -o .`（老写法，2026-10-01 实测必失败，别再改回去）：
 *   输出目录 = **仓库根** 时，MSBuild 的 DefaultItemExcludes 会把 `launcher/` 下的 .cs **全部排掉**
 *   （实测：默认 Compile 项 3 个 → 输出指向仓库根 0 个），于是编译器报
 *   `CS5001: 程序不包含适合于入口点的静态 "Main" 方法` —— 看着像代码被删了，其实一行没动。
 *   dotnet SDK 10.0.401 上必现；CI 用的是 9.0.x，所以这条脚本一直没被 CI 覆盖到（已加门，见 ci.yml）。
 *   所以：先发到 out-launcher/（.gitignore 里已忽略），再把 exe / pdb 拷回仓库根。
 *
 * 为什么"发到 out-launcher 再拷回来"就行：发布目录只影响编译器收哪些源文件，
 * 不影响开发模式定位 —— FindDevRoot() 是从 exe 所在目录**往上**找 src/cli.mjs 的
 * （实测 `out-launcher/CodeAtlas.exe --headless --list-langs` 报的 devRoot 就是仓库根）。
 *
 * 发行版（内嵌引擎包）不走这里，走 `npm run publish:sc` / `publish:lite`（tools/build-payload.mjs）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const STAGE = path.join(ROOT, 'out-launcher');
const CSPROJ = path.join(ROOT, 'launcher', 'CodeAtlas.Launcher.csproj');
const KEEP = ['CodeAtlas.exe', 'CodeAtlas.pdb'];

console.log('\n构建启动器（开发模式）→ 仓库根 CodeAtlas.exe\n');
execFileSync('dotnet', ['publish', CSPROJ, '-c', 'Release', '-o', STAGE], { stdio: 'inherit', cwd: ROOT });

const copied = [];
for (const f of KEEP) {
  const src = path.join(STAGE, f);
  if (!fs.existsSync(src)) {
    console.error(`\n发布产物缺 ${f}：${src}\n（dotnet publish 成功但没出这个文件 —— 检查 launcher/*.csproj 的 AssemblyName / PublishSingleFile）`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(ROOT, f));
  copied.push(`${f}（${(fs.statSync(src).size / 1048576).toFixed(2)} MB）`);
}
console.log(`\n  ✓ ${copied.join(' · ')} → 仓库根`);
console.log('    自检：.\\CodeAtlas.exe --headless --list-langs --log launcher.log\n');
