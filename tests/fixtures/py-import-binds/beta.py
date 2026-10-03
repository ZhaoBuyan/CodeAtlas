# 负向：`render` 从**外部模块** import 进来（gamma.py 里有个同名的类，但这里**没 import 它**）
# → `use → gamma.py::render` **不该存在**：这个名字已经有主了。
# 实测 django 上 `class DateFunctionTests → tests/db_functions/models.py::DTModel`（×142）就是这个形状。
from elsewhere import render

# 正向对照：`Plain` 从 `.alpha` 相对导入进来 → 裸名 `Plain` **必须**接得上 `alpha.py::Plain`。
from .alpha import Plain


def use():
    return (render, Plain)
