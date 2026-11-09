# s3-sustained-intent-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-09T05:33:30.197Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-09T05:33:32.196Z | 1 | 256 | true | 0 | Good morning, everyone! I'm Ada, and I keep bees. This morning I ran my errand around the hamlet, past the green and the orchard, where the blossoms were alrea… |
| bo | 2026-11-09T05:33:44.200Z | 1 | 238 | true | 0 | Um... hi. This morning I meant to go to the orchard, but my plans kept changing. First the pond hall, then the orchard, then I was told to stop. I think I like… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 4 | 52 | 704048 | 28050 | 5221 | 0.2349 |
| bo | 5 | 52 | 685423 | 26090 | 4356 | 0.2166 |
| **total** | 9 | 104 | 1389471 | 54140 | 9577 | 0.4515 |

---

# Playtest report — s3-sustained-intent-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-sustained-intent` at http://world.invalid/w/s3-sustained-intent; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.10.2 `cf1b44b659b9` · CLI eden.mjs `ed954bd297ab`, eden.mjs.version `2.24.8`, eden-agent.mjs `7f8d5c6072d6`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6234 · 300 s · director swarm |
| Cost (seats) | 104 in / 1389471 cached / 9577 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 2 of 5 known | 0.40 | 4 of 14 (0.29) | 4.75 | 31 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 25 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:28 · ada · wrote on the card — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:04 · bo · wrote on the card · card acknowledged — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:12 · ada · wrote on the card · card acknowledged · body started to change · now walking · ada-001 closed — "please walk over to the orchard, and after that go and sit on the bench outside the cottage" — ?
1:12 · bo · wrote on the card · bo-001 closed · card acknowledged — "walk over to the orchard, please" — ?
1:18 · ada · wrote on the card · moved to Green field · ada-002 closed with no answer · ada-003 closed with no answer · ada-004 closed with no answer — "lovely morning! / do you remember where you are going? / tell me when you're there" — ?
1:20 · bo · wrote on the card · walk:lab-pond-hall replaced · bo-002 closed · card acknowledged · card result (done) · bo-003 closed · walk:flag-orchard failed (act.stopped) · now standing · stop:current completed — "actually stop, don't go to the orchard after all" — ?
1:30 · Ada's agent · card acknowledged · walk:lab-pond-hall/hall replaced — "Got it: I'll tell you when I'm at the bench."
1:34 · bo · wrote on the card · card acknowledged · card result (done) · bo-004 closed — "say hello to everyone around you" — ?
1:40 · ada · body started to change
2:00 · ada · moved to World
2:10 · ada · walk:flag-orchard completed
2:20 · bo · nothing visible happened for 92 s
2:20 · ada · moved to Green field
3:04 · ada · wrote on the card · ada-005 closed · card acknowledged · sit:cottage/part-outdoor-bench replaced — "that's all, now walk to the pond hall and wait for the others" — ?
3:06 · bo · wrote on the card — "that's all, now walk to the pond hall and wait for the others"
3:20 · ada · body started to change
3:41 · Ada's agent · card result (done) · moved to Waterside Room — "walk completed at g-lab-pond-hall.hall."
3:50 · ada · ada-006 closed · now standing · walk:lab-pond-hall/hall completed — ?
3:52 · Bo's agent · card acknowledged — "Got it: walking to the pond hall to wait."
4:00 · bo · body started to change · now walking
4:20 · ada · wrote on the card — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her errand, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
4:20 · bo · wrote on the card · moved to Waterside Room · card result (done) · bo-005 closed · walk:lab-pond-hall completed — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about a change of plan, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:30 · ada · ada-007 closed · card acknowledged · card result (done) — ?
4:32 · bo · wrote on the card · bo-006 closed with no answer — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about a change of plan, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:50 · bo · bo-007 closed · card acknowledged · card result (done) — ?
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
| ack (median) (s) | 4.75 | 
| first visible body change (median) (s) | 31 | 
| result (median) (s) | 11.90 | 
| walk speed (median) (m/s) | — | 
| listen open fraction | — | 
| unacked at cutoff (n) | 4 | 
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
| output tokens / request (median) (tok) | 469 | 
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
