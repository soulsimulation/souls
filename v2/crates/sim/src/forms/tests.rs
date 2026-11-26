//! F1's runs in the world (#2766): every kind in the runner's `kinds/` folder has its three-step form run on a body
//! of the fixtures' family, on the controller, the due list and B2's moves, and every run reaches a named end: done,
//! a passed deadline, a move out of reach. No kind, form or move is named here: each run is over the folder's files.

use std::collections::BTreeMap;
use std::path::Path;

use replica::bodies::{Class, Family};
use replica::effects::fixture_bytes;
use replica::effects::{Actor, Body, Cause, Change, Effect};
use replica::encode::{Name, Value, decode};
use replica::host::{Answer, Ask, Seen, Skill};
use replica::ids::{Id, Minter, Scope};
use replica::moves::{Effector, Move};
use replica::pose::{Frame, Quat, Vec3, fixture};
use replica::rules::json::{self, parse};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::{parse_kinds, parse_world};
use skills::form_runner::{Limits, bind, bind_effects};

use super::{Asked, Forms, Intent, Receipt, World};
use crate::controller::Controller;
use crate::ground::Piece;
use crate::host::Geometry;
use crate::mover::Surface;
use crate::moves::{Moves, Reach, load};
use crate::timers::DueList;

/// F11's stages (#2774), on this bench.
mod stages;

const FAMILIES: &str = include_str!("../../../replica/fixtures/bodies/families.diag");
const KINDS: &str = include_str!("../../../replica/fixtures/world-model/kinds.diag");
const TICK: Micros = 50_000;
/// The effector's height above the body's feet, µm: the test's answer to B2's one question.
const SHOULDER: i64 = 1_000_000;

/// The fixtures' two-handed, two-legged family.
fn family() -> Family {
    let v = decode(&fixture_bytes(FAMILIES).expect("bytes"))
        .expect("decodes")
        .value;
    let Value::Array(fs) = v else {
        panic!("a list")
    };
    fs.iter()
        .map(|f| Family::from_value(f).expect("a family"))
        .find(|f| f.resources.iter().any(|r| r.class == Class::Manipulator))
        .expect("a family with hands")
}

/// Every kind entry in the runner's folder, each with its first form's name.
fn entries() -> Vec<(json::Value, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../skills/src/form_runner/kinds");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .expect("the kinds folder")
        .map(|e| e.expect("an entry").path())
        .collect();
    files.sort();
    files
        .iter()
        .map(|f| {
            let v = parse(&std::fs::read_to_string(f).expect("read")).expect("JSON");
            let form = v
                .get("forms")
                .and_then(json::Value::obj)
                .and_then(|o| o.first())
                .map(|(k, _)| k.clone())
                .expect("a form");
            (v, form)
        })
        .collect()
}

fn tree() -> Tree {
    let kinds = parse_kinds(KINDS).expect("kinds");
    let draft = parse_world(
        &kinds,
        "{1: [], 2: {}, 3: [{1: 1, 2: \"souls:place\"}], 4: []}",
    )
    .expect("a world");
    Tree::load(&draft).expect("loads").0
}

/// What the world shows the runs this tick: bodies from the controller, things where they stand, with their points.
#[derive(Default)]
struct Snap {
    bodies: BTreeMap<Id, Vec3>,
    things: BTreeMap<Id, (Vec3, BTreeMap<String, Vec3>)>,
    /// Every distance is this far, when set.
    far: bool,
    defer_walk: bool,
    /// Every walk's plan is no way (no legs), when set.
    no_way: bool,
    /// The thing every move aims at, when set (worldd's thing argument).
    aimed: Option<Id>,
}

impl Geometry for Snap {
    fn plan_walk(&self, _: Id, _: usize, _: Id, _: Vec3, _: i64) -> replica::host::WalkPlan {
        if self.defer_walk {
            replica::host::WalkPlan::Pending
        } else if self.no_way {
            replica::host::WalkPlan::Legs(Vec::new())
        } else {
            replica::host::WalkPlan::Unplanned
        }
    }
    fn ask(&self, _: Id, q: &Ask) -> Option<Answer> {
        match q {
            Ask::Toward { to, .. } => Some(Answer::Point(*to)),
            Ask::Near { .. } => Some(Answer::Near(Vec::new())),
            Ask::Distance { .. } => None,
        }
    }
    fn read(&self, node: Id) -> Option<Seen> {
        let position = match (self.bodies.get(&node), self.things.get(&node)) {
            (Some(p), _) | (None, Some((p, _))) => *p,
            _ => return None,
        };
        Some(Seen {
            id: node,
            kind: Name::new("test:node").expect("a name"),
            parent: Some(fixture(1)),
            position,
            fields: BTreeMap::new(),
        })
    }
}

impl Reach for Snap {
    fn distance(
        &self,
        body: Id,
        _: &Effector,
        _: Option<&Name>,
        target: Id,
        point: &Name,
    ) -> Option<i64> {
        if self.far {
            return Some(5_000_000);
        }
        let b = self.bodies.get(&body)?;
        let (t, points) = self.things.get(&target)?;
        let p = points.get(point.as_str())?;
        let d = [
            i128::from(t.x + p.x - b.x),
            i128::from(t.y + p.y - b.y - SHOULDER),
            i128::from(t.z + p.z - b.z),
        ];
        i64::try_from((d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).isqrt()).ok()
    }
    fn aimed(&self, _: Id, _: &Name) -> Option<Id> {
        self.aimed
    }
}

struct Bench {
    tree: Tree,
    surfaces: BTreeMap<Id, Surface>,
    c: Controller,
    due: DueList,
    mint: Minter,
    moves: Moves,
    library: Vec<Move>,
    snap: Snap,
    forms: Forms,
    now: Micros,
    /// Seats a form's sit takes, when the bench has any (#4187).
    slots: Option<crate::slots::Slots>,
}

fn points(entry: &json::Value) -> BTreeMap<String, Vec3> {
    let um = |v: &json::Value| match v {
        json::Value::Int(n) => i64::try_from(*n).expect("small") * 1000,
        _ => panic!("whole mm"),
    };
    entry
        .get("points")
        .and_then(json::Value::obj)
        .expect("points")
        .iter()
        .map(|(k, p)| {
            let a = p.get("at_mm").and_then(json::Value::arr).expect("at_mm");
            (k.clone(), Vec3::new(um(&a[0]), um(&a[1]), um(&a[2])))
        })
        .collect()
}

impl Bench {
    fn new() -> Bench {
        let ground_id = fixture(1);
        let corners = vec![
            [-30_000, 0, -30_000],
            [30_000, 0, -30_000],
            [30_000, 0, 30_000],
            [-30_000, 0, 30_000],
        ];
        let ground = Surface::new(
            ground_id,
            vec![Piece {
                outline: vec![corners.clone()],
                vertices: corners,
                triangles: vec![[0, 2, 1], [0, 3, 2]],
                ground: crate::gaits::Ground::Dry,
            }],
        );
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../replica/fixtures/moves");
        Bench {
            tree: tree(),
            surfaces: BTreeMap::from([(ground_id, ground)]),
            c: Controller::new(),
            due: DueList::new(),
            mint: Minter::new(Scope([0xf1; 16])),
            moves: Moves::new(),
            library: load(&dir).expect("the fixture moves"),
            snap: Snap::default(),
            forms: Forms::new(),
            now: 0,
            slots: None,
        }
    }

    /// A body standing at `at` and a thing of `entry` at `thing`.
    fn add(&mut self, entry: &json::Value, at: Vec3, thing: Vec3) -> (Id, Id) {
        let body = self.mint.mint().expect("id");
        let node = self.mint.mint().expect("id");
        let frame = Frame {
            node: fixture(1),
            slot: None,
        };
        let placed = self.surfaces[&fixture(1)]
            .place(body, frame, at, Quat::IDENTITY)
            .expect("placed");
        self.c.add(family(), placed).expect("added");
        self.snap.things.insert(node, (thing, points(entry)));
        (body, node)
    }

    fn look(&mut self) {
        self.snap.bodies = self.c.bodies().map(|b| (b.id, b.pose.position)).collect();
    }

    fn world(&mut self) -> (World<'_, Snap, Snap>, &mut Forms) {
        (
            World {
                tree: &self.tree,
                geometry: &self.snap,
                reach: &self.snap,
                controller: &mut self.c,
                due: &mut self.due,
                mint: &mut self.mint,
                moves: &mut self.moves,
                library: &self.library,
                places: self.slots.as_mut().map(|slots| super::Places {
                    slots,
                    floors: &self.surfaces,
                }),
                seed: 1,
            },
            &mut self.forms,
        )
    }

    fn start(&mut self, body: Id, node: Id, entry: &json::Value, form: &str, limits: Limits) {
        let intent = intent(body, 0);
        self.ask(body, node, entry, form, limits, intent)
            .expect("started");
    }

    /// Starts or resends `intent`: the form's effects bound when they bind (the rest are F4's), else none.
    fn ask(
        &mut self,
        body: Id,
        node: Id,
        entry: &json::Value,
        form: &str,
        limits: Limits,
        intent: Intent,
    ) -> Result<Asked, replica::effects::Refusal> {
        let steps = bind(entry, form).expect("binds");
        // A `set ... by` (C22) needs the thing's kind and amount fields, which the bench's things (outside the tree)
        // do not have: left out, as before C22 bound it.
        let effects: Vec<_> = bind_effects(entry, form)
            .unwrap_or_default()
            .into_iter()
            .filter(|e| !matches!(e, skills::form_runner::Effect::Add { .. }))
            .collect();
        self.look();
        let now = self.now;
        let (mut w, forms) = self.world();
        forms.start(&mut w, body, node, intent, steps, effects, limits, now)
    }

    /// One tick: the skills' phase (the walks), the controller's step, then every timer due before the next tick.
    fn tick(&mut self) {
        self.tick_with(&mut || false);
    }

    /// [`Bench::tick`], with each timer fired a second time when `double` says so.
    fn tick_with(&mut self, double: &mut dyn FnMut() -> bool) {
        let now = self.now;
        let at = now + TICK;
        self.look();
        {
            let (mut w, forms) = self.world();
            forms.tick(&mut w, now);
        }
        let stepped = self.c.step(&self.surfaces, TICK, at);
        assert!(stepped.refused.is_empty(), "{:?}", stepped.refused);
        self.look();
        while let Some(t) = self.due.fire(at) {
            let (mut w, forms) = self.world();
            assert!(
                forms.fire(&mut w, &t),
                "every timer is a form's or a move's"
            );
            if double() {
                forms.fire(&mut w, &t);
            }
        }
        self.now = at;
    }

    fn run(&mut self, most: Micros) {
        while !self.forms.is_empty() && self.now < most {
            self.tick();
        }
    }

    /// Nothing outlives the runs: no driver on any body, no timer, no move.
    fn clean(&self) {
        for b in self.c.bodies() {
            let running = self.c.claims(b.id).expect("a body").running().len();
            assert_eq!(running, 0, "a driver outlived its run");
        }
        assert_eq!(self.due.len(), 0, "a timer outlived its run");
        assert!(self.moves.is_empty(), "a move outlived its run");
    }
}

#[test]
fn a1_the_three_step_form_runs_on_every_kind_in_the_folder() {
    let all = entries();
    assert!(all.len() >= 2, "two kinds at least");
    let mut b = Bench::new();
    let mut runs = Vec::new();
    for (i, (entry, form)) in all.iter().enumerate() {
        let x = i64::try_from(i).expect("few") * 6_000_000 - 3_000_000;
        let (body, node) = b.add(entry, Vec3::new(x, 0, 6_000_000), Vec3::new(x, 0, 0));
        b.start(body, node, entry, form, Limits::default());
        runs.push((
            entry
                .get("kind")
                .and_then(json::Value::str)
                .expect("a kind"),
            form,
            body,
        ));
    }
    b.run(60_000_000);
    let ended = std::mem::take(&mut b.forms.ended);
    for (kind, form, body) in &runs {
        let e = ended.iter().find(|e| e.body == *body).expect("ended");
        println!("{kind} {form}: ended {} at {} µs", e.how.as_str(), e.at);
        assert_eq!(e.how.as_str(), "done");
        // The walk took most of it, then the press's 550 ms and the pause's 2 s.
        assert!(e.at > 2_550_000, "{}", e.at);
    }
    b.clean();
}

#[test]
fn a3_every_run_reaches_a_named_end() {
    let (entry, form) = entries().remove(0);
    // A walk too far for its deadline.
    let mut b = Bench::new();
    let (body, node) = b.add(&entry, Vec3::new(0, 0, 20_000_000), Vec3::ZERO);
    let limits = Limits {
        walk: 1_000_000,
        ..Limits::default()
    };
    b.start(body, node, &entry, &form, limits);
    b.run(10_000_000);
    let [e] = b.forms.ended.as_slice() else {
        panic!("{:?}", b.forms.ended)
    };
    println!(
        "a walk past its deadline: {} at {} µs",
        e.how.as_str(),
        e.at
    );
    assert_eq!((e.how.as_str(), e.at), ("deadline-passed", 1_000_000));
    b.clean();

    // A press beyond reach, refused by B2 at its start.
    let mut b = Bench::new();
    let (body, node) = b.add(&entry, Vec3::new(0, 0, 3_000_000), Vec3::ZERO);
    b.snap.far = true;
    b.start(body, node, &entry, &form, Limits::default());
    b.run(30_000_000);
    let [e] = b.forms.ended.as_slice() else {
        panic!("{:?}", b.forms.ended)
    };
    println!("a press beyond reach: {} at {} µs", e.how.as_str(), e.at);
    assert_eq!(e.how.as_str(), "out-of-reach");
    b.clean();

    // A second form on a body with one in progress, from another actor, is refused by name (#4187: the Soul's own
    // new act preempts it instead, below).
    let mut b = Bench::new();
    let (body, node) = b.add(&entry, Vec3::new(0, 0, 3_000_000), Vec3::ZERO);
    b.start(body, node, &entry, &form, Limits::default());
    let world = Intent {
        actor: Actor::World,
        ..intent(body, 1)
    };
    let r = b
        .ask(body, node, &entry, &form, Limits::default(), world)
        .expect_err("refused");
    assert_eq!(r.name, "form-running");
}

