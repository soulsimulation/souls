//! Close quarters (Engine v2 N13, #2723): step, circle, go near and follow, each a skill whose only way to move the
//! body is a controller input (B1). The bodies here are moved by `sim`'s controller stepping N6's mover, on a flat
//! ground with an edge (A1, A3) and on N2's test world (A2); the follow's fall-back runs against a fake host (A4).
//!
//! `cargo test -p sim --release --test close -- --nocapture` prints the step's input records and end, and the
//! follow's distance over time.

use std::collections::{BTreeMap, BTreeSet};

use replica::bodies::{Class, Family, Resource, SkillShape, Want};
use replica::effects::{Change, Event, Refusal};
use replica::encode::Name;
use replica::host::{Answer, Ask, Host, Progress, Seen, Skill};
use replica::ids::{Id, Scope};
use replica::pose::{ControllerInput, Frame, Mode, Quat, Vec3};
use replica::time::Micros;
use sim::controller::{Controller, Driver, Part};
use sim::ground::{HUMAN_RADIUS, OpenGround, Piece, Scene};
use sim::mover::Surface;
use skills::close::{Circle, FELL_BACK, Follow, Near, SPEED, Side, Step, THERE, Target, WALLED};

const TICK: Micros = 50_000;

fn name(t: &str) -> Name {
    Name::new(t).expect("a name")
}

fn id(n: u64) -> Id {
    Id::new(Scope([0x13; 16]), n).expect("an id")
}

fn humanoid() -> Family {
    let r = |n: &str, class, slot| Resource {
        name: name(n),
        class,
        slot,
    };
    Family {
        name: name("souls:humanoid"),
        resources: vec![
            r("souls:leg-left", Class::Locomotion, None),
            r("souls:leg-right", Class::Locomotion, None),
            r("souls:hand-left", Class::Manipulator, Some(1)),
            r("souls:hand-right", Class::Manipulator, Some(2)),
        ],
    }
}

/// A script driver's claim: all the legs; nothing cancels it.
fn script() -> SkillShape {
    SkillShape {
        name: name("test:script"),
        claims: vec![Want::All(Class::Locomotion)],
        blocks: Vec::new(),
        cancelled_by: Vec::new(),
    }
}

/// Flat ground from x = -20 m to x = +2 m (its edge, a wall), z from -20 m to 20 m.
fn edged() -> (Id, Surface) {
    let g = id(1);
    let corners = vec![
        [-20_000, 0, -20_000],
        [2_000, 0, -20_000],
        [2_000, 0, 20_000],
        [-20_000, 0, 20_000],
    ];
    let piece = Piece {
        outline: vec![corners.clone()],
        vertices: corners,
        triangles: vec![[0, 2, 1], [0, 3, 2]],
    };
    (g, Surface::new(g, vec![piece]))
}

/// The bodies, the controller that alone moves them, and what the skills did through the host.
struct World {
    c: Controller,
    surfaces: BTreeMap<Id, Surface>,
    now: Micros,
    /// Per body: route searches asked, nodes read, events emitted, controller refusals.
    asks: BTreeMap<Id, u32>,
    reads: BTreeMap<Id, BTreeSet<Id>>,
    events: Vec<(Id, Name)>,
    refused: Vec<(Id, &'static str)>,
}

impl World {
    fn new(ground: Id, surface: Surface) -> World {
        World {
            c: Controller::new(),
            surfaces: BTreeMap::from([(ground, surface)]),
            now: 0,
            asks: BTreeMap::new(),
            reads: BTreeMap::new(),
            events: Vec::new(),
            refused: Vec::new(),
        }
    }

    /// A humanoid standing at (`x`, `z`) mm on `ground`.
    fn place(&mut self, ground: Id, body: Id, x: i64, z: i64) {
        let frame = Frame {
            node: ground,
            slot: None,
        };
        let b = self.surfaces[&ground]
            .place(
                body,
                frame,
                Vec3::new(x * 1000, 0, z * 1000),
                Quat::IDENTITY,
            )
            .unwrap_or_else(|r| panic!("{}: {}", r.name, r.detail));
        self.c.add(humanoid(), b).expect("added");
    }

