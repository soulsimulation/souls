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
//! - **Moves and their targets** (C23, #3494). A step's move is one of [`library`]'s: every move `content/moves`
//!   declares and the body's own ([`crate::moves`]). A move with no `at` is made where the body stands ([`AT_SELF`]);
//!   one whose `at`, or with no `at` whose `toward`, is a thing argument reaches that thing ([`AT_ARG`]); a missing
//!   one is refused `arg-missing`.
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
//! - **Planning off the clock** (C28). Form legs, standing targets and obstructed corners use the bodies' existing
//!   planner worker and recorded batches. Questions retain body, intent, stage, step, payload generation and one
//!   shared map-version snapshot; a cancelled cursor or stale answer cannot replace a current result. Pending plans
//!   keep the original walk timer and re-read a dynamic target. Corner answers are consumed once, then the town
//!   follows its kept line and asks for a new one only when needed. K18d separately propagates committed map changes.
//!
//! - **Deadlines** (C20, #3469). A form's act is due when its run's steps are, from the run's start ([`limits`],
//!   `sim::forms::span`): a walk across the town and a long pause are its own time, not the 10 s an act gets at its
//!   arrival.
//!
//! - **Timers and values** (C24, #3495). A form's `timer` written to the log ([`Acts::out`]) goes on the forms' due
//!   list; when it fires its clear is written and its form starts on its node with the world as actor, keyed by the
//!   timer ([`Acts::fired`]). A form's value arguments ([`Args::values`]: a value by name, words by reference) reach
//!   its sets.
//! - **A walk that stalls** (C21, #3484). Each tick, every form's walk that asked its way is watched
//!   ([`sim::walk::stall::Watch`]): one that gains less than a quarter metre toward its goal over 3 s of world time
//!   ends `walk.blocked` in that tick, its body's driver released, and the act's ending entry names the nearest thing
//!   or edge in its way ([`sim::walk::stall::blocker`]).
//!
//! Not here: R2's needs checked again at commit (the checkers read bodies from the tree, which does not hold them
//! yet); a form's reservation (F3's link needs both ends in the tree, so a form reserves nothing until bodies are
//! nodes); resuming a run after a restart.

use replica::host::WalkPlan;
use sim::ground::Versions;
use sim::planner::{FormAnswer, FormKey, FormKind, FormQuery, FormQuestion, FormResult};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use replica::effects::{Actor, Body, Effect, Refusal, TimerRec};
use replica::encode::Name;
use replica::host::{Answer, Ask, F_CROSSING, Seen};
use replica::ids::{Id, Minter, Scope};
use replica::kinds::sizes::Build;
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
use sim::timers::{DueList, Timer};
use sim::walk::stall::{Watch, blocker};
use sim::walk::town::{Split, View};
use skills::form_runner::Limits;

use crate::bodies::Bodies;

type R<T> = Result<T, Refusal>;

/// The longest a form's walk may take, µs (C20, #3469): about 250 m at a body's free speed (1.4 m/s), most of the way
/// across Eden's town round its buildings, through doors and up stairs. A walk that cannot go on ends by its own name,
/// or `deadline-passed` by then.
pub const WALK_MOST: Micros = 180_000_000;

/// The ending of a form's walk that stopped making progress (C21, #3484).
pub const BLOCKED: &str = "walk.blocked";

/// The runner's limits for a form's run here: the walk's [`WALK_MOST`], the rest the runner's own. A run's act is
/// given their sum as its deadline (`sim::forms::span`).
pub fn limits() -> Limits {
    Limits {
        walk: WALK_MOST,
        ..Limits::default()
    }
}

/// A gateway walk's route deadline and C21 progress watch. The route is read once N9 grants its actual spot;
/// unrelated ticks do no route search. Waiting for a link or being carried is not a stalled walking tick.
pub(crate) struct Walk {
    body: Id,
    order: Id,
    started: Micros,
    planned: bool,
    watch: Watch,
}

fn walk_span(length_mm: u64, links: usize) -> Micros {
    let speed = i128::from(crate::bodies::WALK);
    let travel = (i128::from(length_mm) * 1_000_000_000 + speed - 1) / speed;
    let travel = i64::try_from(travel).unwrap_or(i64::MAX);
    // Half the free walking time for bends and yielding, at least 5 s, plus 5 s per crossing/door.
    travel
        .saturating_add((travel / 2).max(5_000_000))
        .saturating_add(
            i64::try_from(links)
                .unwrap_or(i64::MAX)
                .saturating_mul(5_000_000),
        )
        .min(WALK_MOST)
}

impl Walk {
    pub(crate) fn new(body: Id, order: Id, started: Micros) -> Self {
        Self {
            body,
            order,
            started,
            planned: false,
            watch: Watch::new(),
        }
    }

    /// A newly planned deadline, and whether the walk stalled. Neither changes the mover's path or authority.
    pub(crate) fn step(&mut self, b: &mut Bodies, now: Micros) -> (Option<Micros>, bool) {
        let Some(me) = b.runner.controller.body(self.body).copied() else {
            return (None, false);
        };
        if !b.runner.running(self.body) {
            return (None, false);
        }
        let mut due = None;
        if !self.planned
            && let Some(metrics) = b.runner.route_metrics(self.body, self.order)
        {
            due = Some(
                self.started
                    .saturating_add(walk_span(metrics.length_mm, metrics.links)),
            );
            self.planned = true;
        }
        let fields = b.runner.fields.get(&self.body);
        let waiting = sim::host::waiting(fields).is_some()
            || fields.is_some_and(|f| f.contains_key(&replica::host::F_HELD));
        let aim = b
            .town
            .next_corner(self.body)
            .filter(|(node, _)| *node == sim::walk::node_of(&me));
        if waiting || b.runner.controller.carrying(self.body).is_some() || aim.is_none() {
            self.watch.keep(&BTreeSet::new());
            return (due, false);
        }
        let (node, aim) = aim.unwrap();
        let to = b
            .runner
            .asks
            .get(&self.body)
            .filter(|(t, _)| t.node == node)
            .and_then(|_| b.runner.granted.get(&self.body))
            .map_or(aim, |p| [p.x, p.z]);
        let here = [me.pose.position.x, me.pose.position.z];
        (due, self.watch.seen(self.body, here, aim, to, now))
    }
}

