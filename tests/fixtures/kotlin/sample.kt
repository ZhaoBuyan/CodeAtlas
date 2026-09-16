package fixture.sample

import kotlin.math.PI

/** 形状基类：测试 Kotlin 的类 / 继承 / 函数抽取。 */
abstract class Shape(val name: String) {
    abstract fun area(): Double

    val kind: String = "shape"

    fun describe(): String = if (name.isNotEmpty()) name else "unknown"
}

class Circle(radius: Double) : Shape("circle") {
    override fun area(): Double = PI * radius * radius
}

object Registry {
    fun register(s: Shape) {
    }
}

enum class Color {
    RED,
    GREEN,
}
