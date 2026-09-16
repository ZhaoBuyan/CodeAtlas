/* 形状与工具：ReScript 样例 */

module Utils = {
  let twice = x => x * 2
}

type shape =
  | Circle(float)
  | Square(float)

/* 算面积 */
let area = (s: shape) =>
  switch s {
  | Circle(r) => 3.14159 *. r *. r
  | Square(a) => a *. a
  }
