package fixture.sample;

import java.util.List;

/** 形状基类：测试包名 / 继承 / Javadoc 抽取。 */
public abstract class Shape {
    protected String name;

    public abstract double area();

    public static class Nested {
        int depth;
    }
}

class Circle extends Shape implements Comparable<Circle> {
    private double r;

    public double area() {
        return Math.PI * r * r;
    }

    public int compareTo(Circle other) {
        return Double.compare(r, other.r);
    }
}

interface Drawable {
    void draw();
}

enum Color {
    RED,
    GREEN
}

record Point(int x, int y) {
}