    fn at(&self, body: Id) -> Vec3 {
        self.c.body(body).expect("a body").pose.position
    }

    fn tick(&mut self) {
        let stepped = self.c.step(&self.surfaces, TICK, self.now);
        assert!(stepped.refused.is_empty(), "{:?}", stepped.refused);
        self.now += TICK;
    }
}

/// The host a skill sees: reads from the controller's bodies as they stood at the tick's start (its own body as of
/// this tick, every other as of the previous one), and its one write, a controller input under its driver.
struct H<'a> {
    w: &'a mut World,
    body: Id,
    driver: Driver,
}

impl Host for H<'_> {
    fn now(&self) -> Micros {
        self.w.now
    }
    fn body(&self) -> Id {
        self.body
    }
    fn read(&self, node: Id) -> Option<Seen> {
        let b = self.w.c.body(node)?;
        Some(Seen {
            id: node,
            kind: name("souls:body"),
            parent: Some(b.pose.frame.node),
            position: b.pose.position,
            fields: BTreeMap::new(),
        })
    }
    fn ask(&self, _q: &Ask) -> Option<Answer> {
        // No route here: [`Counting`] counts every ask, and A1 to A3 want none.
        None
    }
    fn set_timer(&mut self, _after: Micros, _name: Name) -> Id {
        self.body
    }
    fn clear_timer(&mut self, _timer: Id) {}
    fn cross(&mut self, _link: Id, _speed: i64) {}
    fn draw(&mut self) -> u64 {
        0
    }
    fn control(&mut self, input: ControllerInput) {
        if let Err(r) = self.w.c.set(
            self.body,
            self.driver,
            Part::Velocity(input.velocity, input.mode),
        ) {
            self.w.refused.push((self.body, r.name));
        }
    }
    fn emit(&mut self, _changes: Vec<Change>, meaning: Option<Event>) -> Result<(), Refusal> {
        if let Some(e) = meaning {
            self.w.events.push((self.body, e.name));
        }
        Ok(())
    }
}

/// A host that counts what it is asked and what is read, around [`H`].
struct Counting<'a> {
    h: H<'a>,
    asks: std::cell::Cell<u32>,
    reads: std::cell::RefCell<BTreeSet<Id>>,
}

impl Host for Counting<'_> {
    fn now(&self) -> Micros {
        self.h.now()
    }
    fn body(&self) -> Id {
        self.h.body()
    }
    fn read(&self, node: Id) -> Option<Seen> {
        self.reads.borrow_mut().insert(node);
        self.h.read(node)
    }
    fn ask(&self, q: &Ask) -> Option<Answer> {
        self.asks.set(self.asks.get() + 1);
        self.h.ask(q)
    }
    fn set_timer(&mut self, after: Micros, name: Name) -> Id {
        self.h.set_timer(after, name)
    }
    fn clear_timer(&mut self, timer: Id) {
        self.h.clear_timer(timer)
    }
    fn cross(&mut self, link: Id, speed: i64) {
        self.h.cross(link, speed)
    }
    fn draw(&mut self) -> u64 {
        self.h.draw()
    }
    fn control(&mut self, input: ControllerInput) {
        self.h.control(input)
    }
    fn emit(&mut self, changes: Vec<Change>, meaning: Option<Event>) -> Result<(), Refusal> {
        self.h.emit(changes, meaning)
    }
}

impl World {
    /// [`World::skill`], counting route searches and reads.
    fn counted(&mut self, body: Id, driver: Driver, s: &mut dyn Skill) -> Progress {
        let mut c = Counting {
            h: H {
                w: self,
                body,
                driver,
            },
            asks: std::cell::Cell::new(0),
            reads: std::cell::RefCell::new(BTreeSet::new()),
        };
        let p = s.step(&mut c);
        let (asks, reads) = (c.asks.get(), c.reads.into_inner());
        *self.asks.entry(body).or_default() += asks;
        self.reads.entry(body).or_default().extend(reads);
        p
    }

