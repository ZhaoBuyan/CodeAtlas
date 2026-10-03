// 泛型参数夹具：`alpha` 在 b.java 里是**类型参数**（`class Beta<alpha>`），不该跨文件接到这个类上。
class alpha {
    int value() { return 1; }
}

// 正向对照：`gamma` 不是任何类型参数名 → b.java 里的裸引用**应该**接得上（证明这张夹具里跨文件解析本来是通的）
class gamma {
    int value() { return 2; }
}