/// Whether slot argument `key` of form `f` is the body's own place: a `select` of free slots that a `sit` or `lie` step
/// takes, or that an effect reparents the actor into (#3802).
fn selects_body_slot(f: &Json, key: &str) -> bool {
    let arg = |v: Option<&Json>| v.and_then(|v| v.get("arg")).and_then(Json::str) == Some(key);
    let take = f.get("takes").and_then(|t| t.get(key));
    let selects = take.and_then(|t| t.get("type")).and_then(Json::str) == Some("slot")
        && take
            .and_then(|t| t.get("select"))
            .and_then(|s| s.get("of"))
            .and_then(Json::str)
            == Some("free_slots");
    let steps = f.get("steps").and_then(Json::arr).unwrap_or(&[]);
    let effects = f.get("effects").and_then(Json::arr).unwrap_or(&[]);
    selects
        && (steps.iter().any(|s| {
            matches!(s.get("step").and_then(Json::str), Some("sit" | "lie")) && arg(s.get("slot"))
        }) || effects.iter().any(|e| {
            e.get("change").and_then(Json::str) == Some("reparent")
                && e.get("what").and_then(Json::str) == Some("actor")
                && arg(e.get("into"))
        }))
}

fn refusal(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

/// A walker's ask for its way (C21): the node it stands on, where it stands, the corner it aims at and its leg's end.
type Way = (Id, [i64; 2], [i64; 2], [i64; 2]);

/// The current request for each exact form cursor. A new payload or map gets a new generation.
#[derive(Default)]
struct Planning {
    generation: u64,
    current: BTreeMap<FormKey, (FormQuestion, Arc<Versions>)>,
    answers: BTreeMap<FormKey, FormAnswer>,
    queued: BTreeMap<FormKey, FormQuestion>,
}

impl Planning {
    fn keep(&mut self, context: &BTreeMap<Id, (Id, usize, usize)>) {
        self.current
            .retain(|k, _| context.get(&k.body) == Some(&(k.intent, k.stage, k.step)));
        self.answers.retain(|k, _| self.current.contains_key(k));
        self.queued.retain(|k, _| self.current.contains_key(k));
    }

    fn receive(&mut self, answers: BTreeMap<FormKey, FormAnswer>) {
        for (key, a) in answers {
            if self
                .current
                .get(&key)
                .is_some_and(|(q, map)| q.generation == a.generation && Arc::ptr_eq(map, &a.map))
            {
                self.answers.insert(key, a);
            }
        }
    }

    fn answer(&self, key: &FormKey, map: &Arc<Versions>) -> Option<&FormResult> {
        let (q, current_map) = self.current.get(key)?;
        let a = self.answers.get(key)?;
        (q.generation == a.generation && Arc::ptr_eq(current_map, map) && Arc::ptr_eq(&a.map, map))
            .then_some(&a.result)
    }

    /// A line answer is one-shot, like the ordinary planner's Found batch. Keeping it after use would reinstall
    /// the same partial/blocked line instead of asking for a new search. Duplicate late batches are then ignored.
    fn line(
        &mut self,
        key: FormKey,
        body: Moved,
        to: Vec3,
        map: &Arc<Versions>,
    ) -> Option<Result<sim::walk::town::Line, Refusal>> {
        let matches = self
            .current
            .get(&key)
            .is_some_and(|(q, _)| q.body == body && q.query == (FormQuery::Line { to }));
        let answer = self.answer(&key, map).cloned();
        if answer.is_some() {
            self.current.remove(&key);
            self.answers.remove(&key);
            self.queued.remove(&key);
        }
        match answer {
            Some(FormResult::Line(line)) if matches => Some(line),
            _ => None,
        }
    }

    fn ask(
        &mut self,
        key: FormKey,
        body: Moved,
        query: FormQuery,
        map: &Arc<Versions>,
    ) -> Option<FormResult> {
        let unchanged = self
            .current
            .get(&key)
            .is_some_and(|(q, m)| q.body == body && q.query == query && Arc::ptr_eq(m, map));
        if !unchanged {
            self.generation += 1;
            let q = FormQuestion {
                key,
                generation: self.generation,
                body,
                query,
            };
            self.current.insert(key, (q, Arc::clone(map)));
            self.answers.remove(&key);
        }
        if let Some(answer) = self.answer(&key, map) {
            return Some(answer.clone());
        }
        self.queued.insert(key, self.current[&key].0.clone());
        None
    }
}

/// What the runner sees: the bodies as the controller had them at the call, the town's corners and the tree.
struct Sight<'a> {
    bodies: BTreeMap<Id, Moved>,
    /// The bodies carried across a link now.
    carrying: BTreeSet<Id>,
    split: Option<RefCell<Split<'a>>>,
    builds: BTreeMap<Id, Build>,
    tree: &'a Tree,
    kind: Name,
    /// The world's entries by kind, for a thing's points and bounds.
    kinds: &'a Json,
    /// The thing argument each body's run moves at or toward ([`AT_ARG`]).
    toward: &'a BTreeMap<Id, Id>,
    /// Each walker that asked its way this call (C21): the node it stands on, where it stands, the corner it aims at
    /// and its leg's end, x and z µm.
    asked: RefCell<BTreeMap<Id, Way>>,
    context: BTreeMap<Id, (Id, usize, usize)>,
    /// Each run's walk in progress to a named point: its step, the point's node and the point's name (C34, #3599).
    walks: BTreeMap<Id, (usize, Id, Name)>,
    /// Each run's walk in progress right before a sit into a slot the places hold: its step, the seat's floor and its
    /// stand point on that floor (moved clear at registration when the entry's point is blocked).
    sit_walks: BTreeMap<Id, (usize, Id, Vec3)>,
    /// The bodies whose walk in progress is to be there, not to act from there ([`Forms::goal_walks`]).
    goals: BTreeSet<Id>,
    planning: &'a RefCell<Planning>,
    map: Arc<Versions>,
}