    /// Runs `s` on `body` from a fresh claim until it ends or `most` ticks pass: how it ended, and the ticks.
    fn run(&mut self, body: Id, s: &mut dyn Skill, most: u32) -> (Progress, u32) {
        let d = self.c.claim(body, &s.shape()).expect("claimed");
        for n in 1..=most {
            let p = self.counted(body, d, s);
            self.tick();
            if p != Progress::Going {
                self.c.release(body, d).expect("released");
                return (p, n);
            }
        }
        (Progress::Going, most)
    }

    /// How many input records the controller logged for `body`.
    fn records(&self, body: Id) -> usize {
        self.c.log().iter().filter(|l| l.body == body).count()
    }
}

fn mm(v: Vec3) -> (i64, i64) {
    (v.x / 1000, v.z / 1000)
}

fn apart(a: Vec3, b: Vec3) -> i64 {
    let (dx, dz) = ((a.x - b.x) as f64, (a.z - b.z) as f64);
    (dx * dx + dz * dz).sqrt() as i64
}

#[test]
fn a1_a_step_is_one_input_that_moves_the_stated_distance_and_ends_and_a_step_into_a_wall_ends_short()
 {
    let (g, s) = edged();
    let mut w = World::new(g, s);
    let b = id(10);
    w.place(g, b, -5_000, 0);

    // One step: 1.5 m along (3, 4).
    let start = w.at(b);
    let mut step = Step::new(Vec3::new(3, 0, 4), 1_500_000);
    let (end, ticks) = w.run(b, &mut step, 400);
    let at = w.at(b);
    let (dx, dz) = (at.x - start.x, at.z - start.z);
    println!(
        "step 1.5 m along (3, 4): ended {end:?} after {ticks} ticks, moved ({dx}, {dz}) um = {} um; \
         input records {}, velocity at the end {:?}",
        apart(at, start),
        w.records(b),
        w.c.input(b).expect("an input").velocity
    );
    assert_eq!(end, Progress::Done);
    assert!((dx - 900_000).abs() <= THERE && (dz - 1_200_000).abs() <= THERE);
    assert_eq!(w.c.input(b).expect("an input").velocity, Vec3::ZERO);

    // Straight into the edge at x = +2 m: 10 m asked from x = -1 m, ends short, by name, where it stands.
    let mut w2 = World::new(g, edged().1);
    w2.place(g, b, -1_000, 0);
    let mut into = Step::new(Vec3::new(1, 0, 0), 10_000_000);
    let (end, ticks) = w2.run(b, &mut into, 400);
    let at = w2.at(b);
    println!(
        "step 10 m into the wall: ended {end:?} after {ticks} ticks at {:?} mm",
        mm(at)
    );
    assert_eq!(end, Progress::Failed(name(WALLED)));
    assert!(
        at.x <= 2_000_000 && at.x >= 1_900_000 && at.z == 0,
        "{at:?}"
    );

    // At a slant into the edge: it ends short, by name, and does not walk on along it.
    let mut w3 = World::new(g, edged().1);
    w3.place(g, b, 0, 0);
    let mut slant = Step::new(Vec3::new(1, 0, 1), 10_000_000);
    let (end, ticks) = w3.run(b, &mut slant, 400);
    let at = w3.at(b);
    println!(
        "step 10 m at 45 degrees into the wall: ended {end:?} after {ticks} ticks at {:?} mm; slid {} um past the line",
        mm(at),
        at.z - at.x
    );
    assert_eq!(end, Progress::Failed(name(WALLED)));
    // At most one tick's move along the wall (SPEED x TICK = 70 mm), then it stands.
    assert!(at.z - at.x <= SPEED * TICK / 1_000_000, "{at:?}");
    let still = w3.at(b);
    w3.tick();
    assert_eq!(w3.at(b), still, "it stands where it ended");
    assert!(
        w.asks
            .values()
            .chain(w2.asks.values())
            .chain(w3.asks.values())
            .all(|n| *n == 0)
    );
}

