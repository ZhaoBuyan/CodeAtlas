// 夹具（精度轮 13）：**按证据距离消歧**。
//
// 裸名 `Widget` 有两个同名候选：
//   · `direct.hpp` 里的 `nsa::Widget` —— 本文件**自己 include** 了它（**直接**依据 ✓）；
//   · `agg.hpp` 里的 `nsb::Widget` —— 只在 include **闭包**里（经 mid.hpp，**间接**依据）。
// 以前多候选都有据 → **弃权**（这条边整个丢掉 ✗）；现在挑"依据最近的那一份" → 接 `nsa::Widget` ✓。
// 实测来源：sqlite 的 `src/btree.c → src/btreeInt.h::BtShared`（×95，直接 include）就是被聚合文件
// `sqlite3.c` 里那份同名声明挤掉而消失的。
#include "direct.hpp"
#include "mid.hpp"

void f() {
  Widget x;
  (void)x;
}
