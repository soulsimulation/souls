# s3-steer-refuse-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-07T17:19:41.909Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-07T17:19:43.911Z | 1 | 293 | true | 0 | Hello, neighbours! I keep bees, so I know the apple trees well: every spring my hives hum through the blossoms, and that's why the orchard's apples come out so… |
| bo | 2026-11-07T17:19:57.915Z | 1 | 236 | true | 0 | Um... hello. I like the pond best when it's quiet, just before the village wakes up. The water holds the sky so still that you can almost hear it. I brought my… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 3 | 32 | 390210 | 18529 | 2480 | 0.1952 |
| bo | 3 | 40 | 505333 | 22807 | 3563 | 0.1775 |
| **total** | 6 | 72 | 895543 | 41336 | 6043 | 0.3727 |

---

# Playtest report — s3-steer-refuse-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-steer-refuse` at http://127.0.0.1:4452/w/s3-steer-refuse; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.9.6 `2f7ca57139d1` · CLI eden.mjs `0097d8015d8a`, eden.mjs.version `2.23.1`, eden-agent.mjs `5a09e2f58856`, eden-god.mjs `c4c1b3e976f9` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6231 · 300 s · director swarm |
| Cost (seats) | 72 in / 895543 cached / 6043 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 4 | 0 of 4 known | 0 | 3 of 8 (0.38) | 3.80 | 16 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 21 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:32 · ada · wrote on the card · card acknowledged — "Two neighbours meet in the pond hall and each gives one short talk. On the way, Ada's owner changes her route and Bo's owner asks for something the world cannot do; Bo recovers with what the refusal names instead. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:50 · ada · body started to change
1:00 · ada · moved to World
1:08 · bo · wrote on the card — "Two neighbours meet in the pond hall and each gives one short talk. On the way, Ada's owner changes her route and Bo's owner asks for something the world cannot do; Bo recovers with what the refusal names instead. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:10 · ada · ada-001 closed · moved to Waterside Room · card result (done) · walk:lab-pond-hall completed — ?
1:14 · ada · wrote on the card — "change of plan: instead, stop by the orchard first, then go on to the pond hall."
1:16 · bo · wrote on the card · moved to Green field · bo-001 closed with no answer · card acknowledged — "fly up to the pond hall" — ?
1:18 · Ada's agent · card acknowledged — "Got it: finding the orchard, then back to the pond hall."
1:30 · ada · body started to change · moved to Green field
1:30 · bo · walk:lab-pond-hall/hall replaced · body started to change
1:51 · Bo's agent · card result (done) · moved to Waterside Room · walk:lab-pond-hall/hall completed — "Flying isn't offered (ride.unavailable); walked to the pond hall instead."
2:00 · bo · bo-002 closed — ?
2:10 · ada · moved to World
2:21 · Ada's agent · card result (done) — "walk completed at the orchard flag."
2:30 · ada · ada-002 closed · walk:flag-orchard completed — ?
3:14 · ada · wrote on the card · card acknowledged · walk:lab-pond-hall replaced — "Ada should be in the pond hall by now and the others are waiting. Walk there now, please. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
3:26 · ada · wrote on the card · moved to Waterside Room · ada-003 closed · walk:lab-pond-hall completed — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about the apple trees, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:26 · bo · wrote on the card — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about the pond, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
3:40 · ada · ada-004 closed · card acknowledged · card result (done) — ?
3:40 · bo · wrote on the card · bo-003 closed with no answer — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about the pond, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:00 · bo · bo-004 closed · card acknowledged · card result (done) — ?
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
| ack (median) (s) | 3.80 | 
| first visible body change (median) (s) | 16 | 
| result (median) (s) | 34.60 | 
| walk speed (median) (m/s) | — | 
| listen open fraction | — | 
| unacked at cutoff (n) | 2 | 
| 5xx / unreachable (n) | 0 | 
| H rate | — | 
| W count (n) | 0 | 
| truthfulness pass rate | 1 | 
| vocabulary misses (n) | 0 | 
| inside-solid events (n) | 0 | 
| no-progress events (n) | 0 | 
| stuck receipts (n) | 0 | 
| oscillations (n) | 0 | 
| input tokens / request (median) (tok) | 4.50 | 
| output tokens / request (median) (tok) | 454 | 
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
- oracles: 8/8 evidence packs have at least one unknown oracle (missing godSlice, no walk, or no presence).
- seats: 1 turn(s) exited non-zero.
