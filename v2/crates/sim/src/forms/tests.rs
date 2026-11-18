//! F1's runs in the world (#2766): every kind in the runner's `kinds/` folder has its three-step form run on a body
//! of the fixtures' family, on the controller, the due list and B2's moves, and every run reaches a named end: done,
//! a passed deadline, a move out of reach. No kind, form or move is named here: each run is over the folder's files.

use std::collections::BTreeMap;
use std::path::Path;

use replica::bodies::{Class, Family};
use replica::effects::fixture_bytes;
use replica::encode::{Name, Value, decode};
use replica::host::{Answer, Ask, Seen};
use replica::ids::{Id, Minter, Scope};
use replica::moves::{Effector, Move};
use replica::pose::{Frame, Quat, Vec3, fixture};
use replica::rules::json::{self, parse};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::{parse_kinds, parse_world};
use skills::form_runner::{Limits, bind};

use super::{Forms, World};
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
        let steps = bind(entry, form).expect("binds");
        self.look();
        let now = self.now;
        let (mut w, forms) = self.world();
        forms
            .start(&mut w, body, node, steps, limits, now)
            .expect("started");
    }

    /// One tick: the skills' phase (the walks), the controller's step, then every timer due before the next tick.
    fn tick(&mut self) {
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
    let steps = bind(&entry, &form).expect("binds");
    let (mut w, forms) = b.world();
    let r = forms
        .start(&mut w, body, node, steps, Limits::default(), 0)
        .expect_err("refused");
    assert_eq!(r.name, "form-running");
}
