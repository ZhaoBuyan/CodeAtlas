// 负向：**没有 import** 就裸写 `ScopeWidget`（它在 alpha.ts 里）—— TS 里这编译不过
// → `gamma.useWrong → alpha.ts::ScopeWidget` **不该存在**（实测 ant-design 那 871 条 unique 就是这个形状：
//   `title` / `result` / `MouseEvent` 这类局部名或 DOM 全局被当作跨文件类型名，撞上别处的同名声明 ✗）。
// 量过的风险面：TS/JS/Vue 的 2,248 条 unique 里，目标落在 `.d.ts`（ambient 声明文件）的是 **0 条** ——
// 也就是"砍到合法 ambient 全局引用"这个担心在这批样本上不存在 ✓。
export const useWrong = () => new ScopeWidget();
