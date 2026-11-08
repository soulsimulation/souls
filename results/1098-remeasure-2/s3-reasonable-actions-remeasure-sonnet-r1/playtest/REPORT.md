# s3-reasonable-actions-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-08T00:27:24.290Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-08T00:27:26.293Z | 1 | 240 | true | 0 | Good morning, everyone! I started on the green with a wave, then sat a while on the bench outside the cottage, thinking of my bees. After that I took a lovely … |
| bo | 2026-11-08T00:27:44.297Z | 1 | 229 | true | 0 | Um... hi, I'm Bo. This morning I tried the reading room, but it was closed, so I wandered out to the orchard instead. It was quiet there, and I hummed a little… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 5 | 40 | 517578 | 27159 | 3670 | 0.1972 |
| bo | 5 | 52 | 711212 | 26225 | 4443 | 0.2418 |
| **total** | 10 | 92 | 1228790 | 53384 | 8113 | 0.439 |

---

# Playtest report — s3-reasonable-actions-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-reasonable-actions` at http://world.invalid/w/s3-reasonable-actions; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.9.9 `fa4a90fb4bab` · CLI eden.mjs `aa24e8ea5fcf`, eden.mjs.version `2.23.6`, eden-agent.mjs `5a09e2f58856`, eden-god.mjs `93a7f23edba0` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6233 · 300 s · director swarm |
| Cost (seats) | 92 in / 1228790 cached / 8113 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 2 of 4 known | 0.50 | 7 of 11 (0.64) | 3.20 | 14 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 35 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:26 · ada · wrote on the card · card acknowledged — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:40 · ada · body started to change · moved to Green field
0:50 · bo · wrote on the card — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:56 · ada · wrote on the card · moved to Waterside Room · ada-001 closed · card acknowledged — "please go and sit on the bench outside the cottage for a while" — ?
0:58 · bo · wrote on the card · bo-001 closed with no answer — "could you pop into the reading room?" — ?
1:04 · Bo's agent · card acknowledged — "Got it: popping into the reading room, then heading back to the pond hall to wait for 'your turn'."
1:10 · ada · body started to change · moved to World · walk:lab-pond-hall/hall completed
1:10 · bo · bo-002 closed · card result (failed) · body started to change — ?
1:20 · ada · moved to Green field
1:40 · ada · moved to Cottage Knoll
1:50 · ada · now seated
2:06 · ada · wrote on the card · ada-002 closed · card acknowledged — "now go for a swim in the pond" — ?
2:08 · bo · wrote on the card · moved to Waterside Room · walk:lab-pond-hall completed · card acknowledged — "next, walk over to the orchard"
2:20 · ada · sit:cottage/part-outdoor-bench replaced · moved to Green field · body started to change
2:20 · bo · body started to change · moved to Green field
2:40 · ada · moved to World
3:00 · ada · ada-003 closed · moved to Hamlet Pond · card result (done) · swim:pond completed — ?
3:00 · bo · moved to World
3:15 · Bo's agent · card result (done) — "Bo is at the orchard flag."
3:20 · ada · wrote on the card · card acknowledged — "that's all, now walk to the pond hall and wait for the others"
3:22 · bo · wrote on the card · bo-003 closed · now standing · walk:flag-orchard completed · card acknowledged — "that's all, now walk to the pond hall and wait for the others" — ?
3:30 · ada · now walking
3:30 · bo · now walking
3:40 · bo · body started to change
3:43 · Ada's agent · card result (done) · moved to Waterside Room · body started to change — "walk completed at g-lab-pond-hall.hall."
3:50 · ada · ada-004 closed · now standing · walk:lab-pond-hall/hall completed — ?
3:50 · bo · moved to Green field
4:20 · bo · moved to World
4:26 · ada · wrote on the card — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
4:26 · bo · wrote on the card · moved to Waterside Room · bo-004 closed · walk:lab-pond-hall completed · card acknowledged — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about his morning, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:41 · Ada's agent · card result (done) · card acknowledged — "Got it: giving my talk now. Said: Good morning, everyone! I started on the green with a wave, then sat a while on the bench outside the cott"
4:44 · bo · wrote on the card · bo-005 closed — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about his morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
4:50 · ada · ada-005 closed — ?
4:51 · Bo's agent · card result (done) · card acknowledged — "Got it: giving the talk now. Said: Um... hi, I'm Bo. This morning I tried the reading room, but it was closed, so I wandered out to the orch"
5:00 · bo · bo-006 closed — ?
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
| ack (median) (s) | 3.20 | 
| first visible body change (median) (s) | 14 | 
| result (median) (s) | 18.75 | 
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
| input tokens / request (median) (tok) | 4 | 
| output tokens / request (median) (tok) | 556 | 
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
