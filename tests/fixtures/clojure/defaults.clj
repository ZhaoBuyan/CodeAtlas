(ns atlas.defaults)
(defrecord String [])
(defrecord FalseDefault [^String text])
(defrecord QualifiedDefault [^atlas.defaults.String text])
