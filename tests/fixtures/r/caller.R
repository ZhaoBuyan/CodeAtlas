# 引用方：`source()` 导入同目录的 R 文件，再调用里面定义的函数（跨文件依赖）。

source("widget.R")

show_all <- function(count = 2) {
  format_widget(make_widget("demo", count))
}
