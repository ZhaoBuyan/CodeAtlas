# 夹具（精度轮 8）：`render` 在**这个文件**里 —— beta.py **没有** import 它，
# 却 import 了同名的 `render`（来自外部模块）→ 那是"名字已经有主"。
class render:
    pass
