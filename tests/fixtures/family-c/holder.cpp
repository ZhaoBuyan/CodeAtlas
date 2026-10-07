/* C++ 侧引用 C 侧定义的结构体：`ShapeHolder → Shape` 这条跨语言边必须接上。
   与 family-js 同理 —— 这里是 `cpp → c`（`.h` 会被按内容嗅探成 C 或 C++，两者共用同一个头文件）。

   ⚠ 2026-10-05 第 19 轮补充：C/C++ 上了"**跨文件裸名必须有 include 依据**"的闸之后，
   这里**必须有 include** —— 否则那条边就是"跨文件、零依据的裸名匹配"，按政策本来就不该建 ✗。
   夹具当年只钉了"同族（c↔cpp）能互相解析"，没写 include；补上之后**依然**在测同族机制 ✓。 */
#include "shape.c"

class ShapeHolder {
public:
    Shape *inner;
};
