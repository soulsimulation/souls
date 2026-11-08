# s3-reasonable-actions-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-08T00:40:58.669Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-08T00:41:00.669Z | 1 | 249 | true | 0 | Good morning, everyone! I'm Ada, and I keep bees, so my morning started early. I wandered over to the cottage knoll and sat out in the cool dawn air, then took… |
| bo | 2026-11-08T00:41:20.672Z | 1 | 222 | true | 0 | Um... hi. I'm Bo. This morning I walked over to the pond hall, then out to the orchard, and then back here again. It was quiet and the light was nice. I didn't… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 5 | 48 | 670731 | 27600 | 3646 | 0.2393 |
| bo | 5 | 46 | 627160 | 25766 | 4036 | 0.2269 |
| **total** | 10 | 94 | 1297891 | 53366 | 7682 | 0.4662 |

---

# Playtest report — s3-reasonable-actions-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-reasonable-actions` at http://world.invalid/w/s3-reasonable-actions; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.9.9 `fa4a90fb4bab` · CLI eden.mjs `aa24e8ea5fcf`, eden.mjs.version `2.23.6`, eden-agent.mjs `5a09e2f58856`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6233 · 300 s · director swarm |
| Cost (seats) | 94 in / 1297891 cached / 7682 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 3 of 6 known | 0.50 | 6 of 11 (0.55) | 3.40 | 19 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 38 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:26 · ada · wrote on the card · card acknowledged — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:40 · ada · body started to change · moved to Green field
0:54 · bo · wrote on the card · card acknowledged — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:00 · ada · wrote on the card · moved to Waterside Room · card result (done) · walk:lab-pond-hall completed · ada-001 closed — "please go and sit on the bench outside the cottage for a while" — ?
1:02 · bo · wrote on the card · bo-001 closed · card acknowledged — "could you pop into the reading room?" — ?
1:07 · Ada's agent · card acknowledged · moved to World — "Got it: heading to the bench outside the cottage to sit."
1:10 · bo · bo-002 closed · card result (failed) — ?
1:20 · ada · body started to change · moved to Green field
1:40 · ada · moved to Cottage Knoll
1:45 · Ada's agent · card result (done) — "walk completed at g-cottage.living."
1:50 · ada · ada-002 closed · moved to Living Room · walk:cottage completed — ?
2:10 · ada · wrote on the card · card acknowledged — "now go for a swim in the pond"
2:12 · bo · wrote on the card · card acknowledged — "next, walk over to the orchard"
2:20 · ada · sit:here replaced · moved to Cottage Knoll · walk:knoll completed
2:20 · bo · walk:lab-pond-hall completed · moved to World
2:30 · ada · body started to change · moved to Green field
2:30 · bo · body started to change · moved to Green field
2:50 · ada · moved to World
3:00 · Ada's agent · card result (done) · moved to Hamlet Pond — "swim completed at g-pond."
3:10 · ada · ada-003 closed · swim:pond completed — ?
3:10 · bo · moved to World
3:20 · bo · bo-003 closed · card result (done) · now standing · walk:flag-orchard completed — ?
3:24 · ada · wrote on the card · card acknowledged — "that's all, now walk to the pond hall and wait for the others"
3:26 · bo · wrote on the card — "that's all, now walk to the pond hall and wait for the others"
3:40 · ada · body started to change · moved to World
3:50 · ada · ada-004 closed · moved to Waterside Room · card result (done) · walk:lab-pond-hall/hall completed — ?
3:55 · Bo's agent · card acknowledged — "Got it: walking back to the pond hall to wait."
4:00 · bo · body started to change · now walking
4:20 · bo · moved to Green field
4:50 · bo · moved to World
4:56 · ada · wrote on the card — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
4:56 · bo · wrote on the card · moved to Waterside Room · bo-004 closed · walk:lab-pond-hall completed · card result (done) — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about his morning, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
5:10 · bo · bo-005 closed — ?
5:13 · Ada's agent · card result (done) · card acknowledged — "Got it: giving the talk now. Ada gave her talk aloud in the Waterside Room; heard by 1."
5:16 · bo · wrote on the card — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about his morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
5:20 · ada · ada-005 closed — ?
5:21 · Bo's agent · card result (done) · card acknowledged — "Got it: giving the talk now. Said: Um... hi. I'm Bo. This morning I walked over to the pond hall, then out to the orchard, and then back her"
5:30 · bo · bo-006 closed — ?
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
| ack (median) (s) | 3.40 | 
| first visible body change (median) (s) | 19 | 
| result (median) (s) | 22.90 | 
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
| input tokens / request (median) (tok) | 6 | 
| output tokens / request (median) (tok) | 486 | 
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
