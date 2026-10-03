// 夹具（精度轮 8）：`render` 在**这个文件**里 —— beta.ts **没有** import 它，
// 却 import 了同名的 `render`（来自外部包）→ 那是"名字已经有主"。
// 实测 ant-design 的 `Table.filter.test.tsx → scripts/check-site.ts::render`（×92）就是这个形状。
export const render = () => 1;
