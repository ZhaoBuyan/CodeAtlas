(* A3 夹具（OCaml）：`alpha` 是 `use` 函数里 `let … in` 的局部绑定。
   ⚠ 这条夹具是**记录用**而不是回归门：OCaml 的引用采集中，裸值引用（`value_path` 没有 module_path）
   在 refFilter 那一步就被丢掉了，图上只留限定名（`Module.value`）—— 所以 A3 的裸名过滤在 OCaml 上
   本来就不会改变任何一条边（实测 ocaml-ocaml 样本：0 变化）。夹具保证"声明还在、且不炸"。 *)
type alpha = int

type gamma = int

let helper (x : gamma) = x
