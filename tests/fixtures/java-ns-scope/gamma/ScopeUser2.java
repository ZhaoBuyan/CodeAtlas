package gamma;

import alpha.beta.ScopeWidget;

// 正向对照：**写了 import** —— 裸名 `ScopeWidget` 现在指得到 `alpha.beta.ScopeWidget`，
// 所以 `gamma.ScopeUser2 → alpha.beta.ScopeWidget` **必须存在**、而且档位是 **import**（有依据）。
public class ScopeUser2 {
    void m() {
        ScopeWidget w = null;
    }
}
