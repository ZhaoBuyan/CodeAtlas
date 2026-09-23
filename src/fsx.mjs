/**
 * 文件系统补丁：绕开**坏的 `fs.rmSync`**。
 *
 * 背景（2026-09-23 实测）：DSH Desktop 自带的 node 二进制
 * （`D:\DSH Desktop\resources\app\node_modules\node\bin\node.exe`，**v24.9.0**）
 * 的 `fs.rmSync` **彻底失效 —— 不抛错，返回后文件/目录原封不动**：
 * ```
 * node v24.9.0  rmSync(file)                    threw=none  exists=true
 *               rmSync(dir,{recursive,force})   threw=none  exists=true
 *               rmSync(非空目录,{recursive})     threw=none  exists=true
 *   对照         unlinkSync(file)                threw=none  exists=false   ← 正常
 *               fs.promises.rm(file)            threw=none  exists=false   ← 正常
 * ```
 * 同一个脚本在系统 node **v24.18.0** 上全部正常 —— 所以是那个二进制的毛病，不是平台、也不是
 * `NODE_COMPILE_CACHE`（清掉缓存照样失效，已对照测过）。
 *
 * 为什么必须补：`rmSync` 是**静默**失效，于是所有"先删再写、用存在性判成败"的地方都会退化成
 * "拿到上一轮的旧数据当成这一轮的结果"。本仓库踩过两次同类事故（`9f44f12` 修的是测试基架的版本），
 * 而 `src/scan.mjs` 里清理解析子进程产物那处一旦静默失效，**上一轮的旧 emit 会被当成这一轮的结果读走**。
 *
 * 做法：优先 `fs.rmSync`（好环境上它就是对的），**删完复查一次**；还在就退到手写的
 * `unlinkSync` + 自底向上 `rmdirSync`。不依赖"它有没有抛错"这个不可信的信号。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 真的删干净了吗？（不信任 rmSync 的返回值与异常） */
const gone = (p) => !fs.existsSync(p);

/** 手写递归删除：先删内容、再自底向上删目录 */
function rmrfManual(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return gone(p); }
  if (!st.isDirectory()) {
    try { fs.unlinkSync(p); } catch { /* 只读文件在 Windows 上要改属性再删 */ }
    if (!gone(p)) { try { fs.chmodSync(p, 0o666); fs.unlinkSync(p); } catch { } }
    return gone(p);
  }
  let entries = [];
  try { entries = fs.readdirSync(p); } catch { return false; }
  let allGone = true;
  for (const name of entries) if (!rmrfManual(path.join(p, name))) allGone = false;
  if (!allGone) return false;
  try { fs.rmdirSync(p); } catch { }
  return gone(p);
}

/**
 * 递归删除（`fs.rmSync(p, {recursive:true, force:true})` 的安全替代）。
 * 返回 `true` = 已不存在（本来就不在也算成功，与 `force` 语义一致）。
 */
export function rmrf(p) {
  if (!p || gone(p)) return true;
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 下面兜底 */ }
  if (gone(p)) return true;
  return rmrfManual(p);
}

/** 删单个文件（`fs.rmSync(p, {force:true})` 的安全替代）。返回 `true` = 已不存在。 */
export function rmFile(p) {
  if (!p || gone(p)) return true;
  try { fs.rmSync(p, { force: true }); } catch { /* 下面兜底 */ }
  if (gone(p)) return true;
  return rmrfManual(p);
}
