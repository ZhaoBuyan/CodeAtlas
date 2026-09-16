#include <string>
#include <vector>

/// 形状基类（C++ 用继承）。
class Shape {
public:
    explicit Shape(std::string name) : name_(std::move(name)) {}

    virtual double area() const = 0;

protected:
    std::string name_;
};

class Circle : public Shape {
public:
    Circle(double r) : Shape("circle"), r_(r) {}

    double area() const override {
        return 3.14 * r_ * r_;
    }

private:
    double r_;
};

struct Point {
    int x;
    int y;
};

enum class Kind { Red, Green };

double helper(double a) {
    return a > 0 ? a : -a;
}