impl Sight<'_> {
    fn with_view<T>(&self, body: Id, f: impl FnOnce(&View<'_>) -> T) -> Option<T> {
        let size = self.builds.get(&body)?.size;
        let mut split = self.split.as_ref()?.try_borrow_mut().ok()?;
        let Split {
            shared,
            scratches,
            lines,
            spent,
        } = &mut *split;
        let view = shared
            .view_for(
                size,
                &mut scratches[0],
                sim::walk::town::Lines::All(lines),
                spent,
            )
            .ok()?;
        Some(f(&view))
    }
    fn key(&self, body: Id, step: usize, kind: FormKind) -> Option<FormKey> {
        let &(intent, stage, _) = self.context.get(&body)?;
        Some(FormKey {
            body,
            intent,
            stage,
            step,
            kind,
        })
    }

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

    /// A walk to a building's named area, resolved onto the building's own room and floor (C34, #3599). `body`'s run
    /// walks, at step `step`, to point `at` of node `node`'s frame, a point its entry names as an `areas` entry of a
    /// thing on `node` that has floors: the area is the thing's room of that name, on that room's floor (a lantern room
    /// four floors up, whatever height the kind's area gives), else the thing's only floor; the point is carried into
    /// the floor's frame (the thing's), at the room's height. `Some(None)` when the thing has floors and none is the
    /// area's; `None` for any other walk, planned as before. No floor is chosen by nearness.
    fn area_floor(&self, body: Id, step: usize, node: Id, at: Vec3) -> Option<Option<(Id, Vec3)>> {
        use import_eden::{F_ORIGIN, FLOOR, ROOM};
        let &(at_step, thing, ref point) = self.walks.get(&body)?;
        if at_step != step {
            return None;
        }
        let th = self.tree.handle(thing)?;
        let n = self.tree.node(th)?;
        if n.parent() != Some(node) {
            return None;
        }
        self.kinds
            .get(plain(n.kind()))?
            .get("areas")?
            .get(point.as_str())?;
        let place = n.place()?;
        let floors: Vec<_> = self
            .tree
            .children(th)?
            .iter()
            .filter_map(|&c| self.tree.node(c))
            .filter(|f| plain(f.kind()) == FLOOR)
            .collect();
        if floors.is_empty() {
            return None;
        }
        // The room the area names: its origin is `<thing>/<area>` (an area's `_` is a room id's `-`).
        let names = [point.as_str().to_owned(), point.as_str().replace('_', "-")];
        let room = floors.iter().find_map(|f| {
            self.tree
                .children(self.tree.handle(f.id())?)?
                .iter()
                .filter_map(|&c| self.tree.node(c))
                .filter(|r| plain(r.kind()) == ROOM)
                .find(|r| match r.fields().get(&F_ORIGIN) {
                    Some(replica::encode::Value::Bytes(o)) => names
                        .iter()
                        .any(|nm| o.ends_with(format!("/{nm}").as_bytes())),
                    _ => false,
                })
                .map(|r| (f.id(), r.place().map(|p| p.position.y)))
        });
        let (floor, y) = match room {
            Some((floor, y)) => (floor, y),
            None if floors.len() == 1 => (floors[0].id(), None),
            None => return Some(None),
        };
        let [w, x, yq, z] = place.orientation.parts();
        let back = replica::pose::Quat::new(w, -x, -yq, -z).ok()?;
        let local = back.rotate(at.minus(place.position).ok()?).ok()?;
        Some(Some((
            floor,
            Vec3::new(local.x, y.unwrap_or(local.y), local.z),
        )))
    }
}

impl Sight<'_> {
    /// The radius of the area a body walks to, at step `step`, to be there (no move or sit after it): the walk may end
    /// within reach of the area's circle. `None` for any other walk.
    fn area_radius(&self, body: Id, step: usize) -> Option<i64> {
        if !self.goals.contains(&body) {
            return None;
        }
        let &(at_step, thing, ref point) = self.walks.get(&body)?;
        if at_step != step {
            return None;
        }
        let n = self.tree.node(self.tree.handle(thing)?)?;
        let r = self
            .kinds
            .get(plain(n.kind()))?
            .get("areas")?
            .get(point.as_str())?
            .get("radius_mm")?;
        match r {
            Json::Int(mm) => i64::try_from(*mm).ok()?.checked_mul(1000),
            _ => None,
        }
    }

    fn on_shape(&self, body: Id, step: usize, node: Id) -> Option<Vec3> {
        let &(at_step, thing, ref point) = self.walks.get(&body)?;
        if at_step != step {
            return None;
        }
        let n = self.tree.node(self.tree.handle(thing)?)?;
        if n.parent() != Some(node) {
            return None;
        }
        on_drawn_shape(&n, self.kinds.get(plain(n.kind()))?, point.as_str())
    }
}

