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
//!   the floor the body stands on or another floor of its building (C22, #3485); from the feet to the node's place
//!   when its entry gives neither. Height counts too: what lies above the body's standing reach or more than
//!   [`BELOW_FEET`] under its feet is that much further (a thing on the floor above or below is out of reach).
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
//!   ([`sim::walk::stall::Watch`]) against the corner its line aims at and that line's leg's end (never the walk's
//!   goal, which on a route with crossings lies past the leg's end): one that gains less than a quarter metre on
//!   them over 3 s of world time, or whose least way left to the leg's end has not shrunk by a quarter metre in 30 s
//!   (it circles or goes to and fro), ends `walk.blocked` in that tick, its body's driver released, and the act's
//!   ending entry names the nearest thing or edge in its way ([`sim::walk::stall::blocker`]).
//!
//! - **Needs at commit** (#3888). After who may, every need of the form is decided by R2's one evaluator on the
//!   world's own state, links, seats and hands included ([`crate::needs`]): an unmet need is refused by its reason's
//!   name and index before any walk or effect. Reach is the move's own, measured at its start (C22).
//!
//! - **A restart** (N2, 0.133). The forms are read back from the log ([`Acts::recover`]): a run open at the kill is
//!   ended `restart` in the first tick, so its reservation is freed and the log holds its end. Its intent, never
//!   answered, is taken afresh when the gateway sends it again: a walk is planned again from where the body stands.
//!
//! Not here: a form's reservation (F3's link needs both ends in the tree, so a form reserves nothing until bodies are
//! nodes); resuming a run mid-way after a restart.

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
use replica::intents::{Intent as WireIntent, Target};
use replica::kinds::sizes::Build;
use replica::moves::{Effector, Move};
use replica::pose::Vec3;
use replica::rules::json::Value as Json;
use replica::time::Micros;
use replica::tree::Tree;
use sim::controller::Controller;
use sim::forms::{Asked, Forms, Intent, Places, RunId, World};
use sim::ground::scene::xform_to;
use sim::host::{Geometry, Staged};
use sim::mover::Body as Moved;
use sim::moves::{Moves, Reach};
use sim::timers::{DueList, Timer};
use sim::walk::stall::{Watch, blocker};
use sim::walk::town::{Split, View};
use skills::form_runner::Limits;

use crate::bodies::Bodies;

type R<T> = Result<T, Refusal>;

/// The longest a form's walk may take, µs (C20, #3469), its route not yet planned when its timer is set: 30 minutes,
/// about 2.5 km at a body's free speed (1.4 m/s), twice the longest way across Eden. It is a bound, not a pace: as in
/// today's game, a walk that stops making progress ends `walk.blocked` by C21's watch ([`BLOCKED`]), and one that
/// cannot go on by its own name. It was 180 s, and every walk over about 250 m ended `act.timed-out` while moving.
pub const WALK_MOST: Micros = 1_800_000_000;

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
/// unrelated ticks do no route search. Waiting for a link or being carried is not a stalled walking tick. The deadline
/// counts from the tick the route is read, not from the move's start, so a walk whose planning or spot waited still
/// gets its whole route's time (W11, #4087).
pub(crate) struct Walk {
    body: Id,
    order: Id,
    planned: bool,
    watch: Watch,
    /// The leg's end last seen on the walk's line.
    leg: Option<[i64; 2]>,
}

/// A gateway walk's time once its route is planned: the route at walking speed, plus half again for bends and yielding
/// (at least 5 s), plus 5 s per crossing or door. No total cap: a long walk that keeps moving ends done, never by the
/// clock; C21's watch ends one that stalls, and the intent's expiry still bounds it.
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
}

