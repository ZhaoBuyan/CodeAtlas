// 夹具（精度轮）：`Metadata` 只作为**局部变量身上的成员名**出现在 b.java 里 → 不该接到这个类上。
class Metadata {
    int v;
}

// 正向对照：`gamma` 在 b.java 里是**普通类型引用**（不是点号后面的成员名）→ 必须接得上。
class gamma {
    int w;
}
