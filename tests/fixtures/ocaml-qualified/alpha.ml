(* 夹具（精度轮 4）：**源码里写的是完整限定名** —— 这本身就是依据，与"import 能指到"同级。
   beta.ml 里写 `Alpha.value`（没有 `open Alpha`），命中注册的全名 `Alpha.value` →
   这条边应当是 **import 档**，而不是"名字唯一"那种猜的档位。 *)
let value = 41