/// Point `point` of entry `entry` laid on thing `n`'s own shape, when `n` is drawn in its parent's frame (placed at its
/// origin, with a line or an outline field), as Eden's land features are: on its line ([`on_line`]) when the entry
/// is long along x (a hedge's, a bridge's: x at least twice z), else on the box of its line's or outline's points
/// ([`on_outline`]: a pond, a garden, a winding channel). `None` for any other thing or point.
pub fn on_drawn_shape(n: &replica::tree::NodeRef<'_>, entry: &Json, point: &str) -> Option<Vec3> {
    use import_eden::{F_LINE, F_OUTLINE};
    if n.place().is_some_and(|p| p.position != Vec3::ZERO) {
        return None;
    }
    let p = ["points", "areas"]
        .iter()
        .find_map(|k| um(entry.get(k)?.get(point)?.get("at_mm")))?;
    let bounds = um(entry.get("geometry")?.get("bounds_mm"))?;
    let xz = |v: &replica::encode::Value| -> Option<Vec<[i64; 2]>> {
        let replica::encode::Value::Array(rows) = v else {
            return None;
        };
        rows.iter()
            .map(|r| match r {
                replica::encode::Value::Array(c) => {
                    Some([int_of(c.first()?)? * 1000, int_of(c.get(1)?)? * 1000])
                }
                _ => None,
            })
            .collect()
    };
    if let Some(line) = n.fields().get(&F_LINE).and_then(xz) {
        if bounds.x >= 2 * bounds.z {
            return on_line(p, bounds, &line);
        }
        return on_outline(p, bounds, &line);
    }
    on_outline(p, bounds, &n.fields().get(&F_OUTLINE).and_then(xz)?)
}

/// `v` stretched from `from` to `to` (µm).
fn stretch(v: i64, from: i64, to: i64) -> Option<i64> {
    i64::try_from(i128::from(v) * i128::from(to) / i128::from(from.max(1))).ok()
}

/// Point `p` of an entry whose bounds are `bounds` laid on `line` (`[x, z]` µm): its x along the line from the first
/// point to the last, stretched from the bounds' x to the line's length, from the line's middle; its z across it, as
/// it is; its y as it is.
fn on_line(p: Vec3, bounds: Vec3, line: &[[i64; 2]]) -> Option<Vec3> {
    let (a, b) = (line.first()?, line.last()?);
    let (dx, dz) = (b[0] - a[0], b[1] - a[1]);
    let len = flat(*a, *b);
    if len == 0 {
        return None;
    }
    let along = stretch(p.x, bounds.x, len)?;
    let on = |u: i64, w: i64| i64::try_from(i128::from(u) * i128::from(w) / i128::from(len)).ok();
    // The line's way is (dx, dz), and across it (-dz, dx), each over its length.
    Some(Vec3::new(
        (a[0] + b[0]) / 2 + on(along, dx)? - on(p.z, dz)?,
        p.y,
        (a[1] + b[1]) / 2 + on(along, dz)? + on(p.z, dx)?,
    ))
}

/// Point `p` of an entry whose bounds are `bounds` laid on `outline` (`[x, z]` µm): from the middle of the outline's
/// box, each of x and z stretched from the bounds to the box; its y as it is.
fn on_outline(p: Vec3, bounds: Vec3, outline: &[[i64; 2]]) -> Option<Vec3> {
    let lo = [0, 1].map(|k| outline.iter().map(|q| q[k]).min());
    let hi = [0, 1].map(|k| outline.iter().map(|q| q[k]).max());
    let ([Some(x0), Some(z0)], [Some(x1), Some(z1)]) = (lo, hi) else {
        return None;
    };
    Some(Vec3::new(
        (x0 + x1) / 2 + stretch(p.x, bounds.x, x1 - x0)?,
        p.y,
        (z0 + z1) / 2 + stretch(p.z, bounds.z, z1 - z0)?,
    ))
}

/// A whole number of the encoding as an `i64`.
fn int_of(v: &replica::encode::Value) -> Option<i64> {
    match v {
        replica::encode::Value::Uint(u) => i64::try_from(*u).ok(),
        replica::encode::Value::Nint(n) => i64::try_from(*n).ok().map(|n| -n - 1),
        _ => None,
    }
}

