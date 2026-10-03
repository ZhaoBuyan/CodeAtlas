package gamma

// 负向：`package gamma` 里裸写 `ScopeWidget`（它在 `alpha.beta` 里、**没有 import**）→ 不可见
// → `gamma.ScopeUser → alpha.beta.ScopeWidget` **不该存在**
// （实测 ktor 上 `Map` 207 · `Deprecated` 200 · `Array` 50 这类 Kotlin/JDK 名就是这么接错的）。
class ScopeUser {
    val w: ScopeWidget? = null
}
