// 夹具（精度轮 16）**正向**：这也是个全局脚本（没有 import）——
// 它裸写 `ScopeWidget` 是**合法**的（脚本间共享全局）⇒ `UseScript → shared.js::ScopeWidget` **必须存在** ✓。
// 这正是"`.js` 不能一刀切上闸"的原因：本样本里 375 条跨文件 unique 边中 **204 条**在这种脚本里。
class UseScript {
  make() {
    return new ScopeWidget();
  }
}
