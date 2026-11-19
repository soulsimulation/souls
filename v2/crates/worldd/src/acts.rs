//! Soul Actions acts in a running world (Engine v2 C2, #3366): a form intent on a world with bodies is carried out
//! by F1/F2's form runner (`sim::forms`), over the world's loaded entries, on the clock thread. No code here names a
//! kind, a form or a move.
//!
//! - **Committed at the next tick.** [`crate::answers`] takes a form's act like a move: an id, a deadline and a place
//!   in the next tick. There [`Acts::commit`] finds the node's kind in the replica's tree and its entry in the world's
//!   entries (`souls-entry/1`), and hands the form to [`Forms::commit`], which binds its steps and effects (F1, F2),
//!   checks who may (F6) and starts the run. Its candidates are tried in rank order; the first refusal is the answer
//!   when none starts.
//! - **The world the runner reaches** is the bodies' own: their controller (B1), their town for a walk's corners (N7),
//!   and a due list, moves (B2) and a minter of the forms' own. A move's reach is measured across x and z from the
//!   body's edge to the nearer of the thing's point the move names and its nearest surface (its entry's bounds), on
//!   the floor the body stands on (C22, #3485); from the feet to the node's place when its entry gives neither.
//! - **Written once.** What the runner writes ([`Forms::out`]) is numbered at the replica's version, applied as one
//!   part with the tick's other entries and handed back to [`Forms::logged`] (F2's log hook, #3257, as its issue
//!   describes it). A run's end is its intent's answer: `done` a receipt naming every entry the intent caused, else
//!   the run's ending by name.
//!
//! - **Places and indoors** (C17, #3453). A form's `sit` takes the bodies' own places ([`Bodies::slots`], the
//!   gateway's sit's table), and a form's walk is planned by the town across doors and stairs to its point carried
//!   up the tree onto the floor a body stands on ([`View::on_floor`], [`View::plan`]); its crossings are carried by
//!   the town's links after the forms' tick (`sim::host::carry`), and the walk sees itself carried ([`F_CROSSING`]).
//!
//! - **Deadlines** (C20, #3469). A form's act is due when its run's steps are, from the run's start ([`limits`],
//!   `sim::forms::span`): a walk across the town and a long pause are its own time, not the 10 s an act gets at its
//!   arrival.
//!
//! Not here: R2's needs checked again at commit (the checkers read bodies from the tree, which does not hold them
//! yet); a form's reservation (F3's link needs both ends in the tree, so a form reserves nothing until bodies are
//! nodes); resuming a run after a restart.

use std::collections::{BTreeMap, BTreeSet};

use replica::effects::{Actor, Effect, Refusal, fixture_bytes};
use replica::encode::{Name, decode};
use replica::host::{Answer, Ask, F_CROSSING, Seen};
use replica::ids::{Id, Minter, Scope};
use replica::moves::{Effector, Move};
use replica::pose::Vec3;
use replica::rules::json::Value as Json;
use replica::time::Micros;
use replica::tree::Tree;
use sim::controller::Controller;
use sim::forms::{Asked, Forms, Intent, Places, RunId, World};
use sim::host::{Geometry, Staged};
use sim::mover::Body as Moved;
use sim::moves::{Moves, Reach};
use sim::timers::DueList;
use sim::walk::Leg;
use sim::walk::town::View;
use skills::form_runner::Limits;

use crate::bodies::Bodies;

type R<T> = Result<T, Refusal>;

const MOVES: [&str; 6] = [
    include_str!("../../replica/fixtures/moves/lie.diag"),
    include_str!("../../replica/fixtures/moves/pour.diag"),
    include_str!("../../replica/fixtures/moves/press.diag"),
    include_str!("../../replica/fixtures/moves/rise.diag"),
    include_str!("../../replica/fixtures/moves/sit.diag"),
    SLIDE,
];

/// A slide (C22, #3485), as today's engine gives it (`content/moves/slide.json`): one hand reaches the thing's named
/// point, as a press does, and keeps contact while it slides along the surface. Contact begins when start-up ends.
const SLIDE: &str = r#"
{
  1: "souls:slide", 2: 1,
  3: [{1: 2, 2: 2}],                        # claims any one manipulator
  4: [2],                                   # blocks the other manipulators while it runs
  5: [2],                                   # a new claim on a manipulator cancels it
  6: [{1: "souls:start-up", 2: 250000},     # contact at its end
      {1: "souls:slide", 2: 400000},        # the contact window
      {1: "souls:recovery", 2: 300000}],
  7: {1: 2},                                # reaches with the hand it holds
  8: 600000,
  9: "souls:surface"
}
"#;

