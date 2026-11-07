# s3-reasonable-actions-live-sonnet: PASS

Room: the pond hall · order: ada → bo

| check | result | detail |
|---|---|---|
| allPresent | pass | 2/2 in the pond hall at once (first at 2026-11-07T17:11:20.412Z) |
| eachPresented | pass | 2/2 gave a talk of ≥ 40 characters in their turn |
| inOrder | pass | spoken order ada → bo |
| eachOnce | pass | 0 long lines outside the speaker's own turn |
| redirect | pass | none |

## Talks (world speech in each turn)

| seat | turn began | lines | chars | in room | out of turn | talk |
|---|---|---:|---:|---|---:|---|
| ada | 2026-11-07T17:11:22.413Z | 1 | 281 | true | 0 | Good morning, everyone! I started at the village green and waved hello to the new day, then sat a while on the bench by the cottage, thinking of my bees. After… |
| bo | 2026-11-07T17:11:42.414Z | 1 | 200 | true | 0 | I'm Bo. I don't say much in the morning. I walked out to the orchard and back, and mostly listened to the grass and the wind. I hummed a little tune on the way… |

## Cost (seats/*/cost.jsonl)

| seat | turns | input | cached | cache-write | output | USD |
|---|---:|---:|---:|---:|---:|---:|
| ada | 6 | 54 | 757373 | 28583 | 3993 | 0.2301 |
| bo | 5 | 60 | 867808 | 29840 | 4935 | 0.2556 |
| **total** | 11 | 114 | 1625181 | 58423 | 8928 | 0.4857 |

---

# Playtest report — s3-reasonable-actions-live-sonnet (playtest)

## 1. Identity

| | |
|---|---|
| World | dev `s3-reasonable-actions` at http://127.0.0.1:4456/w/s3-reasonable-actions; genesis `worlds/templates/hello-hamlet.json` |
| Build | `dev` · skill 2.9.6 `2f7ca57139d1` · CLI eden.mjs `0097d8015d8a`, eden.mjs.version `2.23.1`, eden-agent.mjs `5a09e2f58856`, eden-god.mjs `c4c1b3e976f9` |
| Seats | ada: claude-headless sonnet/low, persona null (opus); bo: claude-headless sonnet/low, persona null (opus) |
| Seed / duration | 6233 · 300 s · director swarm |
| Cost (seats) | 114 in / 1625181 cached / 8928 out tokens |
| Review | Reviewer opus, Developer opus, rubric `RUBRIC.md` `aede404f0352` |

## 1b. Basics scorecard

Plain walking and acting first; everything subjective comes after.

| walks asked | arrived | arrival rate | body moved in budget | ack median (s) | first body change median (s) | stuck / no progress | inside solid | wrong | hits |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 3 of 5 known | 0.60 | 7 of 11 (0.64) | 5.15 | 16 | 0 | 0 | 0 | 0 |

## 2. What happened

**The story in 40 moments** — open [story.html](story.html) to see each with the screenshot the player was shown:

