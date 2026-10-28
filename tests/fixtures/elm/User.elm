module User exposing (..)
import Alpha as A exposing (Public, Choice)
import Shadow as S

type alias Model =
    { public : Public
    , qualified : A.Public
    , alias : A.Alias
    , choice : Choice
    , hidden : A.Hidden
    , unimported : Hidden
    , wrongPrefix : Alpha.Public
    , standard : Int
    , explicitShadow : S.Int
    }

run : Public -> A.Alias
run value = { public = value }

type alias NegativePrefix = Alpha.Public
type alias NegativeHidden = A.Hidden
type alias Extended r = { r | item : A.Public }
