(* 演示：OCaml —— 模块 + 类型 + 函数 *)

type color = Red | Green

type point = { x : int; y : int }

(* 形状模块 *)
module Shape = struct
  let origin = { x = 0; y = 0 }

  (* 求距离 *)
  let dist (p : point) =
    if p.x > 0 then p.x * p.x + p.y * p.y else 0

  let name = "shape"
end

let helper (a : int) =
  match a with
  | 0 -> 0
  | n when n > 0 -> n
  | n -> -n

(* 回归：① 模块里的类型要登记成**限定名**（`Meta.t`，不是裸 `t`）；
   ② 模块自己的节点不能丢（它既是作用域又是节点）；
   ③ 限定名引用要能解析到正确的那个类型 —— 而不是"随便一个叫 t 的"。
   之前这三件事全都不成立：OCaml 一个 module 内部的类型登记成裸名，
   而引用记的是 `Meta.t` → 对不上 → 一条边都没有（整门语言在图上是盲的）。 *)
module Meta = struct
  type t = int
end

type uses_meta = Meta.t
