(* 引用方：两条必须接上（`Iface.normalize` / `Iface.describe`）；
   `Iface.unused_helper` 没人引用 → 不许进图（按需裁剪还要работать）*)

let a = Iface.normalize 1

let b = Iface.describe "x"
