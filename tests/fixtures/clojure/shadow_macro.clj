(ns atlas.shadow-macro (:refer-clojure :exclude [defrecord]))
(defn defrecord [& values] values)
(defrecord NotAType [])
(clojure.core/defrecord ExplicitType [])
