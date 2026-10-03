package gamma

// 正向对照：`import` 进来了 → 裸名 `ScopeWidget` **必须**接得上（而且是 import 档）。
import alpha.beta.ScopeWidget

class ScopeUser2 {
    val w: ScopeWidget? = null
}
