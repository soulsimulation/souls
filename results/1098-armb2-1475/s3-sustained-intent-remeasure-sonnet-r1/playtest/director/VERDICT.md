# s3-sustained-intent-live-sonnet: FAIL

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-09T17:26:43.686Z) |
| eachPresented | FAIL | 1/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | FAIL | spoken order ada |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-09T17:26:45.691Z | 1 | 254 | true | 0 | Good morning, everyone. I'm Ada, and I keep bees. My errand this morning took me across the green toward the orchard, checking where the blossom is thickest so… |
| bo | 2026-11-09T17:27:03.709Z | 0 | 0 | — | 0 |  |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 3 | 50 | 1088011 | 27322 | 5221 | 0.3052 |
| bo | 2 | 34 | 675388 | 24172 | 3882 | 0.2031 |
| **total** | 5 | 84 | 1763399 | 51494 | 9103 | 0.5083 |
