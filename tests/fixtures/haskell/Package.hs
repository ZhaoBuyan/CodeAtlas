{-# LANGUAGE PackageImports #-}
module Atlas.Package where
import Atlas.Dep (Box)
import "external-package" Atlas.Dep (Box)
type AmbiguousPackage = Box Int
