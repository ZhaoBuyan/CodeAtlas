(* `open Alpha` = 把 Alpha 的成员引进当前作用域 —— 这就是 OCaml 的 import。
   裸名 `value` 不算引用（OCaml 的 refFilter 只认带模块前缀的路径），
   所以这里写限定名 `Alpha.value`，让"有 open 撑着"这件事有地方体现。 *)
open Alpha

let use () = Alpha.value