impl Geometry for Sight<'_> {
    fn ask(&self, body: Id, q: &Ask) -> Option<Answer> {
        match q {
            Ask::Toward { to, .. } => {
                let me = self.bodies.get(&body)?;
                let [x, z] = match &self.split {
                    Some(_) => self.with_view(body, |v| {
                        let step = self.context.get(&body)?.2;
                        let key = self.key(body, step, FormKind::Line)?;
                        let found = self
                            .planning
                            .borrow_mut()
                            .line(key, *me, *to, &self.map)
                            .map(|line| BTreeMap::from([(body, (*to, line))]))
                            .unwrap_or_default();
                        let asked = RefCell::new(Vec::new());
                        let corner = v
                            .corner_planned(
                                me,
                                *to,
                                &sim::walk::town::Plans {
                                    found: &found,
                                    asked: &asked,
                                },
                            )
                            .ok()?;
                        let pending = asked.into_inner();
                        for (sample, goal) in &pending {
                            self.planning.borrow_mut().ask(
                                key,
                                *sample,
                                FormQuery::Line { to: *goal },
                                &self.map,
                            );
                        }
                        // Waiting for the existing planner is not evidence that a physical walk stalled.
                        if !pending.is_empty() {
                            return Some([me.pose.position.x, me.pose.position.z]);
                        }
                        Some(corner)
                    })??,
                    None => [to.x, to.z],
                };
                let y = if [x, z] == [to.x, to.z] { to.y } else { 0 };
                let here = [me.pose.position.x, me.pose.position.z];
                self.asked
                    .borrow_mut()
                    .insert(body, (sim::walk::node_of(me), here, [x, z], [to.x, to.z]));
                Some(Answer::Point(Vec3::new(x, y, z)))
            }
            Ask::Near { .. } => Some(Answer::Near(Vec::new())),
            Ask::Distance { .. } => None,
        }
    }

    fn plan_walk(&self, body: Id, step: usize, node: Id, at: Vec3, reach: i64) -> WalkPlan {
        if self.split.is_none() {
            return WalkPlan::Unplanned;
        }
        let Some(key) = self.key(body, step, FormKind::Walk) else {
            return WalkPlan::Pending;
        };
        let Some(me) = self.bodies.get(&body) else {
            return WalkPlan::Legs(Vec::new());
        };
        let at = self.on_shape(body, step, node).unwrap_or(at);
        // A walk to be in an area ends within reach of the area's circle, not of its middle.
        let reach = reach.saturating_add(self.area_radius(body, step).unwrap_or(0));
        // A walk before a sit goes to the seat's own stand point, the one its sit is measured from.
        let (node, at) = match self.sit_walks.get(&body) {
            Some(&(at_step, floor, stand)) if at_step == step => (floor, stand),
            _ => (node, at),
        };
        let (node, at) = match self.area_floor(body, step, node, at) {
            Some(Some(on)) => on,
            // A building's area with no room or floor of its own to stand on: no way there, the body where it is.
            Some(None) => return WalkPlan::Legs(Vec::new()),
            None => (node, at),
        };
        let mut planning = self.planning.borrow_mut();
        match planning.ask(key, *me, FormQuery::Walk { node, at, reach }, &self.map) {
            Some(FormResult::Walk(legs)) => {
                // A later stage may start in this same call before Sight's context is refreshed: it must request its
                // own answer, even when its step number and target repeat the preceding stage.
                planning.current.remove(&key);
                planning.answers.remove(&key);
                planning.queued.remove(&key);
                WalkPlan::Legs(legs.into_iter().map(|l| (l.to, l.link)).collect())
            }
            _ => WalkPlan::Pending,
        }
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
    fn to_thing(&self, body: Id, floor: Id, from: Vec3, target: Id, point: &Name) -> Option<i64> {
        self.with_view(body, |view| {
            let n = self.tree.node(self.tree.handle(target)?)?;
            let entry = self.kinds.get(plain(n.kind()))?;
            // A body on one of the thing's own floors (inside a greenhouse, C34 #3599) is in the thing's frame: a floor
            // is placed at its building's origin. Carried up the tree, the point would land on the ground cut out under it.
            let own_floor = self
                .tree
                .handle(floor)
                .and_then(|h| self.tree.node(h))
                .is_some_and(|f| {
                    f.parent() == Some(target) && f.place().is_none_or(|p| p.position == Vec3::ZERO)
                });
            let on = |p: Vec3| {
                if own_floor {
                    return Some([p.x, p.z]);
                }
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
            let surface =
                um(entry.get("geometry").and_then(|g| g.get("bounds_mm"))).and_then(|b| {
                    let (x, z) = (b.x / 2, b.z / 2);
                    let c = |u: i64, v: i64| on(Vec3::new(u, 0, v));
                    let ring = [c(-x, -z)?, c(x, -z)?, c(x, z)?, c(-x, z)?];
                    Some(to_ring(q, &ring))
                });
            let d = match (named, surface) {
                (Some(a), Some(b)) => a.min(b),
                (a, b) => a.or(b)?,
            };
            Some(
                d.saturating_sub(self.builds.get(&body)?.size.radius_mm() * 1000)
                    .max(0),
            )
        })?
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
        // C23: a move at the body itself, or at the thing argument its run named.
        let target = match point.as_str() {
            AT_SELF => return Some(0),
            AT_ARG => *self.toward.get(&body)?,
            _ => target,
        };
        if let Some(d) = self.to_thing(body, sim::walk::node_of(me), a, target, point) {
            return Some(d);
        }
        let b = match self.bodies.get(&target) {
            Some(t) => t.pose.position,
            None => self.place(target)?,
        };
        Some(flat([a.x, a.z], [b.x, b.z]))
    }
}

/// The point a move with no `at` and no `toward` reaches (C23, #3494): the body itself, always in reach (a wave, a
/// stretch, a bow where it stands).
pub const AT_SELF: &str = "souls:self";

/// The point a move whose `at` or `toward` is a thing argument reaches (C23): that thing's nearest surface, else its
/// place, measured as a move at the form's own thing is ([`Sight::to_thing`]).
pub const AT_ARG: &str = "souls:argument";

fn obj_mut<'a>(v: &'a mut Json, key: &str) -> Option<&'a mut Json> {
    match v {
        Json::Obj(o) => o.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

/// A move step's target resolved from the form's arguments (C23, #3494), in a copy of `entry` the binder then reads:
/// a move with no `at` and no `toward` is at [`AT_SELF`]; one whose `at`, or with no `at` whose `toward`, is a thing
/// argument is at [`AT_ARG`], that thing (returned). A point of this thing named by `at` stays as it is. An argument
/// not given as a thing is refused `arg-missing`. The two points are added to the copy's points, at its origin, so the
/// binder knows them; [`Sight`] measures them.
fn targets(entry: &Json, form: &str, args: &skills::form_runner::Args) -> R<(Json, Option<Id>)> {
    let mut e = entry.clone();
    let mut thing = None;
    let steps = obj_mut(&mut e, "forms")
        .and_then(|fs| obj_mut(fs, form))
        .and_then(|f| obj_mut(f, "steps"));
    let Some(Json::Arr(steps)) = steps else {
        return Ok((e, None));
    };
    for s in steps.iter_mut() {
        let kind = s.get("step").and_then(Json::str);
        if !matches!(kind, Some("move" | "take" | "put")) || s.get("move").is_none() {
            continue;
        }
        let arg = |k: &str| s.get(k).and_then(|v| v.get("arg")).and_then(Json::str);
        let at = match (s.get("at"), arg("at"), arg("toward")) {
            (Some(Json::Str(_)), ..) => continue,
            (None, None, None) => AT_SELF,
            (_, Some(a), _) | (None, None, Some(a)) => {
                match args.get(a) {
                    Some(skills::form_runner::Arg::Name(_)) => continue,
                    Some(skills::form_runner::Arg::Node(id)) => {
                        if thing.is_some_and(|old| old != *id) {
                            return Err(refusal("arg-ambiguous", a));
                        }
                        thing = Some(*id);
                    }
                    Some(_) => return Err(refusal("step-malformed", a)),
                    None => return Err(refusal("arg-missing", a)),
                }
                AT_ARG
            }
            _ => continue,
        };
        if let Json::Obj(o) = s {
            o.retain(|(k, _)| k != "at");
            o.push(("at".into(), Json::s(at)));
        }
    }
    let origin = || Json::object([("at_mm", Json::Arr(vec![Json::Int(0); 3]))]);
    if let Json::Obj(o) = &mut e
        && !o.iter().any(|(k, _)| k == "points")
    {
        o.push(("points".into(), Json::Obj(Vec::new())));
    }
    if let Some(Json::Obj(ps)) = obj_mut(&mut e, "points") {
        ps.push((AT_SELF.into(), origin()));
        ps.push((AT_ARG.into(), origin()));
    }
    Ok((e, thing))
}

/// A form's arguments, from its intent: things by id (F4), slots of the node by number (C12).
#[derive(Clone, Debug, Default)]
pub struct Args {
    pub things: BTreeMap<String, Id>,
    pub slots: BTreeMap<String, u64>,
    /// Value arguments (C24): a value by name, words by their reference, as a set's `{"arg": a}` reads them (F14).
    pub values: skills::form_runner::Args,
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
    /// The thing argument each body's run moves at or toward (C23).
    toward: BTreeMap<Id, Id>,
    /// The forms' timers (C24) pending on the due list, by id: each starts its form on its node when it fires.
    timers: BTreeMap<Id, (Id, Name)>,
    /// Each form a timer started since the last call, by the timer's id: its run, or its refusal by name (C24).
    pub fired: Vec<(Id, R<Asked>)>,
    /// The form's walks watched for progress (C21).
    watch: Watch,
    /// What blocked each body whose walk ended [`BLOCKED`], until its run's ending is read.
    blocked: BTreeMap<Id, String>,
    planning: RefCell<Planning>,
}

/// The moves a form's step may name: every move content declares, and the body's own (C23, [`crate::moves`]).
pub fn library() -> R<Vec<Move>> {
    crate::moves::library()
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
            toward: BTreeMap::new(),
            timers: BTreeMap::new(),
            fired: Vec::new(),
            watch: Watch::new(),
            blocked: BTreeMap::new(),
            planning: RefCell::new(Planning::default()),
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
        let context = self.forms.planning_context();
        let walks = self.forms.walks();
        self.planning.borrow_mut().keep(&context);
        let mut sit_walks = BTreeMap::new();
        let (controller, split, slots, map, questions) = match bodies {
            Some(b) => {
                for (body, (step, node, slot)) in self.forms.seat_walks() {
                    if let Some(p) = b.slots.place_in(node, slot)
                        && let Ok(stand) = p.stand()
                    {
                        let y = p.point.y - p.place.height;
                        sit_walks.insert(body, (step, p.floor, Vec3::new(stand.x, y, stand.z)));
                    }
                }
                self.planning
                    .borrow_mut()
                    .receive(std::mem::take(&mut b.form_answers));
                (
                    &mut b.runner.controller,
                    Some(b.town.split(1)),
                    Some(&mut b.slots),
                    Arc::clone(&b.form_map),
                    Some(&mut b.form_questions),
                )
            }
            None => (
                &mut self.own,
                None,
                None,
                Arc::new(Versions::default()),
                None,
            ),
        };
        let floors = split.as_ref().map(|s| s.shared);
        let places = match (slots, floors.as_ref()) {
            (Some(slots), Some(floors)) => Some(Places { slots, floors }),
            _ => None,
        };
        let sight = Sight {
            bodies: controller
                .ids()
                .filter_map(|id| controller.body(id).map(|b| (id, *b)))
                .collect(),
            carrying: controller
                .bodies()
                .filter(|b| controller.carrying(b.id).is_some())
                .map(|b| b.id)
                .collect(),
            builds: controller
                .ids()
                .filter_map(|id| controller.build(id).map(|build| (id, build)))
                .collect(),
            split: split.map(RefCell::new),
            tree,
            kind: Name::new("souls:body").unwrap_or_else(|| unreachable!("a literal name")),
            kinds: &self.kinds,
            toward: &self.toward,
            asked: RefCell::new(BTreeMap::new()),
            context,
            walks,
            sit_walks,
            goals: self.forms.goal_walks(),
            planning: &self.planning,
            map,
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
        let result = f(&mut self.forms, &mut w);
        let context = self.forms.planning_context();
        self.planning.borrow_mut().keep(&context);
        if let Some(out) = questions {
            out.retain(|k, _| context.get(&k.body) == Some(&(k.intent, k.stage, k.step)));
            out.extend(std::mem::take(&mut self.planning.borrow_mut().queued));
        }
        result
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
            let Some(entry) = self.kinds.get(&kind) else {
                first.get_or_insert(refusal("no_such_kind", kind));
                continue;
            };
            if let Some(key) = args.things.keys().find(|k| args.slots.contains_key(*k)) {
                first.get_or_insert(refusal("arg-ambiguous", key));
                continue;
            }
            let mut all = match skills::form_runner::args_in(entry, &args.things, &args.slots) {
                Ok(all) => all,
                Err(e) => {
                    first.get_or_insert(e);
                    continue;
                }
            };
            let mut ambiguous = None;
            for (key, value) in &args.values {
                if all.insert(key.clone(), value.clone()).is_some() {
                    ambiguous = Some(key.clone());
                    break;
                }
            }
            if let Some(key) = ambiguous {
                first.get_or_insert(refusal("arg-ambiguous", key));
                continue;
            }
            // A body's slot the caller left out, which the form selects from the thing's free slots, is the free one
            // whose stand point is nearest the body (C19's pick); a thing with none free is refused by name (#3802).
            // One the caller named that another body holds is refused `place-taken`, also before any walk.
            let (mut picked, mut none_free, mut taken) = (false, None, None);
            if let (Some(b), Some(f)) = (
                bodies.as_deref().filter(|b| b.slots.place(*node).is_some()),
                entry.get("forms").and_then(|f| f.get(form)),
            ) {
                let names = entry.get("slots").and_then(Json::obj).unwrap_or(&[]);
                for (key, _) in f.get("takes").and_then(Json::obj).unwrap_or(&[]) {
                    if !selects_body_slot(f, key) {
                        continue;
                    }
                    if let Some(skills::form_runner::Arg::Name(n)) = all.get(key) {
                        let slot = names.iter().position(|(m, _)| m == n).map(|i| i as u64 + 1);
                        if slot
                            .and_then(|s| b.slots.holder_in(*node, s))
                            .is_some_and(|h| h != body)
                        {
                            taken = Some(n.clone());
                        }
                        continue;
                    }
                    if all.contains_key(key) {
                        continue;
                    }
                    let free = b.slots.free(&b.runner.controller, body, *node);
                    match free.and_then(|s| names.get(usize::try_from(s).ok()?.checked_sub(1)?)) {
                        Some((n, _)) => {
                            all.insert(key.clone(), skills::form_runner::Arg::Name(n.clone()));
                            picked = true;
                        }
                        None => none_free = Some(key.clone()),
                    }
                }
            }
            if let Some(name) = taken {
                first.get_or_insert(refusal("place-taken", name));
                continue;
            }
            if let Some(key) = none_free {
                first.get_or_insert(refusal(sim::commit::bind::NONE_FREE, key));
                continue;
            }
            let incompatible = entry
                .get("forms")
                .and_then(|f| f.get(form))
                .and_then(|f| f.get("takes"))
                .and_then(Json::obj)
                .unwrap_or(&[])
                .iter()
                .find_map(|(key, take)| {
                    let fits = match take.get("type").and_then(Json::str) {
                        Some("part") => all
                            .get(key)
                            .map(|a| matches!(a, skills::form_runner::Arg::Name(_))),
                        Some("text") => all
                            .get(key)
                            .map(|a| matches!(a, skills::form_runner::Arg::Text(_))),
                        _ => return None,
                    };
                    match fits {
                        Some(true) => None,
                        Some(false) => Some(refusal("arg-type", key)),
                        None => Some(refusal("arg-missing", key)),
                    }
                });
            if let Some(e) = incompatible {
                first.get_or_insert(e);
                continue;
            }
            // A thing on a course away from its stop (a punt out on the water, #3603) is refused before any walk to it.
            if let Some(Err(e)) = bodies.as_deref().map(|b| b.slots.boardable(*node, now)) {
                first.get_or_insert(e);
                continue;
            }
            // The same complete arguments reach target resolution, step binding and effects.
            let (entry, thing) = match targets(entry, form, &all) {
                Ok(t) => t,
                Err(e) => {
                    first.get_or_insert(e);
                    continue;
                }
            };
            let was = match thing {
                Some(t) => self.toward.insert(body, t),
                None => self.toward.remove(&body),
            };
            // F3's reservation is a link from the body: until bodies are nodes of the tree, a form reserves nothing.
            if tree.handle(body).is_none() {
                self.forms.shared(*node);
            }
            let audiences = BTreeMap::<Id, BTreeSet<Id>>::new();
            let r = self.with(tree, bodies.as_deref_mut(), tick, |forms, w| {
                if !picked
                    && args.things.is_empty()
                    && args.slots.is_empty()
                    && args.values.is_empty()
                {
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
                // Thing, slot and value arguments (F4, C12, C24, C25): bound here, as `Forms::commit` binds none yet.
                let steps = skills::form_runner::bind_with(&entry, form, &all)?;
                let effects = skills::form_runner::bind_effects_args(&entry, form, &all)?;
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
                    // A refused act leaves the body's run as it was.
                    match was {
                        Some(t) => self.toward.insert(body, t),
                        None => self.toward.remove(&body),
                    };
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

    /// The forms' part of a tick at world time `now`: their walks, each one that stalled ended [`BLOCKED`] (C21), then
    /// every timer of theirs due by `now`.
    pub fn tick(&mut self, tree: &Tree, bodies: Option<&mut Bodies>, tick: u64, now: Micros) {
        let mut bodies = bodies;
        let timers = self.timers.keys().copied().collect::<BTreeSet<Id>>();
        let mut watch = std::mem::take(&mut self.watch);
        let mut blocked = Vec::new();
        let fired = self.with(tree, bodies.as_deref_mut(), tick, |forms, w| {
            forms.tick(w, now);
            let asked = std::mem::take(&mut *w.geometry.asked.borrow_mut());
            watch.keep(&asked.keys().copied().collect());
            for (body, (node, here, aim, to)) in asked {
                if watch.seen(body, here, aim, to, now) && forms.stall(w, body, BLOCKED, now) {
                    blocked.push((body, blocker(w.tree, node, here)));
                }
            }
            let mut fired = Vec::new();
            while let Some(t) = w.due.fire(now) {
                if !forms.fire(w, &t) && timers.contains(&t.id) {
                    fired.push(t);
                }
            }
            fired
        });
        self.watch = watch;
        self.blocked.extend(blocked);
        for t in fired {
            self.timer_fired(tree, bodies.as_deref_mut(), &t, tick);
        }
        // The walks' crossings, carried by the town's links as the bodies' own walks are (C17).
        let mut staged = Staged::default();
        staged.crossings.append(&mut self.forms.crossings);
        if let Some(b) = bodies
            && !staged.crossings.is_empty()
        {
            let _ = sim::host::carry(&staged, &mut b.runner.controller, &mut b.town, now);
        }
    }

    /// A form's timer fired (C24): its clear is written, and its form is started on its node with the world as
    /// actor, keyed by the timer; its run or its refusal by name is kept in [`Acts::fired`].
    fn timer_fired(&mut self, tree: &Tree, bodies: Option<&mut Bodies>, t: &Timer, tick: u64) {
        let Some((node, form)) = self.timers.remove(&t.id) else {
            return;
        };
        self.forms.out.push(Effect {
            envelope: replica::effects::Envelope {
                sequence: 0,
                at: t.due,
                cause: replica::effects::Cause::World,
                actor: Actor::World,
                audience: replica::world_model::Audience::Everyone,
                node,
            },
            body: Body::Timers(vec![TimerRec::Clear { timer: t.id }]),
            events: None,
            rest: replica::effects::Rest::new(),
        });
        let name = form
            .as_str()
            .split_once(':')
            .map_or(form.as_str(), |(_, f)| f);
        let entry = tree
            .handle(node)
            .and_then(|h| tree.node(h))
            .and_then(|n| self.kinds.get(plain(n.kind())).cloned());
        let asked = match entry {
            None => Err(refusal("thing-missing", replica::world_model::show(node))),
            Some(entry) => {
                let intent = Intent {
                    id: t.id,
                    expiry: t.due,
                    actor: Actor::World,
                    digest: replica::ids::sha256(
                        &replica::encode::encode(&t.id.to_value()).unwrap_or_default(),
                    ),
                };
                self.with(tree, bodies, tick, |forms, w| {
                    let steps = skills::form_runner::bind(&entry, name)?;
                    let effects = skills::form_runner::bind_effects(&entry, name)?;
                    forms.start(w, node, node, intent, steps, effects, limits(), t.due)
                })
            }
        };
        if let Ok(Asked::Started(run) | Asked::Running(run)) = &asked {
            self.runs.insert(*run, t.id);
        }
        self.fired.push((t.id, asked));
    }

    /// What the forms wrote, to be numbered and applied. The forms' timers set there go on the due list, and those
    /// cleared come off it (C24).
    pub fn out(&mut self) -> Vec<Effect> {
        let out = std::mem::take(&mut self.forms.out);
        for e in &out {
            let Body::Timers(ts) = &e.body else { continue };
            for t in ts {
                match t {
                    TimerRec::Set { timer, due, name } => {
                        let set = self.due.set(Timer {
                            node: e.envelope.node,
                            id: *timer,
                            due: *due,
                            name: name.clone(),
                        });
                        if set.is_ok() {
                            self.timers.insert(*timer, (e.envelope.node, name.clone()));
                        }
                    }
                    TimerRec::Clear { timer } => {
                        if self.timers.remove(timer).is_some() {
                            let _ = self.due.clear(e.envelope.node, *timer);
                        }
                    }
                }
            }
        }
        out
    }

    /// Runs that ended since the last call: each one's intent, its ending's name and, for [`BLOCKED`], what blocked
    /// its walk.
    pub fn ended(&mut self) -> Vec<(Id, String, Option<String>)> {
        std::mem::take(&mut self.forms.ended)
            .into_iter()
            .filter_map(|e| {
                let why = self.blocked.remove(&e.body);
                let why = why.filter(|_| e.how.as_str() == BLOCKED);
                Some((self.runs.remove(&e.run)?, e.how.as_str().to_owned(), why))
            })
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

#[cfg(test)]
mod gateway_walk_tests {
    use super::*;

    #[test]
    fn a_gateway_walks_route_time_includes_margin_links_and_the_same_ceiling() {
        assert_eq!(walk_span(14_000, 0), 15_000_000);
        assert_eq!(walk_span(14_000, 2), 25_000_000);
        assert!(walk_span(20_000, 0) > 14_000_000);
        assert!(walk_span(70_000, 0) >= 75_000_000);
        assert_eq!(walk_span(u64::MAX, usize::MAX), WALK_MOST);
    }
}

#[cfg(test)]
mod tests;
