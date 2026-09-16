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
