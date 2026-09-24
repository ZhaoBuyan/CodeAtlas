(* 跨文件：定义一个模块，里面有一个**被外部引用**的值、一个**没人引用**的值。
   用来当"按需候选"的回归门 —— 没被引用的那个值不该在图上留节点。 *)
module Env = struct
  let normalize x = x + 1

  let unused_local_helper x = x
end
