-- 测试用 Lua 模块（没有类型声明，应该合成一个"模块"节点）
local M = {}

--- 打招呼
function M.greet(name)
  if name then
    return "hi " .. name
  end
  return "hi"
end

function M.count(limit)
  local n = 0
  for i = 1, limit do
    n = n + 1
  end
  return n
end

return M
