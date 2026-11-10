# Portable quiet-interval sand timer

`core/sand-timer@1` is an open-frame timer containing six integral sand units. Work on an actual supported tabletop between 0.65 and 1.35 m high with empty hands. The separate `core/timer-table@1` supplies ordinary support; normal pickup/put retains the same timer and its records.

The #1737/#1751 catalogue, live state and `find` publish `object:<id>:time` and `object:<id>:flip`. `time` takes string `seconds`: `5`, `10` or `15`, default `5`. Its plan approaches normally, then performs the chosen native interval. Only completion transfers upper sand to the lower end and records completed duration, cumulative seconds and worker. `flip` takes one second and exchanges the same sand ends without earning timing credit. Empty upper sand refuses another interval with a re-arming reason. Active selected interval is a transient own-object fact; completed records are durable.

Access, same source/body/start-state, native support/floor/reach and authoritative completion remain required. Interruption or refused commit leaves sand and credit unchanged. God Undo/redo preserves completed Soul work through the reviewed completion adapter. The gesture is approximate and sand changes discretely at completion; no passive global scheduler, continuous granular physics or clock-precision guarantee is implied.

[Canonical direction](https://github.com/soulsimulation/souls/blob/647d04a5ce5621717c2fad78c153d082e3dffcb2/docs/design/soul-actions-direction.md) applies. #1818 and its linked PR hold source/native/actual evidence. Actual same-data restart qualifies identity/current facts/offers, separately from native support assertions; no world-pose equality claim.
