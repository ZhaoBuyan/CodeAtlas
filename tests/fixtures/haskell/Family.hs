{-# LANGUAGE TypeFamilies #-}
module Atlas.Family where
import Atlas.Dep (Shown)
import qualified Atlas.Dep as D
class Associated a where
  type Shown a
type UnresolvedFamily = Shown Int
type StillQualified = D.Shown
