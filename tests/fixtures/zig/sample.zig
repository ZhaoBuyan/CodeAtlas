const std = @import("std");

/// 颜色枚举
pub const Color = enum { red, green };

/// 点
pub const Point = struct {
    x: i32,
    y: i32,

    /// 求距离
    pub fn dist(self: Point) i32 {
        return self.x * self.x + self.y * self.y;
    }
};

pub fn helper(a: i32) i32 {
    if (a > 0) {
        return a;
    }
    return -a;
}

test "helper" {
    try std.testing.expect(helper(2) == 2);
}
