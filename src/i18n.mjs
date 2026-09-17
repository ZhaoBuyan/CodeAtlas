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