impl Walk {
    pub(crate) fn new(body: Id, order: Id) -> Self {
        Self {
            body,
            order,
            planned: false,
            watch: Watch::new(),
            leg: None,
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
            due = Some(now.saturating_add(walk_span(metrics.length_mm, metrics.links)));
            self.planned = true;
        }
        let fields = b.runner.fields.get(&self.body);
        let waiting = sim::host::waiting(fields).is_some()
            || fields.is_some_and(|f| f.contains_key(&replica::host::F_HELD));
        // The corner and the leg's end its line goes toward, as a form's walk asks them: never the walk's granted
        // place, which on a route with crossings lies past the leg's end, so a leg heading away from it gained nothing
        // and a Soul walking at full speed was ended `walk.blocked` (#1960).
        let aim = b
            .town
            .next_corner_toward(self.body)
            .filter(|(node, _, _)| *node == sim::walk::node_of(&me));
        let Some((_, aim, to)) =
            aim.filter(|_| !waiting && b.runner.controller.carrying(self.body).is_none())
        else {
            self.watch.keep(&BTreeSet::new());
            return (due, false);
        };
        // A line forgotten while the planner finds the next one keeps its corner, not its leg's end: the last leg's
        // end seen stands for it (the new line goes toward the same one), so a walk trapped between lines is still
        // watched.
        let to = match to {
            Some(t) => *self.leg.insert(t),
            None => self.leg.unwrap_or(aim),
        };
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
    /// The bodies whose walk in progress is an approach to a move's point (#3688).
    approaches: BTreeSet<Id>,
    /// Each run's walk in progress right before a sit into a slot the places hold: its step, the seat's floor and its
    /// stand point on that floor (moved clear at registration when the entry's point is blocked).
    sit_walks: BTreeMap<Id, (usize, Id, Vec3)>,
    /// The bodies whose walk in progress is to be there, not to act from there ([`Forms::goal_walks`]).
    goals: BTreeSet<Id>,
    /// The reach of the move each walk in progress comes right before ([`Forms::walk_moves`]), µm.
    walk_moves: BTreeMap<Id, i64>,
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

    /// Point `at` of node `node`'s frame carried onto the floor of `node` nearest its height (#3688), when `node` has
    /// floors: `None` when it has none. A floor's heights are its surfaces' (N1's `F_SURFACES`, mm in the thing's
    /// frame) and its rooms': every floor node stands at the thing's origin, so its place says nothing of its height
    /// (#1960: an upper landing's door was carried onto the ground floor, where no place is within an arm of it).
    fn floor_of(&self, node: Id, at: Vec3) -> Option<(Id, Vec3)> {
        use import_eden::{FLOOR, ROOM};
        use replica::encode::Value;
        let mm = |v: &Value| match v {
            Value::Uint(n) => i64::try_from(*n).ok(),
            Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
            _ => None,
        };
        let floor = self
            .tree
            .children(self.tree.handle(node)?)?
            .iter()
            .filter_map(|&c| self.tree.node(c))
            .filter(|f| plain(f.kind()) == FLOOR)
            .filter_map(|f| {
                let place = f.place()?;
                let surfaces = match f.fields().get(&sim::ground::scene::F_SURFACES) {
                    Some(Value::Array(rows)) => rows.as_slice(),
                    _ => &[],
                };
                let rooms = self
                    .tree
                    .children(self.tree.handle(f.id())?)?
                    .iter()
                    .filter_map(|&c| self.tree.node(c))
                    .filter(|r| plain(r.kind()) == ROOM)
                    .filter_map(|r| Some(r.place()?.position.y));
                let off = surfaces
                    .iter()
                    .filter_map(|r| match r {
                        Value::Array(r) => r.first().and_then(mm).map(|y| y * 1000),
                        _ => None,
                    })
                    .chain(rooms)
                    .map(|y| (y - at.y).abs())
                    .min()
                    .unwrap_or((place.position.y - at.y).abs());
                Some((off, f.id(), place))
            })
            .min_by_key(|(off, _, _)| *off)
            .map(|(_, id, place)| (id, place))?;
        let [w, x, y, z] = floor.1.orientation.parts();
        let back = replica::pose::Quat::new(w, -x, -y, -z).ok()?;
        let local = back.rotate(at.minus(floor.1.position).ok()?).ok()?;
        Some((floor.0, local))
    }

    /// A walk to a building's named area, resolved onto the building's own room and floor (C34, #3599). `body`'s run
    /// walks, at step `step`, to point `at` of node `node`'s frame, a point its entry names as an `areas` entry of a
    /// thing on `node` that has floors: the area is the thing's room of that name, on that room's floor (a lantern room
    /// four floors up, whatever height the kind's area gives), else the thing's only floor; the point is carried into
    /// the floor's frame (the thing's), at the room's height. An area that is no room is on the thing's floor where a
    /// body may stand within `reach` of it, the nearest such in height; with none, it is off the thing's floors (a
    /// house's back garden, a bridge's ends) and planned as any other point, on the open ground under it, as today's
    /// game walks to an area by its centre. `None` for any other walk, planned as before.
    fn area_floor(
        &self,
        body: Id,
        step: usize,
        node: Id,
        at: Vec3,
        reach: i64,
    ) -> Option<(Id, Vec3)> {
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
            .get(entry_of(&n))?
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
        let [w, x, yq, z] = place.orientation.parts();
        let back = replica::pose::Quat::new(w, -x, -yq, -z).ok()?;
        let local = back.rotate(at.minus(place.position).ok()?).ok()?;
        if let Some((floor, y)) = room {
            return Some((floor, Vec3::new(local.x, y.unwrap_or(local.y), local.z)));
        }
        let own: Vec<Id> = floors.iter().map(|f| f.id()).collect();
        if let Some(on) = self.stand_on(body, th, &own, local, reach, false) {
            return Some(on);
        }
        // Deck-stand (#1960): a thing with no rooms is sized by its own floors and stairs, not by its kind's frame (a
        // bridge laid along a path in the world's frame, its pose the world's origin; a flight three times the kind's
        // height). Its kind's areas are fitted to them, axis by axis (the areas' span onto the floors' and stairs'),
        // and the area is on a floor that stands a body near the fitted point, else on the ground under it.
        let roomless = floors.iter().all(|f| {
            self.tree
                .handle(f.id())
                .and_then(|h| self.tree.children(h))
                .is_some_and(|cs| {
                    cs.iter()
                        .filter_map(|&c| self.tree.node(c))
                        .all(|r| plain(r.kind()) != ROOM)
                })
        });
        if !roomless {
            return None;
        }
        let entry = self.kinds.get(entry_of(&n))?;
        let fitted = fit(&areas_span(entry)?, &extent(self.tree, &own)?, local);
        // A body is in an area within its radius: its floor is sought within that and `reach`.
        let reach = match entry.get("areas")?.get(point.as_str())?.get("radius_mm") {
            Some(Json::Int(r)) => {
                reach.saturating_add(i64::try_from(*r).unwrap_or(0).saturating_mul(1000))
            }
            _ => reach,
        };
        if let Some(on) = self.stand_on(body, th, &own, fitted, reach, true) {
            return Some(on);
        }
        let on_node = place
            .position
            .plus(place.orientation.rotate(fitted).ok()?)
            .ok()?;
        Some((node, on_node))
    }

    /// Where a body may stand within `reach` of point `p` of thing `th`'s frame on one of the floors `own` of the thing,
    /// else, when `beyond`, on a floor its links land on (the roof its flight leads up to, #1960): that floor and the
    /// place, in that floor's frame, the one nearest `p` in height.
    fn stand_on(
        &self,
        body: Id,
        th: replica::tree::Handle,
        own: &[Id],
        p: Vec3,
        reach: i64,
        beyond: bool,
    ) -> Option<(Id, Vec3)> {
        let thing = self.tree.node(th)?.id();
        self.with_view(body, |v| {
            let others: Vec<Id> = if beyond {
                v.floors_reached(thing)
                    .into_iter()
                    .filter(|f| !own.contains(f))
                    .collect()
            } else {
                Vec::new()
            };
            [own, &others[..]]
                .iter()
                .find_map(|floors| self.nearest_on(v, th, floors, p, reach))
        })
        .flatten()
    }

    /// [`Sight::stand_on`] on the floors `floors` alone.
    fn nearest_on(
        &self,
        v: &View<'_>,
        th: replica::tree::Handle,
        floors: &[Id],
        p: Vec3,
        reach: i64,
    ) -> Option<(Id, Vec3)> {
        floors
            .iter()
            .filter_map(|&f| {
                let owner = self.tree.node(self.tree.handle(f)?)?.parent()?;
                let oh = self.tree.handle(owner)?;
                // Carried through the frame both stand in (the open ground, for two things on it).
                let at = if oh == th {
                    p
                } else {
                    let up = self.tree.handle(self.tree.node(th)?.parent()?)?;
                    let w = xform_to(self.tree, th, up).ok()?.point(p).ok()?;
                    sim::links::back(&xform_to(self.tree, oh, up).ok()?, w).ok()?
                };
                let s = v.stand_near(f, at, reach, None)?;
                Some(((s.y - at.y).abs(), f, s))
            })
            .min_by_key(|c| c.0)
            .map(|(_, f, s)| (f, s))
    }
}

/// The span `[least, most]` of an entry's areas on each axis, µm in its kind's frame.
fn areas_span(entry: &Json) -> Option<[[i64; 2]; 3]> {
    let mut span: Option<[[i64; 2]; 3]> = None;
    for (_, a) in entry.get("areas")?.obj()? {
        let at = a.get("at_mm")?.arr()?;
        let mut p = [0i64; 3];
        for (k, v) in at.iter().take(3).enumerate() {
            match v {
                Json::Int(n) => p[k] = i64::try_from(*n).ok()?.checked_mul(1000)?,
                _ => return None,
            }
        }
        let s = span.get_or_insert([[p[0]; 2], [p[1]; 2], [p[2]; 2]]);
        for k in 0..3 {
            s[k] = [s[k][0].min(p[k]), s[k][1].max(p[k])];
        }
    }
    span
}

/// The span on each axis of a thing's floors' surfaces and stairs (the floors `floors`, `F_SURFACES` and `F_STAIRS`),
/// µm in the thing's frame (its floors stand at its origin).
fn extent(tree: &replica::tree::Tree, floors: &[Id]) -> Option<[[i64; 2]; 3]> {
    use replica::encode::Value as V;
    let int = |v: &V| match v {
        V::Uint(n) => i64::try_from(*n).ok(),
        V::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    };
    let arr = |v: &V| match v {
        V::Array(a) => a.clone(),
        _ => Vec::new(),
    };
    let mut span: Option<[[i64; 2]; 3]> = None;
    let mut add = |x: i64, y: i64, z: i64| {
        let p = [x * 1000, y * 1000, z * 1000];
        let s = span.get_or_insert([[p[0]; 2], [p[1]; 2], [p[2]; 2]]);
        for k in 0..3 {
            s[k] = [s[k][0].min(p[k]), s[k][1].max(p[k])];
        }
    };
    let points = |v: &V| -> Vec<(i64, i64)> {
        arr(v)
            .iter()
            .filter_map(|p| match arr(p).as_slice() {
                [x, z, ..] => Some((int(x)?, int(z)?)),
                _ => None,
            })
            .collect()
    };
    for &f in floors {
        let n = tree.node(tree.handle(f)?)?;
        if let Some(v) = n.fields().get(&import_eden::F_SURFACES) {
            for s in arr(v) {
                if let [y, ring] = arr(&s).as_slice() {
                    let y = int(y)?;
                    points(ring).into_iter().for_each(|(x, z)| add(x, y, z));
                }
            }
        }
        if let Some(v) = n.fields().get(&import_eden::F_STAIRS) {
            for r in arr(v) {
                let r = arr(&r);
                let (Some(y0), Some(y1)) = (r.get(4).and_then(int), r.get(5).and_then(int)) else {
                    continue;
                };
                for (x, z) in r.get(6).map(points).unwrap_or_default() {
                    add(x, y0, z);
                    add(x, y1, z);
                }
            }
        }
    }
    span
}

/// Point `p` of a kind's frame fitted to a thing, axis by axis: the areas' span `areas` onto the thing's span `thing`;
/// on an axis where the areas do not spread, the middle of the thing's span.
fn fit(areas: &[[i64; 2]; 3], thing: &[[i64; 2]; 3], p: Vec3) -> Vec3 {
    let axis = |k: usize, v: i64| {
        let ([a0, a1], [t0, t1]) = (areas[k], thing[k]);
        if a1 > a0 {
            let f = i128::from(v - a0) * i128::from(t1 - t0) / i128::from(a1 - a0);
            t0 + i64::try_from(f).unwrap_or(0)
        } else {
            t0 + (t1 - t0) / 2
        }
    };
    Vec3::new(axis(0, p.x), axis(1, p.y), axis(2, p.z))
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
            .get(entry_of(&n))?
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
        let entry = self.kinds.get(entry_of(&n));
        if let Some(at) = entry.and_then(|e| on_drawn_shape(&n, e, point.as_str())) {
            return Some(at);
        }
        // A thing argument names no point of the thing (#4072): the walk goes to the nearest place on its own shape,
        // from where the body stands, carried into the thing's parent's frame.
        let me = self.bodies.get(&body)?;
        let (frame, parent, p) = (
            self.place(me.pose.frame.node)?,
            self.place(node)?,
            me.pose.position,
        );
        nearest_on_drawn_shape(&n, [frame.x + p.x - parent.x, frame.z + p.z - parent.z])
    }

