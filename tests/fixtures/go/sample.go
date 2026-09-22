package fixture

// 夹具特意保留两种写法（都出自真实项目）：单行 `import "os"` 与多行括号块
//（gin 实测里后者整块被记成一整条字符串，99 个文件只采到 94 条）。
import "os"

import (
	"fmt"
	"strings"
)

// Animal 基类：Go 用结构体 + 方法表达（没有继承）。
type Animal struct {
	Name string
}

// Speak 叫一声。
func (a *Animal) Speak() string {
	if a.Name != "" {
		return fmt.Sprintf("hi %s", a.Name)
	}
	if q := os.Getenv("quiet"); q != "" {
		return strings.ToLower(q)
	}
	return "..."
}

// Walker 接口。
type Walker interface {
	Walk() string
}

type Dog struct {
	Animal
}

func (d Dog) Walk() string {
	return "walk"
}

func helper(n int) int {
	for i := 0; i < n; i++ {
		if i > 2 && i < 9 {
			return i
		}
	}
	return -n
}
