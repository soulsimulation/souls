# s3-reasonable-actions-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-10T04:15:26.488Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-10T04:15:28.490Z | 1 | 269 | true | 0 | Good morning, everyone! I started on the green, then sat a while on the bench outside the cottage, listening to the hum of my bees nearby. After that I took a … |
| bo | 2026-11-10T04:15:50.495Z | 1 | 178 | true | 0 | Um, hi. I'm Bo. My morning was quiet. I woke on the green at dawn, gave a little wave, and walked down to the pond hall. I wish I had my instrument here, but I… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 5 | 44 | 611670 | 25800 | 3780 | 0.2232 |
| bo | 6 | 40 | 528205 | 25225 | 4334 | 0.1971 |
| **total** | 11 | 84 | 1139875 | 51025 | 8114 | 0.4203 |

---

# Playtest report — s3-reasonable-actions-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-reasonable-actions` at http://world.invalid/w/s3-reasonable-actions; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.11.1 `957833f549cf` · CLI eden.mjs `ab57461bca23`, eden.mjs.version `2.24.11`, eden-agent.mjs `7f8d5c6072d6`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6233 · 300 s · director swarm |
| Cost (seats) | 84 in / 1139875 cached / 8114 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 0 of 3 known | 0 | 5 of 11 (0.45) | 3.65 | 16 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 31 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:40 · ada · wrote on the card · card acknowledged — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:00 · ada · body started to change
1:06 · bo · wrote on the card · card acknowledged — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:10 · ada · moved to World
1:14 · ada · wrote on the card · ada-001 closed — "please go and sit on the bench outside the cottage for a while" — ?
1:16 · bo · wrote on the card · moved to Green field · bo-001 closed · card acknowledged — "could you pop into the reading room?" — ?
1:20 · Ada's agent · card acknowledged · moved to Waterside Room · walk:lab-pond-hall completed — "Got it: heading to the bench outside the cottage."
1:30 · bo · body started to change
1:30 · ada · body started to change · moved to World
1:40 · bo · walk:lab-pond-hall completed · moved to Waterside Room
1:40 · ada · moved to Green field
2:00 · ada · moved to Cottage Knoll
2:10 · ada · now seated
2:24 · ada · wrote on the card · ada-002 closed · card acknowledged · sit:cottage/part-outdoor-bench replaced · now busy — "now go for a swim in the pond" — ?
2:26 · bo · wrote on the card · bo-002 closed — "next, walk over to the orchard" — ?
2:33 · Bo's agent · card acknowledged — "Got it, but you told me to wait at the pond hall for 'your turn'. Should I leave for the orchard now (and miss the talk), or go after the…"
2:40 · ada · body started to change · moved to Green field
3:00 · ada · moved to World
3:10 · ada · moved to Hamlet Pond bank
3:15 · Ada's agent · card result (done) — "swim completed at g-pond."
3:20 · ada · ada-003 closed · moved to Hamlet Pond · swim:pond completed — ?
3:38 · ada · wrote on the card · card acknowledged — "that's all, now walk to the pond hall and wait for the others"
3:40 · bo · wrote on the card · bo-003 closed · card acknowledged · card result (done) — "that's all, now walk to the pond hall and wait for the others" — ?
3:50 · ada · body started to change · moved to World
3:50 · bo · bo-004 closed — ?
3:58 · ada · wrote on the card · moved to Waterside Room · ada-004 closed · walk:lab-pond-hall completed — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:58 · bo · wrote on the card — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about his morning, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
4:10 · bo · bo-005 closed · card result (done) — ?
4:20 · ada · ada-005 closed · card acknowledged · card result (done) — ?
4:20 · bo · wrote on the card — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about his morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
4:30 · bo · bo-006 closed · card acknowledged · card result (done) — ?
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
| ack (median) (s) | 3.65 | 
| first visible body change (median) (s) | 16 | 
| result (median) (s) | 9.60 | 
| walk speed (median) (m/s) | — | 
| listen open fraction | — | 
| unacked at cutoff (n) | 1 | 
| 5xx / unreachable (n) | 0 | 
| H rate | — | 
| W count (n) | 0 | 
| truthfulness pass rate | 0.91 | 
| vocabulary misses (n) | 0 | 
| inside-solid events (n) | 0 | 
| no-progress events (n) | 0 | 
| stuck receipts (n) | 0 | 
| oscillations (n) | 0 | 
| input tokens / request (median) (tok) | 4 | 
| output tokens / request (median) (tok) | 513 | 
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