    /// The footprint of the thing argument a body walks to at step `step` (#4072), when the thing is a child of `node`,
    /// not a body, names no point of its entry (a base form's `go_to`, `wait_by`, `touch`, `lean_on`) and its entry
    /// gives bounds ([`sim::spots::footprint`], the rule [`Sight::to_thing`] judges reach by): the floor it stands
    /// over, its corners and its middle carried onto that floor, whether the walk ends on it, and how near its outline
    /// it ends.
    ///
    /// - A walk to be at a walkable thing ([`sim::spots::walkable`]: a stage, a rug, a deck, a court) ends on it.
    /// - A walk right before a move ends within that move's own reach of the outline, as [`Sight::to_thing`] measures
    ///   it from the body's edge, less how near a walk comes to its end ([`skills::route::AT_GOAL`]): so a `touch`
    ///   after it is in reach.
    /// - Any other walk ends within `reach` (the form's) of the outline.
    fn footprint_walk(
        &self,
        body: Id,
        step: usize,
        node: Id,
        reach: i64,
    ) -> Option<(Id, [Vec3; 4], Vec3, bool, i64)> {
        let &(at_step, thing, ref point) = self.walks.get(&body)?;
        if at_step != step || self.bodies.contains_key(&thing) {
            return None;
        }
        let n = self.tree.node(self.tree.handle(thing)?)?;
        if n.parent() != Some(node) {
            return None;
        }
        let entry = self.kinds.get(entry_of(&n))?;
        let named = ["points", "slots", "areas"]
            .iter()
            .any(|s| entry.get(s).and_then(|x| x.get(point.as_str())).is_some());
        if named {
            return None;
        }
        let (corners, _) = sim::spots::footprint(entry)?;
        let on = self.goals.contains(&body) && sim::spots::walkable(entry);
        let reach = match self.walk_moves.get(&body) {
            Some(&r) => {
                let radius = self.builds.get(&body)?.size.radius_mm() * 1000;
                (r + radius - skills::route::AT_GOAL).clamp(sim::spots::REACH_PITCH, reach)
            }
            None => reach,
        };
        let place = n.place()?;
        let (floor, ring, middle) = self.with_view(body, |v| {
            v.footprint_on_floor(node, place.position, place.orientation, &corners)
        })??;
        Some((floor, ring, middle, on, reach))
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
    if let Some(line) = n.fields().get(&F_LINE).and_then(drawn) {
        if bounds.x >= 2 * bounds.z {
            return on_line(p, bounds, &line);
        }
        return on_outline(p, bounds, &line);
    }
    on_outline(p, bounds, &n.fields().get(&F_OUTLINE).and_then(drawn)?)
}

/// A line's or an outline's points (`[[x, z], ...]` mm) as `[x, z]` µm.
fn drawn(v: &replica::encode::Value) -> Option<Vec<[i64; 2]>> {
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
}

/// The place on thing `n`'s own shape nearest `q` (`[x, z]` µm in its parent's frame), when `n` is drawn in its
/// parent's frame (placed at its origin, with a line or an outline field), as Eden's land features are: the nearest
/// point of its line, or of its outline's edge, or `q` itself when it is inside the outline (#4072). `None` for any
/// other thing.
pub fn nearest_on_drawn_shape(n: &replica::tree::NodeRef<'_>, q: [i64; 2]) -> Option<Vec3> {
    use import_eden::{F_LINE, F_OUTLINE};
    if n.place().is_some_and(|p| p.position != Vec3::ZERO) {
        return None;
    }
    let (points, closed) = match n.fields().get(&F_LINE).and_then(drawn) {
        Some(line) => (line, false),
        None => (n.fields().get(&F_OUTLINE).and_then(drawn)?, true),
    };
    let k = points.len();
    if k == 0 {
        return None;
    }
    if closed && inside(q, &points) {
        return Some(Vec3::new(q[0], 0, q[1]));
    }
    let edges = if closed { k } else { (k - 1).max(1) };
    let near = (0..edges)
        .map(|i| on_segment(q, points[i], points[(i + 1) % k]))
        .min_by_key(|p| flat(q, *p))?;
    Some(Vec3::new(near[0], 0, near[1]))
}

/// The point of segment `a`..`b` nearest `q`, across x and z (µm).
fn on_segment(q: [i64; 2], a: [i64; 2], b: [i64; 2]) -> [i64; 2] {
    let d = [i128::from(b[0] - a[0]), i128::from(b[1] - a[1])];
    let w = [i128::from(q[0] - a[0]), i128::from(q[1] - a[1])];
    let len = d[0] * d[0] + d[1] * d[1];
    if len == 0 {
        return a;
    }
    let t = (d[0] * w[0] + d[1] * w[1]).clamp(0, len);
    [0, 1].map(|k| a[k] + i64::try_from(d[k] * t / len).unwrap_or(0))
}

/// Whether `q` is inside the closed outline `ring` (its corners in order), by the even-odd rule.
fn inside(q: [i64; 2], ring: &[[i64; 2]]) -> bool {
    let mut odd = false;
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
        if (a[1] > q[1]) != (b[1] > q[1]) {
            let x = i128::from(a[0])
                + i128::from(b[0] - a[0]) * i128::from(q[1] - a[1]) / i128::from(b[1] - a[1]);
            if i128::from(q[0]) < x {
                odd = !odd;
            }
        }
    }
    odd
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
                let waiting = std::cell::Cell::new(false);
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
                            waiting.set(true);
                            return Some([me.pose.position.x, me.pose.position.z]);
                        }
                        Some(corner)
                    })??,
                    None => [to.x, to.z],
                };
                let y = if [x, z] == [to.x, to.z] { to.y } else { 0 };
                let here = [me.pose.position.x, me.pose.position.z];
                // A tick spent waiting for the planner is no tick of walking: the stall watch starts again (C21).
                if !waiting.get() {
                    self.asked
                        .borrow_mut()
                        .insert(body, (sim::walk::node_of(me), here, [x, z], [to.x, to.z]));
                }
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
        let shape = self.on_shape(body, step, node);
        // A thing argument with a footprint and no drawn shape (#4072): the walk ends within reach of its outline, or
        // on it.
        let foot = shape
            .is_none()
            .then(|| self.footprint_walk(body, step, node, reach))
            .flatten();
        let at = shape.unwrap_or(at);
        let (node, at, ring, reach) = match foot {
            Some((floor, ring, middle, on, near)) => (floor, middle, Some((ring, on)), near),
            None => (node, at, None, reach),
        };
        // A walk to be in an area ends within reach of the area's circle, not of its middle.
        let reach = reach.saturating_add(self.area_radius(body, step).unwrap_or(0));
        // A walk before a sit goes to the seat's own stand point, the one its sit is measured from.
        let sat = matches!(self.sit_walks.get(&body), Some(&(at_step, ..)) if at_step == step);
        let (node, at) = match self.sit_walks.get(&body) {
            Some(&(at_step, floor, stand)) if at_step == step => (floor, stand),
            _ => (node, at),
        };
        let (node, at) = self
            .area_floor(body, step, node, at, reach)
            .unwrap_or((node, at));
        // An approach to a move's point (#3688): a point of a thing on a building with floors (an inner door) is on
        // the building's floor nearest its height, so the walk goes in to it, and once in through a link the runner
        // approaches again from that floor; on the floor the body stands on, it is aimed short of the point, on the
        // body's side. When the body is not before the point (behind the building whose door it is), the point moved
        // toward it may have no place within an arm (#1960): then the walk aims at the point itself, and the search
        // for a place to stand, from the body, finds the body's side.
        // An approach's move acts on the run's own thing: when that is a doorway's door, the walk may end in its
        // doorway (#3688).
        let door = self
            .approaches
            .contains(&body)
            .then(|| self.walks.get(&body).map(|w| w.1))
            .flatten();
        let (node, at) = if self.approaches.contains(&body) {
            let (node, at) = self.floor_of(node, at).unwrap_or((node, at));
            self.with_view(body, |v| {
                let (floor, p, _) = v.on_floor(node, at)?;
                (floor == sim::walk::node_of(me)).then(|| {
                    let short = skills::form_runner::APPROACH_SHORT;
                    let aim = skills::form_runner::short_of(p, me.pose.position, short);
                    match v.stand_near_door(floor, aim, reach, Some(me), door) {
                        Some(_) => (floor, aim),
                        None => (floor, p),
                    }
                })
            })
            .flatten()
            .unwrap_or((node, at))
        } else {
            (node, at)
        };
        let mut planning = self.planning.borrow_mut();
        let query = FormQuery::Walk {
            node,
            at,
            reach,
            door,
            ring: ring.filter(|_| !self.approaches.contains(&body) && !sat),
        };
        match planning.ask(key, *me, query, &self.map) {
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

/// How far below its feet a body reaches, µm: today's contact check (`contact-actuator.ts`, a hand reaches a thing
/// within 1.2 m of the feet's height).
pub const BELOW_FEET: i64 = 1_200_000;

/// How far a span of heights `[lo, hi]` (µm) lies outside what a body with feet at `feet` and standing reach `reach`
/// gets a hand to: from [`BELOW_FEET`] under its feet to its standing reach above them (`sim::slots::standing_reach`,
/// today's overhead reach); 0 within.
fn off_height(feet: i64, reach: i64, lo: i64, hi: i64) -> i64 {
    (feet - BELOW_FEET - hi).max(lo - feet - reach).max(0)
}

/// `[x, z]` gap `h` and height gap `v` (µm) as one distance.
fn with_height(h: i64, v: i64) -> i64 {
    let (h, v) = (i128::from(h), i128::from(v));
    i64::try_from((h * h + v * v).isqrt()).unwrap_or(i64::MAX)
}

impl Sight<'_> {
    /// Whether floors `a` and `b` share one frame: the same node, or two floors of one building, each placed at the
    /// building's origin (a storey's height is in its rooms' and things' places).
    fn same_frame(&self, a: Id, b: Id) -> bool {
        let at_origin = |id: Id| {
            let n = self.tree.handle(id).and_then(|h| self.tree.node(h))?;
            n.place()
                .is_none_or(|p| p.position == Vec3::ZERO)
                .then(|| n.parent())
                .flatten()
        };
        a == b || at_origin(a).is_some_and(|pa| at_origin(b) == Some(pa))
    }

    /// How far a body standing at `from` on floor `floor` is from thing `target` (C22, #3485): across x and z from
    /// the body's edge (a standard body's radius from its feet, [`sim::ground::HUMAN_RADIUS`]: a hand reaches from the
    /// shoulder, not the feet) to the nearer of the thing's point `point` its entry names and its nearest surface, the
    /// box its entry's `geometry.bounds_mm` gives (centred on its place), each turned with the thing and carried onto
    /// that floor ([`View::on_floor`]) or another floor of its building; and in height, how far the point or the box
    /// lies outside the body's reach above and below its feet ([`off_height`]), so a thing on the floor above or
    /// below is out of reach however near across x and z. `None` when its entry gives neither, or the thing is not
    /// over that floor or its building.
    fn to_thing(&self, body: Id, floor: Id, from: Vec3, target: Id, point: &Name) -> Option<i64> {
        let build = *self.builds.get(&body)?;
        let reach = sim::slots::standing_reach(build);
        let radius = build.size.radius_mm() * 1000;
        self.with_view(body, |view| {
            let n = self.tree.node(self.tree.handle(target)?)?;
            let entry = self.kinds.get(entry_of(&n))?;
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
                    return Some(p);
                }
                if let Some(on) = view
                    .on_floor(target, p)
                    .filter(|(f, ..)| self.same_frame(*f, floor))
                {
                    return Some(on.1);
                }
                // A thing of a building with floors (an inner door, #3688), from a body on that building's floor.
                let place = n.place()?;
                let up = place
                    .position
                    .plus(place.orientation.rotate(p).ok()?)
                    .ok()?;
                // A loose thing the view's tree does not hold (a bench a world placed, #4072): carried from its parent.
                if let Some(on) = view
                    .on_floor(n.parent()?, up)
                    .filter(|(f, ..)| self.same_frame(*f, floor))
                {
                    return Some(on.1);
                }
                self.floor_of(n.parent()?, up)
                    .filter(|(f, _)| self.same_frame(*f, floor))
                    .map(|(_, p)| p)
            };
            let q = [from.x, from.z];
            let gap = |h: i64, lo: i64, hi: i64| {
                with_height(
                    h.saturating_sub(radius).max(0),
                    off_height(from.y, reach, lo, hi),
                )
            };
            let named = um(entry
                .get("points")
                .and_then(|ps| ps.get(point.as_str()))
                .and_then(|p| p.get("at_mm")))
            .and_then(on)
            .map(|p| gap(flat(q, [p.x, p.z]), p.y, p.y));
            let surface = sim::spots::footprint(entry).and_then(|(corners, height)| {
                let [a, b, c, d] = corners;
                let corners = [on(a)?, on(b)?, on(c)?, on(d)?];
                let ring = corners.map(|p| [p.x, p.z]);
                let lo = corners.iter().map(|p| p.y).min()?;
                let hi = corners.iter().map(|p| p.y).max()? + height.max(0);
                Some(gap(to_ring(q, &ring), lo, hi))
            });
            match (named, surface) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            }
        })?
    }
}

