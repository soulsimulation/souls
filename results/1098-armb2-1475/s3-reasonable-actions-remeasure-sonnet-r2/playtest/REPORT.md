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

---

# Playtest report — s3-reasonable-actions-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-reasonable-actions` at http://world.invalid/w/s3-reasonable-actions; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.11.1 `957833f549cf` · CLI eden.mjs `ab57461bca23`, eden.mjs.version `2.24.11`, eden-agent.mjs `7f8d5c6072d6`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6233 · 300 s · director swarm |
| Cost (seats) | 86 in / 1847126 cached / 7579 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 3 of 7 known | 0.43 | 6 of 11 (0.55) | 6 | 17.95 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 26 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:28 · ada · wrote on the card — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:58 · bo · wrote on the card — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:04 · ada · wrote on the card · moved to Green field · ada-001 closed with no answer · card acknowledged — "please go and sit on the bench outside the cottage for a while" — ?
1:06 · bo · wrote on the card · moved to Green field · bo-001 closed with no answer · card acknowledged · card result (failed) — "could you pop into the reading room?" — ?
1:20 · ada · walk:lab-pond-hall replaced · body started to change
1:20 · bo · bo-002 closed · body started to change — ?
1:40 · ada · moved to Cottage Knoll
1:46 · Ada's agent · card result (done) — "walk completed at g-cottage.living."
1:50 · ada · ada-002 closed · moved to Living Room · walk:cottage completed — ?
2:14 · ada · wrote on the card · moved to Cottage Knoll · card acknowledged · sit:here replaced · walk:knoll completed — "now go for a swim in the pond"
2:16 · bo · wrote on the card — "next, walk over to the orchard"
2:20 · bo · walk:lab-pond-hall completed · moved to Waterside Room
2:30 · ada · body started to change · moved to Green field
3:00 · ada · ada-003 closed · moved to Hamlet Pond bank · card result (done) · walk:pond completed — ?
3:23 · Bo's agent · card acknowledged — "Got it: walking to the orchard."
3:28 · ada · wrote on the card · moved to Hamlet Pond · swim:pond completed — "that's all, now walk to the pond hall and wait for the others"
3:30 · bo · wrote on the card · moved to Green field · body started to change · bo-003 closed · card acknowledged — "that's all, now walk to the pond hall and wait for the others" — ?
3:43 · Bo's agent · card result (done) · moved to World · walk:flag-orchard replaced — "walk completed at g-lab-pond-hall.hall."
3:50 · bo · bo-004 closed · moved to Waterside Room · body started to change · walk:lab-pond-hall completed — ?
3:59 · Ada's agent · card acknowledged · body started to change — "Got it: walking to the pond hall to wait for the others."
4:10 · ada · moved to World
4:18 · ada · wrote on the card · moved to Waterside Room · ada-004 closed · walk:lab-pond-hall completed — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:18 · bo · wrote on the card — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about his morning, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
4:30 · ada · ada-005 closed · card acknowledged · card result (done) — ?
4:30 · bo · wrote on the card · bo-005 closed with no answer — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about his morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:40 · bo · bo-006 closed with no answer — ?
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
| ack (median) (s) | 6 | 
| first visible body change (median) (s) | 17.95 | 
| result (median) (s) | 12.40 | 
| walk speed (median) (m/s) | — | 
| listen open fraction | — | 
| unacked at cutoff (n) | 4 | 
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
| output tokens / request (median) (tok) | 484 | 
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
