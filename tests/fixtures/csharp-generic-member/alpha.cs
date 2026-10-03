namespace Gamma;

// 夹具（精度轮 7）：两个类都在 `Gamma` 命名空间里 —— 与 use.cs 同命名空间，
// 所以第 6 轮那道"裸名必须在作用域里"的闸**不会**参与，这里量的纯粹是"成员名"那条判据。
public class MemberName
{
    public int V;
}

// 正向对照：`PlainType` 在 use.cs 里是**普通类型引用**（前面不是点号）→ 必须接得上。
public class PlainType
{
}
