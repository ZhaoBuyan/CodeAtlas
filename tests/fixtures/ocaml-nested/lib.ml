(* 回归夹具（2026-09-25）：**文件模块里的成员要能被别的文件指到** + **模块别名要接对**。

   背景（两个真 bug，都是"图上少边、还不报错"）：
   ① `fileModuleNamespace`（`foo.ml` 就是模块 `Foo`）会把文件名并进节点 ns，于是本文件里
      `module M = struct let iter … end` 的 `iter` 在图上叫 `Lib.M.iter`，而别的文件写的是
      `M.iter` / `Lib.M.iter`。裁剪"按需候选"时按"引用名是 fqn 的后缀"比 → `M.iter` 不是
      `Lib.M.iter` 的后缀（它是**去掉文件前缀**那个）→ 真节点被当垃圾剪掉，真依赖直接丢。
   ② 模块别名 `module B = M`：`B.iter` 指的是右边那个模块的 `M.iter`。不认这条，限定名会掉进
      后缀档去撞"别人文件里同名嵌套模块"（实测 `stdlib/string.ml` 的 `B.create` 接到了
      `testsuite/…/mctest.ml` 的 `Mctest.B.create`）。

   正向在 refer.ml；函子参数那条（抽象前缀）在另一个夹具 `ocaml-abstract` 里。*)

module M = struct
  let iter x = x
end

(* 别名指向本文件里的模块 → `B.iter` 必须接到 `Lib.M.iter` *)
module B = M

let via_alias x = B.iter x

(* 别名指向**不在本次图里**的模块 → `C.iter` 必须放弃（不许黏到 refer.ml 里同名的 C 上）*)
module C = Not_in_graph

let via_missing_alias x = C.iter x

let top x = x
