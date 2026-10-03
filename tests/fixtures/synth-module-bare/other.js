// 没有任何 import（也没有同名局部绑定）→ 裸名 `gamma` **不该**接到 gamma.js 的合成 module 节点上。
// 这一条就是候选①要治的"名字撞文件名"错边（numpy 28.8% / tokio 40% 的边是这么来的）。
const doubled = Number(gamma) * 2;
module.exports = { doubled };
