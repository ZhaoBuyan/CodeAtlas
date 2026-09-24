/* C++ 侧引用 C 侧定义的结构体：`ShapeHolder → Shape` 这条跨语言边必须接上。
   与 family-js 同理 —— 这里是 `cpp → c`（`.h` 会被按内容嗅探成 C 或 C++，两者共用同一个头文件）。 */
class ShapeHolder {
public:
    Shape *inner;
};
