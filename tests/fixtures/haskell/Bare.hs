module Atlas.Bare where
import Atlas.Dep hiding (Shown)
type Kept = Box Int
type Hidden = Shown
newtype Wrapped = Wrapped { value :: Box Int }
