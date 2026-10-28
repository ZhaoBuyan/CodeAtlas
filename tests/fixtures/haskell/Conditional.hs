{-# LANGUAGE CPP #-}
module Atlas.Conditional where
import Atlas.Dep
#if USE_BOX
type ConditionalType = Box Int
#endif
type Unselected = Atlas.Dep.Box Int