/// The longest a form's walk may take, µs (C20, #3469): about 250 m at a body's free speed (1.4 m/s), most of the way
/// across Eden's town round its buildings, through doors and up stairs. A walk that cannot go on ends by its own name,
/// or `deadline-passed` by then.
pub const WALK_MOST: Micros = 180_000_000;

/// The runner's limits for a form's run here: the walk's [`WALK_MOST`], the rest the runner's own. A run's act is
/// given their sum as its deadline (`sim::forms::span`).
pub fn limits() -> Limits {
    Limits {
        walk: WALK_MOST,
        ..Limits::default()
    }
}

fn refusal(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

/// What the runner sees: the bodies as the controller had them at the call, the town's corners and the tree.
struct Sight<'a> {
    bodies: BTreeMap<Id, Moved>,
    /// The bodies carried across a link now.
    carrying: BTreeSet<Id>,
    view: Option<View<'a>>,
    tree: &'a Tree,
    kind: Name,
    /// The world's entries by kind, for a thing's points and bounds.
    kinds: &'a Json,
}

impl Sight<'_> {
    /// A node's place in the tree, its parents' positions added (their turns are not: things stand upright).
    fn place(&self, node: Id) -> Option<Vec3> {
        let mut at = Vec3::ZERO;
        let mut id = node;
        for _ in 0..64 {
            let n = self.tree.node(self.tree.handle(id)?)?;
            if let Some(p) = n.place() {
                at = Vec3::new(
                    at.x + p.position.x,
                    at.y + p.position.y,
                    at.z + p.position.z,
                );
            }
            match n.parent() {
                Some(p) => id = p,
                None => return Some(at),
            }
        }
        None
    }
}

impl Geometry for Sight<'_> {
    fn ask(&self, body: Id, q: &Ask) -> Option<Answer> {
        match q {
            Ask::Toward { to, .. } => {
                let me = self.bodies.get(&body)?;
                let [x, z] = match &self.view {
                    Some(v) => v.corner(me, *to).ok()?,
                    None => [to.x, to.z],
                };
                let y = if [x, z] == [to.x, to.z] { to.y } else { 0 };
                Some(Answer::Point(Vec3::new(x, y, z)))
            }
            Ask::Near { .. } => Some(Answer::Near(Vec::new())),
            Ask::Distance { .. } => None,
        }
    }

    fn stand_near(&self, body: Id, at: Vec3, reach: i64) -> Option<Vec3> {
        let me = self.bodies.get(&body)?;
        self.view
            .as_ref()?
            .stand_near(sim::walk::node_of(me), at, reach, Some(me))
    }

    /// The point carried onto the floor a body stands on, the nearest place within reach of it (or the point), and
    /// the town's route there from where the body stands, across links; no legs when there is no way.
    fn legs(&self, body: Id, node: Id, at: Vec3, reach: i64) -> Option<Vec<Leg>> {
        let (me, view) = (self.bodies.get(&body)?, self.view.as_ref()?);
        let (floor, at, _) = view.on_floor(node, at)?;
        let here = sim::walk::node_of(me);
        let to = view.stand_near(floor, at, reach, Some(me));
        // On the body's own ground the walk goes to the point itself when there is no place: it ends there by name.
        if floor == here {
            return Some(vec![Leg {
                to: to.unwrap_or(at),
                link: None,
            }]);
        }
        let Some(to) = to else {
            return Some(Vec::new());
        };
        Some(view.plan(me, floor, to).unwrap_or_default())
    }

    fn read(&self, node: Id) -> Option<Seen> {
        let b = self.bodies.get(&node)?;
        let mut fields = BTreeMap::new();
        if self.carrying.contains(&node) {
            fields.insert(F_CROSSING, replica::encode::Value::Uint(1));
        }
        Some(Seen {
            id: node,
            kind: self.kind.clone(),
            parent: Some(sim::index::place_of(b).0),
            position: b.pose.position,
            fields,
        })
    }
}

