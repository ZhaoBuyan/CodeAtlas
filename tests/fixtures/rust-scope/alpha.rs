// 夹具（精度轮 7）：Rust 里裸名跨文件**必须有 `use`** —— 这两个类型只在本文件里声明，
// 别的文件想裸写它们就得 `use crate::alpha::…`。
pub struct ScopeWidget;

// 正向对照：lib.rs 里 `use crate::alpha::ScopePlain;` 之后裸名 `ScopePlain` 指得到它。
pub struct ScopePlain;