/// #4187: a Soul's own new act, sent while its run is open, leaves that run now (`left`, as a cancel leaves it) and
/// starts at once, whether the old run is walking or mid-move: no `form-running`, no driver, move or timer of the old
/// run left behind, and the new run runs to its end.
#[test]
fn i4187_a_souls_own_new_act_preempts_its_run_walking_or_mid_move() {
    let (entry, form) = entries().remove(0);
    let steps = bind(&entry, &form).expect("binds");
    let mv = steps
        .iter()
        .position(|s| matches!(s, skills::form_runner::Step::Move { .. }))
        .expect("the form has a hand move");
    for mid_move in [false, true] {
        let mut b = Bench::new();
        let (body, node) = b.add(&entry, Vec3::new(0, 0, 3_000_000), Vec3::ZERO);
        b.start(body, node, &entry, &form, Limits::default());
        if mid_move {
            while b.forms.at(body) != Some(mv) && b.now < 30_000_000 {
                b.tick();
            }
            assert_eq!(b.forms.at(body), Some(mv), "the old run is in its move");
            assert!(!b.moves.is_empty(), "its move is under way");
        }
        let at = b.now;
        let asked = b
            .ask(
                body,
                node,
                &entry,
                &form,
                Limits::default(),
                intent(body, 1),
            )
            .expect("the Soul's own new act is accepted");
        assert!(matches!(asked, Asked::Started(_)), "{asked:?}");
        let [left] = b.forms.ended.as_slice() else {
            panic!("{:?}", b.forms.ended)
        };
        println!(
            "#4187 (mid-move {mid_move}): the old run ended {} at {} µs, the new one started then",
            left.how.as_str(),
            left.at
        );
        assert_eq!(
            (left.how.as_str(), left.at),
            ("left", at),
            "left in the same instant"
        );
        assert_eq!(b.forms.len(), 1, "only the new run is open");
        b.forms.ended.clear();
        b.run(60_000_000);
        let [e] = b.forms.ended.as_slice() else {
            panic!("{:?}", b.forms.ended)
        };
        assert_eq!(e.how.as_str(), "done", "the new run runs to its end");
        b.clean();
    }

    // The world's own conflicts keep their codes, and a refused new act leaves the Soul's run as it was: a thing
    // another Soul's run holds is refused `thing-reserved`.
    let mut b = Bench::new();
    let (first, mine) = b.add(&entry, Vec3::new(0, 0, 3_000_000), Vec3::ZERO);
    let (second, theirs) = b.add(&entry, Vec3::new(2_000_000, 0, 3_000_000), Vec3::ZERO);
    b.start(first, mine, &entry, &form, Limits::default());
    b.start(second, theirs, &entry, &form, Limits::default());
    let r = b
        .ask(
            first,
            theirs,
            &entry,
            &form,
            Limits::default(),
            intent(first, 1),
        )
        .expect_err("refused");
    assert_eq!(r.name, "thing-reserved");
    assert!(
        b.forms.ended.is_empty(),
        "nothing was left: {:?}",
        b.forms.ended
    );
    assert_eq!(
        b.forms.holder(mine),
        Some(first),
        "the Soul's own run goes on"
    );
}

/// C20 (#3469): a run is due by its start plus its steps' span, its walk, its move and its pause each by its own
/// deadline as the runner sets it; a run whose walk alone is past an act's 10 s ends `done` before that.
#[test]
fn c20_a_run_is_due_by_its_walk_and_its_own_steps_from_its_start() {
    let (entry, form) = entries().remove(0);
    let limits = Limits {
        walk: 120_000_000,
        ..Limits::default()
    };
    let steps = bind(&entry, &form).expect("binds");
    let span = super::span(&steps, &limits);
    // A walk, a press and a 2 s pause, and two ticks for each step and the end.
    assert_eq!(
        span,
        limits.walk + limits.step_move + 2_000_000 + 4 * 2 * limits.tick
    );
    let mut b = Bench::new();
    b.now = 5_000_000;
    let (body, node) = b.add(&entry, Vec3::new(0, 0, 30_000_000), Vec3::ZERO);
    let start = b.now;
    let run = match b
        .ask(body, node, &entry, &form, limits, intent(body, 0))
        .expect("started")
    {
        Asked::Started(run) => run,
        other => panic!("{other:?}"),
    };
    assert_eq!(b.forms.due(run), Some(start + span), "from its start");
    b.run(start + span);
    let [e] = b.forms.ended.as_slice() else {
        panic!("{:?}", b.forms.ended)
    };
    println!(
        "a 30 m walk, a press and a pause: {} after {} µs, due after {span} µs",
        e.how.as_str(),
        e.at - start
    );
    assert_eq!(e.how.as_str(), "done");
    assert!(e.at - start > 10_000_000, "past an act's 10 s");
    assert!(e.at < start + span, "before its due");
    assert_eq!(b.forms.due(run), None, "ended");
    b.clean();
}

/// C21 (#3484) A2: a form's walk to a point past the ground's edge is cut at the edge and gains nothing more; the
/// watch finds it within 3 s of its last gain, and the world ends it `walk.blocked`: the run ends in that tick, with
/// no driver, timer or move left on the body.
#[test]
fn c21_a2_a_stalled_walk_ends_walk_blocked_and_frees_its_body_in_the_tick() {
    use crate::walk::stall::{GAIN, WINDOW, Watch};
    let (entry, form) = entries().remove(0);
    let mut b = Bench::new();
    // The ground ends at z = 30 m; the thing stands at 40 m.
    let goal = [0, 40_000_000];
    let (body, node) = b.add(
        &entry,
        Vec3::new(0, 0, 25_000_000),
        Vec3::new(0, 0, goal[1]),
    );
    let limits = Limits {
        walk: 120_000_000,
        ..Limits::default()
    };
    b.start(body, node, &entry, &form, limits);
    let mut watch = Watch::new();
    let (mut best, mut gained, mut stalled) = (i64::MAX, 0, None);
    while b.now < 60_000_000 && stalled.is_none() {
        b.tick();
        let p =
            b.c.bodies()
                .find(|x| x.id == body)
                .expect("the body")
                .pose
                .position;
        if goal[1] - p.z < best - GAIN {
            (best, gained) = (goal[1] - p.z, b.now);
        }
        if watch.seen(body, [p.x, p.z], goal, goal, b.now) {
            let now = b.now;
            let (mut w, forms) = b.world();
            assert!(
                forms.stall(&mut w, body, "walk.blocked", now),
                "a walk in progress"
            );
            stalled = Some((now, p));
        }
    }
    let (at, p) = stalled.expect("found stalled");
    println!(
        "cut at the edge at ({:.2}, {:.2}) m; last gained 0.25 m at {gained} µs, ended at {at} µs",
        p.x as f64 / 1e6,
        p.z as f64 / 1e6
    );
    assert!(at - gained <= WINDOW, "within 3 s of its last gain");
    let [e] = b.forms.ended.as_slice() else {
        panic!("{:?}", b.forms.ended)
    };
    assert_eq!((e.how.as_str(), e.at, e.body), ("walk.blocked", at, body));
    assert!(b.forms.is_empty());
    b.clean();
}

// --- F2: the effect, once (#2767) ---------------------------------------------------------------------------------

/// The `n`th intent of `body`, expiring at ten minutes, its digest its number.
fn intent(body: Id, n: u64) -> Intent {
    let mut digest = [0; 32];
    digest[..8].copy_from_slice(&n.to_le_bytes());
    Intent {
        id: Id::new(Scope([0xf2; 16]), body.counter() * 1_000_000 + n).expect("an id"),
        expiry: 600_000_000,
        actor: Actor::Soul(body),
        digest,
    }
}

/// The first kind in the folder whose first form has effects this task binds, with that form.
fn effecting() -> (json::Value, String) {
    entries()
        .into_iter()
        .find(|(e, f)| {
            bind_effects(e, f).is_ok_and(|x| {
                !x.is_empty()
                    && x.iter()
                        .all(|e| matches!(e, skills::form_runner::Effect::Set { .. }))
            })
        })
        .expect("a kind whose effects bind")
}

