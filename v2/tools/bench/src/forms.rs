//! The `forms` bench (Engine v2 F1, #2766), by B2's measure (`moves`, #2681): 1,000 bodies of the fixtures'
//! two-handed family on open ground, each tick the forms' part (the walks runs started), the controller's step and
//! the due list's timers. Arm `idle` starts no form; arm `forms` starts the form runner on every body, each on a thing
//! of a kind in the runner's `kinds/` folder (in turn), its first form: walk to the stand point, press, pause. Each
//! body stands at its thing's stand point, so its walk ends at once. Only ticks with every run in progress and no
//! step at a boundary (no timer due, no walk going) are timed, and both arms time the same ticks: the press's phases
//! and the pause, steps in progress. A third arm, `moves`, starts the same moves on every body directly (B2's
//! `Moves::start`, no runner), so the runner's share is told from the moves' own. No kind, form or move is named: they
//! come from the folder and the fixtures. Two repeats. Declared on #2766. Run from `v2/`:
//! `cargo run -p bench --release --bin forms`.

// Times its own runs: the wall-clock rule (K7) binds the engine, not this bench.
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, BTreeSet};
use std::hint::black_box;
use std::path::Path;
use std::time::Instant;

use body_script::{TICK, ground, ground_id, humanoid, place};
use replica::encode::Name;
use replica::host::{Answer, Ask, Seen};
use replica::ids::{Id, Minter, Scope};
use replica::moves::{Effector, Move};
use replica::pose::Vec3;
use replica::rules::json::{self, parse};
use replica::tree::Tree;
use replica::world_model::{parse_kinds, parse_world};
use sim::controller::Controller;
use sim::forms::{Forms, Intent, World};
use sim::host::Geometry;
use sim::mover::Surface;
use sim::moves::{Moves, Reach, load};
use sim::timers::DueList;
use skills::form_runner::{Limits, Step, bind};

const BODIES: i64 = 1_000;
const CYCLES: usize = 50;

/// Every thing is within reach; bodies and things are read where they were placed (nothing here moves them).
struct Still(BTreeMap<Id, Vec3>);

impl Geometry for Still {
    fn ask(&self, _: Id, q: &Ask) -> Option<Answer> {
        match q {
            Ask::Toward { to, .. } => Some(Answer::Point(*to)),
            Ask::Near { .. } => Some(Answer::Near(Vec::new())),
            Ask::Distance { .. } => None,
        }
    }
    fn read(&self, node: Id) -> Option<Seen> {
        Some(Seen {
            id: node,
            kind: Name::new("bench:node").expect("a name"),
            parent: Some(ground_id()),
            position: *self.0.get(&node)?,
            fields: BTreeMap::new(),
        })
    }
}

impl Reach for Still {
    fn distance(&self, _: Id, _: &Effector, _: Option<&Name>, _: Id, _: &Name) -> Option<i64> {
        Some(0)
    }
}

/// The runner's kinds, each bound to its first form.
fn kinds() -> Vec<Vec<Step>> {
    let dir =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/skills/src/form_runner/kinds");
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
            bind(&v, &form).expect("binds")
        })
        .collect()
}

struct Bench {
    tree: Tree,
    surfaces: BTreeMap<Id, Surface>,
    c: Controller,
    due: DueList,
    mint: Minter,
    moves: Moves,
    library: Vec<Move>,
    geo: Still,
    forms: Forms,
    /// Each body, its thing and the steps it runs.
    runs: Vec<(Id, Id, Vec<Step>)>,
    tick: i64,
}

