module Alpha exposing (Public, Choice(..), Alias)

type Public = Public
type Hidden = Hidden
type Choice = Hit Public | Miss
type alias Alias = { public : Public }

local : Hidden -> Public
local value = Public
