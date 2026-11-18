//! Moving frames on a track (Engine v2 N12, #2737): a ride on a loop with two stops and a boat line there and back,
//! each E23's moving group (`v2/docs/moving-group.md`).
//!
//! `cargo test -p sim --test tracks -- --nocapture` prints the lap's effect list (A1), the two runs and the replay
//! compared (A2), E23's check on both groups (A3), the queue at the boarding link (A4) and the stop check (A5).

use replica::effects::TransferRec;
use replica::group::{Belonging, Scene as Groups};
use replica::ids::{Id, Scope};
use replica::pose::{Frame, HandOff, Movable, Owner, Pose, Quat, Scene, Support, Track, Vec3};
use replica::time::Micros;
use replica::world_model::show;
use sim::ground::Piece;
use sim::links::boarding::{Boarding, CROSSING};
use sim::links::turns::{Facts, Turn, Turns};
use sim::mover::Surface;
use sim::tracks::{Course, Shape, Station, Table, group};
use std::collections::BTreeMap;

const TICK: Micros = 50_000;
const SCOPE: Scope = Scope([0x27; 16]);

fn id(n: u64) -> Id {
    Id::new(SCOPE, n).unwrap()
}

const WORLD: u64 = 1;
const GROUND: u64 = 2;
const RIDE: u64 = 3;
const BODY: u64 = 4;
const LINK: u64 = 5;

/// The ride: a 40 m by 30 m loop at 3 m/s, stopping 20 s at its first corner and 10 s at its third; a stop is
/// always within 60 s.
fn ride_course() -> Course {
    let st = |x: i64, z: i64, dwell: Micros| Station {
        at: Vec3::new(x, 0, z),
        dwell,
    };
    Course {
        stations: vec![
            st(0, 0, 20_000_000),
            st(40_000_000, 0, 0),
            st(40_000_000, 30_000_000, 10_000_000),
            st(0, 30_000_000, 0),
        ],
        shape: Shape::Loop,
        speed: 3_000_000,
        t0: 0,
        within: 60_000_000,
    }
}

/// The ground under the whole loop and its stops: one rectangle at height 0, mm.
fn ground() -> Surface {
    Surface::new(
        id(GROUND),
        vec![Piece {
            outline: vec![vec![
                [-10_000, 0, -10_000],
                [50_000, 0, -10_000],
                [50_000, 0, 40_000],
                [-10_000, 0, 40_000],
            ]],
            vertices: vec![
                [-10_000, 0, -10_000],
                [50_000, 0, -10_000],
                [50_000, 0, 40_000],
                [-10_000, 0, 40_000],
            ],
            triangles: vec![[0, 2, 1], [0, 3, 2]],
        }],
    )
}

fn root() -> Frame {
    Frame {
        node: id(WORLD),
        slot: None,
    }
}

fn on_ground() -> Frame {
    Frame {
        node: id(GROUND),
        slot: None,
    }
}

fn ground_movable() -> Movable {
    Movable {
        id: id(GROUND),
        pose: Pose {
            frame: root(),
            position: Vec3::ZERO,
            orientation: Quat::IDENTITY,
            support: Support::None,
        },
        owner: Owner::Track(Track::Rest),
        linear: Vec3::ZERO,
        angular: Vec3::ZERO,
        slots: BTreeMap::new(),
    }
}

/// The body, standing at the boarding link's ground end beside stop 0.
fn body_movable() -> Movable {
    Movable {
        id: id(BODY),
        pose: Pose {
            frame: on_ground(),
            position: Vec3::new(-800_000, 0, 0),
            orientation: Quat::IDENTITY,
            support: Support::Surface {
                surface: id(GROUND),
                height: 0,
            },
        },
        owner: Owner::Mover,
        linear: Vec3::ZERO,
        angular: Vec3::ZERO,
        slots: BTreeMap::new(),
    }
}

/// The scene at `t` as read from what is stored: the ground, the moving node from its formula, the body's record.
fn scene_at(table: &Table, body: &Movable, t: Micros) -> Scene {
    let ride = table
        .movable(
            id(RIDE),
            root(),
            Support::Surface {
                surface: id(GROUND),
                height: 0,
            },
            Quat::IDENTITY,
            BTreeMap::from([(1, Vec3::ZERO)]),
            t,
        )
        .unwrap();
    Scene::new(id(WORLD), vec![ground_movable(), ride, body.clone()]).unwrap()
}

fn boarding() -> Boarding {
    Boarding {
        id: id(LINK),
        frame: id(RIDE),
        station: 0,
        slot: 1,
        ground: id(GROUND),
        width: 800_000,
    }
}

