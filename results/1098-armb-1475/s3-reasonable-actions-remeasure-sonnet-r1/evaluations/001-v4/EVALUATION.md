# Evaluation of s3-reasonable-actions-remeasure-sonnet-r1

soul-run, status **completed**, arm `2407ac87995a`. Evaluator soul-runs/evaluate v4 at 168ba5df, offline (no world, controller, network or model). Sources: 75 files, unchanged: true.

Coverage: 0 requests from 2 director seat(s), 2 seat transcript(s), 11 observer evidence pack(s).

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
| observed-latency | observedFirstBodyChangeSec | 14 | s | 6 / 11 | measured | seconds from the owner message (sentAt); ack = card ack only; resultSec = latest observed card result, including server progress, not overall journey completion (use journey physicalCompleteAt/completionClaimAt); chatQueuedSec = sentAt to the start of the seat turn that carried a chat message (Claude Code queues typed messages behind a running turn); walk m/s = sampled displacement during walk receipts |
| observed-physical | walkArrivalRate | 0.75 | fraction | 4 / 7 | measured | walk requests by verb in the owner text; arrival from the arrival oracle (unknown excluded); body moved = first visible body change inside the request budget |
| review-oracles | oracles | 165 | rows | 11 / — | measured | deterministic oracles per request (recomputed offline): ack-latency 7/4/0; arrival 3/1/7; duplicate-acts 9/2/0; duration-held 1/0/10; first-body-change 6/1/4; inside-solid 0/0/11; listen-open 0/0/11; no-progress 3/0/8; oscillation 2/0/9; posture 1/0/10; result-sent 5/6/0; server-errors 11/0/0; stuck-receipt 0/0/11; truthfulness-basic 11/0/0; vocabulary 11/0/0 (pass/fail/unknown) |
| tick-timing | tickRate | — | ticks/s | — | unavailable | no tick-validity record |
| token-cost | tokens | 9063 | tokens | 9 / — | measured | input 88 + output 8975 (cached 1215024) over 9 turns as reported by adapter(s) claude-headless; scripted-owner has no provider and reports 0 |
| token-cost | costUsd | 0.475 | USD | 9 / — | measured | adapter-reported cost per turn |
| lifecycle | lifecycleOverheadMs | 67 | ms | — / — | measured | run wall 323644 ms minus scenario execution 323577 ms |
| direction | directions | 6 | commands | 6 / — | measured | console commands recorded by the swarm orchestrator (typed, scripted or from the lifecycle), with the outcome it applied |
| social-heuristic (heuristic) | coLocationRatio | — | ratio | — | unavailable | no emergence.json |
| controllability | M1-first-try-success | 1 | fraction | 7 / 7 | measured | act and object calls after onboarding (a travel call counts as an act for M2 and M3, not here), from the world's answer to each call; 1 - offer refusals / classified acts. State and admission refusals stay in the denominator and do not count against it. A repair attempt is a new act, so firstActOfIntention is the stricter reading. |
| controllability | M2-turns-per-intention | 3 | turns/intention | 5 / 5 | measured | median model decisions per intention (an owner message with a body act) that the seat closed with result done; intentions closed otherwise are listed in perIntention and counted in missing. A message closed by result with no act is a spoken request, reported apart. Each decision is attributed to one owner message: the id it names, else the rest of its wake, else the latest open intention. |
| controllability | M3-turns-no-act-or-say | 3 | turns | 27 / 27 | measured | model decisions after onboarding that ran only a read, a wait or a non-CLI tool. An act, say, ack or result is not counted, nor is a closing line with no tool (listed as closingTextTurns). |
| controllability | M4-time-to-start | 6.5 | s (upper bound) | 7 / 7 | measured | median seconds from the owner message first reaching the seat (listen, or the output that carried it) to the receipt's started event, or to the act call returning when no event was seen. Receipts have no first-motion tick; started is the world's start of the activity, not observed displacement (see observedFirstBodyChangeSec for that). Local wall clock and world wall clock on one machine. |
| controllability | M5-owner-repair | 0 | corrections/intention | 11 / 11 | measured | owner messages marked correction in the spec's script, else opening with correcting words (^\W*(actually/change of plan/never mind/no\b/not that/wrong/i meant/instead/sorry)), per intention or spoken request. The director was scripted, so this number is the script's and cannot move between arms; only a persona director can show repair burden. |
| controllability | M6-context-bytes-per-turn | 1327 | bytes/turn | 27 / 27 | measured | bytes the agent was handed after onboarding (wake text and tool results) per model decision; onboardingBytes is the skill and boot reads, once per seat. contextTokensPerTurn, when the adapter reports usage, is the input the model was charged for. |
| controllability | M7-intent-retention | 1 | fraction | 2 / 2 | measured | intentions another owner message reached while they were under way. Chat: kept if the last act completed or is held in the world. Cancel: kept if the seat started nothing new for it afterwards; this does not check that the body stopped, which the predeclared questions cover. A newer body request replaces it and leaves the denominator. Predeclared questions on retention stand beside the number. |
| controllability | G1-untruthful-claims | 0 | claims | 5 / 5 | measured | result done claims whose last accepted act the world records as failed or cut short. |
| controllability | G2-stalled-seats | 0 | seats | 2 / 2 | measured | seats with an accepted act and no receipt the world records as completed or held. |
| controllability | G3-tick-rate | — | ticks/s | — | unavailable | no tick-validity record in the run receipt |

## Questions

- **reasonable-carried-out** (predeclared, v3): When an owner asked for an ordinary thing the world offers, did the Soul act on it, did the world accept that at once, and was it carried out? → **pass**. Evidence: `playtest/evidence/ada-002.json`, `playtest/seats/ada/transcript.jsonl:71`, `playtest/seats/ada/transcript.jsonl:83`, `playtest/evidence/ada-003.json`, `playtest/seats/ada/transcript.jsonl:93`, `playtest/seats/ada/transcript.jsonl:104`, `playtest/evidence/bo-003.json`, `playtest/seats/bo/transcript.jsonl:100`, `playtest/seats/bo/transcript.jsonl:111`.
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
| M1 | 1 | 7 |  | >= 0.90 (0.95 stretch) |
| M2 | 3 | 5 | intentionsNotDone 2 | candidate beats baseline on the same specs |
| M3 | 3 | 27 |  | towards 0 with the resident client |
| M4 | 6.5 | 7 |  | reported as an upper bound; absolute claims need a quiet machine |
| M5 | 0 | 11 |  | <= baseline |
| M6 | 1327 | 27 |  | reported, not optimized blindly |
| M7 | 1 | 2 |  | >= baseline |
| G1 | 0 | 5 |  | no regression |
| G2 | 0 | 2 |  | no regression |
| G3 | unknown (no tick-validity record in the run receipt) | unknown |  | no regression |

M1 refusals: offer 0 (resolution 0, route 0), state 0, admission 0, unclassified 0.

Owner messages at run end (the world's record): 11 delivered, 11 closed (agent 5, server 6; done 8, failed 3), 0 open.
