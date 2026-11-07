# s3-reasonable-actions-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-07T17:24:27.171Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-07T17:24:29.173Z | 1 | 310 | true | 0 | Good morning, everyone! I started my day on the green, then sat a while on the cottage bench, thinking about my bees and how the clover is coming in. After tha… |
| bo | 2026-11-07T17:24:39.175Z | 1 | 256 | true | 0 | Hi, I'm Bo. I'm a bit shy, so I spent the quiet morning with my music, tuning up in the hamlet while the sun came up. Then I wandered over to the pond hall, hu… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 5 | 50 | 674952 | 29022 | 4061 | 0.2243 |
| bo | 5 | 50 | 692857 | 27367 | 4828 | 0.2271 |
| **total** | 10 | 100 | 1367809 | 56389 | 8889 | 0.4514 |

---

# Playtest report — s3-reasonable-actions-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-reasonable-actions` at http://127.0.0.1:4456/w/s3-reasonable-actions; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.9.6 `2f7ca57139d1` · CLI eden.mjs `0097d8015d8a`, eden.mjs.version `2.23.1`, eden-agent.mjs `5a09e2f58856`, eden-god.mjs `c4c1b3e976f9` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6233 · 300 s · director swarm |
| Cost (seats) | 100 in / 1367809 cached / 8889 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 0 of 3 known | 0 | 5 of 11 (0.45) | 3.60 | 18 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 31 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:30 · ada · wrote on the card — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:35 · Ada's agent · card acknowledged — "Got it: walking to the pond hall, then waiting for 'your turn'."
0:50 · ada · body started to change
1:00 · ada · moved to World
1:02 · bo · wrote on the card · card acknowledged — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:08 · ada · wrote on the card · moved to Waterside Room · ada-001 closed · walk:lab-pond-hall completed — "please go and sit on the bench outside the cottage for a while" — ?
1:12 · bo · wrote on the card · bo-001 closed — "could you pop into the reading room?" — ?
1:17 · Ada's agent · card acknowledged · body started to change · now walking — "Got it: heading to the bench outside the cottage to sit."
1:19 · Bo's agent · card acknowledged — "Got it: heading to the reading room after the pond hall walk."
1:30 · ada · moved to Green field
1:30 · bo · walk:lab-pond-hall replaced · moved to World · body started to change
1:35 · Bo's agent · card result (done) — "walk completed at g-lab-pond-hall.hall."
1:40 · bo · bo-002 closed · moved to Waterside Room · walk:lab-pond-hall completed — ?
1:50 · ada · moved to Cottage Knoll
2:00 · ada · ada-002 closed · card result (done) · now seated — ?
2:18 · ada · wrote on the card · card acknowledged — "now go for a swim in the pond"
2:20 · bo · wrote on the card · card acknowledged · card result (failed) · bo-003 closed — "next, walk over to the orchard" — ?
2:30 · ada · sit:cottage/part-outdoor-bench replaced · body started to change · now walking
2:40 · ada · moved to Green field
3:00 · ada · moved to World
3:10 · ada · ada-003 closed · moved to Hamlet Pond · card result (done) · swim:pond completed — ?
3:32 · ada · wrote on the card · card acknowledged — "that's all, now walk to the pond hall and wait for the others"
3:34 · bo · wrote on the card — "that's all, now walk to the pond hall and wait for the others"
3:50 · ada · body started to change · moved to World
3:56 · ada · wrote on the card · moved to Waterside Room · ada-004 closed · card acknowledged · walk:lab-pond-hall/hall completed · card result (done) — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:56 · bo · wrote on the card · bo-004 closed with no answer — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about his morning, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:06 · bo · wrote on the card · bo-005 closed with no answer — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about his morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:10 · ada · ada-005 closed — ?
4:28 · Bo's agent · card acknowledged — "Got it: giving the talk now."
4:33 · Bo's agent · card result (done) — "Bo gave the talk in the pond hall (heard by 1). Now listening."
4:40 · bo · bo-006 closed — ?
```

The full player's-eye story is in [journal.md](journal.md).

## 3. Fidelity

| request | seat | channel | asked | score | class | noticed | input depth | note |
|---|---|---|---|---|---|---|---|---|

H 0 · P 0 · M 0 · W 0 of 0. P never counts as H. No frozen battery ran in this session.

## 4. Objective measures

No previous run of this scenario in the runs folder.

| measure | this run | 
|---|---|
| ack (median) (s) | 3.60 | 
| first visible body change (median) (s) | 18 | 
| result (median) (s) | 25 | 
| walk speed (median) (m/s) | — | 
| listen open fraction | — | 
| unacked at cutoff (n) | 2 | 
| 5xx / unreachable (n) | 0 | 
| H rate | — | 
| W count (n) | 0 | 
| truthfulness pass rate | 1 | 
| vocabulary misses (n) | 0 | 
| inside-solid events (n) | 0 | 
| no-progress events (n) | 0 | 
| stuck receipts (n) | 0 | 
| oscillations (n) | 0 | 
| input tokens / request (median) (tok) | 6 | 
| output tokens / request (median) (tok) | 563 | 
| acks over 140 chars (n) | 0 | 

All measures with units and bases: [metrics.json](metrics.json).

## 5. Emergence and story


## 6. Issues and feature requests

No issues raised.
**Feature requests** (grouped):

None.

Full text: [issues.md](issues.md) · [feature-requests.md](feature-requests.md).

## 7. Developer drafts

**DRAFT — NOT IMPLEMENTED.** Each spec proposes a cause, an owning area, an approach and a bar; none was applied.

No drafts in this run.

## 8. Harness notes

- shots: 0 indexed of 30 planned.
- oracles: 11/11 evidence packs have at least one unknown oracle (missing godSlice, no walk, or no presence).
