(ns atlas.dynamic (:require [atlas.types :as t]))
(in-ns 'atlas.elsewhere)
(defrecord DynamicUser [] t/Contract (run-it [this] nil))
