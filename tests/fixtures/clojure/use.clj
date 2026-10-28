(ns atlas.use
  (:require [atlas.types :as t :refer [Contract]])
  (:import [atlas.types Box Item]))
(defrecord ViaAlias [^Box box] t/Contract (run-it [this] (Item. box)))
(defrecord ViaRefer [] Contract (run-it [this] (new Box nil)))
(defrecord ViaNamespace [] atlas.types/Contract (run-it [this] nil))
(defn ^Box make-box [^Item value] (new Box value))