impl Reach for Sight<'_> {
    /// To another body, from feet to feet; to a thing, from the body's edge to its point or its nearest surface
    /// ([`Sight::to_thing`]), else to its place in the tree; across x and z, and in height beyond the body's reach
    /// above and below its feet ([`off_height`]).
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
        // A thing in the body's own hand is within its reach (#3715): a held kettle's switch.
        let parent = self
            .tree
            .handle(target)
            .and_then(|h| self.tree.node(h)?.parent());
        if parent == Some(body) {
            return Some(0);
        }
        let floor = sim::walk::node_of(me);
        if let Some(d) = self.to_thing(body, floor, a, target, point) {
            return Some(d);
        }
        // Heights in the tree's frame: a body's feet on its floor's place, as a thing's place is found.
        let height = |node: Id, y: i64| self.place(node).map(|p| p.y + y);
        let (b, top) = match self.bodies.get(&target) {
            Some(t) => (
                t.pose.position,
                height(sim::walk::node_of(t), t.pose.position.y),
            ),
            None => {
                let b = self.place(target)?;
                (b, Some(b.y))
            }
        };
        let reach = sim::slots::standing_reach(*self.builds.get(&body)?);
        let v = match (height(floor, a.y), top) {
            (Some(feet), Some(y)) => off_height(feet, reach, y, y),
            _ => 0,
        };
        Some(with_height(flat([a.x, a.z], [b.x, b.z]), v))
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
/// `kinds` (entries by kind) with each form's `create` kind written as `pinned` names it (`<kind>@<hash>`), where it
/// pins one; any other is left as it is, and its make is refused by name (`name-not-pinned`).
fn pin_made(kinds: Json, pinned: &[Name]) -> Json {
    let pin = |k: &str| {
        pinned
            .iter()
            .find(|n| plain(n) == k)
            .map(|n| n.as_str().to_owned())
    };
    let Json::Obj(entries) = kinds else {
        return kinds;
    };
    Json::Obj(
        entries
            .into_iter()
            .map(|(name, mut entry)| {
                if let Some(Json::Obj(forms)) = obj_mut(&mut entry, "forms") {
                    for (_, f) in forms.iter_mut() {
                        if let Some(Json::Arr(effects)) = obj_mut(f, "effects") {
                            for e in effects.iter_mut() {
                                let made = (e.get("change").and_then(Json::str) == Some("create"))
                                    .then(|| e.get("kind").and_then(Json::str).and_then(pin))
                                    .flatten();
                                if let (Some(p), Json::Obj(o)) = (made, e) {
                                    for (k, v) in o.iter_mut() {
                                        if k == "kind" {
                                            *v = Json::s(&p);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                (name, entry)
            })
            .collect(),
    )
}

/// An intent's whole-number arguments split for `form` of `entry`: those it `takes` as an `int` or a `duration` (a
/// count, a start time) as values, the rest as slot numbers (#3703).
fn numbers(
    entry: &Json,
    form: &str,
    given: &BTreeMap<String, u64>,
) -> (skills::form_runner::Args, BTreeMap<String, u64>) {
    let takes = |k: &str| {
        entry
            .get("forms")
            .and_then(|f| f.get(form))
            .and_then(|f| f.get("takes"))
            .and_then(|t| t.get(k))
            .and_then(|t| t.get("type"))
            .and_then(Json::str)
    };
    let (mut counts, mut slots) = (skills::form_runner::Args::new(), BTreeMap::new());
    for (k, &n) in given {
        match (takes(k), i64::try_from(n)) {
            (Some("count" | "int" | "duration"), Ok(v)) => {
                drop(counts.insert(k.clone(), skills::form_runner::Arg::Int(v)))
            }
            _ => drop(slots.insert(k.clone(), n)),
        }
    }
    (counts, slots)
}

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
    /// The code hatches' modules this world ships (F8, #3713), loaded and checked once, by their SHA-256 multihash.
    hatches: BTreeMap<Vec<u8>, replica::hatch::Loaded>,
    /// The zone's header, which the forms write a take or a put under: given again to forms read back at a restart.
    zone: replica::effects::Header,
}

/// The entries' amounts as F4 reads them (`Forms::kinds`): each entry without its forms, a timed field left out.
fn loaded(kinds: &Json) -> replica::kinds::Kinds {
    let mut loaded = replica::kinds::Kinds::default();
    for (_, entry) in kinds.obj().unwrap_or(&[]) {
        let mut e = entry.clone();
        if let Json::Obj(o) = &mut e {
            o.retain(|(k, _)| k != "forms");
            // A timed field (a kettle's heat) is not an amount, and the kind format cannot hold its default yet:
            // left out, so the entry's amounts load (#3715).
            if let Some((_, Json::Obj(state))) = o.iter_mut().find(|(k, _)| k == "state") {
                state.retain(|(_, f)| f.get("type").and_then(Json::str) != Some("timed"));
            }
        }
        if let Ok(text) = replica::kinds::entry::entry_to_kind(&e.to_json()) {
            loaded.load(&[("entry", text.as_str())]);
        }
    }
    loaded
}

/// The refusal of a thing argument the caller left out whose selector finds nothing (#3914): `form-rules` names the
/// same end `none_selected`.
pub const NONE_SELECTED: &str = "thing.none-selected";

/// How far from the anchor a thing `here` may be, mm: today's reach for a thing a form uses nearby (a tap for a
/// kettle, `TAP_REACH` in today's tea).
pub const HERE_REACH_MM: i64 = 20_000;

/// How near a body stands to a thing to be within a form's reach of it, mm, beyond the thing's own half size.
const NEAR_MM: i64 = 1_500;

/// A node's place in the zone's frame, µm: its position carried up the tree through each parent's place, turns
/// included.
pub(crate) fn world_at(tree: &Tree, node: Id) -> Option<Vec3> {
    let n = tree.node(tree.handle(node)?)?;
    carried(
        tree,
        n.parent(),
        n.place().map_or(Vec3::ZERO, |p| p.position),
    )
}

/// A position in node `frame`'s frame carried into the zone's: through each node's place up the tree, turns included
/// (a seated body's controller pose is in its seat's frame).
fn carried(tree: &Tree, frame: Option<Id>, local: Vec3) -> Option<Vec3> {
    let mut at = local;
    let mut up = frame;
    for _ in 0..64 {
        let Some(p) = up else { return Some(at) };
        let pn = tree.node(tree.handle(p)?)?;
        if let Some(pp) = pn.place() {
            at = pp.orientation.rotate(at).ok()?.plus(pp.position).ok()?;
        }
        up = pn.parent();
    }
    None
}

/// Whether `body` stands within a form's reach of `node`: within its half size (its entry's bounds) and
/// [`NEAR_MM`], across x and z, in the zone's frame (`body_at` when the body is not a node of the tree).
pub(crate) fn within_reach(
    tree: &Tree,
    entry: &Json,
    body: Id,
    body_at: Option<Vec3>,
    node: Id,
) -> bool {
    let (Some(b), Some(n)) = (world_at(tree, body).or(body_at), world_at(tree, node)) else {
        return false;
    };
    let half = entry
        .get("geometry")
        .and_then(|g| g.get("bounds_mm"))
        .and_then(Json::arr)
        .map_or(0, |b| {
            [b.first(), b.get(2)]
                .into_iter()
                .flatten()
                .filter_map(|v| match v {
                    Json::Int(n) => i64::try_from(*n).ok(),
                    _ => None,
                })
                .max()
                .unwrap_or(0)
                / 2
        });
    let reach = i128::from((half + NEAR_MM) * 1_000);
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    d(b.x, n.x) + d(b.z, n.z) <= reach * reach
}

/// Binds a `thing` argument the caller left out by its `select` (E2's closed list, the entry format's `select`;
/// `form-rules`' `selectThing` reads it the same way, #3914). `Ok(Some(thing))` binds it, `Ok(None)` finds nothing
/// that qualifies, and `Err(())` is a selector this does not read (the argument stays missing).
///
/// - **The set** (`in`): `this` the children of the act's node; `here` every thing within [`HERE_REACH_MM`] of the
///   anchor across x and z, what the body holds included, in the same building or on the same ground as the act's
///   node when both say (#3715: the kettle fills at the nearest sink in its own building), and never one inside a
///   closed container; `parent` those of the act's node's parent. Never the act's node, the actor's body, a body (a
///   node linked `souls:body-of`) or a node of a private audience; with `kind`, only things of that kind or entry.
/// - **The order**: by squared distance in the zone's frame (x, y and z) from the `anchor` (`me` the body, `this`
///   the act's node), `nearest` first or `furthest` first, ties by id; a thing with no place goes after every placed
///   one, by id.
/// - **The rank**: 1, 2, ... or `last`. Too few is nothing.
pub(crate) fn select_thing(
    tree: &Tree,
    kinds: &Json,
    select: &Json,
    node: Id,
    body: Id,
    body_at: Option<Vec3>,
) -> Result<Option<Id>, ()> {
    if select.get("of").and_then(Json::str) != Some("things") {
        return Err(());
    }
    let parent = |id: Id| tree.node(tree.handle(id)?)?.parent();
    let here = select.get("in").and_then(Json::str) == Some("here");
    let sets: Vec<Id> = match select.get("in").and_then(Json::str) {
        Some("this") => vec![node],
        // Every node of the tree, narrowed below by reach, building and closed containers.
        Some("here") => Vec::new(),
        Some("parent") => parent(node).into_iter().collect(),
        _ => return Err(()),
    };
    let anchor = match select.get("anchor").and_then(Json::str) {
        Some("me") => world_at(tree, body).or(body_at),
        Some("this") => world_at(tree, node),
        _ => return Err(()),
    };
    let furthest = match select.get("order").and_then(Json::str) {
        Some("nearest") => false,
        Some("furthest") => true,
        _ => return Err(()),
    };
    let rank = match select.get("rank") {
        Some(Json::Int(n)) if *n >= 1 => Some(usize::try_from(*n).map_err(|_| ())?),
        Some(Json::Str(l)) if l == "last" => None,
        _ => return Err(()),
    };
    let kind = select.get("kind").and_then(Json::str);
    let is_body = |id: Id| {
        tree.links_at(id)
            .iter()
            .any(|e| plain(tree.ty(e)) == "souls:body-of")
    };
    let d2 = |a: Vec3, p: Vec3| {
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        d(a.x, p.x) + d(a.y, p.y) + d(a.z, p.z)
    };
    let reach = i128::from(HERE_REACH_MM * 1_000) * i128::from(HERE_REACH_MM * 1_000);
    let handles: Vec<replica::tree::Handle> = if here {
        let mut all = Vec::new();
        let mut stack = vec![tree.root()];
        while let Some(h) = stack.pop() {
            stack.extend(tree.children(h).unwrap_or(&[]));
            all.push(h);
        }
        all
    } else {
        sets.iter()
            .filter_map(|s| tree.children(tree.handle(*s)?))
            .flatten()
            .copied()
            .collect()
    };
    // Here: the same building or ground as the act's node, when both say; never inside a closed container.
    let frame = replica::select::standing(tree, node).ok().map(|f| f.0);
    let same_place = |id: Id| match (frame, replica::select::standing(tree, id)) {
        (Some(f), Ok((g, _))) => f == g,
        _ => true,
    };
    let closed_above = |id: Id| {
        let mut up = parent(id);
        for _ in 0..64 {
            let Some(p) = up else { return false };
            let Some(pn) = tree.node(tree.handle(p).unwrap_or_else(|| tree.root())) else {
                return false;
            };
            if p != node
                && kinds
                    .get(plain(pn.kind()))
                    .and_then(|e| e.get("closed"))
                    .is_some()
            {
                return true;
            }
            up = pn.parent();
        }
        true
    };
    let xz = |a: Vec3, p: Vec3| {
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        d(a.x, p.x) + d(a.z, p.z)
    };
    let of_kind = |n: &replica::tree::NodeRef<'_>| {
        kind.is_none_or(|k| plain(n.kind()) == k || entry_of(n).split('@').next() == Some(k))
    };
    let mut ranked: Vec<(Option<i128>, Id)> = handles
        .into_iter()
        .filter_map(|h| tree.node(h))
        .filter(|n| n.id() != node && n.id() != body)
        .filter(|n| n.audience() == replica::world_model::Audience::Everyone)
        .filter(|n| of_kind(n))
        .filter(|n| !is_body(n.id()))
        .filter(|n| !here || (same_place(n.id()) && !closed_above(n.id())))
        .filter_map(|n| {
            let p = world_at(tree, n.id());
            if here && anchor.zip(p).is_none_or(|(a, p)| xz(a, p) > reach) {
                return None;
            }
            Some((anchor.zip(p).map(|(a, p)| d2(a, p)), n.id()))
        })
        .collect();
    ranked.sort_by(|(da, a), (db, b)| {
        let by = match (da, db) {
            (Some(x), Some(y)) if furthest => y.cmp(x),
            (Some(x), Some(y)) => x.cmp(y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        };
        by.then(a.cmp(b))
    });
    Ok(match rank {
        Some(r) => ranked.get(r - 1).map(|(_, id)| *id),
        None => ranked.last().map(|(_, id)| *id),
    })
}

/// The moves a form's step may name: every move content declares, and the body's own (C23, [`crate::moves`]).
pub fn library() -> R<Vec<Move>> {
    crate::moves::library()
}

/// The name of a node's Soul Actions entry ([`import_eden::entry_name`]): the entry it names, else its kind's.
fn entry_of<'a>(n: &'a replica::tree::NodeRef<'_>) -> &'a str {
    import_eden::entry_name(n.kind().as_str(), n.fields())
}

/// The plain name (`namespace:name`) of a node's kind.
fn plain(kind: &Name) -> &str {
    let k = kind.as_str();
    k.split_once('@').map_or(k, |(p, _)| p)
}

/// The declared nearest-free seat form (#3573): `sit` taking one slot of this thing's free slots nearest me, walked to and
/// then sat in. Its slot is bound by the form runner's pick (#3802); this only recognises the shape, so a bare fixture
/// sit is routed through the form's own approach.
fn fixture_seat<'a>(entry: &'a Json, form: &str) -> Option<&'a str> {
    if form != "sit" {
        return None;
    }
    let f = entry.get("forms")?.get(form)?;
    let [(arg, take)] = f.get("takes")?.obj()? else {
        return None;
    };
    let select = take.get("select")?;
    if take.get("type")?.str()? != "slot"
        || select.obj()?.len() != 5
        || select.get("of")?.str()? != "free_slots"
        || select.get("in")?.str()? != "this"
        || select.get("anchor")?.str()? != "me"
        || select.get("order")?.str()? != "nearest"
        || !matches!(select.get("rank"), Some(Json::Int(1)))
    {
        return None;
    }
    let [walk, sit] = f.get("steps")?.arr()? else {
        return None;
    };
    (walk.get("step")?.str()? == "walk_to"
        && walk.get("point")?.get("arg")?.str()? == arg
        && sit.get("step")?.str()? == "sit"
        && sit.get("slot")?.get("arg")?.str()? == arg)
        .then_some(arg.as_str())
}

impl Acts {
    /// A bare fixture sit uses its actual entry's approach; explicit arguments and selectors keep their path.
    pub(crate) fn fixture_sit(&self, tree: &Tree, intent: &WireIntent) -> bool {
        if intent.parameters.contains_key(&1)
            || !matches!(intent.verb.as_str().split_once(':'), Some((ns, "sit")) if ns != "souls")
        {
            return false;
        }
        let Some(Target::Node(node)) = &intent.target else {
            return false;
        };
        // By the entry the node goes by (#3980): a thing that borrows `eden:chair` (field 27) sits as a chair does.
        tree.handle(*node)
            .and_then(|h| tree.node(h))
            .and_then(|n| self.kinds.get(entry_of(&n)))
            .is_some_and(|entry| fixture_seat(entry, "sit").is_some())
    }
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
        // A form's `create` names its kind plainly; the world makes it as the header pins it (#3703).
        let kinds = pin_made(kinds, &header.kinds);
        let mut forms = Forms::new();
        forms.kinds(&loaded(&kinds));
        forms.zone(header.clone());
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
            hatches: BTreeMap::new(),
            zone: header,
        }
    }

    /// N2 (0.133): the forms read back from the log at a restart at `now` (`Forms::recover`): every run the log shows
    /// started and not ended is ended `restart` now, its ending entry (which frees what it reserved) written with the
    /// first tick. Its intent is not answered here: the gateway sends it again and it starts afresh from where the
    /// body stands. `log` is the restart's replayed entries of the Souls' acts, in order.
    pub fn recover(&mut self, log: &[Effect], now: Micros) {
        let mut forms = Forms::recover(log, now);
        forms.kinds(&loaded(&self.kinds));
        forms.zone(self.zone.clone());
        self.forms = forms;
    }

    /// Loads the code hatches' modules the world ships (`<world>/hatches/*.wasm`, #3713), each named by the hash of
    /// its bytes: a module refused at load is refused here by its name, before the world serves.
    pub fn hatches(&mut self, modules: &[Vec<u8>]) -> Result<usize, Refusal> {
        for bytes in modules {
            let mut named = vec![replica::ids::SHA2_256, 32];
            named.extend(replica::ids::sha256(bytes));
            let loaded = replica::hatch::Loaded::load(bytes, &named)?;
            self.hatches.insert(named, loaded);
        }
        Ok(self.hatches.len())
    }

    /// The sets form `form`'s code hatch answers for `node`, if the form has one (F8, #3713): its declared reads from
    /// the node's fields and the act's arguments, run in the module the world ships under its hash. A no refuses the
    /// act `hatch-said-no` with the hatch's `why`; a module the world does not ship is `hatch-module-missing`.
    fn hatch_sets(
        &self,
        tree: &Tree,
        node: Id,
        entry: &Json,
        form: &str,
        args: &skills::form_runner::Args,
    ) -> Result<Option<Vec<skills::form_runner::Effect>>, Refusal> {
        let Some(hatch) = skills::form_runner::bind_hatch(entry, form)? else {
            return Ok(None);
        };
        let Some(module) = self.hatches.get(&hatch.module) else {
            return Err(refusal("hatch-module-missing", form));
        };
        let empty = BTreeMap::new();
        let fields = tree
            .handle(node)
            .and_then(|h| tree.node(h))
            .map(|n| n.fields().clone());
        let reads = skills::form_runner::hatch_reads(
            entry,
            &hatch,
            fields.as_ref().unwrap_or(&empty),
            args,
        )?;
        let v = skills::form_runner::run_hatch(&hatch, module, entry, &reads)?;
        if !v.yes {
            return Err(skills::form_runner::hatch_no(&hatch));
        }
        Ok(Some(
            v.sets
                .into_iter()
                .map(|(field, to)| skills::form_runner::Effect::Set { field, to })
                .collect(),
        ))
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
        let approaches = self.forms.approaches();
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
            approaches,
            sit_walks,
            goals: self.forms.goal_walks(),
            walk_moves: self
                .forms
                .walk_moves()
                .into_iter()
                .filter_map(|(b, mv)| Some((b, self.library.iter().find(|m| m.name == mv)?.reach)))
                .collect(),
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

    /// Whether the words an act of form `verb` (`<namespace>:<form>`) on `node` carries are everyone's (#3712): the
    /// node's entry has the form, and the form sets a field whose audience is everyone from one of its `text`
    /// arguments (words written on a board for all to read). Words in any other act stay their sender's (T8).
    pub fn public_words(&self, tree: &Tree, node: Id, verb: &str) -> bool {
        let Some(form) = verb.split_once(':').map(|(_, f)| f) else {
            return false;
        };
        let Some(entry) = tree
            .handle(node)
            .and_then(|h| tree.node(h))
            .and_then(|n| self.kinds.get(plain(n.kind())))
        else {
            return false;
        };
        let Some(f) = entry.get("forms").and_then(|fs| fs.get(form)) else {
            return false;
        };
        let text = |a: &str| {
            f.get("takes")
                .and_then(|t| t.get(a))
                .and_then(|t| t.get("type"))
                .and_then(Json::str)
                == Some("text")
        };
        let everyone = |field: &str| {
            entry
                .get("state")
                .and_then(|s| s.get(field))
                .and_then(|d| d.get("audience"))
                .and_then(|a| a.get("rule"))
                .and_then(Json::str)
                == Some("everyone")
        };
        f.get("effects")
            .and_then(Json::arr)
            .unwrap_or(&[])
            .iter()
            .any(|e| {
                e.get("change").and_then(Json::str) == Some("set")
                    && e.get("to")
                        .and_then(|t| t.get("arg"))
                        .and_then(Json::str)
                        .is_some_and(text)
                    && e.get("field").and_then(Json::str).is_some_and(everyone)
            })
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
                .map(|n| entry_of(&n).to_owned());
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
            // A whole number the form takes as a `count`, an `int` or a `duration` is that value (#3703, #3713); any
            // other is a slot of the node by number (C12).
            let (counts, slots) = numbers(entry, form, &args.slots);
            let mut all = match skills::form_runner::args_in(entry, &args.things, &slots) {
                Ok(all) => all,
                Err(e) => {
                    first.get_or_insert(e);
                    continue;
                }
            };
            let mut ambiguous = None;
            for (key, value) in counts.iter().chain(&args.values) {
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
            // A thing the caller left out, which the form describes by a selector, is bound by it now (#3914); a
            // selector that finds nothing is refused by name, before any walk.
            let mut none_selected = None;
            // The body's place in the zone's frame when it is not a node of the tree: its controller's pose carried
            // up from its frame (a seat's, when seated).
            let body_at = bodies
                .as_deref()
                .and_then(|b| b.runner.controller.body(body))
                .and_then(|b| carried(tree, Some(b.pose.frame.node), b.pose.position));
            if let Some(f) = entry.get("forms").and_then(|f| f.get(form)) {
                for (key, take) in f.get("takes").and_then(Json::obj).unwrap_or(&[]) {
                    if all.contains_key(key)
                        || take.get("type").and_then(Json::str) != Some("thing")
                    {
                        continue;
                    }
                    let Some(select) = take.get("select") else {
                        continue;
                    };
                    match select_thing(tree, &self.kinds, select, *node, body, body_at) {
                        Ok(Some(t)) => {
                            all.insert(key.clone(), skills::form_runner::Arg::Node(t));
                            picked = true;
                        }
                        Ok(None) => {
                            none_selected = Some(key.clone());
                            break;
                        }
                        Err(()) => {}
                    }
                }
            }
            // Nothing selected is told only to one who may do the form and stands within its reach, so a far act
            // is never a way to learn what a hiding place holds.
            if let Some(key) = none_selected {
                let none = BTreeMap::<Id, BTreeSet<Id>>::new();
                let named: Result<(), Refusal> =
                    sim::forms::may(tree, &none, &|_| None, body, *node, entry, form).and_then(
                        |()| {
                            if within_reach(tree, entry, body, body_at, *node) {
                                Err(refusal(NONE_SELECTED, key.clone()))
                            } else {
                                Err(refusal("out-of-reach", key.clone()))
                            }
                        },
                    );
                if let Err(e) = named {
                    first.get_or_insert(e);
                }
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
            // Who may, then every need of the form, decided by the world on its own state (#3888): an act whose
            // intent the forms already hold is its run or its receipt, never checked again.
            if !self.forms.known(intent.id) {
                let audiences = BTreeMap::<Id, BTreeSet<Id>>::new();
                // The binder's refusals and who may's come first, from the run's own path below: a form the binder or who
                // may refuses is left to it, so its refusal is the same as before.
                let bound = match sim::forms::bind_stages(&entry, form) {
                    Ok(Some(_)) => true,
                    Ok(None) => skills::form_runner::bind_with(&entry, form, &all)
                        .and_then(|_| skills::form_runner::bind_effects_args(&entry, form, &all))
                        .is_ok(),
                    Err(_) => false,
                };
                let permitted = bound
                    && sim::forms::may(tree, &audiences, &|_| None, body, *node, &entry, form)
                        .is_ok();
                if permitted
                    && let Err(e) = crate::needs::check(
                        tree,
                        bodies.as_deref(),
                        &self.kinds,
                        body,
                        *node,
                        &entry,
                        form,
                        &all,
                        now,
                    )
                    .and_then(|()| {
                        crate::needs::hand_reach(tree, &entry, form, &all, body, body_at, *node)
                    })
                {
                    first.get_or_insert(e);
                    continue;
                }
            }
            // A form's code hatch (F8, #3713) checks the act before any walk, and its answered fields are written
            // with the form's effects, in place of the form's own sets of those fields.
            let hatched = match self.hatch_sets(tree, *node, &entry, form, &all) {
                Ok(h) => h,
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
                    && hatched.is_none()
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
                let mut effects = skills::form_runner::bind_effects_args(&entry, form, &all)?;
                if let Some(sets) = hatched {
                    effects.retain(|e| {
                        !matches!(e, skills::form_runner::Effect::Set { field, .. }
                            if sets.iter().any(|s| matches!(s, skills::form_runner::Effect::Set { field: f, .. } if f == field)))
                    });
                    effects.extend(sets);
                }
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

    /// The Soul's leave: the run on `body` ends `left` at its next stable moment; or, when `intent` names the act
    /// waiting on that run (#4187), that act alone ends `left` and never starts.
    pub fn leave(
        &mut self,
        tree: &Tree,
        bodies: Option<&mut Bodies>,
        body: Id,
        intent: Option<Id>,
        now: Micros,
    ) {
        let _ = self.with(tree, bodies, 0, |forms, w| {
            forms.leave(w, body, intent, now)
        });
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
            .and_then(|n| self.kinds.get(entry_of(&n)).cloned());
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

    /// Entries [`Acts::out`] handed back that the world refused to write: the timers they set come off the due list.
    pub fn unwritten(&mut self, effects: &[Effect]) {
        for e in effects {
            let Body::Timers(ts) = &e.body else { continue };
            for t in ts {
                if let TimerRec::Set { timer, .. } = t
                    && self.timers.remove(timer).is_some()
                {
                    let _ = self.due.clear(e.envelope.node, *timer);
                }
            }
        }
    }

    /// Runs that started late since the last call (#4187: an act that waited on its body's posture step), each
    /// with its intent.
    pub fn started_late(&mut self) -> Vec<(Id, sim::forms::RunId)> {
        std::mem::take(&mut self.forms.late)
            .into_iter()
            .filter_map(|run| Some((*self.runs.get(&run)?, run)))
            .collect()
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
    fn a_gateway_walks_route_time_includes_margin_and_links_with_no_ceiling() {
        assert_eq!(walk_span(14_000, 0), 15_000_000);
        assert_eq!(walk_span(14_000, 2), 25_000_000);
        assert!(walk_span(20_000, 0) > 14_000_000);
        assert!(walk_span(70_000, 0) >= 75_000_000);
        // A 600 m route is not capped at the old 180 s: 429 s of walking, plus half again.
        assert!(walk_span(600_000, 0) > 600_000_000);
        assert_eq!(walk_span(u64::MAX, usize::MAX), Micros::MAX);
    }
}

#[cfg(test)]
mod number_tests {
    use super::*;

    /// #3703: a whole number a form takes as an int or a duration is a value; any other names a slot.
    #[test]
    fn whole_numbers_a_form_takes_as_counts_are_values_and_others_slots() {
        let entry = replica::rules::json::parse(
            r#"{"forms":{"post":{"takes":{"start":{"type":"duration"},"n":{"type":"int"},"spot":{"type":"slot"}}}}}"#,
        )
        .expect("an entry");
        let given = BTreeMap::from([
            ("start".to_owned(), 1_800_000_000_000_000u64),
            ("n".to_owned(), 3),
            ("spot".to_owned(), 2),
            ("other".to_owned(), 1),
        ]);
        let (counts, slots) = numbers(&entry, "post", &given);
        assert_eq!(
            counts,
            skills::form_runner::Args::from([
                ("n".to_owned(), skills::form_runner::Arg::Int(3)),
                (
                    "start".to_owned(),
                    skills::form_runner::Arg::Int(1_800_000_000_000_000)
                ),
            ])
        );
        assert_eq!(
            slots,
            BTreeMap::from([("other".to_owned(), 1), ("spot".to_owned(), 2)])
        );
        // A number past i64 stays a slot number, refused there by name.
        let huge = BTreeMap::from([("n".to_owned(), u64::MAX)]);
        assert_eq!(numbers(&entry, "post", &huge).1, huge);
    }
}

#[cfg(test)]
mod tests;
