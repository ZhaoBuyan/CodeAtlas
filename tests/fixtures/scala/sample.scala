package fixture

import scala.collection.mutable

/** 形状基类（Scala 用 trait + class 表达）。 */
trait Shape {
  def area: Double
}

class Circle(val radius: Double) extends Shape {
  override def area: Double = if (radius > 0) math.Pi * radius * radius else 0.0
}

object Registry {
  private val items = mutable.ArrayBuffer.empty[Shape]

  def register(s: Shape): Unit = {
    items += s
  }
}

case class Point(x: Int, y: Int)

enum Kind {
  case Red, Green
}

object Helper {
  def helper(a: Int): Int = {
    if (a > 0) a else -a
  }
}
