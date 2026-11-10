# s3-reasonable-actions-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-10T04:29:44.679Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-10T04:29:46.680Z | 1 | 260 | true | 0 | Good morning, everyone! I started on the green at dawn, then sat on the cottage bench for a while, thinking about my bees. Afterwards I took a lovely swim in t… |
| bo | 2026-11-10T04:30:04.691Z | 1 | 185 | true | 0 | I was up at dawn and carried my little instrument out to the green, playing softly where nobody could hear. Then I wandered to the orchard and back here. It wa… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 6 | 44 | 581348 | 28168 | 3661 | 0.2075 |
| bo | 5 | 50 | 661213 | 26974 | 4631 | 0.2204 |
| **total** | 11 | 94 | 1242561 | 55142 | 8292 | 0.4279 |

---

# Playtest report — s3-reasonable-actions-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-reasonable-actions` at http://world.invalid/w/s3-reasonable-actions; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.11.1 `957833f549cf` · CLI eden.mjs `ab57461bca23`, eden.mjs.version `2.24.11`, eden-agent.mjs `7f8d5c6072d6`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6233 · 300 s · director swarm |
| Cost (seats) | 94 in / 1242561 cached / 8292 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 4 of 4 known | 1 | 7 of 11 (0.64) | 4.40 | 14 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 39 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:28 · ada · wrote on the card · card acknowledged — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:40 · ada · body started to change · moved to Green field
1:00 · ada · walk:lab-pond-hall completed · moved to Waterside Room
1:00 · bo · wrote on the card — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:06 · ada · wrote on the card · ada-001 closed — "please go and sit on the bench outside the cottage for a while" — ?
1:08 · bo · wrote on the card · bo-001 closed with no answer · card acknowledged — "could you pop into the reading room?" — ?
1:11 · Ada's agent · card acknowledged — "Got it: going to sit on the bench outside the cottage."
1:20 · ada · body started to change · moved to World
1:20 · bo · bo-002 closed · card result (failed) · body started to change — ?
1:30 · ada · moved to Green field
1:40 · ada · moved to World
1:50 · ada · moved to Cottage Knoll
2:16 · ada · wrote on the card · ada-002 closed — "now go for a swim in the pond" — ?
2:18 · bo · wrote on the card · moved to Waterside Room · walk:lab-pond-hall/hall completed · card acknowledged — "next, walk over to the orchard"
2:22 · Ada's agent · card acknowledged — "Got it: going for a swim in the pond."
2:30 · ada · sit:cottage/part-outdoor-bench replaced · body started to change · now walking
2:30 · bo · body started to change · moved to World
2:40 · ada · moved to Green field
2:40 · bo · moved to Green field
3:00 · ada · moved to World
3:10 · Ada's agent · card result (done) · moved to Hamlet Pond — "swim completed at g-pond."
3:20 · ada · ada-003 closed · swim:pond completed — ?
3:20 · bo · moved to World
3:30 · ada · wrote on the card · card acknowledged — "that's all, now walk to the pond hall and wait for the others"
3:32 · bo · wrote on the card · card result (done) · now standing · walk:flag-orchard completed · bo-003 closed — "that's all, now walk to the pond hall and wait for the others" — ?
3:40 · ada · moved to Hamlet Pond bank
3:45 · Bo's agent · card acknowledged — "Got it: walking back to the pond hall to wait"
3:50 · ada · ada-004 closed · moved to Waterside Room · card result (done) · body started to change · walk:lab-pond-hall completed — ?
3:50 · bo · body started to change · now walking
4:10 · bo · moved to Green field
4:40 · bo · moved to World
4:50 · ada · wrote on the card — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
4:50 · bo · wrote on the card · moved to Waterside Room · bo-004 closed · card acknowledged — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about his morning, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
5:00 · bo · walk:lab-pond-hall/hall completed · now standing
5:05 · Ada's agent · card result (done) · card acknowledged — "Got it: giving my talk now. Said: Good morning, everyone! I started on the green at dawn, then sat on the cottage bench for a while, thinkin"
5:08 · bo · wrote on the card · bo-005 closed — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about his morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
5:10 · ada · ada-005 closed — ?
5:16 · Bo's agent · card result (done) · card acknowledged — "Got it: giving the talk now Bo gave the talk; heard by 1."
5:20 · bo · bo-006 closed — ?
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
| ack (median) (s) | 4.40 | 
| first visible body change (median) (s) | 14 | 
| result (median) (s) | 16.25 | 
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
| input tokens / request (median) (tok) | 5 | 
| output tokens / request (median) (tok) | 545 | 
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
