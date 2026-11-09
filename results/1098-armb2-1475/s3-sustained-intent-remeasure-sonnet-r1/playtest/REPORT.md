# s3-sustained-intent-live-sonnet: FAIL

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-09T17:26:43.686Z) |
| eachPresented | FAIL | 1/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | FAIL | spoken order ada |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-09T17:26:45.691Z | 1 | 254 | true | 0 | Good morning, everyone. I'm Ada, and I keep bees. My errand this morning took me across the green toward the orchard, checking where the blossom is thickest so… |
| bo | 2026-11-09T17:27:03.709Z | 0 | 0 | — | 0 |  |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 3 | 50 | 1088011 | 27322 | 5221 | 0.3052 |
| bo | 2 | 34 | 675388 | 24172 | 3882 | 0.2031 |
| **total** | 5 | 84 | 1763399 | 51494 | 9103 | 0.5083 |

---

# Playtest report — s3-sustained-intent-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-sustained-intent` at http://world.invalid/w/s3-sustained-intent; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.11.1 `957833f549cf` · CLI eden.mjs `ab57461bca23`, eden.mjs.version `2.24.11`, eden-agent.mjs `7f8d5c6072d6`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6234 · 300 s · director swarm |
| Cost (seats) | 84 in / 1763399 cached / 9103 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 1 of 5 known | 0.20 | 3 of 14 (0.21) | 3.95 | 18 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 22 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:38 · ada · wrote on the card — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:16 · bo · wrote on the card — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:22 · ada · wrote on the card · card acknowledged · body started to change · now walking · ada-001 closed — "please walk over to the orchard, and after that go and sit on the bench outside the cottage" — ?
1:24 · bo · wrote on the card · moved to Green field · bo-001 closed with no answer · card acknowledged · walk:lab-pond-hall replaced · bo-002 closed — "walk over to the orchard, please / actually stop, don't go to the orchard after all" — ?
1:30 · ada · wrote on the card · moved to Green field · card acknowledged · ada-002 closed · ada-003 closed with no answer · ada-004 closed with no answer — "lovely morning! / do you remember where you are going? / tell me when you're there" — ?
1:40 · bo · walk:flag-orchard replaced
1:45 · Ada's agent · card acknowledged — "Got it: I'll tell you when I'm on the cottage bench."
1:46 · bo · wrote on the card · bo-003 closed · card acknowledged · card result (done) · bo-004 closed — "say hello to everyone around you" — ?
1:50 · ada · walk:lab-pond-hall replaced · moved to World · body started to change
2:00 · ada · moved to Green field
2:32 · bo · nothing visible happened for 92 s
2:40 · ada · moved to World
2:50 · ada · walk:flag-orchard completed
3:00 · ada · moved to Green field
3:16 · ada · wrote on the card · ada-005 closed · card acknowledged — "that's all, now walk to the pond hall and wait for the others" — ?
3:18 · bo · wrote on the card · moved to Waterside Room · walk:lab-pond-hall completed — "that's all, now walk to the pond hall and wait for the others"
3:30 · ada · sit:cottage/part-outdoor-bench replaced · body started to change
4:02 · ada · wrote on the card · moved to Waterside Hall · ada-006 closed — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her errand, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:02 · bo · wrote on the card · bo-005 closed with no answer — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about a change of plan, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:20 · ada · ada-007 closed · moved to Waterside Room · walk:lab-pond-hall completed · card acknowledged · card result (done) — ?
4:20 · bo · wrote on the card · bo-006 closed with no answer — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about a change of plan, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:30 · bo · bo-007 closed with no answer — ?
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
| ack (median) (s) | 3.95 | 
| first visible body change (median) (s) | 18 | 
| result (median) (s) | 9.20 | 
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
| output tokens / request (median) (tok) | 580 | 
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