/// One record the lap wrote: a turn of the boarding link, or a crossing's hand-off and its leave and arrive.
#[derive(Clone, Debug, PartialEq)]
enum Effect {
    Turn(Turn),
    Cross(Box<(HandOff, [TransferRec; 2])>),
}

/// One tick read back: world time, the moving node's position and the body's, in the root frame.
type Sample = (Micros, Vec3, Vec3);

struct Lap {
    effects: Vec<(Micros, Effect)>,
    samples: Vec<Sample>,
    /// The body's stored record at each tick.
    stored: Vec<Movable>,
}

/// The lap: the body reaches the link at 30 s, while the node is away; it waits, is granted the crossing when the
/// node stops, boards, asks to leave once the node has left the far stop, and is let off back at stop 0.
fn run_lap() -> Lap {
    let table = ride_course().load().unwrap();
    let link = boarding();
    let ground = ground();
    let mut turns = Turns::new();
    let mut body = body_movable();
    let (mut effects, mut samples, mut stored) = (Vec::new(), Vec::new(), Vec::new());
    let (mut seen, mut transfers) = (0, 100);
    let mut cross_at: Option<Micros> = None;
    let mut want = Want::On;
    let mut t = 30_000_000;
    while want != Want::Done {
        assert!(t < 30_000_000 + 3 * table.period, "the lap did not end");
        // A grant written last tick is taken now: the crossing.
        if cross_at == Some(t) {
            let mut scene = scene_at(&table, &body, t);
            transfers += 1;
            let (h, r) = if want == Want::On {
                want = Want::Riding;
                link.board(
                    &mut scene,
                    &table,
                    id(BODY),
                    t,
                    id(transfers),
                    SCOPE,
                    id(WORLD),
                )
                .unwrap()
            } else {
                want = Want::Done;
                let (_, h, r) = link
                    .alight(
                        &mut scene,
                        &table,
                        id(BODY),
                        &ground,
                        on_ground(),
                        t,
                        id(transfers),
                        SCOPE,
                        id(WORLD),
                    )
                    .unwrap();
                (h, r)
            };
            body = scene.get(id(BODY)).unwrap().clone();
            effects.push((t, Effect::Cross(Box::new((h, r)))));
            cross_at = None;
        }
        // The rider asks to leave once the node stands at its far stop; it is let off at the link's stop.
        if want == Want::Riding && table.stopped(t).unwrap().is_some_and(|s| s.station == 2) {
            want = Want::Off;
        }
        // The facts of the last tick: who waits at each end, by its own choice. No time or condition is in them.
        let mut f = Facts {
            room: [true, true],
            ..Facts::default()
        };
        match want {
            Want::On => f.waiting[0].push((0, id(BODY))),
            Want::Off => f.waiting[1].push((0, id(BODY))),
            Want::Riding | Want::Done => {}
        }
        link.write(&mut turns, &table, &f, t).unwrap();
        let timeline = turns
            .state(&link.link())
            .map(|s| s.timeline.clone())
            .unwrap_or_default();
        for turn in &timeline[seen..] {
            if matches!(turn, Turn::Grant { who, .. } if *who == id(BODY)) {
                cross_at = Some(t + TICK);
            }
            effects.push((t, Effect::Turn(*turn)));
        }
        seen = timeline.len();
        let scene = scene_at(&table, &body, t);
        let p = |n| scene.motion(id(n), t).unwrap().0.position;
        samples.push((t, p(RIDE), p(BODY)));
        stored.push(body.clone());
        t += TICK;
    }
    Lap {
        effects,
        samples,
        stored,
    }
}

/// What the body wants of the link, by its own choice.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Want {
    On,
    Riding,
    Off,
    Done,
}

