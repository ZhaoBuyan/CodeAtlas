// 夹具（精度轮 18）**正向**：`@import` 拿到容器后写**限定名** → 这条边必须接得上、且是 import 档 ✓。
const alpha = @import("alpha.zig");

pub fn use() void {
    _ = alpha.ScopeWidget{};
}
