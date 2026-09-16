import Foundation

/// 形状基类（Swift 用协议 + 类表达）。
protocol Shape {
    func area() -> Double
}

/// 圆形。
class Circle: Shape {
    private let radius: Double

    init(radius: Double) {
        self.radius = radius
    }

    func area() -> Double {
        return radius > 0 ? Double.pi * radius * radius : 0
    }
}

struct Point {
    var x: Int
    var y: Int
}

enum Kind {
    case red
    case green
}

func helper(_ a: Int) -> Int {
    if a > 0 && a < 10 {
        return a
    }
    return -a
}
