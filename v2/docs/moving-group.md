# One moving group

Engine v2 E23 (#2736). The one mechanism behind carrying together (B9, B14), pushing and wheeling (E5), walking
together (E9), driven vehicles (E12) and rides (N12): several bodies and things move as one, each keeping its place,
with one of them steering. Those six tasks build on this page and define no group of their own. Code:
`v2/crates/replica/src/group/` (types, the check, the fixtures and their tests). It rests on T2
([world-model.md](world-model.md)), T4 ([pose.md](pose.md)), T1 ([zones.md](zones.md)) and B5's joint activities.

## The group

1. **A group is a node whose frame moves, with one owner of its motion** (T4 rule 7): its own mover, or a track (a
   ride). For carrying, pushing and walking together the node is the joint activity's (B5); for a vehicle or a ride
   it is the thing itself. **A group is not a record.** It is read from what is already stored: the node, its
   children, the member links to it and its kind. Nothing about it is stored twice.
2. **A rider** is the group's child at a fixed pose: a carried or pushed load, a body in a vehicle's slot, a body on
   a ride. Its T2 parent is the group's node and its owner is the slot, so it moves with the frame and nothing writes
   it while the group moves. Things on a rider (contents of a pushed thing) are the rider's children, not members.
3. **A walker** is linked to the group's node (B5's membership link, `souls:member`, when the group is an activity),
   keeps its own parent and its own mover, and steers toward its **place**, a point in the group's frame. The place
   is a target, never a constraint. A walker is never the group's child: its pose would be rewritten on every step
   (`walker-is-child`).
4. **Nothing has two parents** (T2 rule 2). A carried load is the activity's child and its carriers are linked; it is
   in nobody's hand slot. A rider whose parent is not the group's node, or a rider of two groups, is refused as
   `member-two-parents`.
5. **Joining is consent.** A body becomes a walker only through B5's join, and a rider only by its own boarding or
   sitting (or, for a thing, by being put there). Being near a group never makes anyone a member.

## The steerer

6. **Exactly one steerer.** A walker that steers is the **leader**: the frame follows its own walk. A rider that
   steers is the **driver**: its intents route the frame, not its body. Or the group's **track** owns the frame and
   no member steers. Two are refused as `group-two-steerers`, none as `group-no-steerer`. The steerer is a role of
   the activity, the occupant of the kind's drive slot, or the track; never a field naming another body.

## The outline

7. **The outline is what the route check sweeps** before the first step: **rigid**, a footprint in the group's frame
   (half its length and half its width, in µm) swept along the route, members included; or **loose**, the walkers'
   own bodies, who fall into single file in member order at a narrow place and open out after it.

## Leaving

8. **A Soul leaves a group whenever it chooses; a leave is always accepted.** The kind states what follows, and a
   group whose kind states nothing is refused as `group-no-leave-rule`:
   - **close up**: the rest close up and go on (walking together);
   - **stop and set down**: the group stops, and what it moves is set down where it stands, one change of parent to
     the node it is in, at rest (carrying, pushing). A carry lowers its load there on a short track of its node first
     (#5067, `sim::activity::carry::Hoist`), so the change of parent happens where the load already is; a lift is the
     same track upward, from where the load lay;
   - **at a stop**: the leaver is let go at the next stop, which the kind states is reached within a bounded time
     (vehicles, rides). Getting on and off is a link to the ground beside it, usable while it stands still.

## Across edges and restarts

9. **A group crossing a node's edge is one paired transfer** for its node (T1), never one per member: riders go with
   their parent; walkers cross as themselves.
10. **A group survives a restart as nodes and links.** Its skills are handed their intents again (K13); no skill state
    is stored.

## The fixtures, and the six tasks

The check (`Scene::check`) refuses, group by group: `group-no-leave-rule`, `group-two-steerers`, `group-no-steerer`,
`member-two-parents`, `walker-is-child`. The five fixtures pass it.

| Fixture | Riders | Walkers | Steerer | Outline | Leaving | Tasks, and what differs |
|---|---|---|---|---|---|---|
| `carried-load` | the 2 m load | two carriers at its ends | leader (front) | rigid 3.3 × 0.56 m | stop and set down | **B9**: as is. **B14**: the same group; the load's pose along the route is searched at planning and the carriers' places follow from it (they swing about their grips) |
| `pushed-thing` | the thing | the pusher, behind its grip | leader | rigid 2.7 × 0.9 m | stop and set down | **E5**: one walker; the grip is a point of the kind; wheeled is the same at a higher speed, its contents the thing's children |
| `pair-side-by-side` | none | two, 0.4 m each side | leader | loose | close up | **E9**: places beside or behind by number; single file at a narrow link; the leader slows for the slowest, never stops |
| `rowed-with-passenger` | rower (drive slot), passenger | none | driver | rigid 3 × 1.2 m | at a stop | **E12**: the group is the vehicle; its mover runs on its own kind of region (water, or ground without stairs) |
| `ride-on-track` | one body | none | track | rigid 2 × 1.5 m | at a stop | **N12**: the track is a formula of world time; riders' stored poses never change while it moves; boarding waits for the stop |

**Walking hand in hand (0.135 R1)** is `pair-side-by-side` for a hold of two: the first member to walk leads, and the
other walks to its place, the width of the kind's two stands to the side it stood on, square to the way the leader
last walked, by its own `souls:follow` order with a place beside (`skills::close::Follow::beside`). The place is a
target: a walker more than 1.5 m from it for 2 s lets go (`souls:follow-lost-place`). Its leave rule is the hold's:
either member's leave, the other's own walk or act, or a restart (moves are not stored) ends it for both.

**Carrying together** is `carried-load` with every carrier a walker: when a lifted carry's front walks, it leads,
and every other carrier that is not moving on its own (no move, no order of its own) walks with it by its own
`souls:follow` order, keeping its place in the carry's frame as an offset from the front on the plan (parameter 4,
`[x, z]` µm, `skills::close::Follow::at`): the back the carry's span behind the front, a side where it stood at the
lift or take (worldd's `keep_carry_orders`, the engine's `carry_follows`). So one walk moves the crew: separate agents
need not set off within the 0.7 s a 1 m stretch allows.

