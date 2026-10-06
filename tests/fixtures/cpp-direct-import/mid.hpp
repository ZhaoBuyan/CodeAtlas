// 夹具（精度轮 13）：中间头 —— use.cpp **只 include 它**，于是 agg.hpp 里的 `nsb::Widget`
// 只是"闭包推出来的"候选（间接依据），而 direct.hpp 是 use.cpp **自己 include** 的（直接依据）。
#include "agg.hpp"
