package alpha

// 夹具（精度轮 11）：Go 里**跨包必须写限定名**（`alpha.ScopeWidget`）——
// 光秃秃的裸名 `ScopeWidget` 在别的包里根本指不到这里。
type ScopeWidget struct{}
