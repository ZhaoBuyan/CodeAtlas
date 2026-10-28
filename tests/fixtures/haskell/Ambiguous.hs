module Atlas.Ambiguous where
import Atlas.Dep (Box)
data Box a = LocalBox a
type Collision = Box Int
type LocalQualified = Atlas.Ambiguous.Box Int
