package gamma;

// 负向：**没有 import**，跨包裸写 `ScopeWidget` —— 这在语义上指不到 `alpha.beta.ScopeWidget`（编译错误），
// 所以 `gamma.ScopeUser → alpha.beta.ScopeWidget` **不该存在**。
// 实测这就是 efcore/aspnetcore 上那一万多条错边的形状（别的命名空间里的同名类）。
public class ScopeUser {
    void m() {
        ScopeWidget w = null;
    }
}
