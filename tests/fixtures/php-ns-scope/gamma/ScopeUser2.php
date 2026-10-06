<?php

// 夹具（精度轮 17）负向：裸写 `ScopeWidget`（它在 `Alpha\Beta` 里、**没有 use**）——
// PHP 里这解析不到那个类 ⇒ `Gamma.ScopeUser2 → Alpha.Beta.ScopeWidget` **不该存在** ✗。
// 正向：`Helper` 在**同命名空间**的 Helper.php 里 ⇒ `Gamma.ScopeUser2 → Gamma.Helper` **必须在** ✓
//（证明这道闸只砍跨命名空间的、不砍同命名空间的真边）。
namespace Gamma;

class ScopeUser2
{
    public function make()
    {
        $a = new ScopeWidget();
        $b = new Helper();
        return [$a, $b];
    }
}