/// A1 and A4: the body waits while the node is away, crosses when it stops, rides a lap and gets off; nothing is
/// written while the node moves.
#[test]
fn a1_a4_board_ride_a_lap_and_alight_with_no_per_tick_write() {
    let table = ride_course().load().unwrap();
    let lap = run_lap();
    println!(
        "A1: the lap's effect list ({} ticks of 50 ms read):",
        lap.samples.len()
    );
    for (t, e) in &lap.effects {
        let stop = table.stopped(*t).unwrap();
        match e {
            Effect::Turn(Turn::Grant { who, end, .. }) => {
                println!(
                    "  {t:>11} us  turn  grant {} from end {end}  (stopped: {stop:?})",
                    show(*who)
                )
            }
            Effect::Turn(turn) => println!("  {t:>11} us  turn  {turn:?}  (stopped: {stop:?})"),
            Effect::Cross(c) => {
                let (h, r) = (&c.0, &c.1);
                println!(
                    "  {t:>11} us  cross {} into {} slot {:?}, owner {:?}, velocity {:?}; leave and arrive under one id: {}  (stopped: {stop:?})",
                    show(h.node),
                    show(h.pose.frame.node),
                    h.pose.frame.slot,
                    h.to,
                    h.linear,
                    matches!((&r[0], &r[1]), (TransferRec::Leave { transfer: a, .. }, TransferRec::Arrive { transfer: b, .. }) if a == b),
                )
            }
        }
    }
    // Every grant and crossing is written while the node stands at the link's stop: none while it moves. The link's
    // turn changes are written once each, when a body starts to wait at the other end, never per tick.
    for (t, e) in &lap.effects {
        if !matches!(e, Effect::Turn(Turn::Change { .. })) {
            assert!(
                table.stopped(*t).unwrap().is_some_and(|s| s.station == 0),
                "{e:?} at {t} us while the node is away"
            );
        }
    }
    assert_eq!(
        lap.effects.len(),
        6,
        "two turn changes, two grants, two crossings"
    );
    let crosses: Vec<_> = lap
        .effects
        .iter()
        .filter_map(|(t, e)| match e {
            Effect::Cross(c) => Some((*t, c.0)),
            _ => None,
        })
        .collect();
    assert_eq!(crosses.len(), 2, "on once and off once");
    let (on_t, on) = crosses[0];
    let (off_t, off) = crosses[1];
    assert_eq!(on.to, Owner::Slot);
    assert_eq!(on.pose.frame.node, id(RIDE));
    assert_eq!(off.to, Owner::Mover);
    assert_eq!(off.pose.frame.node, id(GROUND));
    // At a stop the frame is still: stepping off adds no deck speed.
    assert_eq!(off.linear, Vec3::ZERO);
    // A whole lap: on and off at stop 0, past the far stop between.
    assert!(
        lap.samples.iter().any(|s| s.0 > on_t
            && s.0 < off_t
            && table.stopped(s.0).unwrap().is_some_and(|s| s.station == 2)),
        "a whole lap: on at {on_t}, off at {off_t}"
    );
    // While riding, the body's stored record never changes; the frame carries it.
    let riding: Vec<_> = lap
        .samples
        .iter()
        .zip(&lap.stored)
        .filter(|(s, _)| s.0 > on_t && s.0 < off_t)
        .collect();
    let first = riding[0].1;
    let mut moved = 0;
    for ((_, node, body), rec) in &riding {
        assert_eq!(*rec, first, "the rider's record was written");
        assert_eq!(
            *body,
            node.plus(first.pose.position).unwrap(),
            "the rider is where its frame carries it"
        );
        if *node != riding[0].0.1 {
            moved += 1;
        }
    }
    println!(
        "A1: {} ticks riding, {moved} of them with the node moved; the rider's stored record unchanged over all of them",
        riding.len()
    );
    // No teleport: the body steps off where it stepped on, back at the same stop.
    let before = lap.samples.iter().find(|s| s.0 == on_t).unwrap().2;
    let after = lap.samples.iter().find(|s| s.0 == off_t).unwrap().2;
    assert_eq!(before, after);

    // No teleport: a crossing while the node is away is refused, and nobody moves.
    let mut away = scene_at(&table, &body_movable(), 30_000_000);
    let r = boarding()
        .board(
            &mut away,
            &table,
            id(BODY),
            30_000_000,
            id(99),
            SCOPE,
            id(WORLD),
        )
        .unwrap_err();
    assert_eq!(r.name, "boarding-frame-away");
    assert_eq!(away.get(id(BODY)).unwrap(), &body_movable());

    // A4: the body reached the link at 30 s, while the node was away; it was granted the crossing when the node
    // stopped at the link's station, and not before.
    let arrive = 30_000_000;
    assert!(
        table.stopped(arrive).unwrap().is_none(),
        "away when the body arrives"
    );
    let grant = lap
        .effects
        .iter()
        .find_map(|(t, e)| matches!(e, Effect::Turn(Turn::Grant { .. })).then_some(*t))
        .unwrap();
    let stop_start = (arrive..)
        .step_by(TICK as usize)
        .find(|&t| table.stopped(t).unwrap().is_some_and(|s| s.station == 0))
        .unwrap();
    println!(
        "A4: the body waits at the link from {arrive} us; the node stops there at {stop_start} us; granted at {grant} us; on at {on_t} us; {} us of the dwell left at the crossing (at least {CROSSING})",
        table.stopped(on_t).unwrap().unwrap().left
    );
    assert_eq!(
        grant, stop_start,
        "granted on the tick the node stops, not before"
    );
    assert!(table.stopped(on_t).unwrap().unwrap().left >= CROSSING - TICK);
}

