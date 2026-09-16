package fixture

import "fmt"

// Animal 基类：Go 用结构体 + 方法表达（没有继承）。
type Animal struct {
	Name string
}

// Speak 叫一声。
func (a *Animal) Speak() string {
	if a.Name != "" {
		return fmt.Sprintf("hi %s", a.Name)
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
