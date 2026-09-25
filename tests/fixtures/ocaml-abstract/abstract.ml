(* 回归夹具（2026-09-25）：**函子参数是抽象前缀** —— `Ord.t` 这种引用必须**放弃**。

   背景：限定名解析有三档（同文件 → 全名命中 → 后缀命中），后缀档最弱。函子参数
   （`module Make (Client : T) = struct … Client.t … end` 里的 `Client`）是**调用方传进来的
   模块**，源码里没有实现 —— 让 `Client.t` 掉进后缀档，它就会黏上**任何** fqn 以 `.Client.t`
   结尾的候选（真项目实测：`stdlib/map.ml` 的 `Ord.t` 接到了 `testsuite/…/functors.ml` 的
   `Functors.Ord.t`，真源码 → 测试目录共 16 条这种错边）。

   这个夹具同时钉住两件事（只钉"错边没了"会把"整个后缀档被删掉"当成通过）：
     ① `uses_pair` 引用**本文件里真有的** `Pair.t` → 这条边**必须还在**（后缀档还得工作）；
     ② `Make.use_client` 引用函子参数 `Client.t` → **必须没有**指向 `Decoy.Client.t` 的边。
     ③ `.mli` 那种写法 `module Make : functor (Client : T) -> S` 也要认（见 languages.mjs）。*)

module type T = sig
  type t
end

module Pair = struct
  type t = int
end

type uses_pair = Pair.t

module Make (Client : T) = struct
  type t = Client.t
end

module Decoy = struct
  module Client = struct
    type t = string
  end
end
