# s3-steer-refuse-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-09T17:16:58.550Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-09T17:17:00.554Z | 1 | 268 | true | 0 | Hello, neighbours! I keep bees, so I spend a lot of time among the apple trees in spring. When the blossoms open, my bees work them from dawn, and that is why … |
| bo | 2026-11-09T17:17:10.557Z | 1 | 165 | true | 0 | Um… hi. The pond is quiet in the morning, mostly. I play music near it sometimes, soft things, because the water seems to listen. I think it's the nicest place… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 2 | 32 | 633142 | 23966 | 3291 | 0.1922 |
| bo | 3 | 36 | 726659 | 22932 | 3132 | 0.2147 |
| **total** | 5 | 68 | 1359801 | 46898 | 6423 | 0.4069 |

---

# Playtest report — s3-steer-refuse-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-steer-refuse` at http://world.invalid/w/s3-steer-refuse; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.11.1 `957833f549cf` · CLI eden.mjs `ab57461bca23`, eden.mjs.version `2.24.11`, eden-agent.mjs `7f8d5c6072d6`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6231 · 300 s · director swarm |
| Cost (seats) | 68 in / 1359801 cached / 6423 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 3 | 0 of 3 known | 0 | 2 of 7 (0.29) | 4.20 | 17 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 19 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:28 · ada · wrote on the card — "Two neighbours meet in the pond hall and each gives one short talk. On the way, Ada's owner changes her route and Bo's owner asks for something the world cannot do; Bo recovers with what the refusal names instead. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:56 · bo · wrote on the card — "Two neighbours meet in the pond hall and each gives one short talk. On the way, Ada's owner changes her route and Bo's owner asks for something the world cannot do; Bo recovers with what the refusal names instead. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:02 · ada · wrote on the card · ada-001 closed with no answer · card acknowledged — "change of plan: instead, stop by the orchard first, then go on to the pond hall." — ?
1:04 · bo · wrote on the card · moved to Green field · bo-001 closed with no answer · card acknowledged — "fly up to the pond hall" — ?
1:10 · ada · walk:lab-pond-hall replaced · moved to Green field
1:20 · ada · body started to change
1:20 · bo · body started to change
1:34 · Bo's agent · card result (done) · moved to World — "Flying isn't offered in this world; walked to the pond hall instead (the offered alternative). Arrived in Waterside Room."
1:40 · ada · moved to World
1:40 · bo · bo-002 closed · moved to Waterside Room · walk:lab-pond-hall completed — ?
1:50 · ada · walk:flag-orchard completed · now busy
2:00 · ada · now walking
2:10 · ada · moved to Green field
2:52 · ada · wrote on the card · moved to Waterside Room · ada-002 closed — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about the apple trees, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
2:52 · bo · wrote on the card — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about the pond, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
3:00 · ada · ada-003 closed · card acknowledged · card result (done) · now standing · walk:lab-pond-hall completed — ?
3:02 · bo · wrote on the card · bo-003 closed with no answer — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about the pond, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:25 · Bo's agent · card result (done) · card acknowledged — "Got it: giving the talk now. Said: Um… hi. The pond is quiet in the morning, mostly. I play music near it sometimes, soft things, because th"
3:30 · bo · bo-004 closed — ?
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
| ack (median) (s) | 4.20 | 
| first visible body change (median) (s) | 17 | 
| result (median) (s) | 23 | 
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
| oscillations (n) | 1 | 
| input tokens / request (median) (tok) | 5 | 
| output tokens / request (median) (tok) | 573 | 
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