/// `[x, z]` µm across x and z from `a` to `b`.
fn flat(a: [i64; 2], b: [i64; 2]) -> i64 {
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    i64::try_from((d(a[0], b[0]) + d(a[1], b[1])).isqrt()).unwrap_or(i64::MAX)
}

/// How far point `q` is from the closed quadrilateral `ring` (convex, its corners in order), across x and z: 0 inside.
fn to_ring(q: [i64; 2], ring: &[[i64; 2]; 4]) -> i64 {
    let edge = |a: [i64; 2], b: [i64; 2]| {
        let (d, w) = (
            [i128::from(b[0] - a[0]), i128::from(b[1] - a[1])],
            [i128::from(q[0] - a[0]), i128::from(q[1] - a[1])],
        );
        (d[0] * w[1] - d[1] * w[0], d, w)
    };
    let sides: Vec<i128> = (0..4).map(|i| edge(ring[i], ring[(i + 1) % 4]).0).collect();
    if sides.iter().all(|&c| c >= 0) || sides.iter().all(|&c| c <= 0) {
        return 0;
    }
    (0..4)
        .map(|i| {
            let (a, (_, d, w)) = (ring[i], edge(ring[i], ring[(i + 1) % 4]));
            let len = (d[0] * d[0] + d[1] * d[1]).max(1);
            let t = (d[0] * w[0] + d[1] * w[1]).clamp(0, len);
            let near = |k: usize| a[k] + i64::try_from(d[k] * t / len).unwrap_or(0);
            flat(q, [near(0), near(1)])
        })
        .min()
        .unwrap_or(i64::MAX)
}

/// Whole millimetres `[x, y, z]` in µm.
fn um(v: Option<&Json>) -> Option<Vec3> {
    let n = |v: &Json| match v {
        Json::Int(n) => i64::try_from(*n).ok()?.checked_mul(1000),
        _ => None,
    };
    match v?.arr()? {
        [x, y, z] => Some(Vec3::new(n(x)?, n(y)?, n(z)?)),
        _ => None,
    }
}

impl Sight<'_> {
    /// How far a body standing at `from` on floor `floor` is from thing `target` across x and z (C22, #3485): from
    /// the body's edge (a standard body's radius from its feet, [`sim::ground::HUMAN_RADIUS`]: a hand reaches from the
    /// shoulder, not the feet) to the nearer of the thing's point `point` its entry names and its nearest surface, the
    /// box its entry's `geometry.bounds_mm` gives (centred on its place), each turned with the thing and carried onto
    /// that floor ([`View::on_floor`]). `None` when its entry gives neither, or the thing is not over that floor.
    fn to_thing(&self, floor: Id, from: Vec3, target: Id, point: &Name) -> Option<i64> {
        let view = self.view.as_ref()?;
        let n = self.tree.node(self.tree.handle(target)?)?;
        let entry = self.kinds.get(plain(n.kind()))?;
        let on = |p: Vec3| {
            view.on_floor(target, p)
                .filter(|(f, ..)| *f == floor)
                .map(|(_, p, _)| [p.x, p.z])
        };
        let q = [from.x, from.z];
        let named = um(entry
            .get("points")
            .and_then(|ps| ps.get(point.as_str()))
            .and_then(|p| p.get("at_mm")))
        .and_then(on)
        .map(|p| flat(q, p));
        let surface = um(entry.get("geometry").and_then(|g| g.get("bounds_mm"))).and_then(|b| {
            let (x, z) = (b.x / 2, b.z / 2);
            let c = |u: i64, v: i64| on(Vec3::new(u, 0, v));
            let ring = [c(-x, -z)?, c(x, -z)?, c(x, z)?, c(-x, z)?];
            Some(to_ring(q, &ring))
        });
        let d = match (named, surface) {
            (Some(a), Some(b)) => a.min(b),
            (a, b) => a.or(b)?,
        };
        Some(d.saturating_sub(sim::ground::HUMAN_RADIUS * 1000).max(0))
    }
}

