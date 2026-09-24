/* 形状：在 .c 里定义（C 与 C++ 共用头文件/结构体，跨语言按名字解析是必须的）。 */
typedef struct Shape {
    const char *name;
} Shape;

int shape_area(Shape *s) {
    return 0;
}
