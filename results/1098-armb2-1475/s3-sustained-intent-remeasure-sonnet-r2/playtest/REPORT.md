# s3-sustained-intent-live-sonnet: FAIL

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-09T17:39:35.297Z) |
| eachPresented | FAIL | 1/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | FAIL | spoken order ada |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-09T17:39:37.307Z | 1 | 299 | true | 0 | Good morning, everyone. My errand this morning was to walk over to the orchard and then rest on the bench outside the cottage, and I kept my bees in mind the w… |
| bo | 2026-11-09T17:39:45.307Z | 0 | 0 | — | 0 |  |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 3 | 46 | 991577 | 27960 | 5551 | 0.2666 |
| bo | 2 | 36 | 730252 | 23828 | 4023 | 0.2086 |
| **total** | 5 | 82 | 1721829 | 51788 | 9574 | 0.4752 |

---

# Playtest report — s3-sustained-intent-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-sustained-intent` at http://world.invalid/w/s3-sustained-intent; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.11.1 `957833f549cf` · CLI eden.mjs `ab57461bca23`, eden.mjs.version `2.24.11`, eden-agent.mjs `7f8d5c6072d6`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6234 · 300 s · director swarm |
| Cost (seats) | 82 in / 1721829 cached / 9574 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 0 of 3 known | 0 | 3 of 14 (0.21) | 2.75 | 12 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 23 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:28 · ada · wrote on the card — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:02 · bo · wrote on the card · card acknowledged — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:08 · ada · wrote on the card · moved to Green field · ada-001 closed with no answer — "please walk over to the orchard, and after that go and sit on the bench outside the cottage" — ?
1:10 · bo · wrote on the card · bo-001 closed — "walk over to the orchard, please" — ?
1:16 · ada · wrote on the card · ada-002 closed with no answer · ada-003 closed with no answer · ada-004 closed with no answer · walk:lab-pond-hall/hall replaced — "lovely morning! / do you remember where you are going? / tell me when you're there" — ?
1:18 · bo · wrote on the card · bo-002 closed with no answer · walk:lab-pond-hall replaced · card acknowledged — "actually stop, don't go to the orchard after all" — ?
1:27 · Ada's agent · card acknowledged · body started to change — "Got it: I'll tell you when I'm on the bench."
1:32 · bo · wrote on the card · walk:flag-orchard failed (act.stopped) · body started to change · stop:current completed · bo-003 closed · card acknowledged · card result (done) · bo-004 closed — "say hello to everyone around you" — ?
2:00 · ada · moved to World
2:10 · ada · walk:flag-orchard completed
2:18 · bo · nothing visible happened for 92 s
2:20 · ada · moved to Green field
3:02 · ada · wrote on the card · ada-005 closed — "that's all, now walk to the pond hall and wait for the others" — ?
3:04 · bo · wrote on the card — "that's all, now walk to the pond hall and wait for the others"
3:06 · Ada's agent · card acknowledged · moved to Cottage Knoll · sit:cottage/part-outdoor-bench replaced — "Got it: heading to the pond hall to wait for the others."
3:10 · bo · walk:lab-pond-hall completed · moved to Waterside Room
3:20 · ada · body started to change · moved to Green field
3:40 · ada · moved to World
3:46 · ada · wrote on the card · moved to Waterside Room · ada-006 closed · card acknowledged · walk:lab-pond-hall/hall completed · card result (done) — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her errand, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:46 · bo · wrote on the card · bo-005 closed with no answer — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about a change of plan, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:54 · bo · wrote on the card · bo-006 closed with no answer — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about a change of plan, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:00 · ada · ada-007 closed — ?
4:10 · bo · bo-007 closed with no answer — ?
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
| ack (median) (s) | 2.75 | 
| first visible body change (median) (s) | 12 | 
| result (median) (s) | 4.60 | 
| walk speed (median) (m/s) | — | 
| listen open fraction | — | 
| unacked at cutoff (n) | 8 | 
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
| output tokens / request (median) (tok) | 589 | 
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
