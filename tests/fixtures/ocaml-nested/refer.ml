(* 引用方：三条真依赖必须接上；一条**必须没有**（`C.iter` 的前缀 `C` 是图外模块的别名）*)

let a = Lib.M.iter 3

let b = Lib.B.iter 4

let c = Lib.via_alias 5

let d = Lib.top 6

let f = Lib.via_missing_alias 7

(* 本文件里有个同名的 `C`：这正是"后缀档会撞上的那种候选"，所以它必须**不**被接上 *)
module C = struct
  let iter x = x
end

let e = C.iter 8