/// `v` with every `walk_to` step taken out of its forms (S11).
fn without_walks(v: &json::Value) -> json::Value {
    match v {
        json::Value::Obj(o) => json::Value::Obj(
            o.iter()
                .map(|(k, x)| match (k.as_str(), x) {
                    ("steps", json::Value::Arr(s)) => (
                        k.clone(),
                        json::Value::Arr(
                            s.iter()
                                .filter(|st| {
                                    st.get("step").and_then(json::Value::str) != Some("walk_to")
                                })
                                .cloned()
                                .collect(),
                        ),
                    ),
                    _ => (k.clone(), without_walks(x)),
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `entry` with every `move` step taken out of its forms: a form with no hand step.
fn without_moves(v: &json::Value) -> json::Value {
    without_steps(v, "move")
}

/// `entry` with every step named `step` taken out of its forms.
fn without_steps(v: &json::Value, step: &str) -> json::Value {
    match v {
        json::Value::Obj(o) => json::Value::Obj(
            o.iter()
                .map(|(k, x)| match (k.as_str(), x) {
                    ("steps", json::Value::Arr(s)) => (
                        k.clone(),
                        json::Value::Arr(
                            s.iter()
                                .filter(|st| {
                                    st.get("step").and_then(json::Value::str) != Some(step)
                                })
                                .cloned()
                                .collect(),
                        ),
                    ),
                    _ => (k.clone(), without_steps(x, step)),
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

impl Bench {
    /// The commit point: the tick's effects are numbered, appended to `log` and handed back as logged.
    fn flush(&mut self, log: &mut Vec<Effect>) {
        for mut e in std::mem::take(&mut self.forms.out) {
            e.envelope.sequence = log.len() as u64 + 1;
            self.forms.logged(&e);
            log.push(e);
        }
    }
}

/// The log's entries that are a form's effects (not a run's start or end, F3).
fn effect_entries(log: &[Effect]) -> Vec<&Effect> {
    log.iter()
        .filter(|e| {
            e.events
                .iter()
                .flatten()
                .any(|v| v.name.as_str() == "souls:effect")
        })
        .collect()
}

/// The log's effects caused by `intent`.
fn caused(log: &[Effect], intent: &Intent) -> Vec<u64> {
    effect_entries(log)
        .into_iter()
        .filter(|e| e.envelope.cause == Cause::Intent(intent.id))
        .map(|e| e.envelope.sequence)
        .collect()
}

#[test]
fn f2_a1_the_effect_lands_at_contact_or_when_the_last_step_ends() {
    let (entry, form) = effecting();
    for (case, entry, before_end) in [
        // The press is the last step: its recovery (300 ms) comes after contact.
        (
            "at the hand step's contact",
            without_steps(&entry, "wait"),
            300_000,
        ),
        // A pause after the press: the effect waits for it (E7), so a Soul that leaves during it has none.
        ("at the pause's end, after the hand step", entry.clone(), 0),
        ("at the last step's end", without_moves(&entry), 0),
    ] {
        let mut b = Bench::new();
        let (body, node) = b.add(&entry, Vec3::new(0, 0, 3_000_000), Vec3::ZERO);
        b.start(body, node, &entry, &form, Limits::default());
        let mut log = Vec::new();
        while !b.forms.is_empty() {
            b.tick();
            b.flush(&mut log);
        }
        let [e] = b.forms.ended.as_slice() else {
            panic!("{:?}", b.forms.ended)
        };
        assert_eq!(e.how.as_str(), "done");
        let [effect] = effect_entries(&log)[..] else {
            panic!("one effect: {log:?}")
        };
        let Body::Changes(c) = &effect.body else {
            panic!("changes")
        };
        assert!(matches!(c[0].change, Change::Set { node: n, .. } if n == node));
        println!(
            "{case}: effect at {} µs, run ended at {} µs",
            effect.envelope.at, e.at
        );
        assert_eq!(effect.envelope.at, e.at - before_end, "{case}");
        b.clean();
    }
}

/// E7: a Soul that leaves partway through a later, repeated step (the second of two presses, or the pause after them)
/// gets none of the form's effects: the run ends `left`, nothing of the thing is set, and its reservation is freed, in
/// the run and in the log.
#[test]
fn e7_a_soul_that_leaves_during_a_later_repeated_step_gets_no_effect() {
    let press = r#"{ "step": "move", "move": "press", "at": "button" },"#;
    let entry_text = include_str!("../../../skills/src/form_runner/kinds/lamp.json");
    assert!(entry_text.contains(press), "the kind's press");
    let entry = parse(&entry_text.replacen(press, &format!("{press}\n{press}"), 1)).expect("JSON");
    let form = "switch_on";
    assert_eq!(
        bind(&entry, form).expect("binds"),
        bind(&parse(entry_text).expect("JSON"), form)
            .map(|mut s| {
                s.insert(2, s[1].clone());
                s
            })
            .expect("binds"),
        "the press is repeated"
    );
    // The second press (step 2, moving), and the pause after it (step 3).
    for (case, step, moving) in [("the second press", 2, true), ("the pause", 3, false)] {
        let mut b = Bench::new();
        let (body, node) = b.add(&entry, Vec3::new(0, 0, 3_000_000), Vec3::ZERO);
        b.start(body, node, &entry, form, Limits::default());
        assert_eq!(b.forms.holder(node), Some(body), "reserved");
        let mut log = Vec::new();
        while !(b.forms.at(body) == Some(step) && b.forms.in_hand_move(body) == moving) {
            assert!(!b.forms.is_empty() && b.now < 30_000_000, "{case}: reached");
            b.tick();
            b.flush(&mut log);
        }
        let now = b.now;
        let (mut w, forms) = b.world();
        forms.leave(&mut w, body, None, now).expect("left");
        // A pause is left at once, its end written by the leave itself.
        b.flush(&mut log);
        while !b.forms.is_empty() && b.now < 30_000_000 {
            b.tick();
            b.flush(&mut log);
        }
        let [e] = b.forms.ended.as_slice() else {
            panic!("{case}: {:?}", b.forms.ended)
        };
        println!(
            "{case}: left at step {step} at {} µs, ended {} at {} µs; {} log entries, {} effects",
            now,
            e.how.as_str(),
            e.at,
            log.len(),
            effect_entries(&log).len()
        );
        assert_eq!(e.how.as_str(), "left", "{case}");
        assert!(effect_entries(&log).is_empty(), "{case}: no effect landed");
        assert!(
            log.iter().flat_map(Effect::changes).all(|c| !matches!(
                c.change,
                Change::Set { node: n, .. } if n == node
            )),
            "{case}: the thing's fields are as they were"
        );
        assert_eq!(
            b.forms.holder(node),
            None,
            "{case}: the reservation is freed"
        );
        assert!(
            super::reservations(&log).is_empty(),
            "{case}: and in the log"
        );
        b.clean();
    }
}

#[test]
fn f2_a3_a_resend_across_a_restart_gets_the_first_receipt() {
    let (entry, form) = effecting();
    let mut b = Bench::new();
    let (body, node) = b.add(&entry, Vec3::new(0, 0, 3_000_000), Vec3::ZERO);
    let it = intent(body, 7);
    let limits = Limits::default();
    assert!(matches!(
        b.ask(body, node, &entry, &form, limits, it),
        Ok(Asked::Started(_))
    ));
    let mut log = Vec::new();
    while !b.forms.is_empty() {
        b.tick();
        b.flush(&mut log);
    }
    let first = Receipt {
        intent: it.id,
        entries: caused(&log, &it),
    };
    let before = b.ask(body, node, &entry, &form, limits, it);
    assert_eq!(before, Ok(Asked::Applied(first.clone())));

    // The world restarts: its keys are read back from the log, and no form runs again.
    let now = b.now;
    let mut b = Bench::new();
    let (body, node) = b.add(&entry, Vec3::new(0, 0, 3_000_000), Vec3::ZERO);
    b.forms = Forms::recover(&log, now);
    b.now = now;
    let after = b.ask(body, node, &entry, &form, limits, it);
    println!("a resend before the restart: {before:?}; after it: {after:?}");
    assert_eq!(after, Ok(Asked::Applied(first)));
    assert!(b.forms.is_empty() && b.forms.out.is_empty());

    // The same key with other contents is refused, not applied; past its expiry, a resend is refused.
    let other = Intent {
        digest: [9; 32],
        ..it
    };
    let r = b.ask(body, node, &entry, &form, limits, other);
    assert_eq!(r.map_err(|r| r.name), Err("intent-key-reused"));
    b.now = it.expiry + 1;
    b.forms.forget(b.now);
    let r = b.ask(body, node, &entry, &form, limits, it);
    assert_eq!(r.map_err(|r| r.name), Err("intent-expired"));
    assert_eq!(effect_entries(&log).len(), 1);
}

/// Whether entry `e` is a run's move record for viewers (#3741).
fn is_move_record(e: &Effect) -> bool {
    e.events
        .iter()
        .flatten()
        .any(|v| v.name.as_str() == "souls:form-move")
}

/// #3741: a run's move writes its B2 record for viewers (the body, and the move's name, start and phase ends), seen
/// by everyone, changing nothing; and a restart from a log holding it recovers exactly as from the same log without.
#[test]
fn a_runs_move_record_is_written_for_viewers_and_a_restart_ignores_it() {
    let (entry, form) = effecting();
    let mut b = Bench::new();
    let (body, node) = b.add(&entry, Vec3::new(0, 0, 3_000_000), Vec3::ZERO);
    let it = intent(body, 11);
    assert!(matches!(
        b.ask(body, node, &entry, &form, Limits::default(), it),
        Ok(Asked::Started(_))
    ));
    let mut log = Vec::new();
    while !log.iter().any(is_move_record) {
        assert!(!b.forms.is_empty(), "the run ended without a move record");
        b.tick();
        b.flush(&mut log);
    }
    let rec = log.iter().find(|e| is_move_record(e)).expect("the record");
    assert_eq!(
        rec.envelope.audience,
        replica::world_model::Audience::Everyone
    );
    assert_eq!(rec.envelope.cause, Cause::Intent(it.id));
    assert!(
        matches!(&rec.body, Body::Changes(c) if c.is_empty()),
        "it changes nothing"
    );
    let ev = &rec.events.as_ref().expect("events")[0];
    assert_eq!(ev.fields.get(&2), Some(&body.to_value()));
    let Some(Value::Map(m)) = ev.fields.get(&3) else {
        panic!("a move record: {ev:?}")
    };
    assert!(
        matches!(m.get(&2), Some(Value::Bytes(_))),
        "the move's name"
    );
    assert!(
        matches!(m.get(&8), Some(Value::Array(a)) if !a.is_empty()),
        "its phase ends"
    );
    // A restart mid-run: the same endings, entries and runs with the record as without it.
    let now = b.now;
    let without: Vec<Effect> = log.iter().filter(|e| !is_move_record(e)).cloned().collect();
    let (a, c) = (Forms::recover(&log, now), Forms::recover(&without, now));
    assert_eq!(a.ended, c.ended);
    assert_eq!(a.out, c.out);
    assert_eq!((a.is_empty(), a.len()), (c.is_empty(), c.len()));
    b.run(now + 60_000_000);
    b.clean();
}

/// The record a run's first move writes for viewers: its event's record map (field 3).
fn first_move_record(
    b: &mut Bench,
    entry: &json::Value,
    form: &str,
    body: Id,
    node: Id,
) -> BTreeMap<u64, Value> {
    let it = intent(body, 11);
    assert!(matches!(
        b.ask(body, node, entry, form, Limits::default(), it),
        Ok(Asked::Started(_))
    ));
    let mut log = Vec::new();
    while !log.iter().any(is_move_record) {
        assert!(!b.forms.is_empty(), "the run ended without a move record");
        b.tick();
        b.flush(&mut log);
    }
    let rec = log.iter().find(|e| is_move_record(e)).expect("the record");
    let Some(Value::Map(m)) = rec.events.as_ref().expect("events")[0].fields.get(&3) else {
        panic!("a move record")
    };
    m.clone()
}

/// #4330: the record names the move's target, the form's node; a move aimed at a thing argument (a point toward a
/// lamp) names that thing, so the page turns the body toward it, not toward itself.
#[test]
fn a_move_record_names_the_thing_it_aims_at() {
    let (entry, form) = effecting();
    let mut b = Bench::new();
    let (body, node) = b.add(&entry, Vec3::new(0, 0, 3_000_000), Vec3::ZERO);
    assert_eq!(
        first_move_record(&mut b, &entry, &form, body, node).get(&5),
        Some(&node.to_value())
    );
    let mut b = Bench::new();
    let (body, node) = b.add(&entry, Vec3::new(0, 0, 3_000_000), Vec3::ZERO);
    let thing = fixture(77);
    b.snap.aimed = Some(thing);
    assert_eq!(
        first_move_record(&mut b, &entry, &form, body, node).get(&5),
        Some(&thing.to_value())
    );
}

fn splitmix(x: &mut u64) -> u64 {
    *x = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut z = *x;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

#[test]
fn f2_a2_a3_ten_thousand_runs_with_resends_doubled_timers_and_kills_apply_each_effect_once() {
    const RUNS: u64 = 10_000;
    let (entry, form) = effecting();
    let effects = bind_effects(&entry, &form).expect("binds").len() as u64;
    let limits = Limits::default();
    let start = Vec3::new(0, 0, 1_500_000);
    let (mut resends, mut across, mut doubled, mut kills, mut lost) =
        (0u64, 0u64, 0u64, 0u64, 0u64);
    let mut in_log = 0u64;
    for seed in 0..RUNS {
        let mut rng = seed;
        let mut b = Bench::new();
        let (body, node) = b.add(&entry, start, Vec3::ZERO);
        let it = intent(body, seed);
        let mut log: Vec<Effect> = Vec::new();
        let mut receipts: Vec<Receipt> = Vec::new();
        assert!(matches!(
            b.ask(body, node, &entry, &form, limits, it),
            Ok(Asked::Started(_))
        ));
        let (mut restarted, mut killed) = (false, 0);
        for _ in 0..10_000 {
            let mut coin = splitmix(&mut rng);
            b.tick_with(&mut || {
                coin = splitmix(&mut coin);
                let twice = coin.is_multiple_of(4);
                doubled += u64::from(twice);
                twice
            });
            let r = splitmix(&mut rng) % 100;
            // At most three kills a run. One before the tick's effects reach the log loses them; one after keeps them.
            let kill = killed < 3 && r < 4;
            if kill && r < 2 {
                lost += b.forms.out.len() as u64;
            } else {
                b.flush(&mut log);
            }
            if kill {
                killed += 1;
                let now = b.now;
                b = Bench::new();
                b.add(&entry, start, Vec3::ZERO);
                b.forms = Forms::recover(&log, now);
                b.now = now;
                restarted = true;
            }
            // The agent resends after a kill (its answer was lost), and at random.
            if kill || r.is_multiple_of(10) {
                resends += 1;
                match b
                    .ask(body, node, &entry, &form, limits, it)
                    .expect("answered")
                {
                    Asked::Applied(rc) => {
                        across += u64::from(restarted);
                        receipts.push(rc);
                    }
                    Asked::Running(_) => assert!(!kill, "seed {seed}: a killed world has no run"),
                    Asked::Started(_) => assert!(kill, "seed {seed}: a run started twice"),
                }
            }
            if b.forms.is_empty() {
                break;
            }
        }
        kills += killed;
        assert!(b.forms.is_empty(), "seed {seed}: the run never ended");
        let last = b.ask(body, node, &entry, &form, limits, it);
        // Each effect is in the log exactly once, and every receipt is the first.
        for n in 0..effects {
            let once = effect_entries(&log)
                .into_iter()
                .filter(|e| {
                    e.envelope.cause == Cause::Intent(it.id)
                        && e.events.as_ref().is_some_and(|v| {
                            v.iter().any(|x| x.fields.get(&1) == Some(&Value::Uint(n)))
                        })
                })
                .count();
            assert_eq!(
                once, 1,
                "seed {seed}: effect {n} is in the log {once} times"
            );
        }
        let first = Receipt {
            intent: it.id,
            entries: caused(&log, &it),
        };
        assert_eq!(last, Ok(Asked::Applied(first.clone())), "seed {seed}");
        for r in &receipts {
            assert_eq!(*r, first, "seed {seed}: a resend got another receipt");
        }
        in_log += effect_entries(&log).len() as u64;
    }
    println!(
        "{RUNS} runs: {in_log} effects in the logs, each once; {resends} resends, every receipt the first \
         ({across} answered after a restart); {doubled} timers fired twice; {kills} kills ({lost} effects lost \
         before the log, then written once)"
    );
    assert_eq!(in_log, RUNS * effects);
    assert!(across > 0 && doubled > 0 && kills > 0 && lost > 0);
}

// --- F3: reserve, stop, and end cleanly (#2768) -------------------------------------------------------------------

#[test]
fn f3_a3_a_second_soul_asking_for_a_reserved_thing_is_refused_naming_the_holder_and_a_next_act() {
    let (entry, form) = entries().remove(0);
    let limits = Limits::default();
    let mut b = Bench::new();
    let (first, node) = b.add(&entry, Vec3::new(0, 0, 3_000_000), Vec3::ZERO);
    let (second, _) = b.add(&entry, Vec3::new(2_000_000, 0, 3_000_000), Vec3::ZERO);
    b.start(first, node, &entry, &form, limits);
    assert_eq!(b.forms.holder(node), Some(first));
    let r = b
        .ask(second, node, &entry, &form, limits, intent(second, 0))
        .expect_err("refused");
    println!("{}: {}", r.name, r.detail);
    assert_eq!(r.name, "thing-reserved");
    assert!(r.detail.contains(&replica::world_model::show(first)));
    assert!(r.detail.contains("next: "));
    // Once the holder's run ends, the thing is free.
    b.run(60_000_000);
    assert_eq!(b.forms.holder(node), None);
    let again = b.ask(second, node, &entry, &form, limits, intent(second, 1));
    assert!(matches!(again, Ok(Asked::Started(_))), "{again:?}");
}

#[test]
fn f6_commit_checks_who_may_before_a_run_starts() {
    use replica::world_model::{Audience, Draft, End, FIXTURE_SCOPE_SOULS, Link, Node, plain};
    // A kind of the runner's whose form's effect binds, that form made its owner's alone: the kind declares `owner`.
    let (entry, form) = effecting();
    let json::Value::Obj(mut e) = entry else {
        panic!("an entry")
    };
    for (k, v) in &mut e {
        if k == "forms"
            && let json::Value::Obj(fs) = v
            && let Some((_, json::Value::Obj(f))) = fs.iter_mut().find(|(n, _)| *n == form)
        {
            f.retain(|(k, _)| k != "who");
            f.push(("who".into(), parse(r#"{"link":"owner"}"#).expect("JSON")));
        }
    }
    let links = r#"{"owner":{"n":1,"from":"soul","most":1,"audience":{"rule":"everyone"}}}"#;
    e.push(("links".into(), parse(links).expect("JSON")));
    let entry = json::Value::Obj(e);
    let mut b = Bench::new();
    let (owner, node) = b.add(&entry, Vec3::new(0, 0, 3_000_000), Vec3::ZERO);
    let (other, _) = b.add(&entry, Vec3::new(2_000_000, 0, 3_000_000), Vec3::ZERO);
    let kind = entry
        .get("kind")
        .and_then(json::Value::str)
        .expect("a kind");
    let kinds = parse_kinds(&format!("{KINDS}\n{{1: \"{kind}\", 2: \"thing\"}}")).expect("kinds");
    let full = |p: &str| {
        kinds
            .keys()
            .find(|k| plain(k) == p)
            .expect("a kind")
            .clone()
    };
    let soul = Id::new(FIXTURE_SCOPE_SOULS, 100).expect("an id");
    let mut mint = Minter::new(Scope([0xf6; 16]));
    let node_of = |id, kind: String, parent| Node {
        id,
        kind,
        parent,
        slot: None,
        audience: Audience::Everyone,
        fields: BTreeMap::new(),
    };
    let link = |id, ty: String, ends, owner| Link {
        id,
        ty,
        ends,
        owner,
        audience: Audience::Everyone,
    };
    let root = mint.mint().expect("id");
    let draft = Draft {
        kinds: kinds.clone(),
        souls: [soul].into(),
        audiences: BTreeMap::new(),
        nodes: vec![
            node_of(root, full("souls:place"), None),
            node_of(node, full(kind), Some(root)),
            node_of(owner, full("souls:body"), Some(root)),
            node_of(other, full("souls:body"), Some(root)),
        ],
        links: vec![
            link(
                mint.mint().expect("id"),
                "souls:body-of".into(),
                [owner, soul],
                End::First,
            ),
            link(
                mint.mint().expect("id"),
                replica::audience::link_type(kind, "owner"),
                [soul, node],
                End::Second,
            ),
        ],
    };
    let (tree, rules) = Tree::load(&draft).expect("loads");
    b.tree = tree;
    let names = |id| (id == soul).then(|| "Ana".to_owned());
    let commit = |b: &mut Bench, body| {
        b.look();
        let now = b.now;
        let (mut w, forms) = b.world();
        let i = intent(body, 0);
        let limits = Limits::default();
        forms.commit(
            &mut w,
            &rules.audiences,
            &names,
            body,
            node,
            &entry,
            &form,
            i,
            limits,
            now,
        )
    };
    let r = commit(&mut b, other).expect_err("refused");
    println!("{}: {}", r.name, r.detail);
    assert_eq!(
        (r.name, r.detail.as_str()),
        ("not-permitted", "who may: its owner, Ana")
    );
    assert!(
        b.forms.is_empty() && b.forms.out.is_empty(),
        "no run, no entry"
    );
    let ok = commit(&mut b, owner);
    assert!(matches!(ok, Ok(Asked::Started(_))), "{ok:?}");
}

#[test]
fn pending_form_plan_holds_the_existing_walk_claim_and_cleans_up_when_replaced() {
    let (entry, form) = entries().remove(0);
    let mut b = Bench::new();
    let (body, node) = b.add(&entry, Vec3::ZERO, Vec3::new(5_000_000, 0, 0));
    let walk = skills::route::Route::sent(0, 0);
    let old = b.c.claim(body, &walk.shape()).unwrap();
    b.snap.defer_walk = true;
    b.start(body, node, &entry, &form, Limits::default());
    assert!(
        !b.c.claims(body).unwrap().running().contains_key(&old),
        "the previous walk is cancelled at step start"
    );
    let run = b.forms.by_body[&body];
    let held = b.forms.runs[&run].walk.unwrap();
    assert!(b.c.claims(body).unwrap().running().contains_key(&held));
    b.snap.defer_walk = false;
    let now = b.now;
    let (mut w, forms) = b.world();
    forms.tick(&mut w, now);
    assert_eq!(
        b.forms.runs[&run].walk,
        Some(held),
        "the planned route reuses the original claim"
    );
    let now = b.now;
    let (mut w, forms) = b.world();
    forms.leave(&mut w, body, None, now).unwrap();
    b.clean();

    b.snap.defer_walk = true;
    b.start(body, node, &entry, &form, Limits::default());
    let newer = b.c.claim(body, &walk.shape()).unwrap();
    let now = b.now;
    let (mut w, forms) = b.world();
    forms.tick(&mut w, now);
    assert!(
        b.forms
            .ended
            .iter()
            .any(|e| e.how.as_str() == "claim-taken")
    );
    assert!(b.forms.planning.is_empty());
    b.c.release(body, newer).unwrap();
    b.clean();
}

/// S11: a run walking to its thing whose claim on the legs another walk takes (its Soul's own walk, intents rule 10)
/// ends `claim-taken` in the next tick. Before, only a run waiting for its plan was ended: a walking one stood at its
/// walk step for good, unwatched (it asks no way) and unanswered.
#[test]
fn s11_a_walking_run_whose_legs_another_walk_takes_ends_claim_taken() {
    let (entry, form) = entries().remove(0);
    let mut b = Bench::new();
    let (body, node) = b.add(&entry, Vec3::ZERO, Vec3::new(20_000_000, 0, 0));
    b.start(body, node, &entry, &form, Limits::default());
    b.tick();
    let run = b.forms.by_body[&body];
    assert!(b.forms.runs[&run].walk.is_some(), "walking");
    assert!(!b.forms.planning.contains(&run), "not waiting for a plan");
    let other =
        b.c.claim(body, &skills::route::Route::sent(0, 0).shape())
            .unwrap();
    b.tick();
    assert!(
        b.forms
            .ended
            .iter()
            .any(|e| e.body == body && e.how.as_str() == "claim-taken"),
        "ended: {:?}",
        b.forms.ended
    );
    assert!(b.forms.is_empty());
    assert!(
        b.c.claims(body).unwrap().running().contains_key(&other),
        "the other walk keeps its claim"
    );
    b.c.release(body, other).unwrap();
    b.clean();
}

/// S11 review: an approach whose plan, awaited, is no way goes straight to its move, and gives back the route claim
/// it awaited the plan with. A Soul's own walk arriving during that move leaves the run at the move's phase end
/// (`left`, intents rule 10), not `claim-taken` mid-contact.
#[test]
fn s11_an_approach_with_no_way_moves_and_a_souls_walk_leaves_it_at_the_phase_end() {
    // The doorbell's ring without its walk: it starts with a move at the button, so the binding walks there first.
    let (entry, form) = entries().remove(0);
    let entry = without_walks(&entry);
    assert!(matches!(
        bind(&entry, &form).expect("binds").first(),
        Some(skills::form_runner::Step::WalkTo { approach: true, .. })
    ));
    let mut b = Bench::new();
    // Within reach of the button: the move needs no walk.
    let (body, node) = b.add(&entry, Vec3::new(0, 0, -400_000), Vec3::ZERO);
    b.snap.defer_walk = true;
    b.start(body, node, &entry, &form, Limits::default());
    let run = b.forms.by_body[&body];
    assert!(
        b.forms.runs[&run].walk.is_some(),
        "the plan is awaited with a route claim"
    );
    (b.snap.defer_walk, b.snap.no_way) = (false, true);
    b.tick();
    assert!(
        b.forms.in_hand_move(body),
        "no way: straight to the move; at {:?}, ended {:?}, planning {:?}",
        b.forms.at(body),
        b.forms.ended,
        b.forms.planning
    );
    assert!(
        b.forms.runs[&run].walk.is_none(),
        "the route claim is given back"
    );
    // The Soul's own walk: its claim on the legs, and the world leaves the run (acts.rs, rule 10).
    let walk =
        b.c.claim(body, &skills::route::Route::sent(0, 0).shape())
            .unwrap();
    let now = b.now;
    let (mut w, forms) = b.world();
    forms.leave(&mut w, body, None, now).unwrap();
    while b.forms.ended.is_empty() && b.now < 30_000_000 {
        b.tick();
    }
    let [e] = b.forms.ended.as_slice() else {
        panic!("{:?}", b.forms.ended)
    };
    assert_eq!(e.how.as_str(), "left", "left at the move's phase end");
    b.c.release(body, walk).unwrap();
    b.clean();
}

/// #4187: a Soul's new act sent while its run is taking a seat or leaving one waits for that step to end (as a
/// cancel lets it), then the old run is left and the new one starts. The body is never left half seated: mid-sit it
/// ends in the seat, mid-rise standing at the seat's stand point, with no step between ticks longer than the seat's
/// own hand-off, and nothing of the old run left behind.
#[test]
fn i4187_a_new_act_waits_for_a_seat_taken_or_left_then_starts() {
    use skills::form_runner::Step;
    const CHAIR: &str = include_str!("../../../replica/fixtures/seats/chair.diag");
    let place = replica::moves::Place::from_value(
        &decode(&fixture_bytes(CHAIR).expect("bytes"))
            .expect("decodes")
            .value,
    )
    .expect("the chair's place");
    for mid in ["sit", "rise"] {
        let mut b = Bench::new();
        let chair = b.mint.mint().expect("id");
        let at = crate::slots::PlaceAt {
            thing: chair,
            place: place.clone(),
            point: Vec3::new(0, place.height, 0),
            facing: Quat::IDENTITY,
            floor: fixture(1),
            more: Vec::new(),
        };
        let stand = at.stand().expect("a stand point");
        let mut slots = crate::slots::Slots::new();
        slots.add(at).expect("a place");
        b.slots = Some(slots);
        let body = b.mint.mint().expect("id");
        let frame = Frame {
            node: fixture(1),
            slot: None,
        };
        let placed = b.surfaces[&fixture(1)]
            .place(body, frame, stand, Quat::IDENTITY)
            .expect("placed");
        b.c.add(family(), placed).expect("added");
        let sit = Step::Sit {
            slot: place.slot,
            lie: false,
            stand: false,
            on: None,
        };
        let (steps, posture) = match mid {
            "sit" => (vec![sit, Step::Wait(500_000)], 0),
            _ => (vec![sit, Step::Rise, Step::Wait(500_000)], 1),
        };
        let start = |b: &mut Bench, steps: Vec<Step>, intent: Intent| {
            b.look();
            let now = b.now;
            let (mut w, forms) = b.world();
            forms.start(
                &mut w,
                body,
                chair,
                intent,
                steps,
                Vec::new(),
                Limits::default(),
                now,
            )
        };
        start(&mut b, steps, intent(body, 0)).expect("started");
        let mut last = b.c.body(body).expect("a body").pose.position;
        let mut longest = 0;
        let mut track = |b: &Bench, longest: &mut i64| {
            let p = b.c.body(body).expect("a body").pose.position;
            let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
            let step =
                i64::try_from((d(p.x, last.x) + d(p.y, last.y) + d(p.z, last.z)).isqrt()).unwrap();
            *longest = (*longest).max(step);
            last = p;
        };
        while (b.moves.is_empty() || b.forms.at(body) != Some(posture)) && b.now < 30_000_000 {
            b.tick();
            track(&b, &mut longest);
        }
        assert!(!b.moves.is_empty(), "{mid}: the old run is mid-{mid}");
        let sent = b.now;
        let asked = start(&mut b, vec![Step::Wait(300_000)], intent(body, 1)).expect("accepted");
        let Asked::Started(new) = asked else {
            panic!("{asked:?}")
        };
        assert!(b.forms.ended.is_empty(), "{mid}: the {mid} runs on");
        while b.forms.ended.is_empty() && b.now < 30_000_000 {
            b.tick();
            track(&b, &mut longest);
        }
        let [left] = b.forms.ended.as_slice() else {
            panic!("{:?}", b.forms.ended)
        };
        let (how, ended) = (left.how.clone(), left.at);
        let pose = b.c.body(body).expect("a body").pose;
        let seated = b.slots.as_ref().and_then(|s| s.held_by(body));
        println!(
            "#4187 mid-{mid}: new act at {sent} µs; the old run left at {ended} µs, after its {mid}; body seated {:?}, \
             support {:?}, at {:?}; the new run open: {}",
            seated.is_some(),
            pose.support,
            pose.position,
            b.forms.due(new).is_some()
        );
        assert_eq!(how.as_str(), "left");
        assert!(ended > sent, "{mid}: the {mid} ran to its end first");
        assert!(
            b.forms.due(new).is_some(),
            "{mid}: the new run started as the old was left"
        );
        match mid {
            "sit" => {
                assert_eq!(seated, Some(chair), "in the slot, not half seated");
                assert_eq!(pose.support, replica::pose::Support::Slot);
            }
            _ => {
                assert_eq!(seated, None, "out of the slot");
                assert_ne!(pose.support, replica::pose::Support::Slot);
                assert_eq!(
                    (pose.position.x, pose.position.z),
                    (stand.x, stand.z),
                    "at the stand point"
                );
            }
        }
        b.forms.ended.clear();
        b.run(30_000_000);
        track(&b, &mut longest);
        let [e] = b.forms.ended.as_slice() else {
            panic!("{:?}", b.forms.ended)
        };
        assert_eq!(
            (e.run, e.how.as_str()),
            (new, "done"),
            "the new act runs to its end"
        );
        assert!(
            b.moves.is_empty() && b.due.is_empty(),
            "nothing of either run left"
        );
        let hand_off = {
            let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
            let p = Vec3::new(0, place.height, 0);
            i64::try_from((d(p.x, stand.x) + d(p.y, stand.y) + d(p.z, stand.z)).isqrt()).unwrap()
        };
        println!(
            "#4187 mid-{mid}: longest step between ticks {longest} µm; the slot's hand-off {hand_off} µm"
        );
        assert!(
            longest <= hand_off + 1,
            "{mid}: no jump beyond the slot's own hand-off"
        );
    }
}

/// 0.135 E13: a body in a seat of a thing acts on that thing from the seat. A form's approach walk to one of the
/// thing's points (a motorboat's key from its helm) is dropped, as it is for a move on the body itself (#4143), so the
/// seat's held legs never refuse it `resource-held`; the body stays seated. (Without the rule the walk starts: in a
/// world its legs refuse it `resource-held`; here, where the bench's tree has no chair, it ends `node-gone`.)
#[test]
fn e13_a_body_in_a_seat_of_the_thing_acts_without_an_approach_walk() {
    use skills::form_runner::Step;
    const CHAIR: &str = include_str!("../../../replica/fixtures/seats/chair.diag");
    let place = replica::moves::Place::from_value(
        &decode(&fixture_bytes(CHAIR).expect("bytes"))
            .expect("decodes")
            .value,
    )
    .expect("the chair's place");
    {
        let mut b = Bench::new();
        let chair = b.mint.mint().expect("id");
        let at = crate::slots::PlaceAt {
            thing: chair,
            place: place.clone(),
            point: Vec3::new(0, place.height, 0),
            facing: Quat::IDENTITY,
            floor: fixture(1),
            more: Vec::new(),
        };
        let stand = at.stand().expect("a stand point");
        let mut slots = crate::slots::Slots::new();
        slots.add(at).expect("a place");
        b.slots = Some(slots);
        let body = b.mint.mint().expect("id");
        let frame = Frame {
            node: fixture(1),
            slot: None,
        };
        let placed = b.surfaces[&fixture(1)]
            .place(body, frame, stand, Quat::IDENTITY)
            .expect("placed");
        b.c.add(family(), placed).expect("added");
        let start = |b: &mut Bench, steps: Vec<Step>, intent: Intent| {
            b.look();
            let now = b.now;
            let (mut w, forms) = b.world();
            forms.start(
                &mut w,
                body,
                chair,
                intent,
                steps,
                Vec::new(),
                Limits::default(),
                now,
            )
        };
        let sit = Step::Sit {
            slot: place.slot,
            lie: false,
            stand: false,
            on: None,
        };
        start(&mut b, vec![sit], intent(body, 0)).expect("started");
        b.run(30_000_000);
        let [e] = b.forms.ended.as_slice() else {
            panic!("{:?}", b.forms.ended)
        };
        assert_eq!(e.how.as_str(), "done", "seated");
        b.forms.ended.clear();
        // The approach walk the form runner puts before a move at one of the thing's points, 1 m from the stand point.
        let point = Vec3::new(stand.x + 1_000_000, stand.y, stand.z);
        let walk = Step::WalkTo {
            point: Name::new("key").expect("a name"),
            at: point,
            on: None,
            approach: true,
            face: None,
        };
        start(&mut b, vec![walk, Step::Wait(200_000)], intent(body, 1)).expect("started");
        b.run(30_000_000);
        let [e] = b.forms.ended.as_slice() else {
            panic!("{:?}", b.forms.ended)
        };
        let held = b.slots.as_ref().and_then(|s| s.held_by(body));
        println!(
            "E13: the seated body's act ended {}, body in {held:?}",
            e.how.as_str()
        );
        assert_eq!(e.how.as_str(), "done", "not resource-held");
        assert_eq!(held, Some(chair), "still in its place");
    }
}

/// #4143: a gesture whose move claims the legs (`content/moves/stretch.json`, `slump.json`) on a seated body. The
/// client's form rules say yes (the form has no posture need); the seat's hold on the legs refused the move
/// `resource-held`. A move made from a seat (`Move::seated`) leaves its legs to the seat: the run ends `done` and the
/// body is still seated. Any other move that claims the legs (a jump) is still refused `resource-held` by the seat's
/// hold, as a gateway sit writes no posture for the form's posture need to refuse it by.
#[test]
fn a_seated_stretch_is_made_from_the_seat_never_refused_resource_held() {
    use replica::bodies::Want;
    use skills::form_runner::Step;
    let (mut b, body, chair, slot, _) = seat_bench();
    let sit = Step::Sit {
        slot,
        lie: false,
        stand: false,
        on: None,
    };
    b.steps(body, chair, vec![sit], intent(body, 0), Limits::default())
        .expect("started");
    b.run(30_000_000);
    assert_eq!(
        b.forms.ended.pop().map(|e| e.how.as_str().to_owned()),
        Some("done".into())
    );
    // A stretch, made from a seat (`seated`), and a jump, not: hand moves that also claim and block the legs,
    // reaching anywhere the test's reach says (5 m).
    let press = b
        .library
        .iter()
        .find(|m| m.name.as_str() == "souls:press")
        .expect("press")
        .clone();
    for (n, seated) in [("test:stretch", true), ("test:jump", false)] {
        let mut mv = press.clone();
        mv.name = Name::new(n).expect("a name");
        mv.claims.push(Want::All(Class::Locomotion));
        mv.blocks.push(Class::Locomotion);
        mv.reach = 20_000_000;
        mv.seated = seated;
        b.library.push(mv);
    }
    b.snap.far = true;
    for (k, (n, how)) in [("test:jump", "resource-held"), ("test:stretch", "done")]
        .into_iter()
        .enumerate()
    {
        let mv = Step::Move {
            name: Name::new(n).expect("a name"),
            at: None,
            on: None,
            repeat: None,
        };
        let i = intent(body, 1 + k as u64);
        b.steps(body, body, vec![mv], i, Limits::default())
            .expect("started");
        b.run(30_000_000);
        let e = b.forms.ended.pop().expect("ended");
        let held = b.slots.as_ref().and_then(|s| s.held_by(body));
        println!(
            "#4143: seated, {n} ended {}, body in {held:?}",
            e.how.as_str()
        );
        assert_eq!(e.how.as_str(), how, "{n}");
        assert_eq!(held, Some(chair), "{n}: still seated");
    }
}

/// 0.135 E17: a form's own `walk_to` while the body is in a slot of the thing. A form that leaves the body there (a
/// phone box's `open` from inside: no rise, no sit) is done from inside: its own walk is dropped and the run ends
/// `done` with the body still in the slot, never refused `resource-held`. A form that moves the actor starts with the
/// rise its binding adds (`rises_out`): the rise move stands the body up at the seat's stand point, out of the slot,
/// before anything walks.
#[test]
fn e17_a_form_walk_from_inside_a_slot_is_done_from_inside_or_rises_first() {
    use skills::form_runner::Step;
    let (mut b, body, chair, slot, stand) = seat_bench();
    let sit = Step::Sit {
        slot,
        lie: false,
        stand: false,
        on: None,
    };
    b.steps(body, chair, vec![sit], intent(body, 0), Limits::default())
        .expect("started");
    b.run(30_000_000);
    assert_eq!(
        b.forms.ended.pop().map(|e| e.how.as_str().to_owned()),
        Some("done".into())
    );
    // The form's own walk to the doorway, 1 m off, then its move's time.
    let walk = Step::WalkTo {
        point: Name::new("doorway").expect("a name"),
        at: Vec3::new(stand.x, stand.y, stand.z + 1_000_000),
        on: None,
        approach: false,
        face: None,
    };
    b.steps(
        body,
        chair,
        vec![walk.clone(), Step::Wait(200_000)],
        intent(body, 1),
        Limits::default(),
    )
    .expect("started");
    b.run(30_000_000);
    let e = b.forms.ended.pop().expect("ended");
    assert_eq!(e.how.as_str(), "done", "not resource-held");
    let held = b.slots.as_ref().and_then(|s| s.held_by(body));
    assert_eq!(held, Some(chair), "done from inside, still in the slot");
    // A form that moves the actor rises first: out of the slot by the rise move, standing on the floor.
    b.steps(
        body,
        chair,
        vec![Step::Rise, Step::Wait(200_000)],
        intent(body, 2),
        Limits::default(),
    )
    .expect("started");
    b.run(30_000_000);
    let e = b.forms.ended.pop().expect("ended");
    assert_eq!(e.how.as_str(), "done");
    assert_eq!(b.slots.as_ref().and_then(|s| s.held_by(body)), None);
    let p = b.c.body(body).expect("a body").pose;
    assert!(
        matches!(p.support, replica::pose::Support::Surface { .. }),
        "on its feet"
    );
    assert_eq!(
        (p.position.x, p.position.z),
        (stand.x, stand.z),
        "at the stand point"
    );
}

/// Eden indoor audit (26 Nov): a body seated in a seat of one thing, asked a form at another thing that walks (the
/// lamp across the room, asked from the sofa), rises from its seat first and does it, as a person gets up to go; it
/// was refused `resource-held`, the seat holding its legs.
#[test]
fn a_seated_body_asked_a_form_elsewhere_that_walks_rises_first() {
    use skills::form_runner::Step;
    let (mut b, body, chair, slot, stand) = seat_bench();
    let sit = Step::Sit {
        slot,
        lie: false,
        stand: false,
        on: None,
    };
    b.steps(body, chair, vec![sit], intent(body, 0), Limits::default())
        .expect("started");
    b.run(30_000_000);
    assert_eq!(
        b.forms.ended.pop().map(|e| e.how.as_str().to_owned()),
        Some("done".into())
    );
    // A lamp 2 m off, with its switch: the form walks to the switch, then waits as its move would.
    let lamp = b.mint.mint().expect("id");
    let at = Vec3::new(stand.x, stand.y, stand.z + 2_000_000);
    b.snap.things.insert(
        lamp,
        (at, BTreeMap::from([("switch".to_owned(), Vec3::ZERO)])),
    );
    let walk = Step::WalkTo {
        point: Name::new("switch").expect("a name"),
        at: Vec3::ZERO,
        on: None,
        approach: true,
        face: None,
    };
    b.steps(
        body,
        lamp,
        vec![walk, Step::Wait(200_000)],
        intent(body, 1),
        Limits::default(),
    )
    .expect("started");
    b.run(30_000_000);
    let e = b.forms.ended.pop().expect("ended");
    assert_eq!(
        e.how.as_str(),
        "done",
        "risen and walked, not resource-held"
    );
    assert_eq!(
        b.slots.as_ref().and_then(|s| s.held_by(body)),
        None,
        "out of the chair"
    );
    assert!(
        matches!(
            b.c.body(body).expect("a body").pose.support,
            replica::pose::Support::Surface { .. }
        ),
        "on its feet"
    );
}

/// 0.135 E14: a form done at one thing takes a seat of another (a lecture's `attend` takes a bench's seat, the hall's
/// chairs) through the same places: the sit's hand-off puts the body in the chair, another body is refused the taken
/// seat by name, and the rise of the lecture's `leave` gives it back. A Soul that leaves mid-walk or mid-sit keeps no
/// seat: mid-sit the hand-off lands with no effect, so the run rises the body out onto the seat's stand point by B3's
/// rise and then ends `left`.
#[test]
fn e14_a_form_takes_and_gives_back_a_seat_of_another_thing() {
    use skills::form_runner::Step;
    let (mut b, body, chair, slot, stand) = seat_bench();
    // The body in a tree with a posture field (as `a_seat_taken_or_left_writes_the_bodys_posture` sets it up), so the
    // seat's sit and the back-out's rise write it.
    let kinds = parse_kinds(KINDS).expect("kinds");
    let full = |p: &str| {
        kinds
            .keys()
            .find(|k| replica::world_model::plain(k) == p)
            .expect("a kind")
            .clone()
    };
    let root = b.mint.mint().expect("id");
    let draft = replica::world_model::Draft {
        kinds: kinds.clone(),
        souls: Default::default(),
        audiences: BTreeMap::new(),
        nodes: vec![
            tree_node(root, full("souls:place"), None),
            tree_node(body, full("souls:body"), Some(root)),
        ],
        links: Vec::new(),
    };
    b.tree = Tree::load(&draft).expect("loads").0;
    b.forms.postures.insert(full("souls:body"), 28);
    // The lecture: a thing of its own, apart from the chair whose seat its form takes.
    let hall = b.mint.mint().expect("id");
    b.snap.things.insert(hall, (Vec3::ZERO, BTreeMap::new()));
    let sit = Step::Sit {
        slot,
        lie: false,
        stand: false,
        on: Some(chair),
    };
    let seated = |b: &Bench, who: Id| b.slots.as_ref().and_then(|s| s.held_by(who));
    let ended = |b: &mut Bench| {
        let [e] = b.forms.ended.as_slice() else {
            panic!("{:?}", b.forms.ended)
        };
        let how = e.how.as_str().to_owned();
        b.forms.ended.clear();
        how
    };
    let leave = |b: &mut Bench| {
        let now = b.now;
        let (mut w, forms) = b.world();
        forms.leave(&mut w, body, None, now).expect("left");
    };
    let walk = |at: Vec3| Step::WalkTo {
        point: Name::new("place").expect("a name"),
        at,
        on: None,
        approach: false,
        face: None,
    };
    // Leave mid-sit, before the hand-off: out again, at the stand point, nothing of the run left.
    b.steps(
        body,
        hall,
        vec![sit.clone()],
        intent(body, 1),
        Limits::default(),
    )
    .expect("started");
    b.until_moving(body, 0);
    leave(&mut b);
    b.run(30_000_000);
    let how = ended(&mut b);
    let pose = b.c.body(body).expect("a body").pose;
    println!(
        "E14 leave mid-sit: ended {how}; body in {:?}, support {:?}, at {:?}",
        seated(&b, body),
        pose.support,
        pose.position
    );
    assert_eq!(how, "left");
    assert_eq!(seated(&b, body), None, "no place kept");
    assert_ne!(pose.support, replica::pose::Support::Slot);
    assert_eq!((pose.position.x, pose.position.z), (stand.x, stand.z));
    assert!(
        b.moves.is_empty() && b.due.is_empty(),
        "nothing of the run left"
    );
    let postures: Vec<Value> = b
        .forms
        .out
        .drain(..)
        .filter_map(|e| match e.body {
            Body::Changes(cs) => Some(cs),
            _ => None,
        })
        .flatten()
        .filter_map(|c| match c.change {
            Change::Set {
                node,
                field: 28,
                to,
                ..
            } if node == body => Some(to),
            _ => None,
        })
        .collect();
    println!("E14 leave mid-sit: posture written {postures:?}");
    assert_eq!(
        postures,
        [
            Value::Text(super::name("sit")),
            Value::Text(super::name("stand"))
        ],
        "the body's posture reads standing once it stands"
    );
    b.clean();
    // Leave mid-walk: the walk to the seat ends with the run, and no seat is taken.
    let away = Vec3::new(stand.x, stand.y, stand.z + 2_000_000);
    b.steps(
        body,
        hall,
        vec![walk(away)],
        intent(body, 2),
        Limits::default(),
    )
    .expect("started");
    b.run(30_000_000);
    assert_eq!(ended(&mut b), "done", "walked away");
    let to_seat = vec![walk(stand), sit.clone()];
    b.steps(
        body,
        hall,
        to_seat.clone(),
        intent(body, 3),
        Limits::default(),
    )
    .expect("started");
    b.tick();
    b.tick();
    assert_eq!(b.forms.at(body), Some(0), "mid-walk");
    leave(&mut b);
    b.run(30_000_000);
    let how = ended(&mut b);
    println!(
        "E14 leave mid-walk: ended {how}; body in {:?}",
        seated(&b, body)
    );
    assert_eq!((how.as_str(), seated(&b, body)), ("left", None));
    b.clean();
    // Done: the body sits in the chair, a seat the run's own thing does not have.
    b.steps(body, hall, to_seat, intent(body, 4), Limits::default())
        .expect("started");
    b.run(30_000_000);
    let how = ended(&mut b);
    println!("E14 attend: ended {how}; body in {:?}", seated(&b, body));
    assert_eq!((how.as_str(), seated(&b, body)), ("done", Some(chair)));
    // Another body is refused the taken seat by name.
    let other = b.mint.mint().expect("id");
    let frame = Frame {
        node: fixture(1),
        slot: None,
    };
    let placed = b.surfaces[&fixture(1)]
        .place(
            other,
            frame,
            Vec3::new(stand.x + 1_000_000, stand.y, stand.z),
            Quat::IDENTITY,
        )
        .expect("placed");
    b.c.add(family(), placed).expect("added");
    b.steps(
        other,
        hall,
        vec![sit.clone()],
        intent(other, 1),
        Limits::default(),
    )
    .expect("started");
    b.run(30_000_000);
    let how = ended(&mut b);
    println!(
        "E14 the taken place: ended {how}; the other body in {:?}",
        seated(&b, other)
    );
    assert_eq!((how.as_str(), seated(&b, other)), ("place-taken", None));
    assert_eq!(seated(&b, body), Some(chair), "the first keeps its place");
    // The lecture's `leave`: its rise gives the seat back.
    b.steps(
        body,
        hall,
        vec![Step::Rise],
        intent(body, 5),
        Limits::default(),
    )
    .expect("started");
    b.run(30_000_000);
    let how = ended(&mut b);
    println!(
        "E14 leave the lecture: ended {how}; body in {:?}",
        seated(&b, body)
    );
    assert_eq!((how.as_str(), seated(&b, body)), ("done", None));
    b.clean();
}

/// A node of the test's tree, everyone's, with `fields`.
fn tree_node(id: Id, kind: String, parent: Option<Id>) -> replica::world_model::Node {
    replica::world_model::Node {
        id,
        kind,
        parent,
        slot: None,
        audience: replica::world_model::Audience::Everyone,
        fields: BTreeMap::new(),
    }
}

/// 0.135 E14 review: a slot argument on another thing is checked before the act starts, as the form's own thing is: a
/// private chair is refused `object.private` (as a bare sit on it is), another Soul's body `slot-of-a-body`, a slot the
/// thing neither declares nor holds as a seat `slot-unknown`, and a slot argument the form does not take as a slot
/// `arg-type`. A public chair's seat starts.
#[test]
fn e14_a_slot_of_another_thing_is_refused_when_private_a_body_or_undeclared() {
    use replica::world_model::{Draft, plain};
    use skills::form_runner::Arg;
    let (mut b, body, chair, slot, _) = seat_bench();
    let kinds = parse_kinds(KINDS).expect("kinds");
    let full = |p: &str| {
        kinds
            .keys()
            .find(|k| plain(k) == p)
            .expect("a kind")
            .clone()
    };
    let (root, hall, other) = (
        b.mint.mint().expect("id"),
        b.mint.mint().expect("id"),
        b.mint.mint().expect("id"),
    );
    let mut private = tree_node(chair, full("souls:sofa"), Some(root));
    private
        .fields
        .insert(replica::who_may::F_ACCESS, Value::Uint(2));
    let draft = |chair_node| Draft {
        kinds: kinds.clone(),
        souls: Default::default(),
        audiences: BTreeMap::new(),
        nodes: vec![
            tree_node(root, full("souls:place"), None),
            tree_node(body, full("souls:body"), Some(root)),
            tree_node(hall, full("souls:crate"), Some(root)),
            chair_node,
        ],
        links: Vec::new(),
    };
    let placed = b.surfaces[&fixture(1)]
        .place(
            other,
            Frame {
                node: fixture(1),
                slot: None,
            },
            Vec3::new(1_000_000, 0, 0),
            Quat::IDENTITY,
        )
        .expect("placed");
    b.c.add(family(), placed).expect("added");
    let entry = parse(
        r#"{ "format": "souls-entry/1", "kind": "test:lecture", "owner": "thing",
          "forms": {
            "attend": { "who": "anyone", "takes": { "spot": { "type": "slot" } },
              "steps": [{ "step": "sit", "slot": { "arg": "spot" } }] },
            "point_at": { "who": "anyone", "takes": { "spot": { "type": "thing" } },
              "steps": [{ "step": "wait", "us": 50000 }] } } }"#,
    )
    .expect("JSON");
    let mut n = 0;
    let mut ask = |b: &mut Bench, form: &str, arg: Arg| {
        n += 1;
        b.look();
        let now = b.now;
        let args = BTreeMap::from([("spot".to_owned(), arg)]);
        let (mut w, forms) = b.world();
        forms
            .commit_with(
                &mut w,
                &BTreeMap::new(),
                &|_| None,
                body,
                hall,
                &entry,
                form,
                &args,
                intent(body, n),
                Limits::default(),
                now,
            )
            .map(|_| ())
            .map_err(|r| r.name)
    };
    b.tree = Tree::load(&draft(private)).expect("loads").0;
    let private = ask(&mut b, "attend", Arg::Slot(chair, slot));
    let a_body = ask(&mut b, "attend", Arg::Slot(other, 1));
    b.tree = Tree::load(&draft(tree_node(chair, full("souls:sofa"), Some(root))))
        .expect("loads")
        .0;
    let undeclared = ask(&mut b, "attend", Arg::Slot(chair, slot + 7));
    let not_a_slot = ask(&mut b, "point_at", Arg::Slot(chair, slot));
    let public = ask(&mut b, "attend", Arg::Slot(chair, slot));
    println!(
        "E14 another thing's slot: private {private:?}, a body {a_body:?}, undeclared {undeclared:?}, \
         not taken as a slot {not_a_slot:?}, public {public:?}"
    );
    assert_eq!(private, Err("object.private"));
    assert_eq!(a_body, Err("slot-of-a-body"));
    assert_eq!(undeclared, Err("slot-unknown"));
    assert_eq!(not_a_slot, Err("arg-type"));
    assert_eq!(public, Ok(()));
    b.run(30_000_000);
    let [e] = b.forms.ended.as_slice() else {
        panic!("{:?}", b.forms.ended)
    };
    assert_eq!(e.how.as_str(), "done", "the public place is taken");
}

/// A bench with one chair (`fixtures/seats/chair.diag`) on the ground at the origin and one body standing at its stand
/// point: the bench, the body, the chair, its slot and its stand point.
fn seat_bench() -> (Bench, Id, Id, u64, Vec3) {
    const CHAIR: &str = include_str!("../../../replica/fixtures/seats/chair.diag");
    let place = replica::moves::Place::from_value(
        &decode(&fixture_bytes(CHAIR).expect("bytes"))
            .expect("decodes")
            .value,
    )
    .expect("the chair's place");
    let mut b = Bench::new();
    let chair = b.mint.mint().expect("id");
    let at = crate::slots::PlaceAt {
        thing: chair,
        place: place.clone(),
        point: Vec3::new(0, place.height, 0),
        facing: Quat::IDENTITY,
        floor: fixture(1),
        more: Vec::new(),
    };
    let stand = at.stand().expect("a stand point");
    let mut slots = crate::slots::Slots::new();
    slots.add(at).expect("a place");
    b.slots = Some(slots);
    let body = b.mint.mint().expect("id");
    let frame = Frame {
        node: fixture(1),
        slot: None,
    };
    let placed = b.surfaces[&fixture(1)]
        .place(body, frame, stand, Quat::IDENTITY)
        .expect("placed");
    b.c.add(family(), placed).expect("added");
    (b, body, chair, place.slot, stand)
}

impl Bench {
    /// Starts `steps` on `body` at `node` for `intent`, now.
    fn steps(
        &mut self,
        body: Id,
        node: Id,
        steps: Vec<skills::form_runner::Step>,
        intent: Intent,
        limits: Limits,
    ) -> Result<Asked, replica::effects::Refusal> {
        self.look();
        let now = self.now;
        let (mut w, forms) = self.world();
        forms.start(&mut w, body, node, intent, steps, Vec::new(), limits, now)
    }

    /// Ticks until `body`'s run is in step `at` with its move under way.
    fn until_moving(&mut self, body: Id, at: usize) {
        while (self.moves.is_empty() || self.forms.at(body) != Some(at)) && self.now < 30_000_000 {
            self.tick();
        }
        assert!(!self.moves.is_empty(), "the run is in its move");
    }
}

/// #4187 review: an act waiting on its body's seat step that is itself cancelled, or whose deadline passes, is left
/// alone and never starts. `worldd` does both through one call, the leave naming the act (`souls:cancel` names it by
/// its sequence; the deadline sweep by its id). The run it waited on goes on and ends `done`.
#[test]
fn i4187_a_waiting_act_cancelled_or_timed_out_never_starts() {
    use skills::form_runner::Step;
    for why in ["cancel", "deadline"] {
        let (mut b, body, chair, slot, _) = seat_bench();
        let sit = Step::Sit {
            slot,
            lie: false,
            stand: false,
            on: None,
        };
        let old = intent(body, 0);
        b.steps(
            body,
            chair,
            vec![sit, Step::Wait(500_000)],
            old,
            Limits::default(),
        )
        .expect("started");
        b.until_moving(body, 0);
        let waiting = intent(body, 1);
        let Asked::Started(new) = b
            .steps(
                body,
                chair,
                vec![Step::Wait(300_000)],
                waiting,
                Limits::default(),
            )
            .expect("accepted")
        else {
            panic!("a run number")
        };
        let now = b.now;
        {
            let (mut w, forms) = b.world();
            forms
                .leave(&mut w, body, Some(waiting.id), now)
                .expect("left");
        }
        let [e] = b.forms.ended.as_slice() else {
            panic!("{:?}", b.forms.ended)
        };
        assert_eq!(
            (e.run, e.how.as_str(), e.at),
            (new, "left", now),
            "{why}: the waiting act alone"
        );
        assert_eq!(b.forms.len(), 1, "{why}: the old run goes on");
        b.forms.ended.clear();
        b.run(30_000_000);
        let [e] = b.forms.ended.as_slice() else {
            panic!("{:?}", b.forms.ended)
        };
        println!(
            "#4187 {why}: the waiting act left at {now} µs; the old run ended {} at {} µs",
            e.how.as_str(),
            e.at
        );
        assert_eq!(
            e.how.as_str(),
            "done",
            "{why}: the old run ends by its own steps"
        );
        assert!(
            b.forms.late.is_empty(),
            "{why}: the waiting act never started"
        );
        assert_eq!(b.forms.due(new), None);
    }
}

/// E11b: a Soul that leaves its sit is never left half sat. Left mid-sit, the run ends `left` at the sit's contact with
/// the body in the slot and seated still, so a later rise is taken and completes, and the seat is free after it. Left
/// before the body reaches the slot (the sit's deadline passes first), the seat is given back and the body stands.
#[test]
fn e11b_a_leave_mid_sit_leaves_the_body_seated_or_the_seat_free() {
    use skills::form_runner::Step;
    for when in ["in-slot", "before-slot"] {
        let (mut b, body, chair, slot, _) = seat_bench();
        let sit = Step::Sit {
            slot,
            lie: false,
            stand: false,
            on: None,
        };
        let limits = match when {
            "in-slot" => Limits::default(),
            _ => Limits {
                step_move: 100_000,
                ..Limits::default()
            },
        };
        b.steps(
            body,
            chair,
            vec![sit, Step::Wait(500_000)],
            intent(body, 0),
            limits,
        )
        .expect("started");
        b.until_moving(body, 0);
        let now = b.now;
        {
            let (mut w, forms) = b.world();
            forms.leave(&mut w, body, None, now).expect("left");
        }
        b.run(30_000_000);
        let [e] = b.forms.ended.as_slice() else {
            panic!("{when}: {:?}", b.forms.ended)
        };
        assert_eq!(e.how.as_str(), "left", "{when}");
        let slots = b.slots.as_ref().expect("slots");
        let support = b.c.body(body).expect("a body").pose.support;
        println!(
            "E11b {when}: left at {} µs; slot held {:?}, holder {:?}, support {support:?}",
            e.at,
            slots.held_by(body),
            slots.holder_in(chair, slot)
        );
        assert!(b.moves.is_empty(), "{when}: the sit's move ended");
        if when == "before-slot" {
            assert_eq!(slots.held_by(body), None, "{when}: the slot given back");
            assert_eq!(slots.holder_in(chair, slot), None, "{when}: the slot free");
            assert_ne!(support, replica::pose::Support::Slot, "{when}: standing");
            b.clean();
            continue;
        }
        assert_eq!(slots.held_by(body), Some(chair), "{when}: seated still");
        assert_eq!(support, replica::pose::Support::Slot, "{when}: in the slot");
        b.forms.ended.clear();
        b.steps(body, chair, vec![Step::Rise], intent(body, 1), limits)
            .expect("the rise starts");
        b.run(30_000_000);
        let [e] = b.forms.ended.as_slice() else {
            panic!("{when}: {:?}", b.forms.ended)
        };
        assert_eq!(e.how.as_str(), "done", "{when}: the rise completes");
        let slots = b.slots.as_ref().expect("slots");
        assert_eq!(slots.held_by(body), None, "{when}: out of the slot");
        assert_eq!(slots.holder_in(chair, slot), None, "{when}: the slot free");
        assert_ne!(
            b.c.body(body).expect("a body").pose.support,
            replica::pose::Support::Slot
        );
        b.clean();
    }
}

/// E11c: a rise whose stand point is off the floor (here the floor is cut back to stop short of the seat's exit) is
/// refused at its contact, and its run ends there by the refusal's name, not at its deadline waiting on a move the
/// places cancelled. The body stays seated, and once the floor is back under the stand point the same rise completes.
#[test]
fn e11c_a_rise_with_its_stand_point_off_the_floor_ends_at_once_by_name() {
    use skills::form_runner::Step;
    let (mut b, body, chair, slot, stand) = seat_bench();
    let sit = Step::Sit {
        slot,
        lie: false,
        stand: false,
        on: None,
    };
    b.steps(body, chair, vec![sit], intent(body, 0), Limits::default())
        .expect("started");
    b.run(30_000_000);
    let [e] = b.forms.ended.as_slice() else {
        panic!("{:?}", b.forms.ended)
    };
    assert_eq!(e.how.as_str(), "done", "seated");
    b.forms.ended.clear();
    // The floor now ends 10 m behind the seat: its stand point (in front), every point out along its exit and any
    // floor a body could climb out to (E11d, 3 m) are off it.
    let whole = b.surfaces.remove(&fixture(1)).expect("the floor");
    let corners = vec![
        [-30_000, 0, -30_000],
        [30_000, 0, -30_000],
        [30_000, 0, -10_000],
        [-30_000, 0, -10_000],
    ];
    let cut = Surface::new(
        fixture(1),
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
            ground: crate::gaits::Ground::Dry,
        }],
    );
    assert!(stand.z > -7_000_000, "the stand point is off the cut floor");
    b.surfaces.insert(fixture(1), cut);
    let asked = b.now;
    b.steps(
        body,
        chair,
        vec![Step::Rise],
        intent(body, 1),
        Limits::default(),
    )
    .expect("the rise starts");
    b.run(30_000_000);
    let [e] = b.forms.ended.as_slice() else {
        panic!("{:?}", b.forms.ended)
    };
    println!(
        "E11c: the rise ended {} after {} µs",
        e.how.as_str(),
        e.at - asked
    );
    assert_eq!(e.how.as_str(), "off-surface", "ends by the refusal's name");
    assert!(
        e.at - asked < Limits::default().step_move / 2,
        "at its contact, not its deadline: {} µs",
        e.at - asked
    );
    let slots = b.slots.as_ref().expect("slots");
    assert_eq!(slots.held_by(body), Some(chair), "seated still");
    assert_eq!(slots.holder_in(chair, slot), Some(body));
    assert_eq!(
        b.c.body(body).expect("a body").pose.support,
        replica::pose::Support::Slot
    );
    assert!(b.moves.is_empty(), "the rise's move ended");
    b.forms.ended.clear();
    b.surfaces.insert(fixture(1), whole);
    b.steps(
        body,
        chair,
        vec![Step::Rise],
        intent(body, 2),
        Limits::default(),
    )
    .expect("the rise starts again");
    b.run(30_000_000);
    let [e] = b.forms.ended.as_slice() else {
        panic!("{:?}", b.forms.ended)
    };
    assert_eq!(e.how.as_str(), "done", "the floor back: the rise completes");
    let slots = b.slots.as_ref().expect("slots");
    assert_eq!(slots.holder_in(chair, slot), None, "the slot free");
    b.clean();
}

/// E11c review: a sit whose hand-off into the slot is refused at its contact (forced here: the body is already off
/// its surface when contact comes, `support-not-surface`) ends its run at once by that name, its move cancelled and
/// the seat given back: no seat is left held by a body that never got into it.
#[test]
fn e11c_a_sit_refused_into_its_slot_ends_by_name_and_frees_the_seat() {
    use skills::form_runner::Step;
    let (mut b, body, chair, slot, _) = seat_bench();
    let sit = Step::Sit {
        slot,
        lie: false,
        stand: false,
        on: None,
    };
    b.steps(body, chair, vec![sit], intent(body, 0), Limits::default())
        .expect("started");
    b.until_moving(body, 0);
    let d =
        *b.c.claims(body)
            .expect("a body")
            .running()
            .keys()
            .next()
            .expect("the sit's driver");
    let frame = Frame {
        node: chair,
        slot: Some(slot),
    };
    let asked = b.now;
    b.c.slot_in(body, d, frame, asked)
        .expect("off its surface before contact");
    b.run(30_000_000);
    let [e] = b.forms.ended.as_slice() else {
        panic!("{:?}", b.forms.ended)
    };
    assert_eq!(
        e.how.as_str(),
        "support-not-surface",
        "ends by the refusal's name"
    );
    assert!(
        e.at - asked < Limits::default().step_move / 2,
        "at its contact, not its deadline: {} µs",
        e.at - asked
    );
    let slots = b.slots.as_ref().expect("slots");
    assert_eq!(slots.held_by(body), None, "the slot given back");
    assert_eq!(slots.holder_in(chair, slot), None, "the slot free");
    b.clean();
}

/// #4187 review: a take that waited on its body's seat step, behind a long walk (20 m, well past an act's 10 s), is
/// listed as started late when its run starts, so `worldd` gives it its run's own deadline (its start plus its
/// steps' span) and its progress answer then; it runs to its end.
#[test]
fn i4187_a_late_start_has_its_runs_deadline_behind_a_long_walk() {
    use skills::form_runner::Step;
    let (entry, form) = entries().remove(0);
    let (mut b, body, chair, slot, stand) = seat_bench();
    let thing = b.mint.mint().expect("id");
    b.snap.things.insert(
        thing,
        (Vec3::new(stand.x, 0, stand.z + 20_000_000), points(&entry)),
    );
    let limits = Limits {
        walk: 120_000_000,
        ..Limits::default()
    };
    let sit = Step::Sit {
        slot,
        lie: false,
        stand: false,
        on: None,
    };
    b.steps(body, chair, vec![sit, Step::Rise], intent(body, 0), limits)
        .expect("started");
    b.until_moving(body, 1);
    let sent = b.now;
    let take = bind(&entry, &form).expect("binds");
    let span = super::span(&take, &limits);
    let Asked::Started(new) = b
        .steps(body, thing, take, intent(body, 1), limits)
        .expect("accepted")
    else {
        panic!("a run number")
    };
    assert_eq!(b.forms.due(new), None, "waiting: no run yet");
    while b.forms.late.is_empty() && b.now < 30_000_000 {
        b.tick();
    }
    // The old run's rise was its last step: it ends by its own steps, and the take starts in that instant.
    let [old] = b.forms.ended.as_slice() else {
        panic!("{:?}", b.forms.ended)
    };
    assert!(old.at > sent, "after the rise");
    let started = old.at;
    assert_eq!(
        std::mem::take(&mut b.forms.late),
        vec![new],
        "listed as started late"
    );
    let due = b.forms.due(new).expect("its run");
    println!(
        "#4187 late start: sent at {sent} µs, started at {started} µs, due {due} µs (span {span} µs, past 10 s: {})",
        span > 10_000_000
    );
    assert_eq!(due, started + span, "its run's own deadline from its start");
    assert!(span > 10_000_000, "a take behind a walk past an act's 10 s");
    b.forms.ended.clear();
    b.run(started + span + 1);
    let [e] = b.forms.ended.as_slice() else {
        panic!("{:?}", b.forms.ended)
    };
    println!(
        "#4187 late start: the take ended {} at {} µs",
        e.how.as_str(),
        e.at
    );
    assert_eq!((e.run, e.how.as_str()), (new, "done"));
    assert!(
        e.at > sent + 10_000_000,
        "it ran past the 10 s an act gets on arrival"
    );
}

/// 0.132 A1-5: a seat a thing's form takes writes the body's `posture` field (the slot's `sit`, or `lie`), and its
/// rise writes `stand`, so the body's own `stand` (which needs its posture not `stand`) is run while it sits. A body's
/// own form writes its posture in its own effects: its rise writes nothing here.
#[test]
fn a_seat_taken_or_left_writes_the_bodys_posture() {
    use replica::world_model::{Audience, Draft, Node, plain};
    use skills::form_runner::Step;
    let kinds = parse_kinds(KINDS).expect("kinds");
    let full = |p: &str| {
        kinds
            .keys()
            .find(|k| plain(k) == p)
            .expect("a kind")
            .clone()
    };
    let cases = [
        ("sit", false, false, vec!["sit", "stand"]),
        ("lie", true, false, vec!["lie", "stand"]),
        ("own rise", false, true, vec!["sit"]),
    ];
    for (case, lie, own_rise, want) in cases {
        let (mut b, body, chair, slot, _) = seat_bench();
        let root = b.mint.mint().expect("id");
        let node = |id, kind, parent| Node {
            id,
            kind,
            parent,
            slot: None,
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        };
        let draft = Draft {
            kinds: kinds.clone(),
            souls: Default::default(),
            audiences: BTreeMap::new(),
            nodes: vec![
                node(root, full("souls:place"), None),
                node(body, full("souls:body"), Some(root)),
            ],
            links: Vec::new(),
        };
        b.tree = Tree::load(&draft).expect("loads").0;
        b.forms.postures.insert(full("souls:body"), 28);
        let sit = Step::Sit {
            slot,
            lie,
            stand: false,
            on: None,
        };
        let mut written = Vec::new();
        let mut run = |b: &mut Bench, node, steps, n| {
            b.steps(body, node, steps, intent(body, n), Limits::default())
                .expect("started");
            while !b.forms.is_empty() && b.now < 30_000_000 {
                b.tick();
                for e in b.forms.out.drain(..) {
                    let Body::Changes(cs) = e.body else { continue };
                    for c in cs {
                        if let Change::Set {
                            node,
                            field: 28,
                            to,
                            ..
                        } = c.change
                        {
                            assert_eq!(node, body, "{case}: on the body");
                            written.push(to);
                        }
                    }
                }
            }
        };
        if own_rise {
            run(&mut b, chair, vec![sit], 0);
            run(&mut b, body, vec![Step::Rise], 1);
        } else {
            run(&mut b, chair, vec![sit, Step::Rise], 0);
        }
        let want: Vec<_> = want.iter().map(|w| Value::Text(super::name(w))).collect();
        assert_eq!(written, want, "{case}");
        assert!(
            b.slots.as_ref().and_then(|s| s.held_by(body)).is_none(),
            "{case}: out of the slot"
        );
    }
}

/// E11d through a form run: the floor now ends 2 m behind the seat, so the stand point and the short search beside it
/// are off it but floor lies within the climb-out bound, across the seat's thing's own box. The rise ends `done`, the body climbs out (named once) and
/// stands on that floor, its seat free, and nothing is left over.
#[test]
fn e11d_a_rise_with_floor_behind_the_seat_climbs_out_and_ends_done() {
    use skills::form_runner::Step;
    let (mut b, body, chair, slot, _) = seat_bench();
    let sit = Step::Sit {
        slot,
        lie: false,
        stand: false,
        on: None,
    };
    b.steps(body, chair, vec![sit], intent(body, 0), Limits::default())
        .expect("started");
    b.run(30_000_000);
    b.forms.ended.clear();
    // The seat's thing reaches back to the floor's new edge: its own box is what the climb passes over.
    let slots = b.slots.as_mut().expect("slots");
    let p = slots.held_place(body).expect("seated").point;
    let (x0, x1, z1) = (p.x - 1_000_000, p.x + 1_000_000, p.z + 500_000);
    slots.footprint(
        chair,
        vec![[[x0, -2_100_000], [x1, -2_100_000], [x1, z1], [x0, z1]]],
    );
    let corners = vec![
        [-30_000, 0, -30_000],
        [30_000, 0, -30_000],
        [30_000, 0, -2_000],
        [-30_000, 0, -2_000],
    ];
    b.surfaces.insert(
        fixture(1),
        Surface::new(
            fixture(1),
            vec![Piece {
                outline: vec![corners.clone()],
                vertices: corners,
                triangles: vec![[0, 2, 1], [0, 3, 2]],
                ground: crate::gaits::Ground::Dry,
            }],
        ),
    );
    b.steps(
        body,
        chair,
        vec![Step::Rise],
        intent(body, 1),
        Limits::default(),
    )
    .expect("the rise starts");
    b.run(30_000_000);
    let [e] = b.forms.ended.as_slice() else {
        panic!("{:?}", b.forms.ended)
    };
    assert_eq!(e.how.as_str(), "done", "risen");
    let slots = b.slots.as_mut().expect("slots");
    assert_eq!(slots.holder_in(chair, slot), None, "the slot free");
    assert_eq!(slots.climbs().len(), 1, "one climb out");
    let p = b.c.body(body).expect("a body").pose;
    assert!(
        matches!(p.support, replica::pose::Support::Surface { .. }) && p.position.z <= -2_000_000,
        "on the floor behind the slot: {p:?}"
    );
    assert!(!b.c.carried(body), "landed");
    b.clean();
}

/// #4575: a two-seat bench (the chair fixture's seat, and a second 800 mm to its side) and two bodies, Ada and Bea,
/// each standing at one seat's stand point: the bench, its two slots, and the two bodies.
fn two_seat_bench() -> (Bench, Id, [u64; 2], Id, Id) {
    let (mut b, ada, bench, slot, _) = seat_bench();
    let first = b
        .slots
        .as_ref()
        .and_then(|s| s.place_in(bench, slot))
        .expect("the first place")
        .clone();
    let mut second = first.clone();
    second.place.slot = slot + 1;
    second.point = Vec3::new(first.point.x + 800_000, first.point.y, first.point.z);
    let stand = second.stand().expect("a stand point");
    b.slots
        .as_mut()
        .expect("slots")
        .add(second)
        .expect("a place");
    let bea = b.mint.mint().expect("id");
    let frame = Frame {
        node: fixture(1),
        slot: None,
    };
    let placed = b.surfaces[&fixture(1)]
        .place(bea, frame, stand, Quat::IDENTITY)
        .expect("placed");
    b.c.add(family(), placed).expect("added");
    (b, bench, [slot, slot + 1], ada, bea)
}

/// A sit in `slot` of the thing, then a short wait.
fn sit_at(slot: u64) -> Vec<skills::form_runner::Step> {
    use skills::form_runner::Step;
    vec![
        Step::Sit {
            slot,
            lie: false,
            stand: false,
            on: None,
        },
        Step::Wait(500_000),
    ]
}

/// #4575, the bug seen on Eden: two Souls sit on one two-seat bench at the same moment. Each run reserves only the
/// seat it takes, so the second is not refused `thing-reserved` for the first's run; both end `done`, each in its
/// own seat, and nothing is reserved after.
#[test]
fn i4575_two_souls_sit_on_one_bench_at_once() {
    let (mut b, bench, [left, right], ada, bea) = two_seat_bench();
    let limits = Limits::default();
    let first = b.steps(ada, bench, sit_at(left), intent(ada, 0), limits);
    let second = b.steps(bea, bench, sit_at(right), intent(bea, 0), limits);
    println!("#4575 at once: Ada {first:?}, Bea {second:?}");
    assert!(matches!(first, Ok(Asked::Started(_))), "{first:?}");
    assert!(matches!(second, Ok(Asked::Started(_))), "{second:?}");
    assert_eq!(b.forms.seat_holders(bench, left), vec![ada]);
    assert_eq!(b.forms.seat_holders(bench, right), vec![bea]);
    b.run(30_000_000);
    let hows: Vec<_> = b
        .forms
        .ended
        .iter()
        .map(|e| (e.body, e.how.as_str().to_owned()))
        .collect();
    println!("#4575 at once: ended {hows:?}");
    assert_eq!(hows.len(), 2);
    assert!(hows.iter().all(|(_, how)| how == "done"), "{hows:?}");
    let slots = b.slots.as_ref().expect("slots");
    assert_eq!(slots.holder_in(bench, left), Some(ada));
    assert_eq!(slots.holder_in(bench, right), Some(bea));
    assert_eq!(b.forms.holder(bench), None, "nothing reserved after");
    b.clean();
}

/// #4575: two Souls racing for the same seat. The first's run reserves it; the second is refused `place-taken`,
/// naming the first, and takes the other seat while the first's run goes on. A run that ends before its body reaches
/// its seat gives the reservation back with it, so the seat is never held by nobody: the next Soul takes it.
#[test]
fn i4575_two_souls_racing_for_one_seat_one_wins_the_other_is_refused_place_taken() {
    let (mut b, bench, [left, right], ada, bea) = two_seat_bench();
    let limits = Limits::default();
    b.steps(ada, bench, sit_at(left), intent(ada, 0), limits)
        .expect("Ada's sit starts");
    let lost = b
        .steps(bea, bench, sit_at(left), intent(bea, 0), limits)
        .expect_err("refused");
    println!("#4575 race: Bea {}: {}", lost.name, lost.detail);
    assert_eq!(lost.name, "place-taken");
    assert!(lost.detail.contains(&replica::world_model::show(ada)));
    assert_eq!(b.forms.seat_holders(bench, left), vec![ada]);
    let other = b.steps(bea, bench, sit_at(right), intent(bea, 1), limits);
    assert!(matches!(other, Ok(Asked::Started(_))), "{other:?}");
    b.run(30_000_000);
    assert!(
        b.forms.ended.iter().all(|e| e.how.as_str() == "done"),
        "{:?}",
        b.forms.ended
    );
    let slots = b.slots.as_ref().expect("slots");
    assert_eq!(
        (slots.holder_in(bench, left), slots.holder_in(bench, right)),
        (Some(ada), Some(bea))
    );
    b.clean();

    // Ada's run is left mid-sit: she ends in the seat (E11b), so the seat is held by her body, not by nobody, and
    // Bea's sit of it ends by the same name. A sit that ends before its body reaches the seat gives the seat and its
    // reservation back with the run, and Ada takes the seat.
    let (mut b, bench, [left, _], ada, bea) = two_seat_bench();
    b.steps(ada, bench, sit_at(left), intent(ada, 0), limits)
        .expect("Ada's sit starts");
    let now = b.now;
    {
        let (mut w, forms) = b.world();
        forms.leave(&mut w, ada, None, now).expect("left");
    }
    b.run(30_000_000);
    assert_eq!(b.forms.seat_holders(bench, left), Vec::<Id>::new());
    assert_eq!(
        b.slots.as_ref().expect("slots").holder_in(bench, left),
        Some(ada)
    );
    b.forms.ended.clear();
    b.steps(bea, bench, sit_at(left), intent(bea, 0), limits)
        .expect("Bea's sit starts");
    b.run(30_000_000);
    let how: Vec<_> = b
        .forms
        .ended
        .iter()
        .map(|e| e.how.as_str().to_owned())
        .collect();
    println!("#4575 race: Ada left mid-sit, seated; Bea's sit ended {how:?}");
    assert_eq!(how, vec!["place-taken".to_owned()]);

    let (mut b, bench, [left, _], ada, bea) = two_seat_bench();
    // Bea, at the other seat's stand point, is out of this one's reach: her sit ends before she is in it.
    b.steps(bea, bench, sit_at(left), intent(bea, 0), limits)
        .expect("Bea's sit starts");
    b.run(30_000_000);
    let ended: Vec<_> = b
        .forms
        .ended
        .iter()
        .map(|e| e.how.as_str().to_owned())
        .collect();
    println!("#4575 race: Bea's sit ended before the place:{ended:?}");
    assert_ne!(ended, vec!["done".to_owned()]);
    assert_eq!(b.forms.seat_holders(bench, left), Vec::<Id>::new());
    assert_eq!(
        b.slots.as_ref().expect("slots").holder_in(bench, left),
        None
    );
    let taken = b.steps(ada, bench, sit_at(left), intent(ada, 0), limits);
    println!("#4575 race: then Ada {taken:?}");
    assert!(matches!(taken, Ok(Asked::Started(_))), "{taken:?}");
    b.run(60_000_000);
    assert_eq!(
        b.slots.as_ref().expect("slots").holder_in(bench, left),
        Some(ada)
    );
    b.clean();
}

/// #4575: a sit and a pick-up of the bench. A pick-up (a take of the thing into a hand) needs the whole thing: while
/// Ada's sit holds a seat it is refused `thing-reserved` naming her, and while Bea's pick-up holds the bench Ada's
/// sit is refused the same way, naming Bea.
#[test]
fn i4575_a_sit_and_a_pick_up_of_the_bench_one_holds_it_the_other_is_refused() {
    use skills::form_runner::{Effect, Of, Step};
    type Form = (Vec<Step>, Vec<Effect>);
    let pick_up = || -> Form {
        (
            vec![Step::Wait(1_000_000), Step::Hand],
            vec![Effect::Take { what: Of::This }],
        )
    };
    let limits = Limits::default();
    let start = |b: &mut Bench, body: Id, node: Id, (steps, effects): Form| {
        b.look();
        let now = b.now;
        let (mut w, forms) = b.world();
        forms.start(
            &mut w,
            body,
            node,
            intent(body, 0),
            steps,
            effects,
            limits,
            now,
        )
    };

    // The sit first.
    let (mut b, bench, [left, _], ada, bea) = two_seat_bench();
    start(&mut b, ada, bench, (sit_at(left), Vec::new())).expect("Ada's sit starts");
    let r = start(&mut b, bea, bench, pick_up()).expect_err("refused");
    println!("#4575 sit, then pick-up: {}: {}", r.name, r.detail);
    assert_eq!(r.name, "thing-reserved");
    assert!(r.detail.contains(&replica::world_model::show(ada)));

    // The pick-up first.
    let (mut b, bench, [left, _], ada, bea) = two_seat_bench();
    start(&mut b, bea, bench, pick_up()).expect("Bea's pick-up starts");
    assert_eq!(b.forms.holder(bench), Some(bea));
    let r = start(&mut b, ada, bench, (sit_at(left), Vec::new())).expect_err("refused");
    println!("#4575 pick-up, then sit: {}: {}", r.name, r.detail);
    assert_eq!(r.name, "thing-reserved");
    assert!(r.detail.contains(&replica::world_model::show(bea)));
}

/// #4575, the rule per form, on content's own entries as bound: a bench's sit and a locomotive's board take a seat
/// and reserve only it; a locomotive's drive also sets its fields, so it reserves the whole thing.
#[test]
fn i4575_a_form_that_only_takes_a_seat_reserves_the_seat() {
    use skills::form_runner::{Arg, Args, bind_effects_args, bind_with};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let entry =
        |f: &str| parse(&std::fs::read_to_string(root.join(f)).expect("read")).expect("JSON");
    let node = fixture(7);
    for (file, form, place, whole) in [
        ("seating/bench.json", "sit", "left", false),
        ("vehicles/locomotive.json", "board", "fireman", false),
        ("vehicles/locomotive.json", "drive", "driver", true),
    ] {
        let e = entry(file);
        // The form's one slot argument, by the name its entry gives it.
        let arg = e
            .get("forms")
            .and_then(|f| f.get(form))
            .and_then(|f| f.get("takes"))
            .and_then(json::Value::obj)
            .and_then(|t| {
                t.iter()
                    .find(|(_, t)| t.get("type").and_then(json::Value::str) == Some("slot"))
            })
            .map(|(k, _)| k.clone())
            .expect("a slot argument");
        let args = Args::from([(arg, Arg::Name(place.to_owned()))]);
        let steps = bind_with(&e, form, &args).expect("binds");
        let effects = bind_effects_args(&e, form, &args).expect("binds");
        let taken = super::slots_taken(node, &steps, &effects, false);
        println!("#4575 {file} {form}: slots reserved {taken:?} (empty: the whole thing)");
        assert_eq!(taken.is_empty(), whole, "{file} {form}: {effects:?}");
    }
}

/// #4575 review: a seat run whose seat is on another thing (E14, a lecture's `attend` on a bench) holds its own thing
/// shared. A whole-thing form at the lecture (its `finish`) is refused `thing-reserved` naming the attendee while the
/// attend runs, a second attendee is not kept from the other seat by it, and once both have sat the finish starts.
#[test]
fn i4575_e14_a_whole_thing_form_at_a_lecture_is_refused_while_it_is_attended() {
    use skills::form_runner::Step;
    let (mut b, bench, [left, right], ada, bea) = two_seat_bench();
    let lecture = b.mint.mint().expect("id");
    b.snap.things.insert(lecture, (Vec3::ZERO, BTreeMap::new()));
    let attend = |slot| {
        vec![
            Step::Sit {
                slot,
                lie: false,
                stand: false,
                on: Some(bench),
            },
            Step::Wait(500_000),
        ]
    };
    let limits = Limits::default();
    b.steps(ada, lecture, attend(left), intent(ada, 0), limits)
        .expect("Ada's attend starts");
    assert_eq!(b.forms.holder(lecture), Some(ada));
    let finish = b
        .steps(
            bea,
            lecture,
            vec![Step::Wait(300_000)],
            intent(bea, 0),
            limits,
        )
        .expect_err("refused");
    println!(
        "#4575 E14 finish while attended: {}: {}",
        finish.name, finish.detail
    );
    assert_eq!(finish.name, "thing-reserved");
    assert!(finish.detail.contains(&replica::world_model::show(ada)));
    let second = b.steps(bea, lecture, attend(right), intent(bea, 1), limits);
    assert!(matches!(second, Ok(Asked::Started(_))), "{second:?}");
    b.run(30_000_000);
    assert!(
        b.forms.ended.iter().all(|e| e.how.as_str() == "done"),
        "{:?}",
        b.forms.ended
    );
    assert_eq!(b.forms.holder(lecture), None, "nothing held after");
    let later = b.steps(
        bea,
        lecture,
        vec![Step::Wait(300_000)],
        intent(bea, 2),
        limits,
    );
    assert!(matches!(later, Ok(Asked::Started(_))), "{later:?}");
}

/// #4575 review: the lecture removed (its `lapse`, or a god delete) while an attend runs ends the attend `thing-gone`:
/// its seat's reservation and the lecture's shared hold go with it, its sit's move is cut so the seat is given back,
/// and nothing of the run is left.
#[test]
fn i4575_e14_a_lecture_removed_mid_attend_ends_it_and_frees_the_seat() {
    use skills::form_runner::Step;
    let (mut b, bench, [left, _], ada, _) = two_seat_bench();
    let lecture = b.mint.mint().expect("id");
    b.snap.things.insert(lecture, (Vec3::ZERO, BTreeMap::new()));
    let attend = vec![
        Step::Sit {
            slot: left,
            lie: false,
            stand: false,
            on: Some(bench),
        },
        Step::Wait(500_000),
    ];
    b.steps(ada, lecture, attend, intent(ada, 0), Limits::default())
        .expect("Ada's attend starts");
    let now = b.now;
    {
        let (mut w, forms) = b.world();
        forms.gone(&mut w, lecture, now);
    }
    let hows: Vec<_> = b
        .forms
        .ended
        .iter()
        .map(|e| (e.body, e.how.as_str().to_owned()))
        .collect();
    println!("#4575 E14 lecture removed mid-attend: ended {hows:?}");
    assert_eq!(hows, vec![(ada, "thing-gone".to_owned())]);
    assert!(b.forms.is_empty(), "no run left");
    assert_eq!(b.forms.holder(lecture), None);
    assert_eq!(b.forms.seat_holders(bench, left), Vec::<Id>::new());
    b.run(30_000_000);
    assert_eq!(
        b.slots.as_ref().expect("slots").holder_in(bench, left),
        None,
        "the place given back"
    );
    b.clean();
}

/// 0.135: a form's walk ends facing the way its stand point says, however the walk came in: the campfire's `warm`
/// walks to its `stand` (1.1 m in front of the fire, `yaw_mdeg` 180, facing it). From 4 m to the side of the stand
/// point the walk comes in across the fire's front; there, the body faces the fire, not the way it walked. Turned 90
/// degrees (C13), the fire's stand point and its facing turn with it.
#[test]
fn a_forms_walk_ends_facing_the_way_its_stand_point_says() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let entry = parse(&std::fs::read_to_string(root.join("camp/campfire.json")).expect("read"))
        .expect("JSON");
    for (turned, start, want) in [
        (0, Vec3::new(4_000_000, 0, 1_100_000), (0, -1_000_000)),
        (90_000, Vec3::new(1_100_000, 0, -4_000_000), (-1_000_000, 0)),
    ] {
        let mut b = Bench::new();
        let (body, node) = b.add(&entry, start, Vec3::ZERO);
        let mut steps = bind(&entry, "warm").expect("binds");
        let q = Quat::from_yaw_mdeg(turned).expect("a turn");
        skills::form_runner::turn(&mut steps, q).expect("turns");
        b.look();
        let now = b.now;
        {
            let (mut w, forms) = b.world();
            forms
                .start(
                    &mut w,
                    body,
                    node,
                    intent(body, 0),
                    steps,
                    Vec::new(),
                    Limits::default(),
                    now,
                )
                .expect("started");
        }
        // the walk (about 4 m) is done well inside 8 s; the form then waits 20 s at the fire
        while b.now < 8_000_000 {
            b.tick();
        }
        // the body's facing (its +x turned), on the level, 1 m long
        let m = b.c.bodies().find(|x| x.id == body).expect("the body");
        let f = m
            .pose
            .orientation
            .rotate(Vec3::new(1_000_000, 0, 0))
            .expect("turns");
        let at = m.pose.position;
        println!(
            "turned {turned} mdeg: stands at ({}, {}) mm, faces ({}, {})",
            at.x / 1000,
            at.z / 1000,
            f.x,
            f.z
        );
        let off = (i128::from(f.x - want.0).pow(2) + i128::from(f.z - want.1).pow(2)).isqrt();
        assert!(
            off < 20_000,
            "faces the fire, not the way it walked: ({}, {}), {off} um off at 1 m",
            f.x,
            f.z
        );
    }
}
