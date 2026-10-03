package alpha.beta

// 夹具（精度轮 10）：Scala 的包**嵌套可见** —— 在 `package a.b.c` 里 `a.b.c.X` 与外层包都直接可见，
// 别的包必须 `import`。所以别的包里的裸名 `ScopeWidget` 接不到这里。
class ScopeWidget
