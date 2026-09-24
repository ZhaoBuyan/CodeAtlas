(* 引用 env.ml 里 Env.normalize —— 这条边要跨文件、且目标是**值**（不是类型）。
   这是 OCaml 最要紧的一类依赖（函数级跨模块），也是"按需候选"要保住的东西。 *)
let go p = Env.normalize p
