# Pose and motion

Engine v2 T4 (#2644), contract T4 in [TRUNK.md](TRUNK.md). It fixes what a pose is and who owns a movable's motion,
so that flying, throwing and moving decks need no new stored shape. Code: `v2/crates/replica/src/pose.rs`. Fixtures:
`v2/crates/replica/fixtures/pose/`. Checks: `crates/replica/tests/pose.rs` natively, and the `pose-goldens` step of
`v2/tools/ci.sh` for the WASM build. The mover (N6), ground (N3), tracks at runtime (N14) and rides (N12) are not here.

## The pose

1. **A pose is a frame, a position, an orientation and a support** (`Pose`). The frame is a node and the slot in it,
   if any. In a world it is the node's T2 parent and slot ([world-model.md](world-model.md) rule 1), stored there
   once; a pose names its frame only where it travels alone (a hand-off, a motion sample, T6).
2. **Units:** position in micrometres, linear velocity in micrometres a second, angular velocity in micro-radians a
   second, acceleration in micrometres a second squared, time in T5's microseconds ([time.md](time.md)). All are
   signed 64-bit; a world 10 km across is 10^10 µm, inside 64 bits nine hundred million times over. Soul Actions'
   whole millimetres (SA-D3, SA-D4) are these times 1,000, exactly.
3. **Arithmetic is integer, through 128 bits, rounded once per number:** to the nearest, halves away from zero. A
   product or sum past 128 bits, or a result past 64, is refused as `out-of-range`; nothing wraps. No float, no
   `sin` or `cos` (Rust lets them vary by platform). This is the rule for positions, velocities and orientations;
   a fraction of a duration (a progress in permille, never negative) is a count and rounds down, by T5's rule 4.
4. **An orientation is a unit quaternion as four integers scaled by 2^30** (`Quat`, w x y z). Its squared norm is
   within 2^32 of 2^60 (`orientation-not-unit`). **One byte form**, which a reader checks and refuses otherwise:
   the first non-zero number is positive (`orientation-sign`, so q and −q have one form), and of the whole multiples
   k·p of one direction p (numbers sharing no factor) only the k whose squared norm is nearest 2^60 is kept
   (`orientation-not-canonical`: 2^30 + 1 is not a second identity). A vector is turned exactly over the
   quaternion's own norm, then rounded, so a slightly short quaternion is still an exact rotation. A product of two
   is divided by 2^30 and rounded, so a turn by the identity changes nothing; only a product whose norm leaves the
   band is scaled back through an integer square root. An authored yaw in whole millidegrees (SA-D3's `yaw_mdeg`,
   looks) becomes a `Quat` only through `Quat::from_yaw_mdeg`: the half angle's sine and cosine by an integer
   series in 2^60, with no table to copy. E2, E3 and B3 call it rather than write their own.
5. **Axes are stated per frame by its orientation in its parent.** The root's are today's engine's: right-handed, +y
   up, +x right, +z to the front (SA-D3's thing frame, three.js), in metres scaled to micrometres. A frame's up is its
   own +y, so a station turned on its side has its own up. Gravity is a vector in a track's frame, never a constant.
6. **Support** (`Support`): a surface with a height (standing is 0; a hovering body is held by the surface below it
   with its height, as settled), the frame's slot (a held cup: support is T2's (parent, slot), never a second
   field), a volume (water), a track's rail, or none (in flight). A pose in a slot is supported by the slot and only
   then (`support-not-slot`); a height is never below its surface (`height-below-surface`). The rail is named once,
   in the rail track; a rail support with any other owner, or a rail track with any other support, is
   `support-not-track`. A surface's height and the position both say how high a body is: the position wins, and the
   height is the ground's (N3) to keep equal to it when it writes the support.

## Who moves it

7. **Every movable has exactly one motion owner** (`Owner`): its slot (it moves with its frame), its own mover (N6),
   a closed-form track, or, reserved, a physics island (`island-reserved`). A slot owner needs a slot frame
   (`owner-not-slot`). A mover names no driver: it is the movable's own, so no record can say one body drives
   another. A body's mover is steered by its Soul's controller. **A joint activity's node** (a carried sofa's
   parent, T2) has its own mover, steered by the joint skill (T9). While a carrier is joined, the skill claims the
   carrier's movement (B1) for the whole activity, so its mover has one input at a time: the skill's, toward the
   load's grip points. Pose cannot tell a body from a thing, so the rest is enforced where it can be: B1's claims
   refuse a second claim on a body's movement, and T2's `admits` keeps a body out of another body's hand slot
   unless an activity both joined allows it. One occupant per slot is T2's check too, not a hand-off's.
