(ns atlas.redefined-use (:require [atlas.redefined :as r]))
(defrecord ReplacedUser [] r/Replaced (method [this] nil))
