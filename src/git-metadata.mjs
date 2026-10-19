/** Git snapshot and per-file history; extracted without changing matching semantics. */
import { execFileSync } from 'node:child_process';

export function gitInfo(root, measure) {
  const run = (args) => {
    const invoke = () => { try {
      return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim();
    } catch { return null; } };
    return measure ? measure(`info.${args.join(' ')}`, invoke) : invoke();
  };
  const commit = run(['rev-parse', '--short', 'HEAD']);
  if (!commit) return null;
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = run(['status', '--porcelain']);
  return { commit, branch, dirty: Boolean(status) };
}

/**
 * git 热度：最近 200 次提交里每个文件被改了几次、最近一次是什么时候。
 * 给地图当“我该从哪读起”的着色维度用（见 web 的「git 热度」）。
 *
 * 三个坑：
 *  - `-c core.quotepath=false`：否则非 ASCII 路径会被 git 转义成 `"\346\226..."`，跟 bundle 里的相对路径对不上；
 *  - 扫描根是仓库的子目录时，git 给的路径是**仓库根**相对的 → 用 `rev-parse --show-prefix` 去掉那段前缀；
 *  - 非 git 仓库（或 git 不可用）返回 null，bundle 里就不带 git 字段（不是“全 0”，而是“不知道”）。
 */
export function gitHeat(root, measure) {
  const run = (args) => {
    const invoke = () => { try {
      return execFileSync('git', ['-c', 'core.quotepath=false', '-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString();
    } catch { return null; } };
    return measure ? measure(`heat.${args.join(' ')}`, invoke) : invoke();
  };
  const log = run(['log', '--numstat', '--pretty=format:%ct', '-n', '200']);
  if (log == null) return null;
  const prefix = ((run(['rev-parse', '--show-prefix']) || '').trim());
  const rel = (p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : prefix ? null : p);
  const byPath = new Map();
  let commits = 0;
  let ts = 0;
  for (const line of log.split('\n')) {
    if (/^\d+$/.test(line)) { ts = Number(line) * 1000; commits++; continue; }
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);   // 二进制文件的行数是 "-"
    if (!m) continue;
    const p = rel(m[3]);
    if (!p) continue;
    const cur = byPath.get(p) || { changes: 0, lastTs: 0 };
    cur.changes++;
    if (ts > cur.lastTs) cur.lastTs = ts;
    byPath.set(p, cur);
  }
  // 跟踪清单：用来区分“在仓库里但一直没改”和“压根没提交过”（新增/未提交的文件要在图上单独看得到）
  const tracked = new Set();
  for (const p of (run(['ls-files', '-z']) || '').split('\0')) {
    const r = p && rel(p);
    if (r) tracked.add(r);
  }
  return { byPath, tracked, commits };
}
