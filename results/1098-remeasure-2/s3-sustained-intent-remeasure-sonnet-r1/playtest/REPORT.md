# s3-sustained-intent-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-08T00:31:27.869Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-08T00:31:29.872Z | 1 | 344 | true | 0 | Good morning, everyone! I'm Ada, and I keep bees, so my morning errand started at the hives, checking that the colony was warm and humming. Then I wandered the… |
| bo | 2026-11-08T00:31:49.874Z | 1 | 235 | true | 0 | Um, hi. My morning changed plans a few times. I was sent to the pond hall, then the orchard, then told to stop, and finally back here. I'm shy, so I took it as… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 3 | 22 | 248641 | 16300 | 2008 | 0.1918 |
| bo | 5 | 44 | 599921 | 26035 | 4388 | 0.2292 |
| **total** | 8 | 66 | 848562 | 42335 | 6396 | 0.421 |

---

# Playtest report — s3-sustained-intent-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-sustained-intent` at http://world.invalid/w/s3-sustained-intent; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.9.9 `fa4a90fb4bab` · CLI eden.mjs `aa24e8ea5fcf`, eden.mjs.version `2.23.6`, eden-agent.mjs `5a09e2f58856`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6234 · 300 s · director swarm |
| Cost (seats) | 66 in / 848562 cached / 6396 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 2 of 6 known | 0.33 | 4 of 14 (0.29) | 2.50 | 14 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 23 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:26 · ada · wrote on the card · card acknowledged — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:40 · ada · body started to change · moved to Green field
0:46 · bo · wrote on the card · card acknowledged — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:52 · ada · wrote on the card · ada-001 closed · card acknowledged — "please walk over to the orchard, and after that go and sit on the bench outside the cottage" — ?
0:54 · bo · wrote on the card · moved to Green field · bo-001 closed · card acknowledged · walk:lab-pond-hall replaced · bo-002 closed — "walk over to the orchard, please / actually stop, don't go to the orchard after all" — ?
1:00 · ada · wrote on the card · moved to World · walk:lab-pond-hall replaced · ada-002 closed · ada-003 closed with no answer · ada-004 closed with no answer · card acknowledged — "lovely morning! / do you remember where you are going? / tell me when you're there" — ?
1:10 · ada · moved to Green field
1:10 · bo · bo-003 closed · card result (done) · walk:flag-orchard replaced · now standing · stand:here completed — ?
1:16 · bo · wrote on the card · card acknowledged · card result (done) · bo-004 closed — "say hello to everyone around you" — ?
1:20 · ada · body started to change
1:50 · ada · moved to World
2:00 · ada · walk:flag-orchard completed
2:02 · bo · nothing visible happened for 92 s
2:10 · ada · moved to Green field
2:46 · ada · wrote on the card · ada-005 closed · card acknowledged · sit:cottage/part-outdoor-bench replaced — "that's all, now walk to the pond hall and wait for the others" — ?
2:48 · bo · wrote on the card · card acknowledged — "that's all, now walk to the pond hall and wait for the others"
3:00 · ada · body started to change
3:00 · bo · body started to change · now walking
3:22 · ada · wrote on the card · moved to Waterside Room · card result (done) · ada-006 closed · walk:lab-pond-hall completed — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her errand, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:22 · bo · wrote on the card · moved to Waterside Room · bo-005 closed — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about a change of plan, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:30 · bo · bo-006 closed · card result (done) · now standing · walk:lab-pond-hall completed — ?
3:40 · ada · ada-007 closed · card acknowledged · card result (done) — ?
3:42 · bo · wrote on the card · card acknowledged · card result (done) · bo-007 closed — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about a change of plan, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
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
| ack (median) (s) | 2.50 | 
| first visible body change (median) (s) | 14 | 
| result (median) (s) | 6.10 | 
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
| input tokens / request (median) (tok) | 3 | 
| output tokens / request (median) (tok) | 342 | 
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