fn bench(kinds: &[Vec<Step>], library: &[Move]) -> Bench {
    let k = parse_kinds(include_str!(
        "../../../crates/replica/fixtures/world-model/kinds.diag"
    ))
    .expect("kinds");
    let draft =
        parse_world(&k, "{1: [], 2: {}, 3: [{1: 1, 2: \"souls:place\"}], 4: []}").expect("a world");
    let tree = Tree::load(&draft).expect("loads").0;
    let g = ground();
    let mut c = Controller::new();
    let mut mint = Minter::new(Scope([0xf1; 16]));
    let mut seen = BTreeMap::new();
    let mut runs = Vec::new();
    for i in 0..BODIES {
        let body = mint.mint().expect("an id");
        let thing = mint.mint().expect("an id");
        let (x, z) = ((i % 32 - 16) * 1000, (i / 32 - 16) * 1000);
        place(&mut c, &g, body, humanoid(), x, z).expect("placed");
        let steps = kinds[usize::try_from(i).expect("small") % kinds.len()].clone();
        // The thing stands so that its stand point is where the body stands.
        let stand = steps
            .iter()
            .find_map(|s| match s {
                Step::WalkTo { at, .. } => Some(*at),
                _ => None,
            })
            .unwrap_or(Vec3::ZERO);
        let at = Vec3::new(x * 1000, 0, z * 1000);
        seen.insert(body, at);
        seen.insert(
            thing,
            Vec3::new(at.x - stand.x, at.y - stand.y, at.z - stand.z),
        );
        runs.push((body, thing, steps));
    }
    Bench {
        tree,
        surfaces: BTreeMap::from([(ground_id(), g)]),
        c,
        due: DueList::new(),
        mint,
        moves: Moves::new(),
        library: library.to_vec(),
        geo: Still(seen),
        forms: Forms::new(),
        runs,
        tick: 0,
    }
}

impl Bench {
    fn world(&mut self) -> (World<'_, Still, Still>, &mut Forms) {
        (
            World {
                tree: &self.tree,
                geometry: &self.geo,
                reach: &self.geo,
                controller: &mut self.c,
                due: &mut self.due,
                mint: &mut self.mint,
                moves: &mut self.moves,
                library: &self.library,
                places: None,
                seed: 1,
            },
            &mut self.forms,
        )
    }

    fn start_all(&mut self) {
        let now = self.tick * TICK;
        let runs = std::mem::take(&mut self.runs);
        for (body, thing, steps) in &runs {
            let (mut w, forms) = self.world();
            // No effects: the bench times the steps. Each body is its own intent, never expiring.
            let intent = Intent {
                id: *body,
                expiry: i64::MAX,
                actor: replica::effects::Actor::Soul(*body),
                digest: [0; 32],
            };
            let (s, l) = (steps.clone(), Limits::default());
            forms
                .start(&mut w, *body, *thing, intent, s, Vec::new(), l, now)
                .expect("started");
        }
        self.runs = runs;
    }

    /// One tick: the forms' part, the controller's step, every timer due before the next tick. Returns the timers
    /// fired and the walks going after it.
    fn step(&mut self) -> (usize, usize) {
        let now = self.tick * TICK;
        let end = now + TICK;
        {
            let (mut w, forms) = self.world();
            forms.tick(&mut w, now);
        }
        black_box(self.c.step(&self.surfaces, TICK, end));
        let mut fired = 0;
        while let Some(t) = self.due.fire(end) {
            let (mut w, forms) = self.world();
            assert!(forms.fire(&mut w, &t));
            fired += 1;
        }
        self.tick += 1;
        (fired, self.forms.walking())
    }
}

/// The tick offsets in a cycle with every run in progress and no step at a boundary: no timer due, and no walk going
/// at the tick's start or end.
fn quiet(kinds: &[Vec<Step>], library: &[Move]) -> (BTreeSet<i64>, i64) {
    let mut b = bench(kinds, library);
    b.start_all();
    let mut quiet = BTreeSet::new();
    let mut ticks = 0;
    while !b.forms.is_empty() {
        let (before, walked) = (b.forms.len(), b.forms.walking());
        let (fired, walking) = b.step();
        if fired == 0 && walked == 0 && walking == 0 && before == BODIES as usize {
            quiet.insert(ticks);
        }
        ticks += 1;
    }
    let ended = std::mem::take(&mut b.forms.ended);
    assert!(
        ended.iter().all(|e| e.how.as_str() == "done"),
        "every run done"
    );
    (quiet, ticks + 1)
}

