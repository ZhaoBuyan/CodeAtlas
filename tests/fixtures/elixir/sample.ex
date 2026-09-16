defmodule Shape do
  @moduledoc "形状与面积计算"

  alias Shape.Utils

  defstruct [:kind, :size]

  def area(%{kind: :circle, r: r}), do: 3.14159 * r * r

  def area(%{kind: :square, a: a}) do
    if a > 0 do
      a * a
    else
      0
    end
  end

  defp double(x), do: x * 2
end

defmodule Shape.Utils do
  @doc "缩放"
  def scale(v, k), do: v * k
end
