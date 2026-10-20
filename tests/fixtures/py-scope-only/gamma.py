# 负向对照：**没有 import** 就裸写 `ScopeWidget`（它只在 alpha.py 里）。
#
# Python 里这样写运行时是 NameError；扫描器以前会把这条裸名接到 alpha.py 的同名类上，
# 于是产生了「跨文件 + 零依据」的 unique 边 —— 那只能是名字巧合。

useWrong = ScopeWidget()
