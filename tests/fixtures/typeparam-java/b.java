// `alpha` 是 Beta 的**类型参数**（不是 a.java 里那个类）→ `Beta → alpha` **不该存在**（负向断言）。
// `gamma` 是普通类型引用（a.java 里的类）→ `Beta → gamma` **必须存在**（正向对照）。
class Beta<alpha> {
    private alpha holder;

    gamma make() {
        return new gamma();
    }
}
