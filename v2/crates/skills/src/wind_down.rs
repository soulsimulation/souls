//! The wind-down (Engine v2 B16, #2751; today's `wind-down/1`, #2295): the one place the world moves a body its
//! agent did not order (TRUNK T10, Gene 17 Nov). A Soul's body moves only when its agent tells it to, until its agent
//! has been silent for an hour; then the world walks it out of town and puts it to sleep, where it stays until its
//! agent acts again.
//!
//! - **Owned** from each agent act: nothing is issued. An act is an intent of the Soul's that is not marked as its
//!   client's reflex (`Intent::agent_act`, #3764). Reads and looks are answered by the client's copy and send none.
//! - **Wander** `wander` after the last act: the body stands (out of a seat); then every `leg_min` to `leg_max` one
//!   slow walk of `leg_min_um` to `leg_max_um` whose end is farther from the town's centre than its start.
//! - **Zombie** `zombie` after Wander starts: one walk to its sleeping spot, the nearest open ground outside the built
//!   area at least `spot_gap_um` from another Soul's spot, searched within `spot_search_um`. A body that cannot move
//!   now tries again every `leg_min`.
//! - **Asleep** on arrival (or at the latest `bound` after Wander started, where it stands): it lies down there, and
//!   nothing is issued again: a sleeping body is on no due list and costs no tick time (K9).
//! - **Woken** by its agent's next act, which then runs.
//!
//! Times are world microseconds (T5), data a world may set. Choices come from a hash of the body's id and a counter,
//! never from the world's random source, so a restarted world makes the same ones. Each move is written as a record
//! whose cause and actor are the world ([`record`]), carrying the rule's state, so a restart rebuilds it from the log
//! ([`WindDown::resume`]). The rule never moves a body something else holds (an open act, an order, a joint activity,
//! hands held): it waits. The public words are today's: `awake`, `idle`, `zombie`, `asleep`.

use std::collections::BTreeMap;

use replica::effects::{Actor, Body, Cause, Effect, Envelope, Event, Rest};
use replica::encode::{Name, Value};
use replica::ids::Id;
use replica::world_model::Audience;
use replica::time::{MICROS_PER_SECOND, Micros};

/// The rule's name, as today's.
pub const RULE: &str = "wind-down/1";
/// Its records' event names: the body's public word after the move (`souls:awake` when its agent woke it).
pub const EVENTS: [&str; 4] = ["souls:awake", "souls:idle", "souls:zombie", "souls:asleep"];

/// The rule's clocks and distances. [`KNOBS`] are the maintainer's (13 Nov 2026); a test world shortens them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Knobs {
    pub wander: Micros,
    pub zombie: Micros,
    pub leg_min: Micros,
    pub leg_max: Micros,
    pub bound: Micros,
    pub leg_min_um: i64,
    pub leg_max_um: i64,
    pub spot_gap_um: i64,
    pub spot_search_um: i64,
}

const S: Micros = MICROS_PER_SECOND;
const M: i64 = 1_000_000;

/// Today's defaults: wander after an hour, zombie 30 minutes later, a leg every 2 to 4 minutes of 5 to 15 m, asleep
/// at the latest 50 minutes after Wander began, spots 3 m apart within 80 m.
pub const KNOBS: Knobs = Knobs {
    wander: 3_600 * S,
    zombie: 1_800 * S,
    leg_min: 120 * S,
    leg_max: 240 * S,
    bound: 3_000 * S,
    leg_min_um: 5 * M,
    leg_max_um: 15 * M,
    spot_gap_um: 3 * M,
    spot_search_um: 80 * M,
};

/// Before the bound, a body still walking is stopped (today's 100 ticks), so it lies down before the bound.
const SETTLE: Micros = 5 * S;
/// How often a walk out is looked at for its arrival.
const LOOK: Micros = S;
/// The ring step of the spot search, and the margin of outdoors around a spot.
const RING: i64 = 1_500_000;
const MARGIN: i64 = 3 * M;

/// The public word for a body (LINK BODY).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Word {
    Awake,
    Idle,
    Zombie,
    Asleep,
}

