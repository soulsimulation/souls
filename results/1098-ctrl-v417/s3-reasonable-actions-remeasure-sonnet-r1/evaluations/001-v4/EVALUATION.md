# Evaluation of s3-reasonable-actions-remeasure-sonnet-r1

soul-run, status **completed**, arm `2407ac87995a`. Evaluator soul-runs/evaluate v4 at 168ba5df, offline (no world, controller, network or model). Sources: 71 files, unchanged: true.

Coverage: 0 requests from 2 director seat(s), 2 seat transcript(s), 9 observer evidence pack(s).

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
| observed-walking-speed | walkMps | — | m/s | — | unavailable | the evidence packs' 11 walk receipt(s) carry no startedAt, which review/metrics.mjs needs to window the samples (an existing gap in the pack, not a zero speed) |
| observed-latency | observedFirstBodyChangeSec | 15 | s | 6 / 9 | measured | seconds from the owner message (sentAt); ack = card ack only; resultSec = latest observed card result, including server progress, not overall journey completion (use journey physicalCompleteAt/completionClaimAt); chatQueuedSec = sentAt to the start of the seat turn that carried a chat message (Claude Code queues typed messages behind a running turn); walk m/s = sampled displacement during walk receipts |
| observed-physical | walkArrivalRate | 0 | fraction | 3 / 5 | measured | walk requests by verb in the owner text; arrival from the arrival oracle (unknown excluded); body moved = first visible body change inside the request budget |
| review-oracles | oracles | 135 | rows | 9 / — | measured | deterministic oracles per request (recomputed offline): ack-latency 9/0/0; arrival 0/3/6; duplicate-acts 8/1/0; duration-held 0/0/9; first-body-change 6/1/2; inside-solid 0/0/9; listen-open 0/0/9; no-progress 3/0/6; oscillation 1/0/8; posture 0/1/8; result-sent 3/6/0; server-errors 9/0/0; stuck-receipt 0/0/9; truthfulness-basic 9/0/0; vocabulary 9/0/0 (pass/fail/unknown) |
| tick-timing | tickRate | — | ticks/s | — | unavailable | no tick-validity record |
| token-cost | tokens | 8186 | tokens | 6 / — | measured | input 82 + output 8104 (cached 1046753) over 6 turns as reported by adapter(s) claude-headless; scripted-owner has no provider and reports 0 |
| token-cost | costUsd | 0.395 | USD | 6 / — | measured | adapter-reported cost per turn |
| lifecycle | lifecycleOverheadMs | 67 | ms | — / — | measured | run wall 189686 ms minus scenario execution 189619 ms |
| direction | directions | 4 | commands | 4 / — | measured | console commands recorded by the swarm orchestrator (typed, scripted or from the lifecycle), with the outcome it applied |
| social-heuristic (heuristic) | coLocationRatio | — | ratio | — | unavailable | no emergence.json |
| controllability | M1-first-try-success | 1 | fraction | 6 / 6 | measured | act and object calls after onboarding (a travel call counts as an act for M2 and M3, not here), from the world's answer to each call; 1 - offer refusals / classified acts. State and admission refusals stay in the denominator and do not count against it. A repair attempt is a new act, so firstActOfIntention is the stricter reading. |
| controllability | M2-turns-per-intention | 3 | turns/intention | 2 / 2 | measured | median model decisions per intention (an owner message with a body act) that the seat closed with result done; intentions closed otherwise are listed in perIntention and counted in missing. A message closed by result with no act is a spoken request, reported apart. Each decision is attributed to one owner message: the id it names, else the rest of its wake, else the latest open intention. |
| controllability | M3-turns-no-act-or-say | 1 | turns | 21 / 21 | measured | model decisions after onboarding that ran only a read, a wait or a non-CLI tool. An act, say, ack or result is not counted, nor is a closing line with no tool (listed as closingTextTurns). |
| controllability | M4-time-to-start | 5.2 | s (upper bound) | 5 / 5 | measured | median seconds from the owner message first reaching the seat (listen, or the output that carried it) to the receipt's started event, or to the act call returning when no event was seen. Receipts have no first-motion tick; started is the world's start of the activity, not observed displacement (see observedFirstBodyChangeSec for that). Local wall clock and world wall clock on one machine. |
| controllability | M5-owner-repair | 0 | corrections/intention | 9 / 9 | measured | owner messages marked correction in the spec's script, else opening with correcting words (^\W*(actually/change of plan/never mind/no\b/not that/wrong/i meant/instead/sorry)), per intention or spoken request. The director was scripted, so this number is the script's and cannot move between arms; only a persona director can show repair burden. |
| controllability | M6-context-bytes-per-turn | 1297 | bytes/turn | 21 / 21 | measured | bytes the agent was handed after onboarding (wake text and tool results) per model decision; onboardingBytes is the skill and boot reads, once per seat. contextTokensPerTurn, when the adapter reports usage, is the input the model was charged for. |
| controllability | M7-intent-retention | — | fraction | — | unavailable | no owner message arrived while an intention was under way |
| controllability | G1-untruthful-claims | 0 | claims | 2 / 2 | measured | result done claims whose last accepted act the world records as failed or cut short. |
| controllability | G2-stalled-seats | 0 | seats | 2 / 2 | measured | seats with an accepted act and no receipt the world records as completed or held. |
| controllability | G3-tick-rate | — | ticks/s | — | unavailable | no tick-validity record in the run receipt |

## Questions

- **reasonable-carried-out** (predeclared, v3): When an owner asked for an ordinary thing the world offers, did the Soul act on it, did the world accept that at once, and was it carried out? → **unknown**. Uncertainty: a request was called off or replaced by a later owner line, was never acknowledged, or has no world record after it started. Evidence: `playtest/evidence/ada-002.json`, `playtest/seats/ada/transcript.jsonl:70`, `playtest/seats/ada/transcript.jsonl:82`, `playtest/evidence/ada-004.json`, `playtest/seats/ada/transcript.jsonl:110`, `playtest/seats/ada/transcript.jsonl:122`, `playtest/evidence/bo-004.json`, `playtest/seats/bo/transcript.jsonl:115`, `playtest/seats/bo/transcript.jsonl:124`.
- **refusal-helps** (predeclared, v3): When an owner asked for something the world cannot do here (into the closed reading room), did the world's refusal give a reason and name an offer, and did acting on that offer work? → **unknown**. Uncertainty: no refusal was given for the request, so there is nothing to score. Evidence: `playtest/seats/bo/transcript.jsonl:72`.

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
| M1 | 1 | 6 |  | >= 0.90 (0.95 stretch) |
| M2 | 3 | 2 | intentionsNotDone 3 | candidate beats baseline on the same specs |
| M3 | 1 | 21 |  | towards 0 with the resident client |
| M4 | 5.2 | 5 |  | reported as an upper bound; absolute claims need a quiet machine |
| M5 | 0 | 9 |  | <= baseline |
| M6 | 1297 | 21 |  | reported, not optimized blindly |
| M7 | unknown (no owner message arrived while an intention was under way) | 0 |  | >= baseline |
| G1 | 0 | 2 |  | no regression |
| G2 | 0 | 2 |  | no regression |
| G3 | unknown (no tick-validity record in the run receipt) | unknown |  | no regression |

M1 refusals: offer 0 (resolution 0, route 0), state 0, admission 0, unclassified 0.

Owner messages at run end (the world's record): 9 delivered, 8 closed (agent 6, server 2; done 5, failed 3), 1 open.
