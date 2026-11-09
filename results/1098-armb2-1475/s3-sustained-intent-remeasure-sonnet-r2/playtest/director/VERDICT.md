# s3-sustained-intent-live-sonnet: FAIL

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-09T17:39:35.297Z) |
| eachPresented | FAIL | 1/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | FAIL | spoken order ada |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-09T17:39:37.307Z | 1 | 299 | true | 0 | Good morning, everyone. My errand this morning was to walk over to the orchard and then rest on the bench outside the cottage, and I kept my bees in mind the w… |
| bo | 2026-11-09T17:39:45.307Z | 0 | 0 | — | 0 |  |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 3 | 46 | 991577 | 27960 | 5551 | 0.2666 |
| bo | 2 | 36 | 730252 | 23828 | 4023 | 0.2086 |
| **total** | 5 | 82 | 1721829 | 51788 | 9574 | 0.4752 |
