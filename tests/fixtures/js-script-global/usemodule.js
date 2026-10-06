// 夹具（精度轮 16）**负向**：这个文件**是模块**（有 import）——
// 模块里裸写 `ScopeWidget` 却没有 import 它，就是"名字已经有主"的猜边 ✗
// ⇒ `UseModule → shared.js::ScopeWidget` **不该存在**。
// （反向对照：旧引擎上这条是 `[unique]`，存在 ✗。）
import './userscript.js';

class UseModule {
  make() {
    return new ScopeWidget();
  }
}
