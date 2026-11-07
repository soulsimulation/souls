# s3-sustained-intent-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-07T17:15:26.696Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-07T17:15:28.699Z | 1 | 262 | true | 0 | Good morning, everyone! I'm Ada, and I keep bees, so my errand began at the orchard, where the blossoms were humming already. Then I set off toward the cottage… |
| bo | 2026-11-07T17:15:40.702Z | 1 | 268 | true | 0 | Um... hi. This morning I meant to practise my music alone on the green, but plans changed. I was sent to the pond hall instead, and then to the orchard, and th… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 3 | 22 | 245499 | 14548 | 1698 | 0.1948 |
| bo | 5 | 54 | 773389 | 28845 | 5247 | 0.2453 |
| **total** | 8 | 76 | 1018888 | 43393 | 6945 | 0.4401 |

---

# Playtest report — s3-sustained-intent-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-sustained-intent` at http://127.0.0.1:4458/w/s3-sustained-intent; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.9.6 `2f7ca57139d1` · CLI eden.mjs `0097d8015d8a`, eden.mjs.version `2.23.1`, eden-agent.mjs `5a09e2f58856`, eden-god.mjs `c4c1b3e976f9` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6234 · 300 s · director swarm |
| Cost (seats) | 76 in / 1018888 cached / 6945 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 1 of 3 known | 0.33 | 4 of 14 (0.29) | 2.70 | 19 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 31 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:30 · ada · wrote on the card · card acknowledged — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:50 · ada · body started to change
0:50 · bo · wrote on the card — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:56 · ada · wrote on the card · moved to World · ada-001 closed · card acknowledged — "please walk over to the orchard, and after that go and sit on the bench outside the cottage" — ?
0:58 · bo · wrote on the card · bo-001 closed with no answer — "walk over to the orchard, please" — ?
1:04 · ada · wrote on the card · moved to Green field · ada-002 closed · ada-003 closed with no answer · ada-004 closed with no answer · walk:lab-pond-hall replaced — "lovely morning! / do you remember where you are going? / tell me when you're there" — ?
1:06 · bo · wrote on the card · bo-002 closed with no answer · card acknowledged · walk:flag-orchard replaced · walk:lab-pond-hall replaced · now standing · stand:here completed · card result (done) — "actually stop, don't go to the orchard after all" — ?
1:14 · Ada's agent · card acknowledged — "Got it: I'll report once I reach the orchard."
1:20 · ada · body started to change
1:20 · bo · wrote on the card · bo-003 closed · card acknowledged · card result (done) — "say hello to everyone around you" — ?
1:30 · bo · bo-004 closed — ?
1:50 · ada · moved to World
2:00 · ada · walk:flag-orchard completed · now standing
2:10 · ada · now walking
2:20 · ada · moved to Green field
2:50 · ada · wrote on the card · ada-005 closed · card acknowledged — "that's all, now walk to the pond hall and wait for the others" — ?
2:52 · bo · wrote on the card · card acknowledged — "that's all, now walk to the pond hall and wait for the others"
3:00 · ada · sit:cottage/part-outdoor-bench replaced
3:00 · bo · now walking
3:10 · ada · body started to change
3:10 · bo · body started to change
3:20 · ada · moved to World
3:20 · bo · moved to Waterside Room
3:26 · ada · wrote on the card · moved to Waterside Room · ada-006 closed · walk:lab-pond-hall completed — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her errand, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:26 · bo · wrote on the card · bo-005 closed · now standing · walk:lab-pond-hall completed — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about a change of plan, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:34 · Ada's agent · card result (done) — "Gave the talk with say."
3:38 · bo · wrote on the card · bo-006 closed with no answer — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about a change of plan, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:40 · ada · ada-007 closed — ?
3:49 · Bo's agent · card acknowledged — "Got it: giving my talk aloud now."
4:00 · Bo's agent · card result (done) — "Gave the talk aloud in the pond hall; 1 Soul heard it. Now listening."
4:10 · bo · bo-007 closed — ?
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
| ack (median) (s) | 2.70 | 
| first visible body change (median) (s) | 19 | 
| result (median) (s) | 7.15 | 
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
| input tokens / request (median) (tok) | 3.50 | 
| output tokens / request (median) (tok) | 345 | 
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
- seats: 1 turn(s) exited non-zero.
