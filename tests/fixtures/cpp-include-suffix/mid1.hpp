// 夹具（精度轮 20）：中间头 —— include 的是 `"b/thing.hpp"`，而工程里 `a/thing.hpp` 与 `b/thing.hpp`
// **同 stem**（'thing'）、都不在引用方目录 ⇒ 旧代码的同目录过滤会把候选**清空** ✗ ⇒ 这条 include 丢掉、
// 闭包断链 ⇒ `use.cpp` 里裸写 `Widget` 就成了"跨文件零依据"，被 C/C++ 的闸砍掉 ✗。
// 修好后：按**路径后缀**（`b/thing.hpp` 的段序列）唯一命中 ✓ ⇒ 闭包连上 ⇒ 边保留且是 import 档 ✓。
#include "b/thing.hpp"
