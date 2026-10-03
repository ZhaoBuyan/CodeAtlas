package alpha.beta;

// 夹具（精度轮 6）：这个类在 `alpha.beta` 包里 ——
// `gamma` 包里的文件**不写 import** 时，裸名 `ScopeWidget` 在语义上根本指不到它（编译都过不去）。
// ⚠ 名字特意取得与别的夹具不撞（`family-jvm/` 里已经有一个 `Widget`；撞名会让仓库自扫的
//   "unique 档族内唯一"断言红掉 —— 那是测试判据，不是引擎问题）。
public class ScopeWidget {
    public int v;
}