impl Word {
    pub fn as_str(self) -> &'static str {
        match self {
            Word::Awake => "awake",
            Word::Idle => "idle",
            Word::Zombie => "zombie",
            Word::Asleep => "asleep",
        }
    }
}

/// Which move a record is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Wander,
    Leg,
    Zombie,
    Asleep,
    /// Its agent acted: the rule lets go of it.
    Woken,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Wander => "wander",
            Phase::Leg => "leg",
            Phase::Zombie => "zombie",
            Phase::Asleep => "asleep",
            Phase::Woken => "woken",
        }
    }
    fn read(s: &str) -> Option<Phase> {
        [Phase::Wander, Phase::Leg, Phase::Zombie, Phase::Asleep, Phase::Woken]
            .into_iter()
            .find(|p| p.as_str() == s)
    }
}

/// What the world is asked to do to a body, through its ordinary moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Do {
    /// End the rule's own walk where the body is.
    Stop,
    /// Rise from a seat (nothing when standing).
    Stand,
    /// Walk to a point on the ground, x and z in µm.
    Walk([i64; 2]),
    /// Lie down where it stands, with no end.
    Lie,
}

/// One move of the rule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub body: Id,
    pub phase: Phase,
    pub what: Vec<Do>,
}

/// One body's rule state: enough to rebuild it from its last record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct State {
    /// Its agent's last act.
    pub last: Micros,
    /// When Wander began; `None`: Owned.
    pub wander: Option<Micros>,
    /// When its walk out was issued.
    pub zombie: Option<Micros>,
    pub slept: bool,
    pub spot: Option<[i64; 2]>,
}

impl State {
    fn owned(last: Micros) -> State {
        State {
            last,
            wander: None,
            zombie: None,
            slept: false,
            spot: None,
        }
    }
    /// Its public word.
    pub fn word(&self) -> Word {
        match (self.wander, self.slept, self.zombie) {
            (None, ..) => Word::Awake,
            (_, true, _) => Word::Asleep,
            (_, false, Some(_)) => Word::Zombie,
            _ => Word::Idle,
        }
    }
}

/// What the rule reads of the world. The world implements it over its bodies and ground.
pub trait Ground {
    /// Where the body stands on the ground (x, z µm); `None` when it is not on the ground (away, in a vehicle).
    fn at(&self, body: Id) -> Option<[i64; 2]>;
    /// Held by something not the rule's: an open act, an order, a joint activity, hands held. The rule waits.
    fn held(&self, body: Id) -> bool;
    /// The rule's own walk is still going.
    fn walking(&self, body: Id) -> bool;
    /// On a ride or a boat: it sleeps where it is.
    fn aboard(&self, body: Id) -> bool;
    /// Dry, walkable ground with room for a body (`lying`: room to lie down).
    fn clear(&self, p: [i64; 2], lying: bool) -> bool;
    /// Outside every building and room.
    fn outdoors(&self, p: [i64; 2]) -> bool;
    /// The town's centre.
    fn centre(&self) -> [i64; 2];
}

/// Every body's rule state, and when each next needs the rule.
#[derive(Clone, Debug)]
pub struct WindDown {
    pub knobs: Knobs,
    souls: BTreeMap<Id, (State, Option<Micros>)>,
}

