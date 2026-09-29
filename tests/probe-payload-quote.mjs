/**
 * 打包脚本的**路径引用**测试（安全，2026-09-25；同日改成"真注入"红绿对照）。
 *   node tests/probe-payload-quote.mjs        （Windows / PowerShell）
 *
 * 背景：`tools/build-payload.mjs` 打 zip 那一步要把 `STAGE` / `OUT_ZIP` 拼进一条 PowerShell
 * `-Command` 字符串。旧写法是直接插值（`'${STAGE}'`）—— 这两个路径是从**仓库所在路径**推出来的
 * （`<仓库>/build/payload` 与 `<仓库>/launcher/payload.zip`），路径里只要有一个 `'`
 * （Windows 上合法：`C:\Users\O'Brien\…`），单引号字符串就被截断：**后面的内容变成在构建机上
 * 执行的 PowerShell**。
 *
 * 这条测试用"真注入"做红绿对照：目录名里放一段
 *   `x') ; New-Item -ItemType File -Path <marker> -Force ; ('`
 *   · 转义后（现在的写法）→ 整段只是一段字面量路径，zip 正常生成、**marker 不出现**；
 *   · 不转义（旧写法）→ PowerShell 真的执行 New-Item → **marker 出现**（这就是"构建机执行"）。
 * 正向跑一遍、反向跑一遍，两个方向都断言，这条闸才算证明了自己。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'win32') {
  console.log('— 非 Windows：跳过（这一步只跟 PowerShell 有关）');
  process.exit(0);
}

/** 与 tools/build-payload.mjs 里逐字一致：PowerShell 单引号字符串里 `'` 写两遍 */
const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-quote-'));
const marker = path.join(base, 'PWNED.txt');
// 目录名里塞"闭合引号 + 执行一条命令 + 再开一个引号"：语法上仍然合法（Windows 目录名允许这些字符）。
// ⚠ 注入串里**不能带路径分隔符**（`\` / `/` 在目录名里非法），所以 marker 用**裸文件名**，
//    靠给 PowerShell 设 cwd = base 落进临时目录。
const stage = path.join(base, `x') ; New-Item -ItemType File -Path PWNED.txt -Force ; ('`);
const zip = path.join(base, "out'.zip");
fs.mkdirSync(stage, { recursive: true });
fs.writeFileSync(path.join(stage, 'payload.json'), '{"ok":true}\n', 'utf8');

const checks = [];
const runPs = (cmd) => {
  try {
    return { ok: true, out: execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', stdio: 'pipe', cwd: base }) };
  } catch (e) {
    return { ok: false, out: String((e && (e.stdout || '') + (e.stderr || '')) || e.message) };
  }
};

// ① 转义后（现在的写法）：路径只是字面量 —— zip 生成、注入不执行
const psOk = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(stage)}, ${psQuote(zip)})`;
const rOk = runPs(psOk);
checks.push([rOk.ok, `转义后：PowerShell 正常结束${rOk.ok ? '' : `（${rOk.out.slice(0, 160)}）`}`]);
checks.push([fs.existsSync(zip) && fs.readFileSync(zip).length > 0, `转义后：zip 生成成功（${path.basename(zip)}）`]);
checks.push([!fs.existsSync(marker), '转义后：注入串没有被执行（marker 不出现）']);

// ② 反向对照（旧写法：直接插值）：同一个路径必须**真的执行**那段命令
// ⚠ 目标 zip 的名字**不能带 `'`**：带了会让整条命令变成语法错误（解析期就失败、什么都不执行），
//    那样反向对照就证明不了"注入可执行"了 —— 注入点只要 stage 那一处就够。
const zipOld = path.join(base, 'out-old.zip');
const psOld = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${stage}', '${zipOld}')`;
runPs(psOld);
checks.push([fs.existsSync(marker), '反向对照：不转义的旧写法**真的执行了**注入的命令（marker 出现）—— 证明这道闸有意义']);
if (fs.existsSync(marker)) fs.rmSync(marker, { force: true });

for (const [good, what] of checks) console.log(`${good ? '✓' : '✗'} ${what}`);
fs.rmSync(base, { recursive: true, force: true });
const bad = checks.filter(([g]) => !g).length;
console.log(bad ? `\n${bad} 处不通过` : '\n✓ 全部通过');
process.exitCode = bad ? 1 : 0;
