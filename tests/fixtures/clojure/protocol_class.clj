(ns atlas.protocol-class)
(defprotocol LocalContract (call-it [this]))
(defrecord ProtocolHint [^LocalContract value])
(defrecord ValidImplementation [] LocalContract (call-it [this] nil))
