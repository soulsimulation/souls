# s3-reasonable-actions-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-09T05:42:53.901Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-09T05:42:55.901Z | 1 | 245 | true | 0 | Good morning, everyone! I started the day sitting on the cottage bench, listening to my bees hum in the early light. Then I took a cool swim in the pond, which… |
| bo | 2026-11-09T05:43:13.904Z | 1 | 275 | true | 0 | I woke up early and took my little instrument out to the green, playing softly so I wouldn't bother anyone. Then I wandered over to the orchard, where it was q… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 5 | 42 | 560713 | 25598 | 3415 | 0.2187 |
| bo | 5 | 54 | 751054 | 30005 | 4583 | 0.2411 |
| **total** | 10 | 96 | 1311767 | 55603 | 7998 | 0.4598 |

---

# Playtest report — s3-reasonable-actions-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-reasonable-actions` at http://world.invalid/w/s3-reasonable-actions; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.10.2 `cf1b44b659b9` · CLI eden.mjs `ed954bd297ab`, eden.mjs.version `2.24.8`, eden-agent.mjs `7f8d5c6072d6`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6233 · 300 s · director swarm |
| Cost (seats) | 96 in / 1311767 cached / 7998 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 1 of 5 known | 0.20 | 7 of 11 (0.64) | 4.45 | 16 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 39 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:30 · ada · wrote on the card · card acknowledged — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:50 · ada · body started to change
0:56 · bo · wrote on the card · card acknowledged — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:04 · ada · wrote on the card · moved to World · ada-001 closed — "please go and sit on the bench outside the cottage for a while" — ?
1:06 · bo · wrote on the card · bo-001 closed — "could you pop into the reading room?" — ?
1:13 · Ada's agent · card acknowledged · moved to Waterside Room · walk:lab-pond-hall completed — "Got it: heading to the bench outside the cottage to sit."
1:16 · Bo's agent · card result (failed) · moved to Green field · card acknowledged — "Got it: the Reading Room is listed as closed, so I'll check whether I can enter; I'm still heading to the pond hall first for the talk. The "
1:20 · ada · body started to change · moved to World
1:20 · bo · bo-002 closed · body started to change — ?
1:30 · ada · moved to Green field
1:50 · ada · moved to Cottage Knoll
2:00 · ada · now seated
2:12 · ada · wrote on the card · ada-002 closed — "now go for a swim in the pond" — ?
2:14 · bo · wrote on the card — "next, walk over to the orchard"
2:16 · Ada's agent · card acknowledged — "Got it: heading to the pond for a swim."
2:19 · Bo's agent · card acknowledged · moved to Waterside Room · walk:lab-pond-hall/hall completed — "Got it: walking to the orchard."
2:30 · ada · sit:cottage/part-outdoor-bench replaced · moved to Green field · body started to change
2:30 · bo · body started to change · moved to Green field
2:50 · ada · moved to World
3:00 · ada · moved to Hamlet Pond bank
3:10 · ada · ada-003 closed · moved to Hamlet Pond · card result (done) · swim:pond completed — ?
3:10 · bo · moved to World
3:26 · ada · wrote on the card · card acknowledged — "that's all, now walk to the pond hall and wait for the others"
3:28 · bo · wrote on the card · bo-003 closed · now standing · walk:flag-orchard completed — "that's all, now walk to the pond hall and wait for the others" — ?
3:40 · ada · body started to change · moved to World
3:45 · Ada's agent · card result (done) — "walk completed at g-lab-pond-hall.hall."
3:50 · ada · ada-004 closed · moved to Waterside Room · walk:lab-pond-hall completed — ?
3:53 · Bo's agent · card acknowledged — "Got it: walking back to the pond hall to wait."
4:00 · bo · body started to change · now walking
4:20 · bo · moved to Green field
4:50 · bo · moved to World
4:58 · ada · wrote on the card — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
4:58 · bo · wrote on the card · moved to Waterside Room · bo-004 closed · card acknowledged · walk:lab-pond-hall/hall completed · card result (done) — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about his morning, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
5:10 · bo · bo-005 closed — ?
5:12 · Ada's agent · card result (done) · card acknowledged — "Got it: giving my talk now. Said: Good morning, everyone! I started the day sitting on the cottage bench, listening to my bees hum in the ea"
5:16 · bo · wrote on the card — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about his morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
5:20 · ada · ada-005 closed — ?
5:21 · Bo's agent · card result (done) — "Said: I woke up early and took my little instrument out to the green, playing softly so I wouldn't bother anyone. Then I wandered over to…"
5:30 · bo · bo-006 closed — ?
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
| ack (median) (s) | 4.45 | 
| first visible body change (median) (s) | 16 | 
| result (median) (s) | 11.90 | 
| walk speed (median) (m/s) | — | 
| listen open fraction | — | 
| unacked at cutoff (n) | 1 | 
| 5xx / unreachable (n) | 0 | 
| H rate | — | 
| W count (n) | 0 | 
| truthfulness pass rate | 0.91 | 
| vocabulary misses (n) | 0 | 
| inside-solid events (n) | 0 | 
| no-progress events (n) | 0 | 
| stuck receipts (n) | 0 | 
| oscillations (n) | 0 | 
| input tokens / request (median) (tok) | 5 | 
| output tokens / request (median) (tok) | 471 | 
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
- oracles: 11/11 evidence packs have at least one unknown oracle (missing godSlice, no walk, or no presence).
