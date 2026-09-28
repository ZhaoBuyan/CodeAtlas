# A3 夹具：Ruby 的局部变量是小写 identifier，而**文件合成的 module 节点**名字就是文件名主干
# （实测：`alpha.rb` → 节点名 `alpha`）—— 两者会撞，这正是 sinatra 上那 23 条被砍掉的边。
def helper
  1
end

# 正向对照：`Gamma` 是常量，不是任何局部绑定名
class Gamma
end
