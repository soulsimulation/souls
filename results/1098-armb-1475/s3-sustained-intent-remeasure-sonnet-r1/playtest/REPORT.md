# s3-sustained-intent-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-09T06:01:25.149Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-09T06:01:27.151Z | 1 | 339 | true | 0 | Good morning, everyone! I'm Ada, and I keep bees, so my errand was a round of the hamlet checking on the hives and the blossom they feed on. The orchard is hum… |
| bo | 2026-11-09T06:01:47.156Z | 1 | 225 | true | 0 | Um... hello. This morning I meant to practise my tune alone by the pond. But on the way, my plans changed, and I came here to listen with all of you instead. I… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 3 | 24 | 272141 | 14705 | 1827 | 0.1825 |
| bo | 5 | 48 | 638105 | 26004 | 4382 | 0.2117 |
| **total** | 8 | 72 | 910246 | 40709 | 6209 | 0.3942 |

---

# Playtest report — s3-sustained-intent-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-sustained-intent` at http://world.invalid/w/s3-sustained-intent; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.11.0 `e62e98d212c5` · CLI eden.mjs `a296767957c7`, eden.mjs.version `2.24.10`, eden-agent.mjs `7f8d5c6072d6`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6234 · 300 s · director swarm |
| Cost (seats) | 72 in / 910246 cached / 6209 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 0 of 4 known | 0 | 4 of 14 (0.29) | 3.50 | 14 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 25 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:26 · ada · wrote on the card · card acknowledged — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:40 · ada · body started to change · moved to Green field
0:50 · bo · wrote on the card — "Two neighbours run their owners' errands around the hamlet, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:56 · ada · wrote on the card · moved to Waterside Room · ada-001 closed · card acknowledged · walk:lab-pond-hall/hall replaced · ada-002 closed · ada-003 closed with no answer · ada-004 closed with no answer — "please walk over to the orchard, and after that go and sit on the bench outside the cottage / lovely morning! / do you remember where you are going? / tell me when you're there" — ?
0:58 · bo · wrote on the card · bo-001 closed with no answer — "walk over to the orchard, please" — ?
1:06 · bo · wrote on the card · bo-002 closed with no answer · card acknowledged · walk:flag-orchard replaced · walk:lab-pond-hall/hall replaced · now busy — "actually stop, don't go to the orchard after all" — ?
1:10 · Ada's agent · card acknowledged · moved to Green field — "Yes: orchard, then the cottage bench, then the pond hall talk on 'your turn'. I'll say when I'm at the orchard."
1:20 · ada · body started to change
1:20 · bo · wrote on the card · body started to change · now walking · bo-003 closed · card acknowledged · card result (done) — "say hello to everyone around you" — ?
1:30 · bo · bo-004 closed · walk:lab-pond-hall/hall replaced · nod:here completed · turn:s_3bac6fcec2 completed — ?
2:02 · Ada's agent · card result (done) · moved to World — "walk completed at the orchard flag."
2:10 · ada · ada-005 closed · walk:flag-orchard completed — ?
2:50 · ada · wrote on the card · card acknowledged — "that's all, now walk to the pond hall and wait for the others"
2:52 · bo · wrote on the card — "that's all, now walk to the pond hall and wait for the others"
2:56 · Bo's agent · card acknowledged · moved to Waterside Room · walk:lab-pond-hall/hall completed — "Got it: I'm already in the pond hall (Waterside Room), waiting for the others and for 'your turn'."
3:00 · ada · walk:cottage replaced · moved to Green field
3:10 · ada · body started to change
3:30 · ada · moved to World
3:36 · ada · wrote on the card · moved to Waterside Room · ada-006 closed · walk:lab-pond-hall/hall completed — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her errand, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:36 · bo · wrote on the card · bo-005 closed · card acknowledged — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about a change of plan, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
3:54 · Ada's agent · card result (done) · card acknowledged — "Got it: giving my talk now. Talk given in the pond hall."
3:56 · bo · wrote on the card · bo-006 closed — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about a change of plan, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:00 · ada · ada-007 closed — ?
4:04 · Bo's agent · card result (done) · card acknowledged — "Got it: giving the talk now. Said: Um... hello. This morning I meant to practise my tune alone by the pond. But on the way, my plans changed"
4:10 · bo · bo-007 closed — ?
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
| ack (median) (s) | 3.50 | 
| first visible body change (median) (s) | 14 | 
| result (median) (s) | 12.65 | 
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
| output tokens / request (median) (tok) | 401.50 | 
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
