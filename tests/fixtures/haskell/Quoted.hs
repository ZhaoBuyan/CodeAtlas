{-# LANGUAGE TemplateHaskell #-}
module Atlas.Quoted where
import Atlas.Dep
quote = [d| data Phantom = Phantom Box |]
