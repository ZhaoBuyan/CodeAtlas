// 这个文件**故意没有任何函数/类声明** → 引擎会给它合成一个 module 节点，名字 = 文件名主干 `gamma`。
// 这条夹具钉的是候选①：裸名 `gamma` 什么时候才允许接到它上面。
const value = 41;
const other = value + 1;
module.exports = { other };