/// What an arm starts at each cycle's start.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Arm {
    /// Nothing.
    Idle,
    /// The moves the forms' steps ask for, started on every body directly by B2's `Moves::start`, with no runner.
    Moves,
    /// The form runner on every body.
    Forms,
}

/// Mean ns per timed tick over `CYCLES` cycles.
fn arm(
    kinds: &[Vec<Step>],
    library: &[Move],
    timed: &BTreeSet<i64>,
    cycle: i64,
    which: Arm,
) -> f64 {
    let mut b = bench(kinds, library);
    let (mut spent, mut n) = (0.0, 0u64);
    for _ in 0..CYCLES {
        let t0 = b.tick;
        match which {
            Arm::Idle => {}
            Arm::Forms => b.start_all(),
            Arm::Moves => {
                for (body, thing, steps) in b.runs.clone() {
                    for s in &steps {
                        if let Step::Move { name, at } = s {
                            let mut mv = b
                                .library
                                .iter()
                                .find(|m| m.name == *name)
                                .expect("a move")
                                .clone();
                            mv.contact = at.clone();
                            b.moves
                                .start(
                                    &mut b.c,
                                    &mut b.due,
                                    &mut b.mint,
                                    &b.geo,
                                    body,
                                    &mv,
                                    thing,
                                    t0 * TICK,
                                )
                                .expect("started");
                        }
                    }
                }
            }
        }
        while b.tick < t0 + cycle {
            let off = b.tick - t0;
            if timed.contains(&off) {
                let t = Instant::now();
                let (fired, _) = b.step();
                spent += t.elapsed().as_secs_f64() * 1e9;
                n += 1;
                assert_eq!(fired, 0, "no boundary in a timed tick");
                if which == Arm::Forms {
                    assert_eq!(b.forms.len(), BODIES as usize);
                }
            } else {
                b.step();
            }
        }
        assert!(
            b.forms.is_empty() && b.moves.is_empty(),
            "every run and move ended"
        );
        let ended = std::mem::take(&mut b.forms.ended);
        assert!(ended.iter().all(|e| e.how.as_str() == "done"));
    }
    spent / n as f64
}

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/replica/fixtures/moves");
    let library = load(&dir).expect("the fixture moves");
    let kinds = kinds();
    let (timed, cycle) = quiet(&kinds, &library);
    println!(
        "{BODIES} bodies; {} kinds, each a form of {:?} steps; {} timed ticks of {cycle} a cycle, {CYCLES} cycles; tick {TICK} µs",
        kinds.len(),
        kinds.iter().map(Vec::len).collect::<Vec<_>>(),
        timed.len()
    );
    let mut rows = Vec::new();
    for repeat in 1..=2 {
        let idle = arm(&kinds, &library, &timed, cycle, Arm::Idle);
        let moves = arm(&kinds, &library, &timed, cycle, Arm::Moves);
        let forms = arm(&kinds, &library, &timed, cycle, Arm::Forms);
        println!(
            "repeat {repeat}: idle {idle:.0} ns a tick, the same moves with no runner {moves:.0} ns, \
             1,000 forms in progress {forms:.0} ns"
        );
        rows.push([idle, moves, forms]);
    }
    let mean = |i: usize| (rows[0][i] + rows[1][i]) / 2.0;
    let spread = |i: usize| (rows[0][i] - rows[1][i]).abs();
    for (base, what) in [(0, "idle"), (1, "the same moves with no runner")] {
        let bar = spread(base).max(spread(2));
        let d = mean(2) - mean(base);
        println!(
            "A2 against {what}: mean {:.0} ns, forms {:.0} ns, difference {d:.0} ns; spreads {:.0} and {:.0} ns; \
             bar (the larger) {bar:.0} ns: {}",
            mean(base),
            mean(2),
            spread(base),
            spread(2),
            if d.abs() <= bar { "met" } else { "UNMET" }
        );
    }
}
