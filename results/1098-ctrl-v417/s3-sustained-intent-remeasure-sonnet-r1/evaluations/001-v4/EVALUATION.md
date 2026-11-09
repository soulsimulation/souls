# Evaluation of s3-sustained-intent-remeasure-sonnet-r1

soul-run, status **completed**, arm `65251c3aae72`. Evaluator soul-runs/evaluate v4 at 168ba5df, offline (no world, controller, network or model). Sources: 81 files, unchanged: true.

Coverage: 0 requests from 2 director seat(s), 2 seat transcript(s), 14 observer evidence pack(s).

## Standard measures

| family | measure | value | unit | n / of | status | basis |
|---|---|---|---|---|---|---|
| request-latency | ackSec | — | s | — | unavailable | no card requests were delivered |
| request-latency | seatResultSec | — | s | — | unavailable | no card requests were delivered |
| request-latency | unacked | — | requests | — | unavailable | no card requests were delivered |
| physical-completion | requestsPhysicallyCompleted | 0 | requests | 0 / 0 | measured | requests whose last act call returned a completed receipt (the world's phase, not the seat's claim); requests without an act are not in the denominator |
| physical-completion | requestsPhysicallyOngoing | 0 | requests | 0 / 0 | measured | last act still executing when the seat's wait ended (for example seated); neither completed nor failed |
| physical-completion | requestsPhysicallyUnknown | 0 | requests | 0 / 0 | measured | last act started without a wait, so its end was not observed by the seat |
| seat-claims | seatReportedDone | 0 | requests | 0 / 0 | measured | result calls with outcome done; a claim, compared with physical completion separately |
| observed-walking-speed | walkMps | — | m/s | — | unavailable | the evidence packs' 26 walk receipt(s) carry no startedAt, which review/metrics.mjs needs to window the samples (an existing gap in the pack, not a zero speed) |
| observed-latency | observedFirstBodyChangeSec | 31 | s | 4 / 14 | measured | seconds from the owner message (sentAt); ack = card ack only; resultSec = latest observed card result, including server progress, not overall journey completion (use journey physicalCompleteAt/completionClaimAt); chatQueuedSec = sentAt to the start of the seat turn that carried a chat message (Claude Code queues typed messages behind a running turn); walk m/s = sampled displacement during walk receipts |
| observed-physical | walkArrivalRate | 0.4 | fraction | 5 / 7 | measured | walk requests by verb in the owner text; arrival from the arrival oracle (unknown excluded); body moved = first visible body change inside the request budget |
| review-oracles | oracles | 210 | rows | 14 / — | measured | deterministic oracles per request (recomputed offline): ack-latency 6/8/0; arrival 2/4/8; duplicate-acts 9/5/0; duration-held 0/0/14; first-body-change 4/3/7; inside-solid 0/0/14; listen-open 0/0/14; no-progress 6/0/8; oscillation 2/0/12; posture 0/0/14; result-sent 6/8/0; server-errors 14/0/0; stuck-receipt 0/0/14; truthfulness-basic 14/0/0; vocabulary 14/0/0 (pass/fail/unknown) |
| tick-timing | tickRate | — | ticks/s | — | unavailable | no tick-validity record |
| token-cost | tokens | 9681 | tokens | 9 / — | measured | input 104 + output 9577 (cached 1389471) over 9 turns as reported by adapter(s) claude-headless; scripted-owner has no provider and reports 0 |
| token-cost | costUsd | 0.451 | USD | 9 / — | measured | adapter-reported cost per turn |
| lifecycle | lifecycleOverheadMs | 68 | ms | — / — | measured | run wall 303718 ms minus scenario execution 303650 ms |
| direction | directions | 9 | commands | 9 / — | measured | console commands recorded by the swarm orchestrator (typed, scripted or from the lifecycle), with the outcome it applied |
| social-heuristic (heuristic) | coLocationRatio | — | ratio | — | unavailable | no emergence.json |
| controllability | M1-first-try-success | 1 | fraction | 6 / 6 | measured | act and object calls after onboarding (a travel call counts as an act for M2 and M3, not here), from the world's answer to each call; 1 - offer refusals / classified acts. State and admission refusals stay in the denominator and do not count against it. A repair attempt is a new act, so firstActOfIntention is the stricter reading. |
| controllability | M2-turns-per-intention | 1.5 | turns/intention | 2 / 2 | measured | median model decisions per intention (an owner message with a body act) that the seat closed with result done; intentions closed otherwise are listed in perIntention and counted in missing. A message closed by result with no act is a spoken request, reported apart. Each decision is attributed to one owner message: the id it names, else the rest of its wake, else the latest open intention. |
| controllability | M3-turns-no-act-or-say | 4 | turns | 31 / 31 | measured | model decisions after onboarding that ran only a read, a wait or a non-CLI tool. An act, say, ack or result is not counted, nor is a closing line with no tool (listed as closingTextTurns). |
| controllability | M4-time-to-start | 7.050000000000001 | s (upper bound) | 6 / 6 | measured | median seconds from the owner message first reaching the seat (listen, or the output that carried it) to the receipt's started event, or to the act call returning when no event was seen. Receipts have no first-motion tick; started is the world's start of the activity, not observed displacement (see observedFirstBodyChangeSec for that). Local wall clock and world wall clock on one machine. |
| controllability | M5-owner-repair | 0.071 | corrections/intention | 14 / 14 | measured | owner messages marked correction in the spec's script, else opening with correcting words (^\W*(actually/change of plan/never mind/no\b/not that/wrong/i meant/instead/sorry)), per intention or spoken request. The director was scripted, so this number is the script's and cannot move between arms; only a persona director can show repair burden. |
| controllability | M6-context-bytes-per-turn | 863 | bytes/turn | 31 / 31 | measured | bytes the agent was handed after onboarding (wake text and tool results) per model decision; onboardingBytes is the skill and boot reads, once per seat. contextTokensPerTurn, when the adapter reports usage, is the input the model was charged for. |
| controllability | M7-intent-retention | — | fraction | — | unavailable | no owner message arrived while an intention was under way |
| controllability | G1-untruthful-claims | 0 | claims | 2 / 2 | measured | result done claims whose last accepted act the world records as failed or cut short. |
| controllability | G2-stalled-seats | 0 | seats | 2 / 2 | measured | seats with an accepted act and no receipt the world records as completed or held. |
| controllability | G3-tick-rate | — | ticks/s | — | unavailable | no tick-validity record in the run receipt |

