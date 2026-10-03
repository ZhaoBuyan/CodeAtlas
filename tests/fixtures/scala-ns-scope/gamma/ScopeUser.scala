package gamma

// 负向：`package gamma` 里裸写 `ScopeWidget`，而它在 `alpha.beta` 里 —— **没有 import** 就不可见
// → `gamma.ScopeUser → alpha.beta.ScopeWidget` **不该存在**
// （实测 akka 上 `Throwable` 531 · `Map` 366 · `System` 216 这类 JDK/标准库名就是这么接错的）。
class ScopeUser {
  val w: ScopeWidget = null
}
