port module Ports exposing (send, Payload)

import Alpha exposing (Public)

type alias Payload = { item : Public }
port send : Payload -> Cmd msg
