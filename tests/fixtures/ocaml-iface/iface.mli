(* 回归夹具（2026-09-25）：**只有 .mli、没有同名 .ml** 时，接口里的 val 必须能成节点。

   背景：`val`（`value_specification`）此前**根本走不到建节点那条路** ——
   `emitOnDemandValue` 只在"成员分支"里被调用，而它没在 ocaml profile 的 `members` 表里。
   于是"只有 .mli"的文件（实测 3 个真样本里 152 个，典型是 `asmcomp/CSE.mli`：实现是同名但
   在**别的目录** `asmcomp/amd64/CSE.ml`，`collapseUnits` 只认同目录）**整个文件的成员在图上
   隐形**：没有 `CSE.fundecl` 节点，别的文件写 `CSE.fundecl` 只能去撞同名嵌套模块。

   同一轮还修了两件相关的事（都在 scan.mjs 里）：
   ① 只有 `.mli` 时才给 `val` 发节点（有同名 `.ml` 时发会让同一个 fqn 出现两个节点）；
   ② `nsStack` 为空但能推出文件模块名时（`use.ml` → `Use`）也发 —— 以前顶层 `let` 在这类
      文件里同样隐形。
   引用在 refer.ml。*)

val normalize : int -> int

val unused_helper : int -> int

val describe : string -> string
