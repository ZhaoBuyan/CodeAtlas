module Atlas.Dep (Box(..), Shown, Marker, Atlas.Dep.Maybe) where
-- A nominal type; the constructor is not another type reference.
data Box a = Box a
data Shown = Shown
data Secret = Secret
data Maybe = CustomMaybe
class Marker a where
  mark :: a -> Box a
