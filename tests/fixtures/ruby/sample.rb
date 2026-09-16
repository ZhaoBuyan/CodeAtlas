require 'json'

# 形状基类（Ruby 用类 + 模块表达）
class Shape
  attr_reader :name

  # 初始化
  def initialize(name)
    @name = name
  end

  def area
    raise NotImplementedError
  end

  def internal?
    !@name.empty?
  end
end

module Walkable
  def walk
    'walk'
  end
end

class Circle < Shape
  include Walkable

  def initialize(radius)
    super('circle')
    @radius = radius
  end

  def area
    return 0.0 if @radius <= 0

    3.14 * @radius**2
  end
end

def helper(a)
  for i in 0...a
    return i if i > 2
  end
  -a
end
