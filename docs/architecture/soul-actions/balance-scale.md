# Mechanical balance scale

[Canonical direction](https://github.com/soulsimulation/souls/blob/647d04a5ce5621717c2fad78c153d082e3dffcb2/docs/design/soul-actions-direction.md) applies: usable things, authority, basic coherence and complete proof. #1798 adds a fixed declared-mass comparison tool, not force physics or a precision instrument.

`core/balance-scale@1` has a normal left-pan surface for one real carryable payload up to 0.8 kg and 0.32 × 0.4 × 0.28 m. Normal `put-on:<scale-id>` and `pick-up:<payload-id>` preserve the SAME payload. Its authoritative definition `components.carryable.mass` is compared against eight integral 100 g weights. No hidden or fake sample is substituted.

The catalog declares `object:<scale-id>:weigh`, string parameter `count` from `0` through `8` (default `0`). Find the scale, then send its ID. The ordinary plan walks to the clear front and performs two seconds of native operation. Completed work atomically updates weight placement, the indicator and a historical reading/worker. All eight weights remain visible, split between rack and counter-pan. They are integral material, not separately held physical items.

Missing or held payloads, invalid counts, obstructed work points, access denial and occupied hands refuse use. Started work binds source, payload, body, permissions, poses, support and prior state. Changed inputs or interrupted/refused work preserve the previous reading. History never follows a departed payload's live state. Own work uses the reviewed completion adapter, preserving God Undo/redo and native mirroring. No global idle scan, new client words, protected listing exception or physics contract is added.

Current state and acts follow #1737/#1751; own inspection also exposes historical readings and requirements. Proof and dependency qualifications belong in the PR, including current-facts versus world-pose restart limits.
