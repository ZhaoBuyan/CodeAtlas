package client
import "example.org/atlas/dep"
func LocalPrefix() { actual := 1; _ = actual }
type PrefixUse struct { Value actual.Kept }
