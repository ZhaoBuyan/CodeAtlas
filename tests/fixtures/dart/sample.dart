import 'dart:math';

/// 形状基类（Dart 用抽象类 + mixin 表达）。
abstract class Shape {
  /// 名字
  final String name;

  const Shape(this.name);

  double area();
}

mixin Walkable {
  String walk() => 'walk';
}

class Circle extends Shape with Walkable {
  final double radius;

  Circle(this.radius) : super('circle');

  @override
  double area() => radius > 0 ? pi * radius * radius : 0;
}

enum Kind { red, green }

int helper(int a) {
  for (var i = 0; i < a; i++) {
    if (i > 2 && i < 9) return i;
  }
  return -a;
}