#[test]
fn a3_circle_go_near_and_follow_end_only_when_replaced_cancelled_or_expired_and_keep_their_target()
{
    let (g, s) = edged();
    let mut w = World::new(g, s);
    let (b, other, third) = (id(10), id(11), id(12));
    w.place(g, b, -10_000, 0);
    w.place(g, other, -10_000, 3_000);
    w.place(g, third, -12_000, -3_000);
    let lead =
        w.c.claim(other, &script())
            .expect("a script on the other body");
    let third_d = w.c.claim(third, &script()).expect("a script on the third");

    // The other body walks off, east and back, for each input; the third stands near the body all the while, a
    // closer node a skill could switch to and must not.
    let mut inputs: Vec<(&str, Box<dyn Skill>)> = vec![
        (
            "circle",
            Box::new(Circle::new(Target::Node(other), Side::Left, None)),
        ),
        (
            "go near",
            Box::new(Near {
                target: Target::Node(other),
                distance: 1_000_000,
                until: None,
            }),
        ),
        (
            "follow",
            Box::new(Follow::new(other, (1_000_000, 3_000_000), None)),
        ),
    ];
    for (what, s) in inputs.iter_mut() {
        let d = w.c.claim(b, &s.shape()).expect("claimed");
        let mut going = 0;
        // 60 s; the other body walks east for 4 s every 10 s, then back.
        for n in 0..1_200u32 {
            let v = match n % 200 {
                0..=79 => 1_000_000,
                100..=179 => -1_000_000,
                _ => 0,
            };
            w.c.set(
                other,
                lead,
                Part::Velocity(Vec3::new(v, 0, 0), Mode::Surface),
            )
            .expect("the script");
            w.c.set(third, third_d, Part::Velocity(Vec3::ZERO, Mode::Surface))
                .expect("the script");
            if w.counted(b, d, s.as_mut()) == Progress::Going {
                going += 1;
            }
            w.tick();
        }
        let reads = &w.reads[&b];
        println!(
            "{what}: Going on {going} of 1200 ticks; read {:?}; route searches {}; ends {:?} m apart",
            reads
                .iter()
                .map(|r| replica::world_model::show(*r))
                .collect::<Vec<_>>(),
            w.asks[&b],
            apart(w.at(b), w.at(other)) as f64 / 1e6
        );
        assert_eq!(going, 1_200, "{what} ended by itself");
        assert!(
            reads.iter().all(|r| *r == b || *r == other),
            "{what} read another target"
        );
        // Replaced: a step claims the legs; the controller cancels this input's driver, and its next input is refused.
        let mut step = Step::new(Vec3::new(1, 0, 0), 100_000);
        let s2 =
            w.c.claim(b, &step.shape())
                .expect("the step takes the legs");
        let before = w.refused.len();
        let _ = w.counted(b, d, s.as_mut());
        println!(
            "{what}, replaced by a step: its next input refused {:?}",
            &w.refused[before..]
        );
        assert_eq!(w.refused[before..], [(b, "resource-not-held")]);
        while w.counted(b, s2, &mut step) == Progress::Going {
            w.tick();
        }
        w.c.release(b, s2).expect("released");
    }

    // Cancelled: the body releases it; expired: `until` passes and it stands and ends.
    let mut circle = Circle::new(
        Target::Point(Vec3::new(-10_000_000, 0, 2_000_000)),
        Side::Right,
        None,
    );
    let d = w.c.claim(b, &circle.shape()).expect("claimed");
    for _ in 0..20 {
        assert_eq!(w.counted(b, d, &mut circle), Progress::Going);
        w.tick();
    }
    w.c.release(b, d).expect("cancelled");
    let before = w.refused.len();
    let _ = w.counted(b, d, &mut circle);
    assert_eq!(w.refused[before..], [(b, "resource-not-held")]);
    let mut near = Near {
        target: Target::Point(Vec3::new(-15_000_000, 0, 0)),
        distance: 500_000,
        until: Some(w.now + 5_000_000),
    };
    let (end, ticks) = w.run(b, &mut near, 400);
    println!("go near with until = 5 s: ended {end:?} after {ticks} ticks");
    assert_eq!((end, ticks), (Progress::Done, 101));
    assert!(w.asks.values().all(|n| *n == 0), "{:?}", w.asks);
}

