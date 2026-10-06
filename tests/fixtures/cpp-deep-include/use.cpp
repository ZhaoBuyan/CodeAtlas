// 夹具（精度轮 15）：**传递 include 链算不算依据**。
//
// `use.cpp` 只 include `mid1.hpp`，而 `nsa::Widget` 定义在 **3 跳以外**的 `deep.hpp`
// （use.cpp → mid1.hpp → mid2.hpp → deep.hpp）。C/C++ 的语义就是"经过任意层 include 都可见"⇒
// 这条边**有语言层面的依据** ✓，不该被记成"猜的"。
// 实测来源：jemalloc 的 `src/extent.c` 只 include `jemalloc_internal_includes.h`，
// 而它用的 `edata_t` 在 `internal/edata.h`（3 跳以外）—— redis 上这类升档抽样全是真的
// （`extent.c → edata.h::edata_t` ×101 · `ctl.c → tsd_types.h::tsd_t` ×69 · `arena.c → …::tsdn_t` ×59）。
//
// ⚠ **只影响档位、不影响选边**：解析仍按 ≤2 跳的闭包挑候选（换传递会丢真边：sqlite 曾丢
// `btree.c → btreeInt.h::BtShared` ×95）⇒ 本夹具断言"边存在 **且** 档位是 import"；
// 反向对照：旧引擎上这条边**存在**、但档位是 `unique`（"猜的"）✗。
#include "mid1.hpp"

void f() {
  nsa::Widget x;
  (void)x;
}
