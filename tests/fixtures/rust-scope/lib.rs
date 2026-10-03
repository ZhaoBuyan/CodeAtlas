// 夹具（精度轮 7）：Rust 的裸名跨文件规则。
mod alpha;

// 正向对照：`ScopePlain` 被 use 进来了 → 裸写它**必须**接得上（而且是 import 档）。
use crate::alpha::ScopePlain;

// 负向：`ScopeWidget` **没有** use（这里故意不写）→ 裸写它在语义上指不到 alpha.rs 里那个类型
// （编译都过不去）→ `lib → ScopeWidget` **不该存在**。
// 实测这就是 rust-analyzer 上 7,218 条错边的形状（`Option`/`Debug`/`Clone` 撞测试夹具里那份"假标准库"）。
pub fn negative() {
    let _ = ScopeWidget;
}

pub fn positive() {
    let _ = ScopePlain;
}
