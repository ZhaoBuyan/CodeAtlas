package gamma

// 正向对照：**同包**（同目录）不同文件的裸名引用 —— 跨文件、但没有 import 依据，
// 这道闸**必须放行**它（否则就是把 Go 的真边一起砍了）。
type Helper struct{}
