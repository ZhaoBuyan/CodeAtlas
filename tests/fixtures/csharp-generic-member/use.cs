namespace Gamma;

// 负向：`holder.MemberName<int>()` 是**局部变量身上的泛型方法调用** —— `MemberName` 是成员名、
// 不是类型引用，所以 `Gamma.User → Gamma.MemberName` **不该存在**。
// 这正是第 5 轮发现的那个残留缺口：`MemberName` 包在 `generic_name` 里，
// 第 2 轮那道闸只看"前一个兄弟是不是 `.`"，于是漏了（实测 efcore 上 `e.Property<int>("Id")` 就是它）。
public class User
{
    void M()
    {
        var holder = Get();
        holder.MemberName<int>();

        PlainType p = null;
    }
}
