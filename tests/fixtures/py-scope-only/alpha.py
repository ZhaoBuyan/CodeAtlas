# 夹具（T2，Python 上闸）：这个类**只在这里定义**。
#
# Python 的模块作用域规则与 Rust 同构：一个模块里的裸名只能指
#   ① 本文件里声明的、② `import` / `from … import` 引进来的、③ 内建（builtins，不在图里）。
# 别的模块的顶层名字**没有 import 就看不到**（`module.attr` 是限定名，走另一条路）。
#
# 所以「跨文件 + 零 import 依据」的裸名匹配只能是名字巧合。


class ScopeWidget:
    v = 1
