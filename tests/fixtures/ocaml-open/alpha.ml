(* 夹具（精度轮 3）：`beta.ml` 里 `open Alpha` 之后写 `Alpha.value` —— 这条边应当是 **import 档**
   （有 `open` 撑着），而不是"名字唯一"那种猜的档位。
   改之前实测：OCaml 的 `open` 根本没记成 import（`imports: []`）→ 全部落在 unique 档。 *)
let value = 41