8. **A track is a formula of world time, never accumulated** (`Track`): at rest, straight
   (`p0 + v·dt`), thrown (`p0 + v·dt + g·dt²/2`, one division of `2·10^6·v·dt + g·dt²` by `2·10^12`) or on a rail
   (a distance along a path; the path is N14's, so its position is refused as `rail-needs-path` here). A track's
   orientation is constant; one that turns needs an integer sine table (N14). A time before its start is
   `before-track-start`. A straight or thrown track starts at its pose's position at `t0`; it stores no second start.
   T5's `Line` ([time.md](time.md) rule 4) does not fit a track: a position falls (a negative velocity), a throw
   is quadratic, and a pose rounds to the nearest so that a hand-off is off by half a unit, not up to one in a fixed
   direction. Time itself (`dt`) is T5's microseconds, unrounded. When a track's end time is worked out (N14's catch
   or landing timer), the time rounds by T5's rule (the first microsecond at or after it) and the position at that
   time by rule 3.
9. **A pose reaches the root frame one frame at a time,** walked up with a loop, then carried down: each frame turns
   its child's arm, adds its own position and velocity, and adds ω × arm. Each carry rounds each turned vector once.
   A chain of more than 32 ancestors is `depth-over-limit`, as in T2.
10. **A hand-off** (`HandOff`) names the node, the world time, the old and the new owner, the pose in the new frame,
    and the linear and angular velocity in the new frame's axes. To an owner that carries a velocity (a mover, a
    straight or thrown track) it keeps the movable's motion in the root frame to **one unit per frame crossed** (the
    old chain, the new chain, and the step between); a track handed to starts there, from that pose with that
    velocity. To a slot or a rest track it keeps the position and orientation, and the velocity, held and recorded,
    is zero: a catch ends the motion on purpose.
11. **A controller takes a velocity in three dimensions, in the axes of the frame the body is in** (its parent's,
    rule 1, not the body's own facing; facing is B1's separate input), **and a mode** (`ControllerInput`). Only
    walking on a surface is built; any other mode is `mode-not-built`.
12. **Regions have kinds** (ground, water, air); a T2 link between two regions names the move that crosses it.

## Records and the fixtures

13. **Records** use T0's profile: a pose is `{1: frame, 2: position, 3: orientation, 4: support}`, a hand-off
    `{1: node, 2: at, 3: from, 4: to, 5: pose, 6: linear, 7: angular}`; ids are T3's. Fixtures write ids as counters.
    T6's motion sample is one of these two (`HandOff::to_value`, `Pose::to_value`), not a third shape. A pose record
    carries its frame, so a record that also names the new parent (T6's `reparent`) keeps only one of the two.
    Nothing enforces rule 12's links or `ControllerInput` yet: they are types, with no record or check.
14. **The drift bound:** after n hand-offs a pose is within n × (frames crossed) units of exact arithmetic. Measured:
    1,000 hand-offs of a body from a moving, turned deck to a turned dock and back, every 10 ms, end **21 µm** from
    exact (bound 4,000), with velocity and orientation exact. Why it holds: the new frame's motion is used both to
    find the local pose and by the next carry, so it cancels; one hand-off then moves a position by the turned
    local rounding (at most √3/2) and one carry rounding (½), at most one unit at any depth. Tracks are formulas, so
    nothing builds up between hand-offs. The error walks rather than adds: each rounding is in no fixed direction.
15. `boat.diag` (a body on a moving boat's deck, a ball in its hand, a dock), `hover.diag` and `thrown.diag` (Step 0:
    after 10 s the ball is at x 80,000,000, y −428,832,500 µm; g·t² is 9.8 × 10^20, past 2^63, so 128 bits) state
    where each node must be, worked out in exact fractions. `goldens.txt` holds what both builds give.

## What would quietly break this

- **A float, or a platform `sin`,** anywhere a pose is decided. Native and WASM would differ.
- **A track stepped by adding a velocity each tick.** Its error grows with every tick and with the tick rate.
- **Storing the frame twice** (in the pose and in T2's parent), or holding written as a link. They would disagree.
- **Writing −q, or any multiple of a rotation but its one form.** Two byte forms of one rotation; hashes differ.
  A reader refuses them, so a writer that skips `Quat::new` fails loudly.
- **A fact stored twice:** a track's start beside the pose's position, a rail in the support and the track, a
  driver beside the owner. They would disagree.
- **Micrometres squared in 64 bits.** g·t² overflows after a second; 32-bit micrometres end at 2.1 km.
- **A coarse unit.** At 1,000 ticks a second a millimetre a tick is already 1 m/s.
- **Two owners of one motion** (a slot and a mover, a carrier and the activity). Each would move it.
- **A mover driven by another Soul's body outside a joined activity.** B1's claims and T2's `admits` refuse it.
- **A turned body walking along its own facing** when the controller's velocity is in its frame's axes (rule 11).
- **A lever arm far from its frame.** The orientation's 2^-30 step moves a point 10 km out by about 10 µm.
