(ns atlas.rebinding (:require [atlas.types :refer [Contract]]))
(def Contract :other)
(defrecord Rebound [] Contract (run-it [this] nil))
