(ns atlas.renamed (:require [atlas.types :refer [Contract] :rename {Contract Renamed}]))
(defrecord RenamedUser [] Renamed (run-it [this] nil))
(defrecord OldName [] Contract (run-it [this] nil))
