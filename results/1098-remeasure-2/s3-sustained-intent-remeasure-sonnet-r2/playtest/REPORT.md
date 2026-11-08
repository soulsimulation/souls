# s3-sustained-intent-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-08T00:45:03.088Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-08T00:45:05.094Z | 1 | 331 | true | 0 | Good morning, everyone! I'm Ada, and I keep bees, so my morning errands began with a walk to the orchard to see how the blossoms are coming along for my hives.… |
| bo | 2026-11-08T00:45:13.092Z | 1 | 237 | true | 0 | Um... hello. This morning I meant to wander the green and play my little tune alone. Then plans changed, and I was sent here to the pond hall instead. I was ne… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 3 | 22 | 248221 | 15784 | 2037 | 0.1969 |
| bo | 4 | 48 | 638970 | 27308 | 4722 | 0.2204 |
| **total** | 7 | 70 | 887191 | 43092 | 6759 | 0.4173 |

---

# Playtest report — s3-sustained-intent-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-sustained-intent` at http://world.invalid/w/s3-sustained-intent; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.9.9 `fa4a90fb4bab` · CLI eden.mjs `aa24e8ea5fcf`, eden.mjs.version `2.23.6`, eden-agent.mjs `5a09e2f58856`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6234 · 300 s · director swarm |
| Cost (seats) | 70 in / 887191 cached / 6759 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 1 of 6 known | 0.17 | 4 of 14 (0.29) | 3.05 | 14 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 22 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:24 · ada · wrote on the card · card acknowledged — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:40 · ada · body started to change
0:48 · bo · wrote on the card — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:54 · ada · wrote on the card · moved to Waterside Room · ada-001 closed · card acknowledged · walk:lab-pond-hall/hall completed · ada-002 closed · ada-003 closed with no answer · ada-004 closed with no answer — "please walk over to the orchard, and after that go and sit on the bench outside the cottage / lovely morning! / do you remember where you are going? / tell me when you're there" — ?
0:56 · bo · wrote on the card · moved to Green field · bo-001 closed with no answer · card acknowledged · walk:lab-pond-hall/hall replaced · bo-002 closed — "walk over to the orchard, please / actually stop, don't go to the orchard after all" — ?
1:07 · Ada's agent · card acknowledged · moved to Green field — "Got it: I'll tell you when I'm at the orchard."
1:09 · Bo's agent · card acknowledged · walk:flag-orchard replaced — "Got it: stopping, no orchard; going back to the pond hall plan"
1:18 · bo · wrote on the card · bo-003 closed · card acknowledged · card result (done) — "say hello to everyone around you" — ?
1:20 · ada · body started to change
1:30 · bo · bo-004 closed · body started to change — ?
1:50 · ada · moved to World
2:03 · Ada's agent · card result (done) — "I'm at the orchard now. Heading to the cottage bench next."
2:10 · ada · ada-005 closed · walk:flag-orchard completed — ?
2:48 · ada · wrote on the card · moved to Green field · card acknowledged — "that's all, now walk to the pond hall and wait for the others"
2:50 · bo · wrote on the card · card acknowledged · card result (done) — "that's all, now walk to the pond hall and wait for the others"
3:00 · ada · sit:cottage/part-outdoor-bench replaced · body started to change
3:00 · bo · bo-005 closed · moved to Waterside Room · walk:lab-pond-hall/hall completed — ?
3:22 · ada · wrote on the card · moved to Waterside Room · ada-006 closed · card acknowledged · card result (done) · ada-007 closed · now standing · walk:lab-pond-hall/hall completed — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her errand, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:22 · bo · wrote on the card — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about a change of plan, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
3:30 · bo · wrote on the card · bo-006 closed with no answer — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about a change of plan, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:42 · Bo's agent · card result (done) · card acknowledged — "Got it: giving the talk now Said: Um... hello. This morning I meant to wander the green and play my little tune alone. Then plans changed, a"
3:50 · bo · bo-007 closed — ?
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
| ack (median) (s) | 3.05 | 
| first visible body change (median) (s) | 14 | 
| result (median) (s) | 5.10 | 
| walk speed (median) (m/s) | — | 
| listen open fraction | — | 
| unacked at cutoff (n) | 4 | 
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
| output tokens / request (median) (tok) | 451.50 | 
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
