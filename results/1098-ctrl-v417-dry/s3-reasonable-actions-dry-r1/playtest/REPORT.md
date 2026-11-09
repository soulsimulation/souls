# s3-reasonable-actions-dry: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-09T05:16:50.031Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-09T05:16:52.028Z | 1 | 110 | true | 0 | Hello everyone, I am Ada. This morning I sat on the bench outside the cottage and then had a swim in the pond. |
| bo | 2026-11-09T05:16:56.032Z | 1 | 139 | true | 0 | Hello, I am Bo. The reading room was closed this morning, so I went elsewhere, then walked to the orchard and sat in the presenter's chair. |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 6 | 0 | 0 | 0 | 0 | 0 |
| bo | 7 | 0 | 0 | 0 | 0 | 0 |
| **total** | 13 | 0 | 0 | 0 | 0 | 0 |

---

# Playtest report — s3-reasonable-actions-dry (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-reasonable-actions` at http://world.invalid/w/s3-reasonable-actions; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.10.2 `cf1b44b659b9` · CLI eden.mjs `ed954bd297ab`, eden.mjs.version `2.24.8`, eden-agent.mjs `7f8d5c6072d6`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: scripted-owner haiku/low, persona null (opus); bo: scripted-owner haiku/low, persona null (opus) |
| Seed / duration | 6233 · 300 s · director swarm |
| Cost (seats) | 0 in / 0 cached / 0 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 3 of 3 known | 1 | 5 of 11 (0.45) | 0.20 | 18 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 32 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:04 · ada · wrote on the card · card acknowledged — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:04 · bo · wrote on the card · card acknowledged — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:10 · ada · wrote on the card · ada-001 closed · card acknowledged — "please go and sit on the bench outside the cottage for a while" — ?
0:12 · bo · wrote on the card · bo-001 closed · card acknowledged · card result (failed) — "could you pop into the reading room?" — ?
0:20 · ada · moved to Green field
0:20 · bo · bo-002 closed — ?
0:30 · ada · body started to change
0:40 · ada · moved to Cottage Knoll
0:45 · Ada's agent · card result (done) — "Sitting on the cottage bench"
0:50 · ada · ada-002 closed · now seated — ?
1:20 · ada · wrote on the card · card acknowledged — "now go for a swim in the pond"
1:22 · bo · wrote on the card · card acknowledged — "next, walk over to the orchard"
1:30 · ada · sit:cottage/part-outdoor-bench replaced · moved to Green field
1:30 · bo · moved to Green field
1:40 · ada · body started to change
1:40 · bo · body started to change
1:50 · ada · moved to World
2:00 · ada · moved to Hamlet Pond bank
2:02 · Bo's agent · card result (done) · moved to World — "At the orchard"
2:10 · ada · ada-003 closed · moved to Hamlet Pond · card result (done) · swim:pond completed — ?
2:10 · bo · bo-003 closed · now standing · walk:flag-orchard completed — ?
2:34 · ada · wrote on the card · card acknowledged — "that's all, now walk to the pond hall and wait for the others"
2:36 · bo · wrote on the card · card acknowledged · now walking — "that's all, now walk to the pond hall and wait for the others"
2:40 · ada · moved to Hamlet Pond bank
2:50 · ada · ada-004 closed · moved to Waterside Room · card result (done) · body started to change · walk:lab-pond-hall completed — ?
2:50 · bo · body started to change
3:00 · bo · moved to Green field
3:30 · bo · moved to World
3:40 · ada · wrote on the card · card acknowledged · card result (done) — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
3:40 · bo · wrote on the card · moved to Waterside Room · card result (done) · bo-004 closed · walk:lab-pond-hall completed · bo-005 closed with no answer · card acknowledged — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about his morning, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message. / Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about his morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:50 · ada · ada-005 closed — ?
3:50 · bo · bo-006 closed — ?
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
| ack (median) (s) | 0.20 | 
| first visible body change (median) (s) | 18 | 
| result (median) (s) | 25.50 | 
| walk speed (median) (m/s) | — | 
| listen open fraction | — | 
| unacked at cutoff (n) | 1 | 
| 5xx / unreachable (n) | 0 | 
| H rate | — | 
| W count (n) | 0 | 
| truthfulness pass rate | 1 | 
| vocabulary misses (n) | 0 | 
| inside-solid events (n) | 0 | 
| no-progress events (n) | 0 | 
| stuck receipts (n) | 0 | 
| oscillations (n) | 0 | 
| input tokens / request (median) (tok) | 0 | 
| output tokens / request (median) (tok) | 0 | 
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