/// A hash of the body's id, a tag and two counters, in [0, 2^64): the rule's only source of choice.
fn mix(body: Id, tag: u8, a: i64, b: u64) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |bytes: &[u8]| {
        for x in bytes {
            h = (h ^ u64::from(*x)).wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    eat(&body.scope().0);
    eat(&body.counter().to_le_bytes());
    eat(&[tag]);
    eat(&a.to_le_bytes());
    eat(&b.to_le_bytes());
    h
}

fn pick(h: u64, n: i64) -> i64 {
    // n is small and positive; the remainder fits.
    i64::try_from(h % u64::try_from(n.max(1)).unwrap_or(1)).unwrap_or(0)
}

/// `a / b` rounded up (b > 0).
fn up(a: i64, b: i64) -> i64 {
    a.div_euclid(b) + i64::from(a.rem_euclid(b) != 0)
}

fn d2(a: [i64; 2], b: [i64; 2]) -> i128 {
    let (x, z) = (i128::from(a[0] - b[0]), i128::from(a[1] - b[1]));
    x * x + z * z
}

fn ahead(p: [i64; 2], dir: usize, d: i64) -> [i64; 2] {
    let [c, s] = DIRS[dir % 64];
    let step = |v: i64| i64::try_from(i128::from(v) * i128::from(d) / i128::from(M)).unwrap_or(0);
    [p[0] + step(c), p[1] + step(s)]
}

impl Default for WindDown {
    fn default() -> WindDown {
        WindDown::new(KNOBS)
    }
}

impl WindDown {
    pub fn new(knobs: Knobs) -> WindDown {
        WindDown {
            knobs,
            souls: BTreeMap::new(),
        }
    }

    /// Sets the clocks (a test world shortens them): every body's next move is found again from `now`.
    pub fn set_knobs(&mut self, knobs: Knobs, now: Micros) {
        self.knobs = knobs;
        let bodies: Vec<Id> = self.souls.keys().copied().collect();
        for b in bodies {
            if let Some((s, _)) = self.souls.get(&b).copied() {
                let due = self.due(b, &s, now);
                self.souls.insert(b, (s, due));
            }
        }
    }

    /// Clocks from text `wander,zombie,leg_min,leg_max,bound` in seconds (a test world's setting); the distances are
    /// the defaults. `None` when it does not read.
    pub fn knobs_from(text: &str) -> Option<Knobs> {
        let n: Vec<i64> = text.split(',').map(|t| t.trim().parse().ok()).collect::<Option<_>>()?;
        let [wander, zombie, leg_min, leg_max, bound] = n[..] else {
            return None;
        };
        (wander > 0 && zombie > 0 && leg_min > 0 && leg_max >= leg_min && bound > zombie).then_some(Knobs {
            wander: wander * S,
            zombie: zombie * S,
            leg_min: leg_min * S,
            leg_max: leg_max * S,
            bound: bound * S,
            ..KNOBS
        })
    }

    /// A body the rule looks after from `now` (a birth, an arrival), Owned as of now unless it has a state.
    pub fn add(&mut self, body: Id, now: Micros) {
        if !self.souls.contains_key(&body) {
            let s = State::owned(now);
            let due = self.due(body, &s, now);
            self.souls.insert(body, (s, due));
        }
    }

    /// A body that left (retired, away by travel): not wound down here.
    pub fn remove(&mut self, body: Id) {
        self.souls.remove(&body);
    }

    /// Its agent acted at `now`: Owned from now. Returns the state the rule held it in, when it held it (woken).
    pub fn acted(&mut self, body: Id, now: Micros) -> Option<State> {
        let s = State::owned(now);
        let due = self.due(body, &s, now);
        let old = self.souls.insert(body, (s, due)).map(|(o, _)| o);
        old.filter(|o| o.wander.is_some())
    }

    pub fn state(&self, body: Id) -> Option<&State> {
        self.souls.get(&body).map(|(s, _)| s)
    }

    /// Its public word; `None` for a body the rule does not know.
    pub fn word(&self, body: Id) -> Option<Word> {
        self.state(body).map(State::word)
    }

    /// The earliest time the rule next moves a body; `None` when none is due (every body asleep).
    pub fn next(&self) -> Option<Micros> {
        self.souls.values().filter_map(|(_, d)| *d).min()
    }

    /// Rebuilds the rule from a log: each body's state from its last record or its agent's last act, whichever is
    /// later (`body_of` names a Soul's body). Bodies the log does not name are added at `now`.
    pub fn resume<'a>(
        &mut self,
        effects: impl IntoIterator<Item = &'a Effect>,
        body_of: impl Fn(Id) -> Option<Id>,
        bodies: impl IntoIterator<Item = Id>,
        now: Micros,
    ) {
        let mut found: BTreeMap<Id, State> = BTreeMap::new();
        for e in effects {
            if let Some((body, s)) = read(e) {
                found.insert(body, s);
            } else if let Actor::Soul(soul) = e.envelope.actor
                && let Some(body) = body_of(soul)
                && found.get(&body).is_none_or(|s| s.wander.is_none())
            {
                // A Soul's entry moves on its agent's last act while the rule does not hold it; a held body is let go
                // only by its woken record (a reflex's entry, #3764, never wakes it).
                found.insert(body, State::owned(e.envelope.at));
            }
        }
        for body in bodies {
            let mut s = found.remove(&body).unwrap_or_else(|| State::owned(now));
            // A body whose hour passed while the world was down enters Wander at the hour, as today.
            if s.wander.is_none() && now > s.last + self.knobs.wander {
                s.wander = Some(s.last + self.knobs.wander);
            }
            let due = self.due(body, &s, now);
            self.souls.insert(body, (s, due));
        }
    }

    /// The tick of Wander's k-th leg (k ≥ 1).
    fn leg(&self, body: Id, wander: Micros, k: u64) -> Micros {
        let kn = &self.knobs;
        let span = (kn.leg_max - kn.leg_min + 1).max(1);
        (1..=k).fold(wander, |t, j| t + kn.leg_min + pick(mix(body, b'l', wander, j), span))
    }

    /// When the rule next acts on this body at or after `from`; `None` asleep.
    fn due(&self, body: Id, s: &State, from: Micros) -> Option<Micros> {
        let kn = &self.knobs;
        if s.slept {
            return None;
        }
        let Some(wander) = s.wander else {
            return Some(from.max(s.last + kn.wander));
        };
        let zombie_at = wander + kn.zombie;
        let stop_at = wander + kn.bound - SETTLE;
        let lie_at = stop_at + SETTLE / 2;
        if from < zombie_at {
            let mut k = 1;
            let mut t = self.leg(body, wander, k);
            while t < from {
                k += 1;
                t = self.leg(body, wander, k);
            }
            return Some(t.min(zombie_at));
        }
        if s.zombie.is_none() {
            let n = up((from - zombie_at).max(0), kn.leg_min.max(1));
            let t = zombie_at + n * kn.leg_min;
            return Some(if from >= stop_at { from.max(lie_at) } else { t.min(stop_at) });
        }
        let look = up(from, LOOK) * LOOK;
        Some(if from <= stop_at { look.min(stop_at) } else { look.max(lie_at) })
    }

    /// The moves due at `now`, in body order. A body held by something else waits `leg_min` and is not moved.
    pub fn step(&mut self, now: Micros, g: &dyn Ground) -> Vec<Order> {
        let due: Vec<Id> = self
            .souls
            .iter()
            .filter(|(_, (_, d))| d.is_some_and(|d| d <= now))
            .map(|(b, _)| *b)
            .collect();
        let mut out = Vec::new();
        for body in due {
            let Some((mut s, _)) = self.souls.get(&body).copied() else {
                continue;
            };
            let next = if g.held(body) {
                Some(now + self.knobs.leg_min)
            } else {
                if let Some(o) = self.one(body, &mut s, now, g) {
                    out.push(o);
                }
                self.due(body, &s, now + 1)
            };
            self.souls.insert(body, (s, next));
        }
        out
    }

    fn one(&self, body: Id, s: &mut State, now: Micros, g: &dyn Ground) -> Option<Order> {
        let kn = self.knobs;
        let order = |phase, what| Some(Order { body, phase, what });
        let Some(wander) = s.wander else {
            // Wander begins: the body stands.
            s.wander = Some(now);
            return order(Phase::Wander, vec![Do::Stand]);
        };
        let stop_at = wander + kn.bound - SETTLE;
        if now < wander + kn.zombie {
            return self.wander_leg(body, now, g).and_then(|p| order(Phase::Leg, vec![Do::Walk(p)]));
        }
        if s.zombie.is_none() && now < stop_at {
            let at = g.at(body).filter(|_| !g.walking(body) && !g.aboard(body))?;
            let spot = self.spot(body, at, g).unwrap_or(at);
            s.zombie = Some(now);
            s.spot = Some(spot);
            if d2(spot, at) < i128::from(M / 2) * i128::from(M / 2) {
                return self.lie(body, s, now, g);
            }
            return order(Phase::Zombie, vec![Do::Walk(spot)]);
        }
        if s.zombie.is_some() && now < stop_at {
            return if g.walking(body) { None } else { self.lie(body, s, now, g) };
        }
        if now < stop_at + SETTLE / 2 {
            // The bound: a walk still going stops where it is.
            return g.walking(body).then(|| Order { body, phase: Phase::Zombie, what: vec![Do::Stop] });
        }
        self.lie(body, s, now, g)
    }

    fn lie(&self, body: Id, s: &mut State, now: Micros, g: &dyn Ground) -> Option<Order> {
        s.zombie.get_or_insert(now);
        s.slept = true;
        if s.spot.is_none() {
            s.spot = g.at(body);
        }
        let what = if g.aboard(body) { Vec::new() } else { vec![Do::Stop, Do::Lie] };
        Some(Order { body, phase: Phase::Asleep, what })
    }

    /// One walk of `leg_min_um` to `leg_max_um` whose end is farther from the centre than its start.
    fn wander_leg(&self, body: Id, now: Micros, g: &dyn Ground) -> Option<[i64; 2]> {
        let at = g.at(body).filter(|_| !g.walking(body) && !g.aboard(body))?;
        let kn = &self.knobs;
        let c = g.centre();
        let d0 = d2(at, c);
        // The direction of the 64 nearest straight out from the centre; a leg turns up to 14 of them (79°) aside.
        let out = if d0 == 0 {
            None
        } else {
            (0..64).max_by_key(|&i| {
                let [x, z] = DIRS[i];
                i128::from(x) * i128::from(at[0] - c[0]) + i128::from(z) * i128::from(at[1] - c[1])
            })
        };
        for n in 0..12u64 {
            let h = mix(body, b'a', now, n);
            let dir = match out {
                Some(o) => usize::try_from(i64::try_from(o).unwrap_or(0) + 64 + pick(h, 29) - 14).unwrap_or(0),
                None => usize::try_from(pick(h, 64)).unwrap_or(0),
            };
            let d = kn.leg_min_um + pick(mix(body, b'd', now, n), (kn.leg_max_um - kn.leg_min_um + 1).max(1));
            let p = ahead(at, dir, d);
            if d2(p, c) > d0 && g.clear(p, false) {
                return Some(p);
            }
        }
        None
    }

    /// The nearest open ground outside the built area: outdoors with `MARGIN` of outdoors around it, clear to lie
    /// down, `spot_gap_um` from every other body's spot. Rings around the body, each from an angle of its id.
    fn spot(&self, body: Id, at: [i64; 2], g: &dyn Ground) -> Option<[i64; 2]> {
        let gap = i128::from(self.knobs.spot_gap_um) * i128::from(self.knobs.spot_gap_um);
        let others: Vec<[i64; 2]> = self
            .souls
            .iter()
            .filter(|(b, _)| **b != body)
            .filter_map(|(_, (s, _))| s.spot)
            .collect();
        let open = |p: [i64; 2]| {
            g.outdoors(p)
                && [[MARGIN, 0], [-MARGIN, 0], [0, MARGIN], [0, -MARGIN]]
                    .iter()
                    .all(|[dx, dz]| g.outdoors([p[0] + dx, p[1] + dz]))
                && g.clear(p, true)
                && others.iter().all(|o| d2(*o, p) >= gap)
        };
        if open(at) {
            return Some(at);
        }
        let a0 = usize::try_from(pick(mix(body, b's', 0, 0), 64)).unwrap_or(0);
        for k in 1..=self.knobs.spot_search_um / RING {
            // About one point every 1.5 m of the ring, at most 64.
            let n = usize::try_from(up(k * 62_832, 10_000).clamp(1, 64)).unwrap_or(64);
            for i in 0..n {
                let p = ahead(at, a0 + i * 64 / n, k * RING);
                if open(p) {
                    return Some(p);
                }
            }
        }
        None
    }
}