impl Reach for Sight<'_> {
    /// To another body, from feet to feet; to a thing, from the body's edge to its point or its nearest surface
    /// ([`Sight::to_thing`]), else to its place in the tree; across x and z.
    fn distance(
        &self,
        body: Id,
        _: &Effector,
        _: Option<&Name>,
        target: Id,
        point: &Name,
    ) -> Option<i64> {
        let me = self.bodies.get(&body)?;
        let a = me.pose.position;
        if let Some(d) = self.to_thing(sim::walk::node_of(me), a, target, point) {
            return Some(d);
        }
        let b = match self.bodies.get(&target) {
            Some(t) => t.pose.position,
            None => self.place(target)?,
        };
        Some(flat([a.x, a.z], [b.x, b.z]))
    }
}

/// A form's arguments, from its intent: things by id (F4), slots of the node by number (C12).
#[derive(Clone, Debug, Default)]
pub struct Args {
    pub things: BTreeMap<String, Id>,
    pub slots: BTreeMap<String, u64>,
}

/// The forms in progress, and what they reach that the bodies do not hold.
pub struct Acts {
    pub forms: Forms,
    /// The world's entries by kind (`souls-entry/1`).
    kinds: Json,
    due: DueList,
    mint: Minter,
    moves: Moves,
    library: Vec<Move>,
    /// A controller for a world with no bodies: a form there may only have no steps.
    own: Controller,
    /// Each run's intent.
    runs: BTreeMap<RunId, Id>,
}

/// The moves a form's step may name: the fixture moves.
pub fn library() -> R<Vec<Move>> {
    MOVES
        .iter()
        .map(|t| {
            let v = decode(&fixture_bytes(t)?)
                .map_err(|e| refusal("move-unread", e.to_string()))?
                .value;
            Move::from_value(&v)
        })
        .collect()
}

/// The plain name (`namespace:name`) of a node's kind.
fn plain(kind: &Name) -> &str {
    let k = kind.as_str();
    k.split_once('@').map_or(k, |(p, _)| p)
}

impl Acts {
    /// No forms yet, over the world's entries by kind and the moves' library ([`library`]), in the zone `header`
    /// names, minting ids of `scope`: F4's amounts read the entries' fields (`Forms::kinds`), and a take or a put writes under the zone.
    pub fn new(
        kinds: Json,
        library: Vec<Move>,
        header: replica::effects::Header,
        scope: Scope,
    ) -> Acts {
        let mut forms = Forms::new();
        let mut loaded = replica::kinds::Kinds::default();
        for (_, entry) in kinds.obj().unwrap_or(&[]) {
            let mut e = entry.clone();
            if let Json::Obj(o) = &mut e {
                o.retain(|(k, _)| k != "forms");
            }
            if let Ok(text) = replica::kinds::entry::entry_to_kind(&e.to_json()) {
                loaded.load(&[("entry", text.as_str())]);
            }
        }
        forms.kinds(&loaded);
        forms.zone(header);
        Acts {
            forms,
            kinds,
            due: DueList::new(),
            mint: Minter::new(scope),
            moves: Moves::new(),
            library,
            own: Controller::new(),
            runs: BTreeMap::new(),
        }
    }

