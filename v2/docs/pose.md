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
   `sin` or `cos` (Rust lets them vary by platform).
4. **An orientation is a unit quaternion as four integers scaled by 2^30** (`Quat`, w x y z). Its squared norm is
   within 2^32 of 2^60 (`orientation-not-unit`). **Sign rule:** the first non-zero number is positive
   (`orientation-sign`), so q and −q, one rotation, have one byte form. A vector is turned exactly over the
   quaternion's own norm, then rounded, so a slightly short quaternion is still an exact rotation. A product of two
   is scaled back to 2^30 through an integer square root and given the sign rule.
5. **Axes are stated per frame by its orientation in its parent.** The root's are today's engine's: right-handed, +y
   up, +x right, +z to the front (SA-D3's thing frame, three.js), in metres scaled to micrometres. A frame's up is its
   own +y, so a station turned on its side has its own up. Gravity is a vector in a track's frame, never a constant.
6. **Support** (`Support`): a surface with a height (standing is 0; a hovering body is held by the surface below it
   with its height, as settled), the frame's slot (a held cup: support is T2's (parent, slot), never a second
   field), a volume (water), a rail, or none (in flight). A pose in a slot is supported by the slot and only then
   (`support-not-slot`); a height is never below its surface (`height-below-surface`).

## Who moves it

7. **Every movable has exactly one motion owner** (`Owner`): its slot (it moves with its frame), a mover (N6) steered
   by a driver's controller, a closed-form track, or, reserved, a physics island (`island-reserved`). A slot owner
   needs a slot frame (`owner-not-slot`). **A joint activity's node** (a carried sofa's parent, T2) is owned by a
   mover whose driver is the activity node, steered by the joint skill (T9); each carrier keeps its own mover, which
   that skill steers to the load's grip points. Bodies touch only inside an activity both Souls joined.
8. **A track is a formula of world time, never accumulated** (`Track`): at rest, straight
   (`p0 + v·dt`), thrown (`p0 + v·dt + g·dt²/2`, one division of `2·10^6·v·dt + g·dt²` by `2·10^12`) or on a rail
   (a distance along a path; the path is N14's, so its position is refused as `rail-needs-path` here). A track's
   orientation is constant; one that turns needs an integer sine table (N14). A time before its start is
   `before-track-start`.
9. **A pose reaches the root frame one frame at a time,** walked up with a loop, then carried down: each frame turns
   its child's arm, adds its own position and velocity, and adds ω × arm. Each carry rounds each turned vector once.
10. **A hand-off** (`HandOff`) names the node, the world time, the old and the new owner, the pose in the new frame,
    and the linear and angular velocity in the new frame's axes. It keeps the movable's motion in the root frame to
    **one unit per frame crossed** (the old chain, the new chain, and the step between). A track handed to starts
    there, from that pose with that velocity.
11. **A controller takes a velocity in three dimensions, in the body's frame, and a mode** (`ControllerInput`). Only
    walking on a surface is built; any other mode is `mode-not-built`.
12. **Regions have kinds** (ground, water, air); a T2 link between two regions names the move that crosses it.

## Records and the fixtures

13. **Records** use T0's profile: a pose is `{1: frame, 2: position, 3: orientation, 4: support}`, a hand-off
    `{1: node, 2: at, 3: from, 4: to, 5: pose, 6: linear, 7: angular}`; ids are T3's. Fixtures write ids as counters.
14. **The drift bound:** after n hand-offs a pose is within n × (frames crossed) units of exact arithmetic. Measured:
    1,000 hand-offs of a body from a moving, turned deck to a turned dock and back, every 10 ms, end **21 µm** from
    exact (bound 4,000), with velocity and orientation exact. The error walks rather than adds: each hand-off rounds
    by at most one unit, in no fixed direction.
15. `boat.diag` (a body on a moving boat's deck, a ball in its hand, a dock), `hover.diag` and `thrown.diag` (Step 0:
    after 10 s the ball is at x 80,000,000, y −428,832,500 µm; g·t² is 9.8 × 10^20, past 2^63, so 128 bits) state
    where each node must be, worked out in exact fractions. `goldens.txt` holds what both builds give.

## What would quietly break this

- **A float, or a platform `sin`,** anywhere a pose is decided. Native and WASM would differ.
- **A track stepped by adding a velocity each tick.** Its error grows with every tick and with the tick rate.
- **Storing the frame twice** (in the pose and in T2's parent), or holding written as a link. They would disagree.
- **Writing −q, or a quaternion not produced by the normalizer.** Two byte forms of one rotation; hashes differ.
- **Micrometres squared in 64 bits.** g·t² overflows after a second; 32-bit micrometres end at 2.1 km.
- **A coarse unit.** At 1,000 ticks a second a millimetre a tick is already 1 m/s.
- **Two owners of one motion** (a slot and a mover, a carrier and the activity). Each would move it.
- **A lever arm far from its frame.** The orientation's 2^-30 step moves a point 10 km out by about 10 µm.