**The crew turns with its front.** A front's walk that names the carry's heading at its goal (the walk's parameter 3,
`[x, z]`, from the back toward the front: the client's `carry to <crew> <bay> <slot>` and `carry to <crew> the loading
spot` send it, so a load goes into a slot or a bay square), or that goes to a pose of the way a lift found (0.135 R2:
its front within 0.1 m of the walk's goal), turns the group: each order also names the goal and the place's offset there
(parameter 5, `[goal x, goal z, x, z]`, `Follow::turning`), and the place swings about the front by the share of the way
to the goal the front has walked, keeping its length, at most a jog's pace along its chord (`skills::close::SWING`), so
a large turn on a short walk is a pivot that goes on after the front stops; the carrier is fed its place's own pace, so
it keeps up as the place swings. A walk that ends short of its goal (a granted spot) finishes its turn where the front
stands, the same way. A front's new walk takes the places again when it or the walk before turns the crew; a straight
one keeps them. The turn's sweep is not checked before it starts: each step is C7's check, so a load swung into a post
is set down there (`souls:carry-blocked`). A walk that names no heading and goes to no pose leaves the load turned as it
is.


A carrier's own act takes its legs back (B2) and it walks its own way, still in the carry, as before (a late carrier's
own `carry to` does not fight the group); once its own walk ends while the front's still goes, it stays where it chose
(a scripted crew's carrier that arrives first is not dragged on past its place), and no turn of that walk moves it: it
takes its place again at the front's next walk, where the carry's frame has it then, turned as the frame is. The leave
rule is the carry's: a side's leave with the load's crew left closes up, its order cancelled; a carry that breaks off
(`souls:partner-left`, `souls:carriers-apart`, `souls:carry-blocked`) stops the front's walk with that reason and
cancels the walkers' orders, so the whole group stops with one reason. A restart sets the load down (C3) and cancels the
orders.


**Others keep apart from a carried load.** The walkers' map learns where a load rests only when it is set down or
seated, so while it is carried it stands among the bodies a walker keeps apart from (`sim::host::Carried`, the route
skill's `Ask::Near`): points across its outline as held, at most 0.4 m apart and drawn in a walker's own space from
its edge, moving with it, so a walker never passes between them and goes round it as round a row of standing bodies.
Its own carriers do not see it.

No task needs a seventh idea: each is one of these with its own data (places, outline, speed, region, stops).

## What would quietly break this

- **A walker made the group's child.** The group would rewrite its pose each step and its mover would fight it.
- **A load in a carrier's hand and in the group.** Two parents: the hand and the frame would each move it.
- **A second steerer.** A leader and a driver, or a member and a track, would each route the frame.
- **A group stored as its own record.** It would disagree with the tree and links it is read from.
- **Per-member transfers at an edge.** A frame half in one zone and half in another.
- **A group that holds a leaver.** Gene's rule: a Soul leaves whenever it chooses.
