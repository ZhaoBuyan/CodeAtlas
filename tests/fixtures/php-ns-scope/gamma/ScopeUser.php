<?php

// 夹具（精度轮 17）正向：`use` 进来了 → 裸名 `ScopeWidget` **必须**接得上（且是 import 档）。
namespace Gamma;

use Alpha\Beta\ScopeWidget;

class ScopeUser
{
    public function make(): ScopeWidget
    {
        return new ScopeWidget();
    }
}
