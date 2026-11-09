# s3-reasonable-actions-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-09T06:10:35.822Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-09T06:10:37.823Z | 1 | 276 | true | 0 | Good morning, everyone! I'm Ada, and I keep bees, so my morning began with a wave to the sunrise on the green. Then I rested on the bench by the cottage, and l… |
| bo | 2026-11-09T06:10:55.824Z | 1 | 230 | true | 0 | I spent the morning mostly on my own, wandering from the green out to the orchard and back again. It was quiet, so I hummed a little tune as I walked. Mornings… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 5 | 44 | 579706 | 28546 | 4039 | 0.2126 |
| bo | 5 | 40 | 501402 | 23630 | 3975 | 0.2076 |
| **total** | 10 | 84 | 1081108 | 52176 | 8014 | 0.4202 |

---

# Playtest report — s3-reasonable-actions-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-reasonable-actions` at http://world.invalid/w/s3-reasonable-actions; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.11.0 `e62e98d212c5` · CLI eden.mjs `a296767957c7`, eden.mjs.version `2.24.10`, eden-agent.mjs `7f8d5c6072d6`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6233 · 300 s · director swarm |
| Cost (seats) | 84 in / 1081108 cached / 8014 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 2 of 4 known | 0.50 | 8 of 11 (0.73) | 3.65 | 14 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 38 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:22 · ada · wrote on the card · card acknowledged — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:40 · ada · body started to change
0:50 · ada · moved to World
0:50 · bo · wrote on the card — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:56 · ada · wrote on the card · moved to Waterside Room · ada-001 closed · walk:lab-pond-hall/hall completed · card acknowledged — "please go and sit on the bench outside the cottage for a while" — ?
0:58 · bo · wrote on the card · bo-001 closed with no answer · card acknowledged — "could you pop into the reading room?" — ?
1:10 · ada · body started to change · moved to World
1:10 · bo · body started to change
1:20 · ada · moved to Green field
1:20 · bo · moved to World
1:30 · ada · moved to World
1:30 · bo · walk:lab-pond-hall completed · moved to Waterside Room
1:40 · ada · moved to Cottage Knoll
1:50 · ada · now seated
2:06 · ada · wrote on the card · ada-002 closed · card acknowledged — "now go for a swim in the pond" — ?
2:08 · bo · wrote on the card · bo-002 closed · card acknowledged — "next, walk over to the orchard" — ?
2:20 · ada · sit:cottage/part-outdoor-bench replaced · body started to change · now walking
2:20 · bo · body started to change · moved to Green field
2:30 · ada · moved to Green field
2:50 · ada · moved to World
3:00 · ada · ada-003 closed · moved to Hamlet Pond · card result (done) · swim:pond completed — ?
3:13 · Bo's agent · card result (done) · moved to World — "walk completed at the orchard flag."
3:20 · ada · wrote on the card · card acknowledged — "that's all, now walk to the pond hall and wait for the others"
3:22 · bo · wrote on the card · bo-003 closed · now standing · walk:flag-orchard completed · card acknowledged — "that's all, now walk to the pond hall and wait for the others" — ?
3:30 · bo · now walking
3:30 · ada · now walking
3:40 · bo · body started to change
3:43 · Ada's agent · card result (done) · moved to Waterside Room · body started to change — "walk completed at g-lab-pond-hall.hall."
3:50 · bo · moved to Green field
3:50 · ada · ada-004 closed · now standing · walk:lab-pond-hall/hall completed — ?
4:20 · bo · moved to World
4:28 · ada · wrote on the card · now walking — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
4:28 · bo · wrote on the card · moved to Waterside Room · bo-004 closed · walk:lab-pond-hall/hall completed · card acknowledged — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about his morning, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:43 · Ada's agent · card result (done) · body started to change · now standing · card acknowledged — "Got it: giving the talk now. Said: Good morning, everyone! I'm Ada, and I keep bees, so my morning began with a wave to the sunrise on the g"
4:46 · bo · wrote on the card · bo-005 closed — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about his morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:50 · ada · ada-005 closed — ?
4:51 · Bo's agent · card acknowledged — "Got it: giving the talk now"
5:10 · bo · bo-006 closed — ?
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
| first visible body change (median) (s) | 14 | 
| result (median) (s) | 37.60 | 
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
| input tokens / request (median) (tok) | 4 | 
| output tokens / request (median) (tok) | 548 | 
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
