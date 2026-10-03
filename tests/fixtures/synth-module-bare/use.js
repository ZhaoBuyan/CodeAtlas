// require **指名道姓**导入了 ./gamma → 裸名 `gamma` 应该接到 gamma.js 的合成 module 节点上。
// （`const gamma = require('./gamma')` 是**导入绑定**，不是局部变量 —— 见 languages.mjs 的 isRequireDeclaration。）
const gamma = require('./gamma');
const doubled = Number(gamma) * 2;
module.exports = { doubled };
