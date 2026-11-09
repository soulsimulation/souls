# s3-reasonable-actions-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-09T05:27:23.614Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-09T05:27:25.616Z | 1 | 272 | false | 0 | Good morning, everyone! I'm Ada, and I keep bees, so my morning began at the hives, listening to the hum wake up as the sun rose. I checked on the colony and t… |
| bo | 2026-11-09T05:28:35.633Z | 1 | 227 | false | 0 | Um, hi. I'm Bo. This morning I woke early, hummed a few quiet tunes on my instrument, and wandered over to the pond hall. It was calm and the light was soft, a… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 3 | 40 | 501237 | 25055 | 3614 | 0.1866 |
| bo | 3 | 42 | 545516 | 27256 | 4490 | 0.2086 |
| **total** | 6 | 82 | 1046753 | 52311 | 8104 | 0.3952 |

---

# Playtest report — s3-reasonable-actions-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-reasonable-actions` at http://world.invalid/w/s3-reasonable-actions; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.10.2 `cf1b44b659b9` · CLI eden.mjs `ed954bd297ab`, eden.mjs.version `2.24.8`, eden-agent.mjs `7f8d5c6072d6`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6233 · 300 s · director swarm |
| Cost (seats) | 82 in / 1046753 cached / 8104 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 5 | 0 of 3 known | 0 | 6 of 9 (0.67) | 3 | 15 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 21 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:30 · ada · wrote on the card — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:35 · Ada's agent · card acknowledged — "Got it: walking to the pond hall, then waiting for your turn."
0:50 · ada · body started to change
0:54 · bo · wrote on the card · card acknowledged — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:00 · ada · wrote on the card · moved to World · ada-001 closed — "please go and sit on the bench outside the cottage for a while" — ?
1:02 · bo · wrote on the card · bo-001 closed · card acknowledged · card result (failed) · bo-002 closed — "could you pop into the reading room?" — ?
1:09 · Ada's agent · card acknowledged · moved to Waterside Room · walk:lab-pond-hall/hall completed — "Got it: heading to the cottage bench to sit."
1:28 · ada · wrote on the card · moved to World · ada-002 closed · card acknowledged — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
1:28 · bo · wrote on the card · moved to Waterside Room · card acknowledged — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about his morning, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:35 · Ada's agent · card result (done) — "Said: Good morning, everyone! I'm Ada, and I keep bees, so my morning began at the hives, listening to the hum wake up as the sun rose. I…"
1:40 · ada · ada-003 closed · moved to Green field · body started to change — ?
1:40 · bo · body started to change · now standing · walk:lab-pond-hall/hall completed
2:10 · ada · wrote on the card · card acknowledged — "now go for a swim in the pond"
2:12 · bo · wrote on the card · bo-003 closed · card acknowledged — "next, walk over to the orchard" — ?
2:20 · bo · moved to World
2:20 · ada · sit:cottage/part-outdoor-bench replaced · moved to Cottage Knoll
2:30 · bo · body started to change · moved to Green field
2:30 · ada · body started to change · moved to Green field
2:38 · bo · wrote on the card · bo-004 closed · card acknowledged · card result (done) — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about his morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
2:50 · ada · ada-004 closed · moved to World — ?
2:50 · bo · bo-005 closed · body started to change — ?
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
| ack (median) (s) | 3 | 
| first visible body change (median) (s) | 15 | 
| result (median) (s) | 6.70 | 
| walk speed (median) (m/s) | — | 
| listen open fraction | — | 
| unacked at cutoff (n) | 0 | 
| 5xx / unreachable (n) | 0 | 
| H rate | — | 
| W count (n) | 0 | 
| truthfulness pass rate | 1 | 
| vocabulary misses (n) | 0 | 
| inside-solid events (n) | 0 | 
| no-progress events (n) | 0 | 
| stuck receipts (n) | 0 | 
| oscillations (n) | 0 | 
| input tokens / request (median) (tok) | 5 | 
| output tokens / request (median) (tok) | 585 | 
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
- oracles: 9/9 evidence packs have at least one unknown oracle (missing godSlice, no walk, or no presence).
