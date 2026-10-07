// 夹具（精度轮 19）**负向**：`Widget2` 在 far.hpp 里，而 far.hpp **既没被本文件 include、
// 也不在 include 闭包里** —— C/C++ 里这个裸名根本解析不到 ⇒ **不该建边** ✗
// （实测同类：`unit-ordered_map.cpp → unit-regression1.cpp::string` ×68 —— 真身是 `std::string` 在图外；
//   `liolib.c → rio.h::FILE` ×30 —— 真身是 stdio 的 `FILE`）。
// 而**正向**在 use.cpp 里：`nsa::Widget` 定义在 3 跳以外、但**经 include 链可达** ⇒ 必须保留 ✓
//（闸查的是传递闭包 `closureDeep`，不是 ≤2 跳那层）。
#include "mid1.hpp"

void g() {
  Widget2 y;
  (void)y;
}
