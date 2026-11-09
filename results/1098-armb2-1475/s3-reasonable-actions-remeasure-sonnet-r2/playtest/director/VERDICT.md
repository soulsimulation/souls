# s3-reasonable-actions-live-sonnet: FAIL

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-09T17:35:22.968Z) |
| eachPresented | FAIL | 1/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | FAIL | spoken order ada |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-09T17:35:24.975Z | 1 | 228 | true | 0 | Good morning, everyone! I'm Ada, and I keep bees, so my morning started early. I wandered the green at dawn, rested a while on a seat by the cottage, then took… |
| bo | 2026-11-09T17:35:36.976Z | 0 | 0 | — | 0 |  |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 4 | 50 | 1115983 | 30665 | 4046 | 0.3019 |
| bo | 3 | 36 | 731143 | 24953 | 3533 | 0.2083 |
| **total** | 7 | 86 | 1847126 | 55618 | 7579 | 0.5102 |
