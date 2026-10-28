(ns atlas.types)
;; A protocol Var and a generated JVM class use different bindings.
(defprotocol Contract (run-it [this]))
(defprotocol ^:private Hidden (secret [this]))
(defrecord Box [value])
(deftype Item [value])