    /// Runs `f` on the world the runner reaches.
    fn with<T>(
        &mut self,
        tree: &Tree,
        bodies: Option<&mut Bodies>,
        seed: u64,
        f: impl FnOnce(&mut Forms, &mut World<'_, Sight<'_>, Sight<'_>>) -> T,
    ) -> T {
        let (controller, view, slots) = match bodies {
            Some(b) => (
                &mut b.runner.controller,
                Some(b.town.view()),
                Some(&mut b.slots),
            ),
            None => (&mut self.own, None, None),
        };
        let places = match (slots, view.as_ref()) {
            (Some(slots), Some(v)) => Some(Places {
                slots,
                floors: v.surfaces(),
            }),
            _ => None,
        };
        let sight = Sight {
            bodies: controller.bodies().map(|b| (b.id, *b)).collect(),
            carrying: controller
                .bodies()
                .filter(|b| controller.carrying(b.id).is_some())
                .map(|b| b.id)
                .collect(),
            view,
            tree,
            kind: Name::new("souls:body").unwrap_or_else(|| unreachable!("a literal name")),
            kinds: &self.kinds,
        };
        let mut w = World {
            tree,
            geometry: &sight,
            reach: &sight,
            controller,
            due: &mut self.due,
            mint: &mut self.mint,
            moves: &mut self.moves,
            library: &self.library,
            seed,
            places,
        };
        f(&mut self.forms, &mut w)
    }

    /// Starts the act's first candidate that starts (`(node, form)` in rank order) for intent `intent` on `body`, or
    /// the first refusal. A resend of an intent whose run is going joins it; one whose effects are logged gets them.
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &mut self,
        tree: &Tree,
        bodies: Option<&mut Bodies>,
        body: Id,
        candidates: &[(Id, String)],
        args: &Args,
        intent: Intent,
        tick: u64,
        now: Micros,
    ) -> R<Asked> {
        let mut bodies = bodies;
        let mut first = None;
        for (node, form) in candidates {
            let kind = tree
                .handle(*node)
                .and_then(|h| tree.node(h))
                .map(|n| plain(n.kind()).to_owned());
            // A thing already gone is refused by name here, never handed to the runner (F4's known gap).
            let Some(kind) = kind else {
                first.get_or_insert(refusal("thing-missing", replica::world_model::show(*node)));
                continue;
            };
            let Some(entry) = self.kinds.get(&kind).cloned() else {
                first.get_or_insert(refusal("no_such_kind", kind));
                continue;
            };
            // F3's reservation is a link from the body: until bodies are nodes of the tree, a form reserves nothing.
            if tree.handle(body).is_none() {
                self.forms.shared(*node);
            }
            let audiences = BTreeMap::<Id, BTreeSet<Id>>::new();
            let r = self.with(tree, bodies.as_deref_mut(), tick, |forms, w| {
                if args.things.is_empty() && args.slots.is_empty() {
                    return forms.commit(
                        w,
                        &audiences,
                        &|_| None,
                        body,
                        *node,
                        &entry,
                        form,
                        intent,
                        limits(),
                        now,
                    );
                }
                // Thing and slot arguments (F4, C12): bound here, as `Forms::commit` binds none yet.
                let steps = skills::form_runner::bind_in(&entry, form, &args.slots)?;
                let effects =
                    skills::form_runner::bind_effects_in(&entry, form, &args.things, &args.slots)?;
                sim::forms::may(w.tree, &audiences, &|_| None, body, *node, &entry, form)?;
                forms.start(w, body, *node, intent, steps, effects, limits(), now)
            });
            match r {
                Ok(a) => {
                    if let Asked::Started(run) | Asked::Running(run) = a {
                        self.runs.insert(run, intent.id);
                    }
                    return Ok(a);
                }
                Err(e) => {
                    first.get_or_insert(e);
                }
            }
        }
        Err(first.unwrap_or_else(|| refusal("no_candidate", "")))
    }

    /// The Soul's leave: the run on `body` ends `left` at its next stable moment.
    pub fn leave(&mut self, tree: &Tree, bodies: Option<&mut Bodies>, body: Id, now: Micros) {
        let _ = self.with(tree, bodies, 0, |forms, w| forms.leave(w, body, now));
    }

    /// The forms' part of a tick at world time `now`: their walks, then every timer of theirs due by `now`.
    pub fn tick(&mut self, tree: &Tree, bodies: Option<&mut Bodies>, tick: u64, now: Micros) {
        let mut bodies = bodies;
        self.with(tree, bodies.as_deref_mut(), tick, |forms, w| {
            forms.tick(w, now);
            while let Some(t) = w.due.fire(now) {
                forms.fire(w, &t);
            }
        });
        // The walks' crossings, carried by the town's links as the bodies' own walks are (C17).
        let mut staged = Staged::default();
        staged.crossings.append(&mut self.forms.crossings);
        if let Some(b) = bodies
            && !staged.crossings.is_empty()
        {
            let _ = sim::host::carry(&staged, &mut b.runner.controller, &mut b.town, now);
        }
    }

    /// What the forms wrote, to be numbered and applied.
    pub fn out(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.forms.out)
    }

    /// Runs that ended since the last call: each one's intent and its ending's name.
    pub fn ended(&mut self) -> Vec<(Id, String)> {
        std::mem::take(&mut self.forms.ended)
            .into_iter()
            .filter_map(|e| Some((self.runs.remove(&e.run)?, e.how.as_str().to_owned())))
            .collect()
    }
}

/// F2's intent for a world intent: its id, its expiry, its actor and its bytes' digest.
pub fn intent(id: Id, expiry: Micros, actor: Actor, bytes: &[u8]) -> Intent {
    Intent {
        id,
        expiry,
        actor,
        digest: replica::ids::sha256(bytes),
    }
}
