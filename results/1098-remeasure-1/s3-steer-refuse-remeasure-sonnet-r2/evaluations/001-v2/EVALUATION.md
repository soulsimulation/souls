# Evaluation of s3-steer-refuse-remeasure-sonnet-r2

soul-run, status **completed**, arm `b56ba8fc0a08`. Evaluator soul-runs/evaluate v2 at 54d9df7e, offline (no world, controller, network or model). Sources: 68 files, unchanged: true.

Coverage: 0 requests from 2 director seat(s), 2 seat transcript(s), 8 observer evidence pack(s).

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
| observed-walking-speed | walkMps | — | m/s | — | unavailable | the evidence packs' 18 walk receipt(s) carry no startedAt, which review/metrics.mjs needs to window the samples (an existing gap in the pack, not a zero speed) |
| observed-latency | observedFirstBodyChangeSec | 16 | s | 3 / 8 | measured | seconds from the owner message (sentAt); ack = card ack only; resultSec = latest observed card result, including server progress, not overall journey completion (use journey physicalCompleteAt/completionClaimAt); chatQueuedSec = sentAt to the start of the seat turn that carried a chat message (Claude Code queues typed messages behind a running turn); walk m/s = sampled displacement during walk receipts |
| observed-physical | walkArrivalRate | 0 | fraction | 4 / 4 | measured | walk requests by verb in the owner text; arrival from the arrival oracle (unknown excluded); body moved = first visible body change inside the request budget |
| review-oracles | oracles | 120 | rows | 8 / — | measured | deterministic oracles per request (recomputed offline): ack-latency 5/3/0; arrival 1/4/3; duplicate-acts 2/6/0; duration-held 0/0/8; first-body-change 3/2/3; inside-solid 0/0/8; listen-open 0/0/8; no-progress 4/0/4; oscillation 3/0/5; posture 0/0/8; result-sent 5/3/0; server-errors 8/0/0; stuck-receipt 0/0/8; truthfulness-basic 8/0/0; vocabulary 8/0/0 (pass/fail/unknown) |
| tick-timing | tickRate | — | ticks/s | — | unavailable | no tick-validity record |
| token-cost | tokens | 6115 | tokens | 6 / — | measured | input 72 + output 6043 (cached 895543) over 6 turns as reported by adapter(s) claude-headless; scripted-owner has no provider and reports 0 |
| token-cost | costUsd | 0.373 | USD | 6 / — | measured | adapter-reported cost per turn |
| lifecycle | lifecycleOverheadMs | 17 | ms | — / — | measured | run wall 253334 ms minus scenario execution 253317 ms |
| direction | directions | 2 | commands | 2 / — | measured | console commands recorded by the swarm orchestrator (typed, scripted or from the lifecycle), with the outcome it applied |
| social-heuristic (heuristic) | coLocationRatio | — | ratio | — | unavailable | no emergence.json |
| controllability | M1-first-try-success | 1 | fraction | 5 / 5 | measured | act and object calls after onboarding (a travel call counts as an act for M2 and M3, not here), from the world's answer to each call; 1 - offer refusals / classified acts. State and admission refusals stay in the denominator and do not count against it. A repair attempt is a new act, so firstActOfIntention is the stricter reading. |
| controllability | M2-turns-per-intention | 3.5 | turns/intention | 4 / 4 | measured | median model decisions per intention (an owner message with a body act) that the seat closed with result done; intentions closed otherwise are listed in perIntention and counted in missing. A message closed by result with no act is a spoken request, reported apart. Each decision is attributed to one owner message: the id it names, else the rest of its wake, else the latest open intention. |
| controllability | M3-turns-no-act-or-say | 3 | turns | 25 / 25 | measured | model decisions after onboarding that ran only a read, a wait or a non-CLI tool. An act, say, ack or result is not counted, nor is a closing line with no tool (listed as closingTextTurns). |
| controllability | M4-time-to-start | 3.8 | s (upper bound) | 5 / 5 | measured | median seconds from the owner message first reaching the seat (listen, or the output that carried it) to the receipt's started event, or to the act call returning when no event was seen. Receipts have no first-motion tick; started is the world's start of the activity, not observed displacement (see observedFirstBodyChangeSec for that). Local wall clock and world wall clock on one machine. |
| controllability | M5-owner-repair | 0 | corrections/intention | 8 / 8 | measured | owner messages marked correction in the spec's script, else opening with correcting words (^\W*(actually/change of plan/never mind/no\b/not that/wrong/i meant/instead/sorry)), per intention or spoken request. The director was scripted, so this number is the script's and cannot move between arms; only a persona director can show repair burden. |
| controllability | M6-context-bytes-per-turn | 884 | bytes/turn | 25 / 25 | measured | bytes the agent was handed after onboarding (wake text and tool results) per model decision; onboardingBytes is the skill and boot reads, once per seat. contextTokensPerTurn, when the adapter reports usage, is the input the model was charged for. |
| controllability | M7-intent-retention | — | fraction | — | unavailable | no owner message arrived while an intention was under way |
| controllability | G1-untruthful-claims | 1 | claims | 4 / 4 | measured | result done claims whose last accepted act the world records as failed or cut short. |
| controllability | G2-stalled-seats | 0 | seats | 2 / 2 | measured | seats with an accepted act and no receipt the world records as completed or held. |
| controllability | G3-tick-rate | — | ticks/s | — | unavailable | no tick-validity record in the run receipt |

## Questions

- **steer-honoured** (predeclared, v3): When the owner changed a Soul's route mid-walk, did the Soul close the earlier request as failed and did the world complete each act of the new route? → **unknown**. Uncertainty: no request was superseded in this run. Evidence: none.
- **refusal-recovered** (predeclared, v3): After the world refused an impossible request, by act or by resolve, did the refusal name an alternative, and did the same Soul then complete a physical act? → **pass**. Evidence: `playtest/seats/bo/transcript.jsonl:76`, `playtest/seats/bo/transcript.jsonl:83`.
- **scene-finished** (predeclared, v1): Did every seat end the scene having spoken its talk, with no request left open or failed after its talk? → **pass**. Evidence: `playtest/seats/ada/transcript.jsonl:125`, `playtest/seats/bo/transcript.jsonl:120`.

Scenario acceptance (expect oracles): 0 declared; the scenario script declares no expect oracles.

## Conflicting or late records

None.

## Limits

- Retrospective: answers describe what the records show; they do not establish motivation, causality or that a replay would repeat it.
- Latency uses this machine's wall clock on both sides (director and seat); there is no shared tick stamp on owner requests.

## Controllability scorecard

Scorer controllability v3, predeclared (hash in the spec). Turns from seat log (transcript.jsonl assistant messages, turns.jsonl wake reasons).

| id | value | of | missing | target |
|---|---|---|---|---|
| M1 | 1 | 5 | unreadable 1 | >= 0.90 (0.95 stretch) |
| M2 | 3.5 | 4 | intentionsNotDone 1 | candidate beats baseline on the same specs |
| M3 | 3 | 25 |  | towards 0 with the resident client |
| M4 | 3.8 | 5 |  | reported as an upper bound; absolute claims need a quiet machine |
| M5 | 0 | 8 |  | <= baseline |
| M6 | 884 | 25 |  | reported, not optimized blindly |
| M7 | unknown (no owner message arrived while an intention was under way) | 0 |  | >= baseline |
| G1 | 1 | 4 |  | no regression |
| G2 | 0 | 2 |  | no regression |
| G3 | unknown (no tick-validity record in the run receipt) | unknown |  | no regression |

M1 refusals: offer 0 (resolution 0, route 0), state 0, admission 0, unclassified 0.
