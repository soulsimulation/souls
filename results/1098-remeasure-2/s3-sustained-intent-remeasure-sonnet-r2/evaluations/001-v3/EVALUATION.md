# Evaluation of s3-sustained-intent-remeasure-sonnet-r2

soul-run, status **completed**, arm `65251c3aae72`. Evaluator soul-runs/evaluate v3 at b9d52423, offline (no world, controller, network or model). Sources: 80 files, unchanged: true.

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
| observed-walking-speed | walkMps | — | m/s | — | unavailable | the evidence packs' 28 walk receipt(s) carry no startedAt, which review/metrics.mjs needs to window the samples (an existing gap in the pack, not a zero speed) |
| observed-latency | observedFirstBodyChangeSec | 14 | s | 4 / 14 | measured | seconds from the owner message (sentAt); ack = card ack only; resultSec = latest observed card result, including server progress, not overall journey completion (use journey physicalCompleteAt/completionClaimAt); chatQueuedSec = sentAt to the start of the seat turn that carried a chat message (Claude Code queues typed messages behind a running turn); walk m/s = sampled displacement during walk receipts |
| observed-physical | walkArrivalRate | 0.16666666666666666 | fraction | 6 / 7 | measured | walk requests by verb in the owner text; arrival from the arrival oracle (unknown excluded); body moved = first visible body change inside the request budget |
| review-oracles | oracles | 210 | rows | 14 / — | measured | deterministic oracles per request (recomputed offline): ack-latency 9/5/0; arrival 1/5/8; duplicate-acts 5/9/0; duration-held 0/0/14; first-body-change 4/3/7; inside-solid 0/0/14; listen-open 0/0/14; no-progress 5/0/9; oscillation 2/0/12; posture 0/1/13; result-sent 5/9/0; server-errors 14/0/0; stuck-receipt 0/0/14; truthfulness-basic 13/1/0; vocabulary 14/0/0 (pass/fail/unknown) |
| tick-timing | tickRate | — | ticks/s | — | unavailable | no tick-validity record |
| token-cost | tokens | 6829 | tokens | 7 / — | measured | input 70 + output 6759 (cached 887191) over 7 turns as reported by adapter(s) claude-headless; scripted-owner has no provider and reports 0 |
| token-cost | costUsd | 0.417 | USD | 7 / — | measured | adapter-reported cost per turn |
| lifecycle | lifecycleOverheadMs | 70 | ms | — / — | measured | run wall 233660 ms minus scenario execution 233590 ms |
| direction | directions | 9 | commands | 9 / — | measured | console commands recorded by the swarm orchestrator (typed, scripted or from the lifecycle), with the outcome it applied |
| social-heuristic (heuristic) | coLocationRatio | — | ratio | — | unavailable | no emergence.json |
| controllability | M1-first-try-success | 1 | fraction | 6 / 6 | measured | act and object calls after onboarding (a travel call counts as an act for M2 and M3, not here), from the world's answer to each call; 1 - offer refusals / classified acts. State and admission refusals stay in the denominator and do not count against it. A repair attempt is a new act, so firstActOfIntention is the stricter reading. |
| controllability | M2-turns-per-intention | 3 | turns/intention | 1 / 1 | measured | median model decisions per intention (an owner message with a body act) that the seat closed with result done; intentions closed otherwise are listed in perIntention and counted in missing. A message closed by result with no act is a spoken request, reported apart. Each decision is attributed to one owner message: the id it names, else the rest of its wake, else the latest open intention. |
| controllability | M3-turns-no-act-or-say | 2 | turns | 23 / 23 | measured | model decisions after onboarding that ran only a read, a wait or a non-CLI tool. An act, say, ack or result is not counted, nor is a closing line with no tool (listed as closingTextTurns). |
| controllability | M4-time-to-start | 3.3 | s (upper bound) | 5 / 5 | measured | median seconds from the owner message first reaching the seat (listen, or the output that carried it) to the receipt's started event, or to the act call returning when no event was seen. Receipts have no first-motion tick; started is the world's start of the activity, not observed displacement (see observedFirstBodyChangeSec for that). Local wall clock and world wall clock on one machine. |
| controllability | M5-owner-repair | 0.071 | corrections/intention | 14 / 14 | measured | owner messages marked correction in the spec's script, else opening with correcting words (^\W*(actually/change of plan/never mind/no\b/not that/wrong/i meant/instead/sorry)), per intention or spoken request. The director was scripted, so this number is the script's and cannot move between arms; only a persona director can show repair burden. |
| controllability | M6-context-bytes-per-turn | 1301 | bytes/turn | 23 / 23 | measured | bytes the agent was handed after onboarding (wake text and tool results) per model decision; onboardingBytes is the skill and boot reads, once per seat. contextTokensPerTurn, when the adapter reports usage, is the input the model was charged for. |
| controllability | M7-intent-retention | 1 | fraction | 1 / 1 | measured | intentions another owner message reached while they were under way. Chat: kept if the last act completed or is held in the world. Cancel: kept if the seat started nothing new for it afterwards; this does not check that the body stopped, which the predeclared questions cover. A newer body request replaces it and leaves the denominator. Predeclared questions on retention stand beside the number. |
| controllability | G1-untruthful-claims | 1 | claims | 1 / 1 | measured | result done claims whose last accepted act the world records as failed or cut short. |
| controllability | G2-stalled-seats | 0 | seats | 2 / 2 | measured | seats with an accepted act and no receipt the world records as completed or held. |
| controllability | G3-tick-rate | — | ticks/s | — | unavailable | no tick-validity record in the run receipt |

