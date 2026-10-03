package gamma

// 负向：裸写 `ScopeWidget`（它在 `package alpha` 里、**没有导入**）→ Go 里这根本编译不过
// → `gamma.Use → alpha.ScopeWidget` **不该存在**
// （实测 etcd 上 `etcdserverpb → snap::Message`、grpc-go 上 `xdsresource → bufconn::Listener` 就是这类）。
// 正向：`Helper` 在**同包**的 helper.go 里 → `gamma.Use → gamma.Helper` **必须**在（同包跨文件是真边）。
func Use() {
	var a ScopeWidget
	var b Helper
	_, _ = a, b
}
