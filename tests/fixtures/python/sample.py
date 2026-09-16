import os
from typing import List


class Animal:
    """动物基类：测试 docstring 抽取。"""

    kind = "x"

    def speak(self):
        """叫一声。"""
        return "..."

    def eat(self, food):
        if food:
            return True
        return False


class Dog(Animal):
    """狗。"""

    def speak(self):
        return "woof"


def helper(a: int) -> int:
    """顶层函数（应落到模块节点上）。"""
    for i in range(a):
        if i > 2:
            return i
    return -a
