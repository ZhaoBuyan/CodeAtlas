// A3 夹具（JavaScript）：**顶层函数名与小写局部变量名同名**。
// `alpha` 是 b.js 里某个函数内 `const alpha` 的名字；那个函数里的 `alpha` 是变量，
// 不该跨文件接到这个函数上（负向断言）。
export function alpha() {
  return 1;
}

// 正向对照：`gamma` 不是任何局部绑定名，裸引用**应该**接得上。
export function gamma() {
  return 2;
}
