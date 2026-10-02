// CommonJS 的 `require` 绑定是**导入绑定**，不是局部变量：
// `const { alpha } = require('./a.js')` 之后，`alpha` 指的就是 a.js 里那个函数 —— 这条边**必须**存在。
// （Babel 编译出来的 JS 满地是这个形状：`var _r = require('x'), y = _r.y`；
//   要是把这种名字当局部变量，真依赖会被整片砍掉 —— 实测 oss4-graphql-tools 一次砍掉 166 条。）
const { alpha } = require('./a.js');

export function viaRequire() {
  return alpha();
}