```
0:34 · ada · wrote on the card · card acknowledged — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Ada: Ada is cheerful and keeps bees. The others are Bo. Walk Ada to the pond hall now and wait there with everyone. Ada speaks 1st of 2, first. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
0:50 · ada · body started to change · moved to Green field
1:08 · bo · wrote on the card — "Two neighbours spend a quiet morning in the hamlet doing what their owners ask, then meet in the pond hall and each gives one short talk about their morning. Bo: Bo is shy and plays music. The others are Ada. Walk Bo to the pond hall now and wait there with everyone. Bo speaks 2nd of 2, right after Ada. Do not give the talk until I write "your turn". Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
1:10 · ada · walk:lab-pond-hall/hall completed · moved to Waterside Room
1:14 · ada · wrote on the card · ada-001 closed — "please go and sit on the bench outside the cottage for a while" — ?
1:16 · bo · wrote on the card · moved to Green field · bo-001 closed with no answer — "could you pop into the reading room?" — ?
1:20 · Ada's agent · card acknowledged — "Got it: finding the bench outside the cottage and sitting."
1:30 · ada · body started to change · moved to World
1:30 · bo · bo-002 closed · card acknowledged · card result (failed) · walk:lab-pond-hall replaced · body started to change — ?
1:40 · ada · moved to Green field
2:00 · ada · moved to Cottage Knoll
2:10 · ada · ada-002 closed · card result (done) · now seated — ?
2:24 · ada · wrote on the card · card acknowledged · sit:cottage/part-outdoor-bench replaced · now busy — "now go for a swim in the pond"
2:26 · bo · wrote on the card — "next, walk over to the orchard"
2:31 · Bo's agent · card acknowledged · moved to Waterside Room · walk:lab-pond-hall completed — "Got it: looking for the orchard and walking there."
2:40 · ada · body started to change · moved to Green field
2:40 · bo · body started to change · moved to World
2:50 · bo · moved to Green field
3:00 · ada · moved to World
3:10 · ada · moved to Hamlet Pond bank
3:20 · ada · ada-003 closed · moved to Hamlet Pond · card result (done) · swim:pond completed — ?
3:30 · bo · moved to World
3:38 · ada · wrote on the card — "that's all, now walk to the pond hall and wait for the others"
3:40 · bo · wrote on the card · card result (done) · bo-003 closed · now standing · walk:flag-orchard completed — "that's all, now walk to the pond hall and wait for the others" — ?
3:43 · Ada's agent · card acknowledged — "Got it: walking to the pond hall to wait for the others."
3:50 · ada · body started to change
4:00 · ada · moved to World
4:10 · ada · ada-004 closed · moved to Waterside Room · card result (done) · walk:lab-pond-hall/hall completed — ?
4:13 · Bo's agent · card acknowledged — "Got it: walking back to the pond hall to wait."
4:20 · bo · body started to change · now walking
4:40 · bo · moved to Green field
5:10 · bo · moved to World
5:16 · ada · wrote on the card — "Your turn: Ada gives the talk now, out loud to the room with say, 2 to 4 sentences about her morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
5:16 · bo · wrote on the card · moved to Waterside Room · bo-004 closed · walk:lab-pond-hall completed · card acknowledged · card result (done) — "Bo is next, right after Ada. Get the talk ready now (2 to 4 sentences about his morning, in character) but do not say it yet; stay in the pond hall and listen. Do not say it yet; wait until I write "your turn". Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message." — ?
5:30 · bo · bo-005 closed — ?
5:33 · Ada's agent · card result (done) · card acknowledged — "Got it: giving my talk now with say. Gave the talk in the Waterside Room; 1 listener heard it."
5:36 · bo · wrote on the card — "Your turn: Bo gives the talk now, out loud to the room with say, 2 to 4 sentences about his morning, in character. Then stop and listen to the others. Keep it cheap: do just this with one or two commands, no exploring, then wait for my next message."
5:40 · ada · ada-005 closed — ?
5:44 · Bo's agent · card result (done) · card acknowledged — "Got it: giving the talk now with say. Gave the talk aloud in the pond hall; heard by 1. Now listening."
5:50 · bo · bo-006 closed — ?
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
| ack (median) (s) | 5.15 | 
| first visible body change (median) (s) | 16 | 
| result (median) (s) | 22.45 | 
| walk speed (median) (m/s) | — | 
| listen open fraction | — | 
| unacked at cutoff (n) | 1 | 
| 5xx / unreachable (n) | 0 | 
| H rate | — | 
| W count (n) | 0 | 
| truthfulness pass rate | 1 | 
| vocabulary misses (n) | 0 | 
| inside-solid events (n) | 0 | 
| no-progress events (n) | 0 | 
| stuck receipts (n) | 0 | 
| oscillations (n) | 0 | 
| input tokens / request (median) (tok) | 6 | 
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