/// The open ground of N2's test world, as the mover walks it, and its node.
fn test_world() -> (Id, Surface) {
    let t = testworld::generate(1, 0).expect("the test world");
    let im = import_eden::load(&t.text).expect("it loads");
    let g = im.nodes["ground"];
    let open = OpenGround::prepare(&Scene::of(&im.tree, g).expect("a scene"), HUMAN_RADIUS)
        .expect("the open ground");
    let pieces = open
        .squares()
        .into_iter()
        .flat_map(|(i, j)| open.cut_square(i, j).pieces)
        .collect();
    (g, Surface::new(g, pieces))
}

#[test]
fn a2_following_a_scripted_leader_for_two_minutes_stays_within_one_to_three_metres() {
    let (g, s) = test_world();
    let mut w = World::new(g, s);
    let (leader, follower) = (id(20), id(21));
    // The hall stands 12 m north of the square, x from -15 m to 15 m, z from 42 m to 82 m (walls 0.2 m outside).
    // The leader goes north from the square, round the hall 1.3 m to 1.5 m off its walls, and back to its front.
    let path: [(i64, i64); 7] = [
        (1_000, 40_300),
        (16_500, 40_300),
        (16_500, 83_700),
        (-16_500, 83_700),
        (-16_500, 40_300),
        (-5_000, 40_300),
        (-5_000, 30_000),
    ];
    w.place(g, leader, 1_000, 20_000);
    w.place(g, follower, 1_000, 15_000);
    let lead = w.c.claim(leader, &script()).expect("the leader's script");
    let mut follow = Follow::new(leader, (1_000_000, 3_000_000), None);
    let d = w.c.claim(follower, &follow.shape()).expect("claimed");
    let mut next = 0;
    let (mut closed, mut worst): (Option<Micros>, (i64, i64)) = (None, (i64::MAX, 0));
    let mut table = Vec::new();
    let mut walked = 0;
    // Two minutes.
    for n in 0..2_400u32 {
        let at = w.at(leader);
        let goal = path
            .get(next)
            .map(|&(x, z)| Vec3::new(x * 1000, 0, z * 1000));
        let v = match goal {
            Some(p) if apart(at, p) < 100_000 => {
                next += 1;
                Vec3::ZERO
            }
            Some(p) => {
                let len = apart(at, p).max(1);
                Vec3::new((p.x - at.x) * SPEED / len, 0, (p.z - at.z) * SPEED / len)
            }
            None => Vec3::ZERO,
        };
        w.c.set(leader, lead, Part::Velocity(v, Mode::Surface))
            .expect("the script");
        let before = w.at(leader);
        assert_eq!(w.counted(follower, d, &mut follow), Progress::Going);
        w.tick();
        walked += apart(before, w.at(leader));
        let gap = apart(w.at(leader), w.at(follower));
        if closed.is_none() && (1_000_000..=3_000_000).contains(&gap) {
            closed = Some(w.now);
        }
        if closed.is_some() {
            worst = (worst.0.min(gap), worst.1.max(gap));
        }
        if n % 20 == 19 {
            table.push(format!("{:>3} s {:.2}", (n + 1) / 20, gap as f64 / 1e6));
        }
    }
    println!("distance over time (s, m):\n{}", table.join("\n"));
    println!(
        "the leader walked {:.1} m along {next} of {} legs; closed to the band at {:.2} s; then between {:.2} m and {:.2} m; \
         route searches {}; refusals {:?}",
        walked as f64 / 1e6,
        path.len(),
        closed.unwrap_or(0) as f64 / 1e6,
        worst.0 as f64 / 1e6,
        worst.1 as f64 / 1e6,
        w.asks[&follower],
        w.refused
    );
    assert!(next >= 5, "the leader went round the hall");
    assert!(walked >= 120 * SPEED * 9 / 10, "two minutes of walking");
    assert!(closed.is_some());
    assert!(worst.0 >= 1_000_000 && worst.1 <= 3_000_000, "{worst:?}");
    assert_eq!(w.asks[&follower], 0, "no route search");
    assert!(w.refused.is_empty());
}

