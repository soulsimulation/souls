# s3-sustained-intent-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-09T06:15:43.425Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-09T06:15:45.426Z | 1 | 302 | true | 0 | Good morning, everyone! I'm Ada, and I keep bees, so my morning errand was a walk out to check on the hives for my neighbour. The bees were already busy in the… |
| bo | 2026-11-09T06:16:03.428Z | 1 | 195 | true | 0 | Um, hi. I'm Bo. This morning I planned to walk to the orchard with my flute. Then the plan changed, twice, and I ended up here instead. I think I like it. Mayb… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 4 | 54 | 762653 | 29401 | 4928 | 0.2531 |
| bo | 5 | 48 | 647079 | 25402 | 4296 | 0.2305 |
| **total** | 9 | 102 | 1409732 | 54803 | 9224 | 0.4836 |

---

# Playtest report — s3-sustained-intent-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-sustained-intent` at http://world.invalid/w/s3-sustained-intent; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.11.0 `e62e98d212c5` · CLI eden.mjs `a296767957c7`, eden.mjs.version `2.24.10`, eden-agent.mjs `7f8d5c6072d6`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6234 · 300 s · director swarm |
| Cost (seats) | 102 in / 1409732 cached / 9224 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 2 of 4 known | 0.50 | 4 of 14 (0.29) | 6.25 | 20 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 33 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:26 · ada · wrote on the card — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:30 · Ada's agent · card acknowledged — "Got it: walking to the pond hall, then waiting for your turn."
0:40 · ada · body started to change · moved to Green field
0:52 · bo · wrote on the card · card acknowledged — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:00 · ada · wrote on the card · moved to Waterside Room · ada-001 closed — "please walk over to the orchard, and after that go and sit on the bench outside the cottage" — ?
1:00 · bo · wrote on the card · bo-001 closed — "walk over to the orchard, please" — ?
1:06 · ada · wrote on the card · ada-002 closed with no answer · ada-003 closed with no answer · ada-004 closed with no answer · now standing · walk:lab-pond-hall/hall completed — "lovely morning! / do you remember where you are going? / tell me when you're there" — ?
1:08 · bo · wrote on the card · bo-002 closed with no answer · walk:flag-orchard failed (act.stopped) · walk:lab-pond-hall replaced · now standing · stop:current completed · card result (done) — "actually stop, don't go to the orchard after all" — ?
1:20 · Ada's agent · card acknowledged — "Got it: I will tell you when I arrive."
1:22 · bo · wrote on the card · bo-003 closed · card acknowledged · card result (done) · bo-004 closed — "say hello to everyone around you" — ?
1:30 · ada · body started to change · moved to World
1:40 · ada · moved to Green field
2:08 · bo · nothing visible happened for 92 s
2:20 · ada · moved to World
2:30 · ada · walk:flag-orchard completed
2:40 · ada · moved to Green field
2:52 · ada · wrote on the card · ada-005 closed · card acknowledged — "that's all, now walk to the pond hall and wait for the others" — ?
2:54 · bo · wrote on the card — "that's all, now walk to the pond hall and wait for the others"
3:00 · ada · sit:cottage/part-outdoor-bench replaced
3:10 · ada · body started to change · moved to Village Green
3:20 · ada · moved to Green field
3:40 · ada · ada-006 closed · moved to Waterside Room · card result (done) · walk:lab-pond-hall/hall completed — ?
3:51 · Bo's agent · card acknowledged — "Got it: walking to the pond hall to wait for the others."
4:00 · bo · body started to change · now walking
4:10 · bo · moved to World
4:16 · ada · wrote on the card — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her errand, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
4:16 · bo · wrote on the card · moved to Waterside Room · bo-005 closed · walk:lab-pond-hall completed · card result (done) — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about a change of plan, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:30 · bo · bo-006 closed — ?
4:32 · Ada's agent · card result (done) · card acknowledged — "Got it: giving my talk now. Said: Good morning, everyone! I'm Ada, and I keep bees, so my morning errand was a walk out to check on the hive"
4:34 · bo · wrote on the card — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about a change of plan, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
4:40 · ada · ada-007 closed — ?
4:43 · Bo's agent · card result (done) · card acknowledged — "Got it: giving the talk now. Said: Um, hi. I'm Bo. This morning I planned to walk to the orchard with my flute. Then the plan changed, twice"
4:50 · bo · bo-007 closed — ?
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
| ack (median) (s) | 6.25 | 
| first visible body change (median) (s) | 20 | 
| result (median) (s) | 7.35 | 
| walk speed (median) (m/s) | — | 
| listen open fraction | — | 
| unacked at cutoff (n) | 6 | 
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
| output tokens / request (median) (tok) | 439.50 | 
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
- oracles: 14/14 evidence packs have at least one unknown oracle (missing godSlice, no walk, or no presence).
