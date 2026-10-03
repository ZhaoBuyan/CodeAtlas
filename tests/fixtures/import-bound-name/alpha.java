// 夹具（精度轮）：`alpha` 在 imports.java 里被一条**外部库** import 绑定了 → 裸名 `alpha`
// 不该再接回这个类上（图里没有那条 import 指向的东西，也不能"回落到同名"）。
class alpha {
    int value() { return 1; }
}

// 正向对照：`gamma` 没有被任何 import 绑定 → imports.java 里的裸引用**应该**接得上。
class gamma {
    int value() { return 2; }
}
