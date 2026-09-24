/** 面板：引用 Java 侧定义的类（跨 Kotlin → Java，同一个 JVM 类路径，这是真依赖）。
 *  为什么单独造这个样例：引擎一度按"语言 id 相等"过滤跨语言解析 —— 实测 akka 丢了
 *  `java↔scala` 6,517 条、kotlin 工程丢了 `kotlin↔java` 487/233 条。见 languages.mjs 的 family。 */
class Panel {
    fun make(): Widget? = null
}
