namespace Gamma;

// ⚠ 这个文件**故意不写 `using Alpha.Beta;`** —— 它能裸写 `Widget` 全靠项目级 global using
// （Proj.csproj 里的 `<Using Include="Alpha.Beta" />`）。
// 于是 `User → Alpha.Beta.Widget` 这条边应当是 **import 档**（有项目级依据），不是 unique。
public class User
{
    Widget field;
}