## Questions

- **errand-kept-through-burst** (predeclared, v3): When an owner sent chat while a two-step errand was under way, did every errand step still happen in the world, in order and once each, and was every chat message answered? → **unknown**. Uncertainty: no multi-step errand in this run. Evidence: none.
- **cancel-not-resumed** (predeclared, v1): When an owner cancelled a walk under way, did that walk end without completing, and did the Soul never start the same walk again? → **unknown**. Uncertainty: no cancel of a walk under way in this run. Evidence: none.
- **reasonable-carried-out** (predeclared, v3): When an owner asked for an ordinary thing the world offers, did the Soul act on it, did the world accept that at once, and was it carried out? → **unknown**. Uncertainty: a request was called off or replaced by a later owner line, was never acknowledged, or has no world record after it started. Evidence: `playtest/evidence/ada-002.json`, `playtest/seats/ada/transcript.jsonl:67`, `playtest/seats/ada/transcript.jsonl:122`, `playtest/evidence/bo-002.json`, `playtest/seats/bo/transcript.jsonl:70`.

Scenario acceptance (expect oracles): 0 declared; the scenario script declares no expect oracles.

## Conflicting or late records

None.

## Limits

- Retrospective: answers describe what the records show; they do not establish motivation, causality or that a replay would repeat it.
- Latency uses this machine's wall clock on both sides (director and seat); there is no shared tick stamp on owner requests.

## Controllability scorecard

Scorer controllability v5, predeclared (hash in the spec). Turns from seat log (transcript.jsonl assistant messages, turns.jsonl wake reasons).

| id | value | of | missing | target |
|---|---|---|---|---|
| M1 | 1 | 6 | unreadable 2 | >= 0.90 (0.95 stretch) |
| M2 | 1.5 | 2 | intentionsNotDone 4 | candidate beats baseline on the same specs |
| M3 | 4 | 31 |  | towards 0 with the resident client |
| M4 | 7.050000000000001 | 6 |  | reported as an upper bound; absolute claims need a quiet machine |
| M5 | 0.071 | 14 |  | <= baseline |
| M6 | 863 | 31 |  | reported, not optimized blindly |
| M7 | unknown (no owner message arrived while an intention was under way) | 0 |  | >= baseline |
| G1 | 0 | 2 |  | no regression |
| G2 | 0 | 2 |  | no regression |
| G3 | unknown (no tick-validity record in the run receipt) | unknown |  | no regression |

M1 refusals: offer 0 (resolution 0, route 0), state 0, admission 0, unclassified 0.

Owner messages at run end (the world's record): 14 delivered, 14 closed (agent 9, server 5; done 9, failed 5), 0 open.
