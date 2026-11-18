//! F1's runs in the world (#2766): every kind in the runner's `kinds/` folder has its three-step form run on a body
//! of the fixtures' family, on the controller, the due list and B2's moves, and every run reaches a named end: done,
//! a passed deadline, a move out of reach. No kind, form or move is named here: each run is over the folder's files.

use std::collections::BTreeMap;
use std::path::Path;

use replica::bodies::{Class, Family};
use replica::effects::fixture_bytes;
use replica::effects::{Actor, Body, Cause, Change, Effect};
use replica::encode::{Name, Value, decode};
use replica::host::{Answer, Ask, Seen};
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
}

impl Geometry for Snap {
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
        let effects = bind_effects(entry, form).unwrap_or_default();
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

    // A second form on a body with one in progress is refused by name.
    let mut b = Bench::new();
    let (body, node) = b.add(&entry, Vec3::new(0, 0, 3_000_000), Vec3::ZERO);
    b.start(body, node, &entry, &form, Limits::default());
    let r = b
        .ask(
            body,
            node,
            &entry,
            &form,
            Limits::default(),
            intent(body, 1),
        )
        .expect_err("refused");
    assert_eq!(r.name, "form-running");
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
        .find(|(e, f)| bind_effects(e, f).is_ok_and(|x| !x.is_empty()))
        .expect("a kind whose effects bind")
}

/// `entry` with every `move` step taken out of its forms: a form with no hand step.
fn without_moves(v: &json::Value) -> json::Value {
    match v {
        json::Value::Obj(o) => json::Value::Obj(
            o.iter()
                .map(|(k, x)| match (k.as_str(), x) {
                    ("steps", json::Value::Arr(s)) => (
                        k.clone(),
                        json::Value::Arr(
                            s.iter()
                                .filter(|st| {
                                    st.get("step").and_then(json::Value::str) != Some("move")
                                })
                                .cloned()
                                .collect(),
                        ),
                    ),
                    _ => (k.clone(), without_moves(x)),
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
    let pause = 2_000_000;
    for (case, entry, before_end) in [
        // The press's recovery (300 ms) and the pause come after contact.
        ("at the hand step's contact", entry.clone(), 300_000 + pause),
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
    let ns = kind.split(':').next().expect("a namespace");
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
                format!("{ns}:owner"),
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
