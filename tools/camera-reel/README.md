# Camera reel

The test bed of the camera tranche (#5340): scripted scenes in real worlds, filmed by the old and the new camera at
the same moment, and a scorecard worked out from a per-frame camera log.

- `catalogue.json` holds the scenes, the log's fields and the scorecard's formulas. It is the one source for the
  runner (`run.mjs`, C02) and the scorer (`score.mjs`, C03).
- `catalogue.test.mjs` checks it against the world templates and the Soul client's command forms:
  `node --test tools/camera-reel/catalogue.test.mjs`. It starts no world.

## Scenes

45 scenes over six worlds. Each names its world template, its Souls (seats `a` to `f`), the commands in order, its
length, the camera mode, portrait or landscape, the light, and its set.

| Group | Kinds | Scenes |
|---|---|---|
| Walking | open ground, street with turns, past trees and posts, narrow passage, U-turn, stop-and-start, jog, round a building | 13 |
| Buildings | in and out of a house, activity in a tiny room, large hall, stairs | 9 |
| Still | bench, activity with an object, two talking, circle of four | 8 |
| Rides | balloon, cable car, big wheel, boat, carousel | 6 |
| Groups | six in a line, carry crew, field game, others crossing | 6 |
| Broadcast | three-minute sessions: quiet, busy, medium | 3 |

Round a building, the carousel and the medium Broadcast session are kinds added to the plan's list.

**How a scene runs.** `setup` steps run to their end before recording (Souls run to their marks, sit, board, form a
crew). `steps` run on the recording's clock: at `t` seconds, or when the same Soul's previous step is done. Every
command is one the Soul client has today (`v2/client/src/cli/souls.mjs`):

- `act walk:<x>,<z>` with `gait=jog|run`, and `stop`;
- `act sit:@thing`, `act rise`, `act yoga for=20s`, `act wave for=6s`, `act dance for=20s`;
- `act go_up:@stairs`, `act play:@piano`, `act play:@court`, `act play_white:@table`;
- `act ride:@ride` (balloon, cable car, big wheel, carousel) and `act sail:@boat`. The client has no `board:` word
  of its own: `ride` and `sail` are the rides' own acts that take a seat and start the ride;
- `say`, `converse start|accept|say`, `together offer|accept|leave`, `carry grip|offer|accept|lift|to|set-down`.

`@alias` stands for a thing the scene names by its name in the template; `$a` for a seat's body id; `{name}` for a
value captured from an earlier answer. `conventions` in the file states each rule exactly, and how a ride scene
times its recording to the take-off.

**Stand-ins.** Nothing commands a parade, so six in a line is six staggered walks to one point. The football pitch
offers no acts, so the field game is doubles on a tennis court. Each is noted in the scene's `gap`.

**Worlds need their map.** Rides, seats and loads offer their acts only when the template is exported with the
world's map (`worlds` in the file names each). The stock launcher passes a map only for eden-2026.

## Tuning set and held-out set

Scenes are numbered in file order and every third is held out: 15 of 45. The order was fixed on 28 November 2026,
before any camera ran on any scene, so that the held-out set covers all six worlds and all six groups, each named
failure keeps at least two tuning scenes, and no kind the plan asks for is only held out. `set` never changes. A new
scene goes at the end and takes the next number. Held-out scenes run only at gates.

## Named failures

Each scene lists in `provokes` the old camera's failures it is built to catch. Every failure has at least six
scenes, three or more in the tuning set.

| Failure | Shown by |
|---|---|
| Forced climb | measure `forced-climbs` |
| Glide round a building | detector `glide` |
| Zigzag | measure `zigzags` |
| Balloon jutting in and out | detector `jutting` |
| Cropped head | measure `head-outside` |
| Wall pass | detector `wall-pass` (needs the optional `blocked` field; otherwise by eye) |

## The log and the scorecard

`log` lists what the page keeps for every drawn frame: the camera's eye, look point and lens, the mode, whether a
viewer holds the camera, the shot, whether a high view was chosen on purpose, cuts, cost, whether sky shows, and for
each subject its place, its front, where head, torso and feet fall on screen, whether they are hidden, and whether it
is riding or indoors. `derived` defines what the scorer works out from those, and `measures` gives the eight
formulas, each with the subjects it applies to and its starting target:

| Measure | In short | Target |
|---|---|---|
| Overhead time | looking down more than 35° at a subject that is not riding, outside a chosen high wide | under 2% |
| Forced climbs | the camera gains 2 m over its subject in 2 s without a cut | none |
| Zigzags | sideways or vertical motion reversing twice within 3 s | 80% fewer than today |
| Head outside the frame | the head, with its radius, not wholly on screen | under 1% |
| Good-angle time | visible, head in frame, eye-level band, sensible size, not from behind for long | 90% or more |
| Horizon or sky in frame | outdoors only | 70% or more |
| Cuts | count, spacing and jump cuts | Follow: 2 a minute, 8 s apart; Broadcast: 6 s apart |
| Camera cost | ms per frame, mean and 95th percentile | no worse than today |

Heights are measured from the subject, so stairs, hills and rides do not count as the camera climbing. A rider is
never "overhead" and has its own band and size. A climb counts as chosen only when the shot says so and the subject
was in view before it began: a climb that follows a blocked view is forced whatever the shot is called.
