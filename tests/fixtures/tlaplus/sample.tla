---- MODULE Sample ----
EXTENDS Naturals

VARIABLE x

(* 初始状态 *)
Init == x = 0

Next == x' = x + 1

Double(v) == v * 2

Spec == Init /\ [][Next]_x
====
