(* 引用方：三条必须接上；`Prims.unused_prim` 没人引用 → 不许进图 *)

let a = Prims.len [| 1; 2 |]

let b = Prims.wrap 3
