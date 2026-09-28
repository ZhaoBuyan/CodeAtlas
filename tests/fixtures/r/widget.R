# 回归夹具（2026-09-25，新加语言 R）：函数 / 参考类 / library 导入 / 跨文件引用。
# R 没有专门的函数与类节点：`f <- function(...)` 是 `binary_operator(<-)` 套 `function_definition`
# （那个 function_definition 的 name 字段是字面量 `function`），类走 `Widget <- setRefClass(...)`。

library(stats)

Widget <- setRefClass("Widget",
  fields = list(name = "character", size = "numeric"),
  methods = list(
    describe = function() paste0(name, ":", size)
  )
)

make_widget <- function(name, size = 3) {
  w <- Widget$new(name = name, size = size)
  if (size > 0) {
    w$size <- size
  } else {
    warning("size must be positive")
  }
  w
}

format_widget <- function(w) {
  w$describe()
}
