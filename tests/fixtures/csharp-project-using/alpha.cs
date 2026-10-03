namespace Alpha.Beta;

// 夹具（精度轮 5）：这个类在 `Alpha.Beta` 命名空间里，而 use.cs 的命名空间是 `Gamma` ——
// 它能裸写 `Widget` 全靠 Proj.csproj 里的 `<Using Include="Alpha.Beta" />`（项目级 global using）。
public class Widget
{
    public int Value;
}
