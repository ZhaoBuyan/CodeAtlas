(* 回归夹具（2026-09-25）：`external` 声明要成节点 + **同一文件里同名 `external` 与 `let` 只留一个**。

   背景一：OCaml 标准库里一大批最常用的函数是 `external` 声明的
   （`external length : 'a array -> int = "%array_length"`，语法树上是独立节点类型 `external`）。
   profile 里以前没声明它 → 这些函数**一次都没进过图**，引用成批接不上：实测某真项目
   `Array.length` 511 条、`String.length` 346 条、`Array.make` 253 条全落在 unknown。

   背景二：`stdlib/array.ml` 里 `external length : …` 后面还有包装它的 `let length`。
   两个都发按需节点 → 同一个文件里两个同 fqn 节点 → "全名命中"挑不出唯一、`byOwner` 也挑不出
   （parent 都是 null）→ **510 条 `Array.length` 引用整批放弃**。同一文件里的同名定义语义上
   就是同一个符号（后定义遮蔽前者），只留一个；被合并掉那个节点身上的引用要归到留下的那个上。

   这个夹具钉三头：
   ① `Prims.len`（纯 external）是节点、别的文件指得到；
   ② `Prims.wrap`（同名 external + let）**只有一个节点**，引用仍接得上（引用没被去重弄丢）；
   ③ **没人引用**的 `Prims.unused_prim` 不许进图（按需裁剪仍有效）。
   引用在 refer.ml。*)

external len : 'a array -> int = "%array_length"

external wrap : int -> int = "caml_wrap"

let wrap x = x + 1

external unused_prim : unit -> unit = "caml_unused"
