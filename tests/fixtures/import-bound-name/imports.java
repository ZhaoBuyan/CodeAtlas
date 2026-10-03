// `import org.junit.jupiter.api.alpha;` —— 一条**外部库** import，把裸名 `alpha` 绑给了它
// （图里当然没有这个类）。于是 `alpha` 这个裸名**已经有主**：不许再回落到"同名匹配"接到 alpha.java 上。
// 这正是实测 spring-boot 上 10,751 条错边的形状（`@Test` 被接到另一个模块叫 `Test` 的类上）。
import org.junit.jupiter.api.alpha;

class Beta {
    // 负向：`alpha` 已被上面的 import 绑定 → `Beta → alpha` **不该存在**
    alpha make() {
        return null;
    }

    // 正向对照：`gamma` 没被任何 import 绑定 → `Beta → gamma` **必须存在**
    gamma build() {
        return new gamma();
    }
}
