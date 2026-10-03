// `holder.Metadata()` —— `Metadata` 是**局部变量 holder 身上的成员名**，不是跨文件引用：
// 这类"成员名撞同名类"实测是 efcore 上最大的一类错边（`… → Query.Metadata ×597`、`→ Query.List ×662`）。
// 负向断言：`User → Metadata` **不该存在**。
// 正向对照：`gamma` 是普通类型引用（前面不是点号）→ `User → gamma` **必须存在**。
class User {
    void run() {
        Object holder = null;
        holder.Metadata();

        gamma g = new gamma();
    }
}
