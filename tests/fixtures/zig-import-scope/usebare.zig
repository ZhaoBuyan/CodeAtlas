// 夹具（精度轮 18）**负向**：导入了 other.zig，却**裸写** `ScopeWidget`（它在 alpha.zig 里、没导入）
// —— Zig 里这编不过 ⇒ `UseBare → alpha.zig::ScopeWidget` **不该存在** ✗。
const other = @import("other.zig");

pub fn use() void {
    _ = ScopeWidget{};
    _ = other.Other{};
}
