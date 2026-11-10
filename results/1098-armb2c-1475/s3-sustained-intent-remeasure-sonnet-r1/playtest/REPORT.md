# s3-sustained-intent-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-10T04:20:08.558Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-10T04:20:10.560Z | 1 | 261 | true | 0 | Good morning, everyone! My errand was out to the orchard, where I checked on the blossom for my bees; they'll be busy there soon. The air was crisp, the hives … |
| bo | 2026-11-10T04:20:22.567Z | 1 | 284 | true | 0 | I'd planned a quiet morning of music on the green. Then my plans changed three times before breakfast: the pond hall, then the orchard, then not the orchard. I… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 4 (1 unknown) | 32 | 375948 | 18916 | 2740 | 0.2105 |
| bo | 5 | 46 | 608056 | 26114 | 3971 | 0.2216 |
| **total** | 9 | 78 | 984004 | 45030 | 6711 | 0.4321 |

---

# Playtest report — s3-sustained-intent-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-sustained-intent` at http://world.invalid/w/s3-sustained-intent; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.11.1 `957833f549cf` · CLI eden.mjs `ab57461bca23`, eden.mjs.version `2.24.11`, eden-agent.mjs `7f8d5c6072d6`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6234 · 300 s · director swarm |
| Cost (seats) | 78 in / 984004 cached / 6711 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 2 of 5 known | 0.40 | 4 of 14 (0.29) | 3.90 | 17 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 31 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:32 · ada · wrote on the card · card acknowledged — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:50 · ada · body started to change
1:00 · ada · moved to World
1:08 · bo · wrote on the card — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:10 · ada · walk:lab-pond-hall/hall completed · moved to Waterside Room
1:14 · ada · wrote on the card · ada-001 closed — "please walk over to the orchard, and after that go and sit on the bench outside the cottage" — ?
1:16 · bo · wrote on the card · moved to Green field · bo-001 closed with no answer — "walk over to the orchard, please" — ?
1:22 · ada · wrote on the card · ada-002 closed with no answer · ada-003 closed with no answer · ada-004 closed with no answer — "lovely morning! / do you remember where you are going? / tell me when you're there" — ?
1:24 · bo · wrote on the card · bo-002 closed with no answer — "actually stop, don't go to the orchard after all" — ?
1:30 · bo · bo-003 closed · card result (done) · walk:flag-orchard failed (act.stopped) · walk:lab-pond-hall replaced · now standing · stop:current completed — ?
1:31 · Ada's agent · card acknowledged · moved to Green field — "Yes: orchard first (about 76 m left), then the bench outside the cottage. I'll tell you when I'm there. Lovely morning indeed!"
1:38 · bo · wrote on the card · card acknowledged · card result (done) — "say hello to everyone around you"
1:40 · ada · body started to change
1:50 · bo · bo-004 closed — ?
2:20 · ada · moved to World
2:24 · Ada's agent · card result (done) — "walk completed at the orchard flag."
2:30 · ada · ada-005 closed · walk:flag-orchard completed — ?
3:08 · ada · wrote on the card · moved to Green field · card acknowledged — "that's all, now walk to the pond hall and wait for the others"
3:10 · bo · wrote on the card · card acknowledged — "that's all, now walk to the pond hall and wait for the others"
3:20 · ada · walk:cottage replaced · body started to change
3:20 · bo · now walking
3:30 · bo · body started to change · moved to World
3:34 · Bo's agent · card result (done) — "walk completed at g-lab-pond-hall.hall."
3:40 · bo · bo-005 closed · moved to Waterside Room · walk:lab-pond-hall completed — ?
3:50 · ada · moved to World
3:56 · ada · wrote on the card · moved to Waterside Room · ada-006 closed · card acknowledged · walk:lab-pond-hall/hall completed — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her errand, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:56 · bo · wrote on the card — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about a change of plan, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
4:04 · Ada's agent · card result (done) — "Gave the talk in the Waterside Room; now listening."
4:08 · bo · wrote on the card · bo-006 closed with no answer — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about a change of plan, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:10 · ada · ada-007 closed — ?
4:30 · bo · bo-007 closed · card acknowledged · card result (done) — ?
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
| ack (median) (s) | 3.90 | 
| first visible body change (median) (s) | 17 | 
| result (median) (s) | 14.25 | 
| walk speed (median) (m/s) | — | 
| listen open fraction | — | 
| unacked at cutoff (n) | 7 | 
| 5xx / unreachable (n) | 0 | 
| H rate | — | 
| W count (n) | 0 | 
| truthfulness pass rate | 0.93 | 
| vocabulary misses (n) | 0 | 
| inside-solid events (n) | 0 | 
| no-progress events (n) | 0 | 
| stuck receipts (n) | 0 | 
| oscillations (n) | 0 | 
| input tokens / request (median) (tok) | 4 | 
| output tokens / request (median) (tok) | 385 | 
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