fn name(s: &str) -> Name {
    Name::new(s).unwrap_or_else(|| unreachable!("a fixed name"))
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

fn read_int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

/// The record of one move: cause and actor the world, node the body, and one event named for the body's word after it
/// ([`EVENTS`]), carrying the rule's state `{1: phase, 3: last, 4: wander, 5: zombie, 6: [x, z] spot}` (4, 5 and 6
/// left out when none). A woken body's record is `souls:awake` with phase `woken`.
pub fn record(o: &Order, s: &State, at: Micros, sequence: u64) -> Effect {
    let mut f = BTreeMap::new();
    f.insert(1, Value::Text(name(o.phase.as_str())));
    f.insert(3, int(s.last));
    if let Some(w) = s.wander {
        f.insert(4, int(w));
    }
    if let Some(z) = s.zombie {
        f.insert(5, int(z));
    }
    if let Some([x, z]) = s.spot {
        f.insert(6, Value::Array(vec![int(x), int(z)]));
    }
    Effect {
        envelope: Envelope {
            sequence,
            at,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node: o.body,
        },
        body: Body::Changes(Vec::new()),
        events: Some(vec![Event {
            name: name(&format!("souls:{}", s.word().as_str())),
            fields: f,
            changes: Vec::new(),
            rest: Rest::new(),
        }]),
        rest: Rest::new(),
    }
}

/// A record's body and state, when the entry is one of the rule's.
pub fn read(e: &Effect) -> Option<(Id, State)> {
    if e.envelope.actor != Actor::World {
        return None;
    }
    let ev = e.events.as_ref()?.iter().find(|v| EVENTS.contains(&v.name.as_str()))?;
    let f = &ev.fields;
    let phase = match f.get(&1)? {
        Value::Text(t) => Phase::read(t.as_str())?,
        _ => return None,
    };
    let spot = match f.get(&6) {
        Some(Value::Array(a)) if a.len() == 2 => Some([read_int(&a[0])?, read_int(&a[1])?]),
        _ => None,
    };
    Some((
        e.envelope.node,
        State {
            last: read_int(f.get(&3)?)?,
            wander: f.get(&4).and_then(read_int),
            zombie: f.get(&5).and_then(read_int),
            slept: phase == Phase::Asleep,
            spot,
        },
    ))
}

/// 64 directions, cos and sin × 10^6.
const DIRS: [[i64; 2]; 64] = [
    [1000000, 0],
    [995185, 98017],
    [980785, 195090],
    [956940, 290285],
    [923880, 382683],
    [881921, 471397],
    [831470, 555570],
    [773010, 634393],
    [707107, 707107],
    [634393, 773010],
    [555570, 831470],
    [471397, 881921],
    [382683, 923880],
    [290285, 956940],
    [195090, 980785],
    [98017, 995185],
    [0, 1000000],
    [-98017, 995185],
    [-195090, 980785],
    [-290285, 956940],
    [-382683, 923880],
    [-471397, 881921],
    [-555570, 831470],
    [-634393, 773010],
    [-707107, 707107],
    [-773010, 634393],
    [-831470, 555570],
    [-881921, 471397],
    [-923880, 382683],
    [-956940, 290285],
    [-980785, 195090],
    [-995185, 98017],
    [-1000000, 0],
    [-995185, -98017],
    [-980785, -195090],
    [-956940, -290285],
    [-923880, -382683],
    [-881921, -471397],
    [-831470, -555570],
    [-773010, -634393],
    [-707107, -707107],
    [-634393, -773010],
    [-555570, -831470],
    [-471397, -881921],
    [-382683, -923880],
    [-290285, -956940],
    [-195090, -980785],
    [-98017, -995185],
    [0, -1000000],
    [98017, -995185],
    [195090, -980785],
    [290285, -956940],
    [382683, -923880],
    [471397, -881921],
    [555570, -831470],
    [634393, -773010],
    [707107, -707107],
    [773010, -634393],
    [831470, -555570],
    [881921, -471397],
    [923880, -382683],
    [956940, -290285],
    [980785, -195090],
    [995185, -98017]
,
];

#[cfg(test)]
#[path = "wind_down_tests.rs"]
mod tests;