## Questions

- **errand-kept-through-burst** (predeclared, v3): When an owner sent chat while a two-step errand was under way, did every errand step still happen in the world, in order and once each, and was every chat message answered? → **unknown**. Uncertainty: no multi-step errand in this run. Evidence: none.
- **cancel-not-resumed** (predeclared, v1): When an owner cancelled a walk under way, did that walk end without completing, and did the Soul never start the same walk again? → **unknown**. Uncertainty: no cancel of a walk under way in this run. Evidence: none.
- **reasonable-carried-out** (predeclared, v3): When an owner asked for an ordinary thing the world offers, did the Soul act on it, did the world accept that at once, and was it carried out? → **unknown**. Uncertainty: a request was called off or replaced by a later owner line, was never acknowledged, or has no world record after it started. Evidence: `playtest/evidence/ada-002.json`, `playtest/seats/ada/transcript.jsonl:69`, `playtest/seats/ada/transcript.jsonl:136`, `playtest/evidence/bo-002.json`, `playtest/seats/bo/transcript.jsonl:70`.

Scenario acceptance (expect oracles): 0 declared; the scenario script declares no expect oracles.

## Conflicting or late records

None.

## Limits

- Retrospective: answers describe what the records show; they do not establish motivation, causality or that a replay would repeat it.
- Latency uses this machine's wall clock on both sides (director and seat); there is no shared tick stamp on owner requests.

## Controllability scorecard

Scorer controllability v4, predeclared (hash in the spec). Turns from seat log (transcript.jsonl assistant messages, turns.jsonl wake reasons).

| id | value | of | missing | target |
|---|---|---|---|---|
| M1 | 1 | 6 | unreadable 1 | >= 0.90 (0.95 stretch) |
| M2 | 3 | 1 | intentionsNotDone 5 | candidate beats baseline on the same specs |
| M3 | 2 | 23 |  | towards 0 with the resident client |
| M4 | 3.3 | 5 |  | reported as an upper bound; absolute claims need a quiet machine |
| M5 | 0.071 | 14 |  | <= baseline |
| M6 | 1301 | 23 |  | reported, not optimized blindly |
| M7 | 1 | 1 |  | >= baseline |
| G1 | 1 | 1 |  | no regression |
| G2 | 0 | 2 |  | no regression |
| G3 | unknown (no tick-validity record in the run receipt) | unknown |  | no regression |

M1 refusals: offer 0 (resolution 0, route 0), state 0, admission 0, unclassified 0.
