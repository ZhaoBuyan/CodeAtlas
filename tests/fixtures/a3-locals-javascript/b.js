// 同一个文件里两个函数，用来钉**作用域级**（而不是文件级）的局部绑定：
//   · `shadowed()` 里声明了 `const alpha` → 这个函数里的 `alpha` 是变量，**不该**跨文件接到 a.js 的 alpha 上；
//   · `genuine()` 里没有同名局部绑定 → 这个 `alpha` 是**真引用**，**必须**接得上。
// ⚠ 文件级的老口径（A3 第一版：局部名按**整个文件**记）会把 `genuine` 这条真边一起砍掉 ——
//    这正是 2026-10-03 那轮要修的（仓库自扫里 src/*.mjs 的 68 条真 `t('中文','English')` 就是这么丢的）。
export function shadowed() {
  const alpha = 1;
  return alpha + 1;
}

export function genuine() {
  return alpha();
}
