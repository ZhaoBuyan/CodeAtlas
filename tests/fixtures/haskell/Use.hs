module Atlas.Use where
import qualified Atlas.Dep as D (Box(..), Secret)
type Qualified = D.Box Int
type MissingAlias = Bad.Box Int
type BareNotImported = Box Int
type NotSelected = D.Shown
type Private = D.Secret
data Holder = Holder (D.Box Int)
helper :: D.Box Int -> Holder
helper x = Holder x
