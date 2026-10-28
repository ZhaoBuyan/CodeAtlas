module Atlas.ExportsUse where
import qualified Atlas.SelfExport as S
import qualified Atlas.QualifiedExport as Q
import qualified Atlas.SplitExport as Split
type ViaSelf = S.SelfBox
type ViaQualified = Q.Box Int
type ViaSplit = Split.Box Int
