(* 回归夹具（2026-09-25）：**`external` 声明也要成节点**。

   背景：OCaml 标准库里一大批最常用的函数是 `external` 声明的
   （`external length : 'a array -> int = "%array_length"`），语法树上是**独立节点类型 `external`**
   （子节点 value_name / function_type / string）。profile 里以前根本没声明它 → 这些函数
   **一次都没进过图**，引用它们的边**成批**接不上：实测某真项目 `Array.length` 511 条、
   `String.length` 346 条、`Array.make` 253 条全落在 unknown。

   这个夹具钉两头：
   ① `Prims.len` / `Prims.make`（external）是节点、别的文件指得到；
   ② **没人引用**的 `Prims.unused_prim` 不许进图（按需裁剪仍然有效）。
   引用在 refer.ml。*)

external len : 'a array -> int = "%array_length"

external make : int -> 'a -> 'a array = "caml_array_make"

external unused_prim : unit -> unit = "caml_unused"
