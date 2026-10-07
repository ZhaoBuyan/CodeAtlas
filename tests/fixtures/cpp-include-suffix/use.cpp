// 夹具（精度轮 20）：只 include mid1.hpp，而 `nsb::Widget` 在 **b/thing.hpp**（经 mid1.hpp 两跳可达）。
// 裸写 `Widget` 的两个候选（`nsa.Widget`@a/thing.hpp、`nsb.Widget`@b/thing.hpp）里，只有后者**经 include 链可达**
// ⇒ 这条边**必须存在、且是 import 档** ✓（依据来自传递闭包）。
// 反向对照：旧引擎上这条边**不存在**（同目录过滤把候选清空 ⇒ 中间那条 include 断链 ⇒ 无据 ⇒ 被闸砍）✗。
#include "mid1.hpp"

void f() {
  Widget x;
  (void)x;
}
