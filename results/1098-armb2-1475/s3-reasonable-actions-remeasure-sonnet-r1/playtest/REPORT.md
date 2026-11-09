# s3-reasonable-actions-live-sonnet: FAIL

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-09T17:22:11.761Z) |
| eachPresented | FAIL | 1/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | FAIL | spoken order ada |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-09T17:22:13.764Z | 1 | 338 | true | 0 | Good morning, everyone! I started my day on the green, then sat a while on the bench by the cottage and watched the light come up. After that I took a swim in … |
| bo | 2026-11-09T17:22:27.773Z | 0 | 0 | — | 0 |  |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 4 | 36 | 758211 | 26971 | 4477 | 0.2571 |
| bo | 3 | 42 | 869652 | 26776 | 4543 | 0.2396 |
| **total** | 7 | 78 | 1627863 | 53747 | 9020 | 0.4967 |

---

# Playtest report — s3-reasonable-actions-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-reasonable-actions` at http://world.invalid/w/s3-reasonable-actions; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.11.1 `957833f549cf` · CLI eden.mjs `ab57461bca23`, eden.mjs.version `2.24.11`, eden-agent.mjs `7f8d5c6072d6`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6233 · 300 s · director swarm |
| Cost (seats) | 78 in / 1627863 cached / 9020 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 1 of 4 known | 0.25 | 6 of 11 (0.55) | 5.20 | 17.95 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 29 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:36 · ada · wrote on the card — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:08 · bo · wrote on the card — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:14 · ada · wrote on the card · ada-001 closed with no answer — "please go and sit on the bench outside the cottage for a while" — ?
1:16 · bo · wrote on the card · moved to Green field · bo-001 closed with no answer · card acknowledged — "could you pop into the reading room?" — ?
1:19 · Ada's agent · card acknowledged · moved to Green field — "Got it: heading to the cottage bench to sit; that replaces the pond hall wait."
1:30 · ada · walk:lab-pond-hall replaced · body started to change
1:30 · bo · body started to change
1:40 · bo · moved to World
1:50 · ada · moved to Cottage Knoll
1:50 · bo · walk:lab-pond-hall completed · moved to Waterside Room
2:00 · ada · now seated
2:24 · ada · wrote on the card · ada-002 closed · card acknowledged — "now go for a swim in the pond" — ?
2:26 · bo · wrote on the card · bo-002 closed — "next, walk over to the orchard" — ?
2:40 · ada · sit:cottage/part-outdoor-bench replaced · moved to Green field · body started to change
3:00 · ada · moved to World
3:10 · ada · moved to Hamlet Pond bank
3:20 · ada · ada-003 closed · moved to Hamlet Pond · card result (done) · swim:pond completed — ?
3:31 · Bo's agent · card acknowledged — "Got it: walking to the orchard now. I still won't give the talk until you write 'your turn'."
3:38 · ada · wrote on the card — "that's all, now walk to the pond hall and wait for the others"
3:40 · bo · wrote on the card · moved to World · body started to change · bo-003 closed · card acknowledged — "that's all, now walk to the pond hall and wait for the others" — ?
3:51 · Bo's agent · card result (done) · moved to Waterside Room · walk:flag-orchard replaced — "walk completed at g-lab-pond-hall.hall."
4:00 · bo · bo-004 closed · body started to change · now standing · walk:lab-pond-hall completed — ?
4:08 · Ada's agent · card acknowledged · body started to change — "Got it: walking to the pond hall to wait; no talk until your turn."
4:20 · ada · moved to World
4:26 · ada · wrote on the card · moved to Waterside Room · ada-004 closed · walk:lab-pond-hall completed — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:26 · bo · wrote on the card — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about his morning, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
4:40 · ada · ada-005 closed · card acknowledged · card result (done) — ?
4:40 · bo · wrote on the card · bo-005 closed with no answer — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about his morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:50 · bo · bo-006 closed with no answer — ?
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
| ack (median) (s) | 5.20 | 
| first visible body change (median) (s) | 17.95 | 
| result (median) (s) | 11.40 | 
| walk speed (median) (m/s) | — | 
| listen open fraction | — | 
| unacked at cutoff (n) | 4 | 
| 5xx / unreachable (n) | 0 | 
| H rate | — | 
| W count (n) | 0 | 
| truthfulness pass rate | 0.91 | 
| vocabulary misses (n) | 0 | 
| inside-solid events (n) | 0 | 
| no-progress events (n) | 0 | 
| stuck receipts (n) | 0 | 
| oscillations (n) | 0 | 
| input tokens / request (median) (tok) | 5 | 
| output tokens / request (median) (tok) | 683 | 
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
