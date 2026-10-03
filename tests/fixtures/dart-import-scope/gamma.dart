// 负向：裸写 `ScopeWidget`（它在 alpha.dart 里、**没有 import**）→ Dart 里编译不过
// → `gamma.Use2 → alpha.ScopeWidget` **不该存在**
// （实测 riverpod 843 条 / bloc 484 条 unique 就是这类跨库同名 ✗）。
class Use2 {
  ScopeWidget? w;
}
