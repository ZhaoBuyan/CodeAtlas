(* ⚠ 故意**不写** `open Alpha` —— 只靠限定名 `Alpha.value`。
   源码里明确写了模块名、又命中注册的全名 → 这比"名字在族内唯一"硬得多（实测 ocaml 真项目里
   `Buffer.t` / `Sys.opaque_identity` / `Variables.t` 全是这种形状，以前全落在 unique 档）。 *)
let use () = Alpha.value
