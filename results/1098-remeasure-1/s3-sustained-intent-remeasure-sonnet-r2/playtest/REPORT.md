# s3-sustained-intent-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-07T17:29:02.249Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-07T17:29:04.250Z | 1 | 346 | true | 0 | Good morning, everyone! I'm Ada, and I keep bees, so my errand took me out to the orchard to see how the hives are doing among the blossoms. The morning was lo… |
| bo | 2026-11-07T17:29:14.252Z | 1 | 264 | true | 0 | Um... hello. My morning was supposed to be quiet: a few songs on the green, nothing more. But a change of plan brought me here to the pond hall instead, and I'… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 4 | 30 | 365123 | 20113 | 2413 | 0.2117 |
| bo | 5 | 56 | 804230 | 28624 | 5150 | 0.2465 |
| **total** | 9 | 86 | 1169353 | 48737 | 7563 | 0.4582 |

---

# Playtest report — s3-sustained-intent-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-sustained-intent` at http://127.0.0.1:4458/w/s3-sustained-intent; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.9.6 `2f7ca57139d1` · CLI eden.mjs `0097d8015d8a`, eden.mjs.version `2.23.1`, eden-agent.mjs `5a09e2f58856`, eden-god.mjs `c4c1b3e976f9` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6234 · 300 s · director swarm |
| Cost (seats) | 86 in / 1169353 cached / 7563 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 2 of 6 known | 0.33 | 4 of 14 (0.29) | 3.40 | 13 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 28 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:28 · ada · wrote on the card · card acknowledged — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:40 · ada · body started to change · moved to Green field
1:00 · ada · moved to Waterside Room
1:06 · Ada's agent · card result (done) — "Ada is in the Waterside Room (pond hall), waiting for 'your turn'. No talk given."
1:06 · bo · wrote on the card · card acknowledged — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:12 · ada · wrote on the card · ada-001 closed · now standing · walk:lab-pond-hall/hall completed · card acknowledged — "please walk over to the orchard, and after that go and sit on the bench outside the cottage" — ?
1:14 · bo · wrote on the card · moved to Green field · bo-001 closed · card acknowledged · walk:lab-pond-hall/hall replaced · bo-002 closed — "walk over to the orchard, please / actually stop, don't go to the orchard after all" — ?
1:20 · ada · wrote on the card · now walking · ada-002 closed · ada-003 closed with no answer · ada-004 closed with no answer — "lovely morning! / do you remember where you are going? / tell me when you're there" — ?
1:26 · Ada's agent · card acknowledged · moved to Green field — "Will do: I'll tell you when I reach the orchard."
1:30 · bo · bo-003 closed · card result (done) · walk:flag-orchard replaced · now standing · stand:here completed — ?
1:36 · bo · wrote on the card · card acknowledged · card result (done) — "say hello to everyone around you"
1:40 · ada · body started to change
1:50 · bo · bo-004 closed — ?
2:10 · ada · moved to World
2:30 · ada · walk:flag-orchard completed
2:40 · ada · moved to Green field
3:06 · ada · wrote on the card · ada-005 closed — "that's all, now walk to the pond hall and wait for the others" — ?
3:08 · bo · wrote on the card · card acknowledged — "that's all, now walk to the pond hall and wait for the others"
3:11 · Ada's agent · card acknowledged — "Got it: I reached the orchard; dropping the bench, walking to the pond hall to wait."
3:20 · ada · sit:cottage/part-outdoor-bench replaced · body started to change
3:20 · bo · body started to change · now walking
3:30 · bo · moved to World
3:42 · ada · wrote on the card · moved to Waterside Hall · ada-006 closed — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her errand, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:42 · bo · wrote on the card · moved to Waterside Room · card result (done) · bo-005 closed · walk:lab-pond-hall/hall completed — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about a change of plan, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:50 · ada · ada-007 closed · moved to Waterside Room · card acknowledged · card result (done) · walk:lab-pond-hall/hall completed — ?
3:52 · bo · wrote on the card · bo-006 closed with no answer — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about a change of plan, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:14 · Bo's agent · card result (done) · card acknowledged — "Got it: giving the talk aloud now, then listening. Gave the talk aloud in the pond hall (heard by 1); now listening."
4:20 · bo · bo-007 closed — ?
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
| first visible body change (median) (s) | 13 | 
| result (median) (s) | 14.85 | 
| walk speed (median) (m/s) | — | 
| listen open fraction | — | 
| unacked at cutoff (n) | 3 | 
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
| output tokens / request (median) (tok) | 485.50 | 
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
