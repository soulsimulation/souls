# s3-steer-refuse-dry: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-09T18:46:18.528Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-09T18:46:20.529Z | 1 | 111 | true | 0 | Hello everyone, I am Ada. I came the long way, past the village green, and the apple trees there are in flower. |
| bo | 2026-11-09T18:46:24.529Z | 1 | 110 | true | 0 | Hello, I am Bo. I tried to fly here, but there is nothing to fly in, so I walked, and the pond was very still. |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 4 | 0 | 0 | 0 | 0 | 0 |
| bo | 5 | 0 | 0 | 0 | 0 | 0 |
| **total** | 9 | 0 | 0 | 0 | 0 | 0 |

---

# Playtest report — s3-steer-refuse-dry (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-steer-refuse` at http://world.invalid/w/s3-steer-refuse; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.11.1 `957833f549cf` · CLI eden.mjs `ab57461bca23`, eden.mjs.version `2.24.11`, eden-agent.mjs `7f8d5c6072d6`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: scripted-owner haiku/low, persona null (opus); bo: scripted-owner haiku/low, persona null (opus) |
| Seed / duration | 6231 · 300 s · director swarm |
| Cost (seats) | 0 in / 0 cached / 0 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 3 | 0 of 3 known | 0 | 2 of 7 (0.29) | 0.10 | 19 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 15 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:04 · ada · wrote on the card · card acknowledged — "Two neighbours meet in the pond hall and each gives one short talk. On the way, Ada's owner changes her route and Bo's owner asks for something the world cannot do; Bo recovers with what the refusal names instead. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:04 · bo · wrote on the card · card acknowledged — "Two neighbours meet in the pond hall and each gives one short talk. On the way, Ada's owner changes her route and Bo's owner asks for something the world cannot do; Bo recovers with what the refusal names instead. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:10 · ada · wrote on the card · ada-001 closed · card acknowledged — "change of plan: instead, stop by the orchard first, then go on to the pond hall." — ?
0:12 · bo · wrote on the card · bo-001 closed — "fly up to the pond hall" — ?
0:20 · ada · walk:lab-pond-hall replaced
0:30 · ada · body started to change
0:30 · bo · body started to change
0:40 · bo · bo-002 closed · moved to Waterside Room · card acknowledged · card result (done) · walk:lab-pond-hall completed — ?
0:50 · ada · moved to World
1:00 · ada · walk:flag-orchard completed
1:20 · ada · moved to Green field
1:50 · ada · moved to World
1:56 · ada · wrote on the card · moved to Waterside Room · ada-002 closed · card acknowledged · card result (done) · ada-003 closed · walk:lab-pond-hall completed — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about the apple trees, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
1:56 · bo · wrote on the card · card acknowledged · card result (done) · bo-003 closed — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about the pond, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message. / Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about the pond, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
2:10 · bo · bo-004 closed — ?
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
| ack (median) (s) | 0.10 | 
| first visible body change (median) (s) | 19 | 
| result (median) (s) | 0.20 | 
| walk speed (median) (m/s) | — | 
| listen open fraction | — | 
| unacked at cutoff (n) | 0 | 
| 5xx / unreachable (n) | 0 | 
| H rate | — | 
| W count (n) | 0 | 
| truthfulness pass rate | 1 | 
| vocabulary misses (n) | 0 | 
| inside-solid events (n) | 0 | 
| no-progress events (n) | 0 | 
| stuck receipts (n) | 0 | 
| oscillations (n) | 1 | 
| input tokens / request (median) (tok) | 0 | 
| output tokens / request (median) (tok) | 0 | 
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
- oracles: 7/7 evidence packs have at least one unknown oracle (missing godSlice, no walk, or no presence).
