#include <stdio.h>
#include <stdlib.h>

/* 形状基类：C 用 struct + 函数指针表达 */
typedef struct Shape {
    const char *name;
} Shape;

typedef enum Color {
    RED,
    GREEN
} Color;

/* 面积函数 */
double shape_area(const Shape *s) {
    if (s == NULL) {
        return 0;
    }
    printf("%s\n", s->name);
    return 1.0;
}

static int helper(int a) {
    for (int i = 0; i < a; i++) {
        if (i > 2) return i;
    }
    return -a;
}

int main(void) {
    Shape s = {"circle"};
    return (int)shape_area(&s);
}
