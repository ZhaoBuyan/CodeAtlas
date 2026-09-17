/**
 * 引擎侧的语言（英文支持第②步起用）。
 *
 * 语言从环境变量 CODEATLAS_LANG 来：启动器会把它设成界面选的语言（子进程自动继承）；
 * 不用启动器、直接跑 `node src/cli.mjs` 或让 AI 客户端连 MCP 的人，可以自己设：
 *   CODEATLAS_LANG=en   → 引擎输出、MCP 描述与输出都用英文
 * 认不出的一律当中文（默认不变）。
 *
 * 用法：`t('中文文案', 'English text')` —— 中英都写在调用点上，改文案时一眼能同时看到两份。
 */
export const LANG = (() => {
  const v = String(process.env.CODEATLAS_LANG || '').trim().toLowerCase();
  return v.startsWith('en') ? 'en' : 'zh';
})();

export const isEn = LANG === 'en';

/** 按当前语言二选一 */
export const t = (zh, en) => (isEn ? en : zh);

/**
 * 数据里的「哨兵值」→ 显示文案的映射（用户拍板：不给数据翻两套语言）。
 *
 * bundle / facets 里存的是**中性固定值**（英文），显示层统一走这里 —— 好处：切语言不用重扫、
 * 同一份 bundle 中英共用；右边也把老 bundle（旧版本写下的中文哨兵）兜住。
 * 只映射「工具自己生成」的那几个词；用户自己起的系统名一律原样返回。
 */
const SYS_LABELS = {
  '(unclassified)': ['(未分类)', '(unclassified)'],
  '(未分类)': ['(未分类)', '(unclassified)'],            // 老 bundle 兜底
  'Other': ['其他', 'Other'],
  '其他': ['其他', 'Other'],
  'Top level': ['顶层', 'Top level'],
  '顶层': ['顶层', 'Top level'],
  'root': ['根目录', 'root'],
  '根目录': ['根目录', 'root'],
  '(root)': ['(根目录)', '(root)'],
  '(根目录)': ['(根目录)', '(root)'],
};

/** 系统名 → 当前语言的显示文案（认不出就原样返回） */
export const sysLabel = (name) => {
  const m = SYS_LABELS[name];
  return m ? (isEn ? m[1] : m[0]) : name;
};

/** 这个系统名是不是「没归到任何规则」那个哨兵 —— 拿它比**数据值**，别拿显示文案去比 */
export const isUnclassified = (name) => name === '(unclassified)' || name === '(未分类)';
