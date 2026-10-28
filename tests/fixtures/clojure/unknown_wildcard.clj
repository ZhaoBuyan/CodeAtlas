(ns atlas.unknown-wildcard
  (:require [atlas.types :refer [Contract]] [external.not-scanned :refer :all]))
(defrecord UnknownWild [] Contract (run-it [this] nil))