/// A fake host for the fall-back: the leader is where the test says; the follower's own moves are held while a gap
/// it cannot cross lies across its way (an ability the trail needs and it lacks), and the route answers a point.
struct Fake {
    me: Vec3,
    leader: Vec3,
    now: Micros,
    held: bool,
    asks: u32,
    events: Vec<Name>,
}

impl Host for Fake {
    fn now(&self) -> Micros {
        self.now
    }
    fn body(&self) -> Id {
        id(1)
    }
    fn read(&self, node: Id) -> Option<Seen> {
        let position = if node == id(1) { self.me } else { self.leader };
        Some(Seen {
            id: node,
            kind: name("souls:body"),
            parent: Some(id(0)),
            position,
            fields: BTreeMap::new(),
        })
    }
    fn ask(&self, q: &Ask) -> Option<Answer> {
        match q {
            Ask::Toward { .. } => Some(Answer::Point(Vec3::new(0, 0, 4_000_000))),
            Ask::Distance { .. } => None,
            Ask::Near { .. } => None,
        }
    }
    fn set_timer(&mut self, _after: Micros, _name: Name) -> Id {
        id(1)
    }
    fn clear_timer(&mut self, _timer: Id) {}
    fn cross(&mut self, _link: Id, _speed: i64) {}
    fn draw(&mut self) -> u64 {
        0
    }
    fn control(&mut self, input: ControllerInput) {
        let to = Vec3::new(
            self.me.x + input.velocity.x * TICK / 1_000_000,
            0,
            self.me.z + input.velocity.z * TICK / 1_000_000,
        );
        // The gap: x from 0.6 m to 2.5 m, z under 1 m. A move into it is held where it stands.
        self.held = (600_000..=2_500_000).contains(&to.x) && to.z < 1_000_000;
        if !self.held {
            self.me = to;
        }
    }
    fn emit(&mut self, _changes: Vec<Change>, meaning: Option<Event>) -> Result<(), Refusal> {
        self.events.extend(meaning.map(|e| e.name));
        Ok(())
    }
}

#[test]
fn a4_no_input_searches_a_route_but_follows_one_fall_back_which_is_recorded() {
    // The leader went 6 m east, then north: the follower, 0.5 m in, is held (it lacks what the trail needs).
    let mut f = Follow::new(id(2), (1_000_000, 3_000_000), None);
    let mut h = Fake {
        me: Vec3::ZERO,
        leader: Vec3::ZERO,
        now: 0,
        held: false,
        asks: 0,
        events: Vec::new(),
    };
    let mut log = Vec::new();
    for n in 0..600u32 {
        let t = i64::from(n) * TICK;
        // The leader's walk: east at 1.4 m/s to x = 6 m, then north.
        let east = (SPEED * t / 1_000_000).min(6_000_000);
        let north = (SPEED * t / 1_000_000 - 6_000_000).max(0);
        h.leader = Vec3::new(east + 3_000_000, 0, north);
        let asks_before = f.routes;
        assert_eq!(f.step(&mut h), Progress::Going);
        if f.routes != asks_before {
            log.push(format!(
                "{:.2} s: fell back at {:?} mm",
                t as f64 / 1e6,
                mm(h.me)
            ));
        }
        h.now += TICK;
    }
    h.asks = f.routes;
    println!(
        "{}; route searches {}; events {:?}; ends at {:?} mm, the leader at {:?} mm",
        log.join("; "),
        h.asks,
        h.events,
        mm(h.me),
        mm(h.leader)
    );
    assert_eq!(f.routes, 1, "one route, once");
    assert_eq!(h.events, [name(FELL_BACK)]);
    // It walked to the route's point, off the held stretch, and went on after the leader.
    assert!(h.me.z > 3_000_000, "{:?}", mm(h.me));
}
