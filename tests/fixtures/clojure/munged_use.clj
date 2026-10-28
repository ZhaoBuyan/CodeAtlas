(ns atlas.hyphen-use (:import (atlas.hyphen_types HyphenBox)))
(defrecord HyphenUser [^HyphenBox value])
(defn direct [] (atlas.hyphen_types.HyphenBox.))