/// A2: two runs and a replay from the effect list give the same node and rider positions, to the micrometre.
#[test]
fn a2_two_runs_and_a_replay_agree() {
    let (one, two) = (run_lap(), run_lap());
    assert_eq!(one.samples, two.samples);
    assert_eq!(one.effects, two.effects);
    // The replay: the body's record rebuilt from the crossings alone, and the node from its loaded table, read at
    // the same times, with no step in between. A restart at any of these ticks reads the same.
    let table = ride_course().load().unwrap();
    let mut body = body_movable();
    let mut crossings = one.effects.iter().filter_map(|(t, e)| match e {
        Effect::Cross(c) => Some((*t, c.0)),
        _ => None,
    });
    let mut next = crossings.next();
    let mut replayed = Vec::new();
    for &(t, _, _) in &one.samples {
        if let Some((at, h)) = next
            && at == t
        {
            body.pose = h.pose;
            body.owner = h.to;
            body.linear = h.linear;
            body.angular = h.angular;
            next = crossings.next();
        }
        let scene = scene_at(&table, &body, t);
        let p = |n| scene.motion(id(n), t).unwrap().0.position;
        replayed.push((t, p(RIDE), p(BODY)));
    }
    assert_eq!(replayed, one.samples);
    println!(
        "A2: {} samples; run 1, run 2 and the replay equal to the micrometre; last {:?}",
        one.samples.len(),
        one.samples.last().unwrap()
    );
}

/// The boat line: a node that runs between two landings 60 m apart at 2 m/s, standing 15 s at each.
fn boat_line() -> Course {
    Course {
        stations: vec![
            Station {
                at: Vec3::new(0, 0, 0),
                dwell: 15_000_000,
            },
            Station {
                at: Vec3::new(60_000_000, 0, 0),
                dwell: 15_000_000,
            },
        ],
        shape: Shape::ThereAndBack,
        speed: 2_000_000,
        t0: 0,
        within: 30_000_000,
    }
}

/// A3: the ride and a boat line are E23's moving group with E23's types, and E23's check passes on both.
#[test]
fn a3_the_ride_and_a_boat_line_are_e23_groups() {
    let table = boat_line().load().unwrap();
    // The line runs there, stands, and back: at 52.5 s it is halfway back.
    assert_eq!(
        table
            .at(15_000_000 + 30_000_000 + 15_000_000 + 15_000_000)
            .unwrap()
            .0,
        Vec3::new(30_000_000, 0, 0)
    );
    let lap = run_lap();
    let rider = lap
        .stored
        .iter()
        .find(|m| m.pose.frame.node == id(RIDE))
        .unwrap();
    let (line, a, b) = (id(10), id(11), id(12));
    let mut parents = BTreeMap::new();
    parents.insert(id(RIDE), id(WORLD));
    parents.insert(rider.id, rider.pose.frame.node);
    parents.insert(line, id(WORLD));
    parents.insert(a, line);
    parents.insert(b, line);
    let groups = Groups {
        parents,
        groups: vec![
            group(id(RIDE), &[rider.id], 1_000_000, 750_000),
            group(line, &[a, b], 3_000_000, 1_200_000),
        ],
    };
    groups.check().unwrap();
    for g in &groups.groups {
        assert!(
            g.members
                .iter()
                .all(|m| m.belongs == Belonging::Rider && !m.steers)
        );
        println!(
            "A3: group {} with {} riders passes E23's check, steered by {}",
            show(g.node),
            g.members.len(),
            g.steerer().unwrap()
        );
    }
    // E23's check refuses a rider that also steers, and a rider whose parent is not the node.
    let mut two = groups.clone();
    two.groups[1].members[0].steers = true;
    assert_eq!(two.check().unwrap_err().name, "group-two-steerers");
    let mut away = groups.clone();
    away.parents.insert(a, id(WORLD));
    assert_eq!(away.check().unwrap_err().name, "member-two-parents");
}

/// A5: a track with no stop reached within its stated time is refused by name at load.
#[test]
fn a5_a_track_without_a_stop_within_its_time_is_refused() {
    let mut far = ride_course();
    far.within = 20_000_000;
    let r = far.load().unwrap_err();
    println!("A5: {}: {}", r.name, r.detail);
    assert_eq!(r.name, "track-no-stop-within");
    let mut none = boat_line();
    for s in &mut none.stations {
        s.dwell = 0;
    }
    let r = none.load().unwrap_err();
    println!("A5: {}: {}", r.name, r.detail);
    assert_eq!(r.name, "track-no-stop-within");
    let ok = ride_course().load().unwrap();
    println!(
        "A5: the ride's lap is {} us; its stops are within {} us",
        ok.period,
        ride_course().within
    );
}
