//! A served world's targets (follow-up of X7, #4015): what the driver's Souls walk to, sit on and act on, read the
//! way a client reads them, before the clock starts.
//!
//! - **The ids** come from the first agent's copy ([`sync_copy`]): once every agent is signed in, on its own socket,
//!   it asks the world for its scope's hashes and fetches every record they reach (R5b's compare and descend, `replica::sync`, as the
//!   client's daemon does), checked against their hashes. Each record gives a node's id and its kind's plain name
//!   (the Soul Actions entry its field 27 names, else its kind, without `@revision`).
//! - **The forms** come from the world's kind entries (`GET /v2/entries`, signed in with the same token, gzip), as
//!   the client's `inspect` reads them ([`read_entries`]). A gateway without entries (404) gives none.
//! - **The choice** ([`Targets::of`]): walks go to things with a seat (their stand point), else to any thing with an
//!   entry; sits to things with a seat of posture `sit`; each other shape kind to the first of its [`FORMS`] an entry
//!   offers, on the things of that kind, or on the Soul's own body (its `souls:body-of` link) when its body's kind
//!   has an entry with the form. A shape kind no entry offers goes as a walk and is counted (`standIns`).
//!
//! [`Choice`] then turns each act into an intent the way an agent would: a Soul its last sit seated rises first
//! (a walk or a sit while seated is refused, `resource-held`), and says are withheld unless `--speech` opts in, so a
//! run on a world people visit says nothing out loud. A `look_at` or a `point` is at a thing the Soul can see: one
//! within [`SIGHT_UM`] of where it was last sent (its birth place before that), as an agent looks at what is around it.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::{SinkExt, StreamExt};
use replica::encode::{Value, decode, encode};
use replica::ids::Id;
use replica::pose::{Quat, Vec3};
use replica::rules::json::{self, Value as Json};
use replica::sync::{Copy, read_hashes, read_records, wire};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

/// Each shape kind but walk, sit and say, and the entry forms that carry it, the first one offered taken.
pub const FORMS: &[(&str, &[&str])] = &[
    ("gesture", &["wave", "clap", "cheer"]),
    ("sit-ground", &["sit_down"]),
    ("read", &["read"]),
    ("eat", &["eat", "bite", "drink"]),
    ("play-music", &["play_music", "play"]),
];

/// The body forms of the real Soul Actions mix (#4154) that take one thing: each shape kind's form, sent on the Soul's
/// own body with the thing as its argument (C2's `[[name, id]]`, the name the entry's `takes` gives).
pub const BODY_FORMS: &[&str] = &["go_to", "look_at", "touch", "lean_on", "wait_by", "point"];

/// The gestures of the mix (#4154): the body forms with no argument, taken in turn.
pub const GESTURES: &[&str] = &[
    "wave",
    "clap",
    "cheer",
    "bow",
    "shrug",
    "stretch",
    "jump",
    "dance",
    "look_around",
];

/// What a Soul can be sent on this world.
#[derive(Debug, Default, PartialEq)]
pub struct Targets {
    pub walk: Vec<Id>,
    pub sit: Vec<Id>,
    /// #4154: every thing with an entry (a body form's argument), the things whose own `take` form needs nothing
    /// held, the body's one-thing forms (form → verb and argument name) and its gestures (verbs).
    pub things: Vec<Id>,
    pub takeable: Vec<Id>,
    pub body_forms: BTreeMap<String, (String, String)>,
    pub gestures: Vec<String>,
    /// Shape kind → the form's verb (`<entry namespace>:<form>`) and the things that offer it; none: the Soul's body.
    pub forms: BTreeMap<String, (String, Vec<Id>)>,
    /// Each Soul's body in the copy (its `souls:body-of` link), for a body family's form.
    pub bodies: BTreeMap<Id, Id>,
    /// #4193: each Soul's own walk, sit, take and thing targets, the nearest its body of those reachable, spread so
    /// that at most [`SHARE_MOST`] Souls share one where there are enough; a Soul not in it uses the lists above.
    pub mine: BTreeMap<Id, Mine>,
    /// #5019 follow-up: from each place a Soul may be sent to (a target above) or born at (its body), the things
    /// within [`SIGHT_UM`] of it, nearest first, at most [`SIGHT_EACH`]: what a `look_at` or a `point` there is at.
    pub in_sight: BTreeMap<Id, Vec<Id>>,
}

/// #4193: one Soul's targets, nearest first.
#[derive(Debug, Default, PartialEq)]
pub struct Mine {
    pub walk: Vec<Id>,
    pub sit: Vec<Id>,
    pub takeable: Vec<Id>,
    pub things: Vec<Id>,
}

/// #4193: how many targets each Soul gets of each kind, and how many Souls may share one before a farther one is
/// taken instead.
pub const MINE_EACH: usize = 4;
pub const SHARE_MOST: usize = 3;

/// A node's pose as its record holds it: its frame's node, its position (micrometres, `v2/docs/pose.md` rule 2) and
/// its orientation, both in the frame's axes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Place {
    pub frame: Id,
    pub at: Vec3,
    pub turn: Quat,
}

/// What a test Soul's copy holds: each node's id and plain kind, and each body's Soul.
#[derive(Debug, Default)]
pub struct Seen {
    pub nodes: Vec<(Id, String)>,
    pub bodies: BTreeMap<Id, Id>,
    /// #4154: each node's pose, for the things near the Souls.
    pub places: BTreeMap<Id, Place>,
}

/// #5019 follow-up: how far a `look_at`'s or a `point`'s thing may be from the place the Soul was last sent to, µm. Both
/// moves reach 20 m (sight, `content/moves/look.json`); 5 m are kept for a walk that ends beside its thing, short of
/// it, or a seat's stand point.
pub const SIGHT_UM: i64 = 15_000_000;
/// The things kept in sight of each place, nearest first.
pub const SIGHT_EACH: usize = 8;

/// #4154: how far from where the Souls stand a thing may be to be acted on, as an agent acts on what it sees: the
/// radius (micrometres: 30 m) doubles from this until at least [`NEAR_LEAST`] things are in it.
pub const NEAR_UM: i64 = 30_000_000;
pub const NEAR_LEAST: usize = 20;

fn entry_ns(e: &Json) -> &str {
    e.get("kind")
        .and_then(Json::str)
        .and_then(|k| k.split_once(':'))
        .map_or("eden", |(ns, _)| ns)
}

fn has_slot(e: &Json, posture: Option<&str>) -> bool {
    e.get("slots").and_then(Json::obj).is_some_and(|s| {
        s.iter().any(|(_, s)| {
            let p = s.get("posture").and_then(Json::str);
            match posture {
                Some(want) => p == Some(want),
                None => p.is_some() || s.get("admits").and_then(Json::str) == Some("body"),
            }
        })
    })
}

/// Whether the entry offers `form` to a Soul standing anywhere: a form that needs the thing held first (a book's
/// `read`, an apple's `bite`) is left out, since an agent would take the thing before it.
fn has_form(e: &Json, form: &str) -> bool {
    e.get("forms").and_then(Json::obj).is_some_and(|f| {
        f.iter().any(|(n, f)| {
            n == form
                && !f.get("needs").and_then(Json::arr).is_some_and(|needs| {
                    needs
                        .iter()
                        .any(|x| x.get("need").and_then(Json::str) == Some("held_by_actor"))
                })
        })
    })
}

/// A node's place in the world's axes, x and z in micrometres: its position turned by each frame's orientation and
/// added to the frame's position, up the chain (#4193: #4154 left the turns out and read micrometres as millimetres).
/// None without a place.
pub fn world_xz(seen: &Seen, id: &Id) -> Option<(i64, i64)> {
    let p = *seen.places.get(id)?;
    let (mut f, mut at) = (p.frame, p.at);
    for _ in 0..12 {
        let Some(up) = seen.places.get(&f).copied().filter(|u| u.frame != f) else {
            break;
        };
        at = up.turn.rotate(at).ok()?.plus(up.at).ok()?;
        f = up.frame;
    }
    Some((at.x, at.z))
}

/// #4193: the frame most bodies stand in (the world's ground). A thing in another frame (inside a building, on a
/// table) is not walked to: its walk crosses the world or is refused while it runs.
fn ground(seen: &Seen) -> Option<Id> {
    let mut n: BTreeMap<Id, usize> = BTreeMap::new();
    for b in seen.bodies.values() {
        if let Some(p) = seen.places.get(b) {
            *n.entry(p.frame).or_default() += 1;
        }
    }
    n.into_iter().max_by_key(|(_, k)| *k).map(|(f, _)| f)
}

/// #4193: each Soul's [`MINE_EACH`] nearest of `of`, taking a farther one where [`SHARE_MOST`] Souls already have it
/// (`used` counts across the kinds, so a seat that is also a walk target counts for both).
fn spread(seen: &Seen, of: &[Id], used: &mut BTreeMap<Id, usize>) -> BTreeMap<Id, Vec<Id>> {
    let at: Vec<(Id, (i64, i64))> = of
        .iter()
        .filter_map(|t| Some((*t, world_xz(seen, t)?)))
        .collect();
    let mut out = BTreeMap::new();
    if at.is_empty() {
        return out;
    }
    for (soul, body) in &seen.bodies {
        let Some((x, z)) = world_xz(seen, body) else {
            continue;
        };
        let mut by: Vec<(i128, Id)> = at
            .iter()
            .map(|(t, (tx, tz))| (i128::from(tx - x).pow(2) + i128::from(tz - z).pow(2), *t))
            .collect();
        by.sort_unstable();
        let mut mine: Vec<Id> = by
            .iter()
            .filter(|(_, t)| used.get(t).copied().unwrap_or(0) < SHARE_MOST)
            .take(MINE_EACH)
            .map(|(_, t)| *t)
            .collect();
        // Too few targets for every Soul to have its own: the nearest, shared.
        for (_, t) in &by {
            if mine.len() >= MINE_EACH.min(by.len()) {
                break;
            }
            if !mine.contains(t) {
                mine.push(*t);
            }
        }
        for t in &mine {
            *used.entry(*t).or_default() += 1;
        }
        out.insert(*soul, mine);
    }
    out
}

/// #5019 follow-up: for each of `from`, the things of `of` within [`SIGHT_UM`] of it across x and z, nearest first, at
/// most [`SIGHT_EACH`]. A place with no position, or none in sight, is left out.
fn in_sight(seen: &Seen, from: impl IntoIterator<Item = Id>, of: &[Id]) -> BTreeMap<Id, Vec<Id>> {
    let at: Vec<(Id, (i64, i64))> = of
        .iter()
        .filter_map(|t| Some((*t, world_xz(seen, t)?)))
        .collect();
    let r = i128::from(SIGHT_UM).pow(2);
    let mut out = BTreeMap::new();
    for p in from {
        if out.contains_key(&p) {
            continue;
        }
        let Some((x, z)) = world_xz(seen, &p) else {
            continue;
        };
        let mut by: Vec<(i128, Id)> = at
            .iter()
            .map(|(t, (tx, tz))| (i128::from(tx - x).pow(2) + i128::from(tz - z).pow(2), *t))
            .filter(|(d, _)| *d <= r)
            .collect();
        by.sort_unstable();
        if !by.is_empty() {
            out.insert(p, by.into_iter().take(SIGHT_EACH).map(|(_, t)| t).collect());
        }
    }
    out
}

/// #4154: the things within a radius of the Souls' bodies' middle that doubles from [`NEAR_MM`] until it holds
/// [`NEAR_LEAST`]; all of them when the copy says no places or too few things are near. Picked at random across a
/// world as large as Eden, each walk and form would take minutes, and every act sent meanwhile would be refused
/// `form-running`.
fn near<'a>(seen: &Seen, things: Vec<(Id, &'a Json)>) -> Vec<(Id, &'a Json)> {
    let at: Vec<(i64, i64)> = seen
        .bodies
        .values()
        .filter_map(|b| world_xz(seen, b))
        .collect();
    if at.is_empty() {
        return things;
    }
    let (cx, cz) = (
        at.iter().map(|p| p.0).sum::<i64>() / at.len() as i64,
        at.iter().map(|p| p.1).sum::<i64>() / at.len() as i64,
    );
    let placed: Vec<((Id, &Json), i128)> = things
        .iter()
        .filter_map(|t| {
            let (x, z) = world_xz(seen, &t.0)?;
            Some((*t, i128::from(x - cx).pow(2) + i128::from(z - cz).pow(2)))
        })
        .collect();
    let mut r = NEAR_UM;
    while r < 4_000_000_000 {
        let close: Vec<(Id, &Json)> = placed
            .iter()
            .filter(|(_, d)| *d <= i128::from(r).pow(2))
            .map(|(t, _)| *t)
            .collect();
        if close.len() >= NEAR_LEAST {
            return close;
        }
        r *= 2;
    }
    things
}

impl Targets {
    /// The targets from the copy's nodes (id, plain kind) and the world's entries (a JSON array).
    pub fn of(seen: &Seen, entries: &Json) -> Targets {
        let nodes = &seen.nodes;
        let all = entries.arr().unwrap_or(&[]);
        let by_kind: BTreeMap<&str, &Json> = all
            .iter()
            .filter_map(|e| Some((e.get("kind")?.str()?, e)))
            .collect();
        // The bodies' own entries (the kind the world looks a body's forms up by), and the things that are not bodies.
        let is_body = |id: &Id| seen.bodies.values().any(|b| b == id);
        let mut families: Vec<&Json> = nodes
            .iter()
            .filter(|(id, _)| is_body(id))
            .filter_map(|(_, k)| by_kind.get(k.as_str()).copied())
            .collect();
        // #4154: a seeded world's test bodies are of kind `souls:body`, which names no entry; their forms are the body
        // family's entry's (`"owner": "family"`, Eden's `eden:humanoid`), sent on the body as an agent sends them.
        if families.is_empty() {
            families = all
                .iter()
                .filter(|e| e.get("owner").and_then(Json::str) == Some("family"))
                .collect();
        }
        let mut things: Vec<(Id, &Json)> = nodes
            .iter()
            .filter(|(id, _)| !is_body(id))
            .filter_map(|(id, k)| Some((*id, *by_kind.get(k.as_str())?)))
            .collect();
        // #4193: only things on the ground the bodies stand on are targets, where there are any.
        if let Some(g) = ground(seen) {
            let on: Vec<(Id, &Json)> = things
                .iter()
                .filter(|(id, _)| seen.places.get(id).is_some_and(|p| p.frame == g))
                .copied()
                .collect();
            if !on.is_empty() {
                things = on;
            }
        }
        // Each kind of target is taken near the Souls on its own (#4154), so seats and things to take are found
        // even where the nearest things are neither.
        let ids = |f: &dyn Fn(&Json) -> bool| -> Vec<Id> {
            let of: Vec<(Id, &Json)> = things.iter().filter(|(_, e)| f(e)).copied().collect();
            near(seen, of).into_iter().map(|(id, _)| id).collect()
        };
        // #4193: each Soul's own targets are the nearest its body, from every reachable thing, not only the middle's.
        let every = |f: &dyn Fn(&Json) -> bool| -> Vec<Id> {
            things
                .iter()
                .filter(|(_, e)| f(e))
                .map(|(id, _)| *id)
                .collect()
        };
        let mut walk = ids(&|e| has_slot(e, None));
        if walk.is_empty() {
            walk = ids(&|_| true);
        }
        // A gateway with no entries: any node of the copy.
        if walk.is_empty() {
            walk = nodes.iter().map(|(id, _)| *id).collect();
        }
        let mut forms = BTreeMap::new();
        for (kind, names) in FORMS {
            let found = names.iter().find_map(|n| {
                let on = ids(&|e| has_form(e, n));
                if let Some((_, e)) = things.iter().find(|(_, e)| has_form(e, n)) {
                    return Some((format!("{}:{n}", entry_ns(e)), on));
                }
                let fam = families.iter().find(|e| has_form(e, n))?;
                Some((format!("{}:{n}", entry_ns(fam)), Vec::new()))
            });
            if let Some(f) = found {
                forms.insert((*kind).to_owned(), f);
            }
        }
        let mut body_forms = BTreeMap::new();
        for f in BODY_FORMS {
            let Some(fam) = families.iter().find(|e| has_form(e, f)) else {
                continue;
            };
            let arg = fam
                .get("forms")
                .and_then(|x| x.get(f))
                .and_then(|x| x.get("takes"))
                .and_then(Json::obj)
                .and_then(|t| t.first().map(|(k, _)| k.clone()));
            if let Some(arg) = arg {
                body_forms.insert((*f).to_owned(), (format!("{}:{f}", entry_ns(fam)), arg));
            }
        }
        let gestures = GESTURES
            .iter()
            .filter_map(|g| {
                let fam = families.iter().find(|e| has_form(e, g))?;
                Some(format!("{}:{g}", entry_ns(fam)))
            })
            .collect();
        let sit = ids(&|e| has_slot(e, Some("sit")));
        // #4171: a body form's thing is a thing, not the world's land (`"owner": "place"`: a mountain range, the sea),
        // whose origin is the world's (0, 0) wherever its outline lies, so it was "nearest" every Soul born there.
        let thing = |e: &Json| e.get("owner").and_then(Json::str) != Some("place");
        let all_things = ids(&thing);
        let takeable = ids(&|e| has_form(e, "take"));
        let mut used = BTreeMap::new();
        let mut w = spread(seen, &every(&|e| has_slot(e, None)), &mut used);
        let mut s = spread(seen, &every(&|e| has_slot(e, Some("sit"))), &mut used);
        let mut k = spread(seen, &every(&|e| has_form(e, "take")), &mut used);
        let lookable = every(&thing);
        let mut a = spread(seen, &lookable, &mut BTreeMap::new());
        // Every place a Soul may be sent to or stand at: its body, and each target it may be sent to.
        let places: Vec<Id> = seen
            .bodies
            .values()
            .copied()
            .chain(
                [&w, &s, &k, &a]
                    .into_iter()
                    .flat_map(|m| m.values().flatten().copied()),
            )
            .chain(
                walk.iter()
                    .chain(&sit)
                    .chain(&takeable)
                    .chain(&all_things)
                    .copied(),
            )
            .collect();
        let in_sight = in_sight(seen, places, &lookable);
        let mine = seen
            .bodies
            .keys()
            .filter_map(|soul| {
                let m = Mine {
                    walk: w.remove(soul).unwrap_or_default(),
                    sit: s.remove(soul).unwrap_or_default(),
                    takeable: k.remove(soul).unwrap_or_default(),
                    things: a.remove(soul).unwrap_or_default(),
                };
                (m != Mine::default()).then_some((*soul, m))
            })
            .collect();
        Targets {
            walk,
            sit,
            things: all_things,
            takeable,
            body_forms,
            gestures,
            forms,
            bodies: seen.bodies.clone(),
            mine,
            in_sight,
        }
    }

    /// The report's line: how many targets each kind has, and each form's verb.
    pub fn json(&self) -> String {
        let forms: Vec<String> = self
            .forms
            .iter()
            .map(|(k, (v, on))| {
                let on = if on.is_empty() {
                    "\"own body\"".to_owned()
                } else {
                    on.len().to_string()
                };
                format!("{k:?}: {{\"verb\": {v:?}, \"on\": {on}}}")
            })
            .collect();
        format!(
            "{{\"walk\": {}, \"sit\": {}, \"things\": {}, \"takeable\": {}, \"bodies\": {}, \"bodyForms\": {:?}, \
             \"gestures\": {}, \"forms\": {{{}}}}}",
            self.walk.len(),
            self.sit.len(),
            self.things.len(),
            self.takeable.len(),
            self.bodies.len(),
            self.body_forms
                .keys()
                .cloned()
                .collect::<Vec<_>>()
                .join(" "),
            self.gestures.len(),
            forms.join(", ")
        )
    }
}

/// One act as sent: its verb, its target, whether it carries words, and how it was chosen.
#[derive(Debug, PartialEq)]
pub struct Chosen {
    pub verb: String,
    pub target: Option<Id>,
    /// A body form's one argument, by the name its entry takes it under (#4154).
    pub arg: Option<(String, Id)>,
    pub words: bool,
    /// `None`, or the shape kind a walk stands in for.
    pub stand_in: Option<String>,
}

/// One agent's state across its acts: seated (set by the agent's socket when a sit's receipt comes, cleared by a
/// rise), and how many acts it has sent.
#[derive(Default, Clone)]
pub struct Choice {
    pub seated: Arc<AtomicBool>,
    /// #4154: the thing the Soul's last take put in its hand (set by the agent's socket on the take's receipt); its
    /// next take puts it down first (`hands:set-down`, `v2/docs/intents.md` rule 16).
    pub holding: Arc<std::sync::Mutex<Option<Id>>>,
    /// #5019 follow-up: the place the Soul was last sent to (a walk's or a sit's target, a take's thing, a walking body
    /// form's thing), where its `look_at` and `point` look from; none yet: its body, where it was born.
    at: Option<Id>,
    n: u64,
}

impl Choice {
    /// The intent for agent `agent`'s next act of shape kind `kind` (its schedule verb `verb`, whose namespace walks,
    /// sits and rises take), or `None` for a say withheld. `soul` is the agent's Soul.
    pub fn next(
        &mut self,
        t: &Targets,
        kind: &str,
        verb: &str,
        agent: u32,
        soul: Id,
        speech: bool,
    ) -> Option<Chosen> {
        let seated = self.seated.load(Ordering::Relaxed);
        let sit = |to: bool| self.seated.store(to, Ordering::Relaxed);
        let ns = verb.split_once(':').map_or("eden", |(ns, _)| ns);
        let pick = |v: &[Id], k: u64| (!v.is_empty()).then(|| v[(k % v.len() as u64) as usize]);
        let a = u64::from(agent);
        let n = self.n;
        let plain = |verb: String, target| Chosen {
            verb,
            target,
            arg: None,
            words: false,
            stand_in: None,
        };
        let body = t.bodies.get(&soul).copied();
        let mine = t.mine.get(&soul);
        let own = |m: Option<&Vec<Id>>, all: &Vec<Id>| -> Vec<Id> {
            m.filter(|v| !v.is_empty()).unwrap_or(all).clone()
        };
        let (walk, sit_on, takeable, things) = (
            own(mine.map(|m| &m.walk), &t.walk),
            own(mine.map(|m| &m.sit), &t.sit),
            own(mine.map(|m| &m.takeable), &t.takeable),
            own(mine.map(|m| &m.things), &t.things),
        );
        let holding = *self.holding.lock().unwrap_or_else(|e| e.into_inner());
        let standing_form =
            |k: &str| k == "take" || (BODY_FORMS.contains(&k) && k != "look_at" && k != "point");
        let out = match kind {
            "say" if !speech => return None,
            "say" => Chosen {
                verb: verb.to_owned(),
                target: None,
                arg: None,
                words: true,
                stand_in: None,
            },
            // #4154's mix: a body form needs the Soul standing (all but a look or a point), so a seated one rises.
            k if seated && standing_form(k) => {
                sit(false);
                plain(format!("{ns}:rise"), None)
            }
            "take" if holding.is_some() => {
                *self.holding.lock().unwrap_or_else(|e| e.into_inner()) = None;
                plain("hands:set-down".to_owned(), holding)
            }
            "take" if !takeable.is_empty() => {
                plain(format!("{ns}:take"), pick(&takeable, a * 13 + n))
            }
            k if t.body_forms.contains_key(k) && body.is_some() && !things.is_empty() => {
                let (v, arg) = &t.body_forms[k];
                // A look or a point is at a thing in sight of where the Soul is (#5019 follow-up), else as before.
                let seen = (k == "look_at" || k == "point")
                    .then(|| self.at.or(body).and_then(|p| t.in_sight.get(&p)))
                    .flatten();
                Chosen {
                    arg: pick(seen.unwrap_or(&things), a * 11 + n).map(|x| (arg.clone(), x)),
                    ..plain(v.clone(), body)
                }
            }
            "gesture" if body.is_some() && !t.gestures.is_empty() => {
                let g = &t.gestures[((a + n) % t.gestures.len() as u64) as usize];
                plain(g.clone(), body)
            }
            "walk" | "sit" if seated => {
                sit(false);
                plain(format!("{ns}:rise"), None)
            }
            "walk" => plain(format!("{ns}:walk"), pick(&walk, a * 7 + n)),
            // Seated once the sit's receipt comes (the agent's socket sets it): a sit still on its way is replaced by
            // the next walk, as the world does, and needs no rise.
            "sit" if !sit_on.is_empty() => plain(format!("{ns}:sit"), pick(&sit_on, a)),
            k => match t.forms.get(k) {
                Some((v, on)) if on.is_empty() && t.bodies.contains_key(&soul) => {
                    plain(v.clone(), t.bodies.get(&soul).copied())
                }
                Some((v, on)) if !on.is_empty() => plain(v.clone(), pick(on, a + n)),
                _ if seated => {
                    sit(false);
                    plain(format!("{ns}:rise"), None)
                }
                _ => Chosen {
                    stand_in: Some(k.to_owned()),
                    ..plain(format!("{ns}:walk"), pick(&walk, a * 7 + n))
                },
            },
        };
        // Where the Soul goes: a walk's, a sit's or a take's target, or a walking body form's thing.
        let v = out.verb.as_str();
        if v.ends_with(":walk") || v.ends_with(":sit") || v.ends_with(":take") {
            self.at = out.target.or(self.at);
        } else if !(v.ends_with(":look_at") || v.ends_with(":point")) && out.arg.is_some() {
            self.at = out.arg.as_ref().map(|x| x.1);
        }
        self.n += 1;
        Some(out)
    }
}

async fn next_map<R>(rx: &mut R, n: u64) -> Result<BTreeMap<u64, Value>, String>
where
    R: futures_util::Stream<Item = Result<Message, WsError>> + Unpin,
{
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(30), rx.next())
            .await
            .map_err(|_| "targets: no answer to a sync request in 30 s".to_owned())?;
        let Some(Ok(Message::Binary(b))) = frame else {
            match frame {
                Some(Ok(_)) => continue,
                _ => return Err("targets: the socket closed during the sync".into()),
            }
        };
        if let Ok(Value::Map(m)) = decode(&b).map(|d| d.value)
            && m.get(&wire::ASK) == Some(&Value::Uint(n))
        {
            if let Some(Value::Text(r)) = m.get(&wire::REFUSED) {
                return Err(format!("targets: the sync was refused: {}", r.as_str()));
            }
            return Ok(m);
        }
    }
}

/// The plain name of a node record's kind: its field 27's entry, else its kind, without `@revision`.
fn plain_kind(record: &BTreeMap<u64, Value>) -> Option<String> {
    let named = match record.get(&6) {
        Some(Value::Map(f)) => f.get(&27),
        _ => None,
    };
    let Some(Value::Text(k)) = named.or_else(|| record.get(&2)) else {
        return None;
    };
    let k = k.as_str();
    Some(k.split_once('@').map_or(k, |(p, _)| p).to_owned())
}

/// A node record's pose (field 7, `{1: frame, 2: position, 3: orientation}`): its frame's node, its position in
/// micrometres and its orientation (no turn when it is not read).
fn place_of(record: &BTreeMap<u64, Value>) -> Option<Place> {
    let Some(Value::Map(p)) = record.get(&7) else {
        return None;
    };
    let frame = match p.get(&1)? {
        Value::Array(f) => replica::effects::read_id(f.first()?).ok()?,
        v => replica::effects::read_id(v).ok()?,
    };
    let Value::Array(xyz) = p.get(&2)? else {
        return None;
    };
    let n = |v: &Value| match v {
        Value::Uint(u) => Some(*u as i64),
        Value::Nint(u) => Some(-1 - *u as i64),
        _ => None,
    };
    let turn = match p.get(&3) {
        Some(Value::Array(q)) if q.len() == 4 => {
            Quat::new(n(&q[0])?, n(&q[1])?, n(&q[2])?, n(&q[3])?).ok()
        }
        _ => None,
    };
    Some(Place {
        frame,
        at: Vec3::new(n(xyz.first()?)?, n(xyz.get(1)?)?, n(xyz.get(2)?)?),
        turn: turn.unwrap_or(Quat::IDENTITY),
    })
}

/// The Soul a body record's `souls:body-of` link names (field 9's links `[[id, {1: type, 2: [body, soul]}], ...]`).
fn soul_of(record: &BTreeMap<u64, Value>) -> Option<Id> {
    let Some(Value::Array(links)) = record.get(&9) else {
        return None;
    };
    links.iter().find_map(|l| {
        let Value::Array(pair) = l else { return None };
        let Some(Value::Map(link)) = pair.get(1) else {
            return None;
        };
        let Some(Value::Text(ty)) = link.get(&1) else {
            return None;
        };
        if ty.as_str().split('@').next() != Some("souls:body-of") {
            return None;
        }
        let Some(Value::Array(ends)) = link.get(&2) else {
            return None;
        };
        replica::effects::read_id(ends.get(1)?).ok()
    })
}

/// The nodes of a test Soul's scope, as its copy holds them after a sync from nothing, over its signed-in socket
/// (its agent's, once every agent is signed in, so their bodies are in the world).
pub async fn sync_copy<S, R>(tx: &mut S, rx: &mut R) -> Result<Seen, String>
where
    S: futures_util::Sink<Message, Error = WsError> + Unpin,
    R: futures_util::Stream<Item = Result<Message, WsError>> + Unpin,
{
    let send = |b: Vec<u8>| Message::Binary(b.into());
    let ask = |n: u64, key: u64, list: Vec<Value>| {
        encode(&Value::Map(BTreeMap::from([
            (wire::ASK, Value::Uint(n)),
            (key, Value::Array(list)),
        ])))
        .expect("a sync request")
    };
    tx.send(send(ask(1, wire::IDS, Vec::new())))
        .await
        .map_err(|e| e.to_string())?;
    let (scope, hashes) = read_hashes(&next_map(rx, 1).await?).map_err(|r| r.name)?;
    let mut copy = Copy::default();
    let mut d = copy.compare(&scope, hashes);
    let mut n = 1;
    loop {
        let asked = copy.ask(&mut d, wire::RECORDS_MOST);
        if asked.is_empty() {
            break;
        }
        n += 1;
        let list = asked.iter().map(|h| Value::Bytes(h.clone())).collect();
        tx.send(send(ask(n, wire::RECORDS, list)))
            .await
            .map_err(|e| e.to_string())?;
        let got = read_records(&next_map(rx, n).await?).map_err(|r| r.name)?;
        copy.take(&mut d, &asked, got).map_err(|r| r.name)?;
    }
    copy.finish(d).map_err(|r| r.name)?;
    let mut out = Seen::default();
    for h in copy.reach().map_err(|r| r.name)? {
        let Some(Ok(Value::Map(m))) = copy.record(&h).map(|b| decode(b).map(|d| d.value)) else {
            continue;
        };
        if let (Some(id), Some(kind)) = (
            m.get(&1).and_then(|v| replica::effects::read_id(v).ok()),
            plain_kind(&m),
        ) {
            if let Some(soul) = soul_of(&m) {
                out.bodies.insert(soul, id);
            }
            if let Some(p) = place_of(&m) {
                out.places.insert(id, p);
            }
            out.nodes.push((id, kind));
        }
    }
    out.nodes.sort();
    Ok(out)
}

/// The world's kind entries, `GET /v2/entries` at the gateway (plain HTTP, as `--remote` is), signed in with `token`.
pub async fn read_entries(url: &str, token: &str) -> Result<Json, String> {
    let host = url
        .strip_prefix("ws://")
        .and_then(|r| r.split('/').next())
        .ok_or("targets: the gateway's address")?;
    let mut s = tokio::net::TcpStream::connect(host)
        .await
        .map_err(|e| format!("targets: entries: {e}"))?;
    let req = format!(
        "GET /v2/entries HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n"
    );
    s.write_all(req.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
    let at = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("targets: entries: no HTTP answer")?;
    let head = String::from_utf8_lossy(&buf[..at]);
    let status = head.lines().next().unwrap_or("");
    if status.contains(" 404 ") {
        eprintln!(
            "driver: the gateway serves no entries (no --entries): walks go to any node, forms stand in as walks"
        );
        return Ok(Json::Arr(Vec::new()));
    }
    if !status.contains(" 200 ") {
        return Err(format!(
            "targets: entries: {status} (the gateway serves them with --entries)"
        ));
    }
    let gz = &buf[at + 4..];
    if gz.len() < 18 {
        return Err("targets: entries: a short body".into());
    }
    let raw = miniz_oxide::inflate::decompress_to_vec(&gz[10..gz.len() - 8])
        .map_err(|e| format!("targets: entries: gzip: {e:?}"))?;
    json::parse(&String::from_utf8_lossy(&raw))
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::ids::Scope;

    fn id(n: u64) -> Id {
        Id::new(Scope([5; 16]), n).unwrap()
    }

    const ENTRIES: &str = r#"[
      {"kind": "eden:chair", "slots": {"seat": {"admits": "body", "posture": "sit"}}, "forms": {"sit": {}}},
      {"kind": "eden:speaker", "forms": {"play_music": {}}},
      {"kind": "eden:book", "forms": {"read": {"needs": [{"need": "held_by_actor"}]}}},
      {"kind": "eden:humanoid", "forms": {"wave": {}, "sit_down": {}}}
    ]"#;

    #[test]
    fn targets_come_from_the_copy_and_the_entries() {
        let seen = Seen {
            nodes: vec![
                (id(1), "eden:chair".to_owned()),
                (id(2), "eden:chair".to_owned()),
                (id(3), "eden:speaker".to_owned()),
                (id(4), "souls:ground".to_owned()),
                (id(5), "eden:book".to_owned()),
                (id(6), "eden:humanoid".to_owned()),
                (id(7), "souls:body".to_owned()),
            ],
            bodies: BTreeMap::from([(id(9), id(6)), (id(10), id(7))]),
            ..Default::default()
        };
        let t = Targets::of(&seen, &json::parse(ENTRIES).unwrap());
        assert_eq!(t.walk, [id(1), id(2)]);
        assert_eq!(t.sit, [id(1), id(2)]);
        assert_eq!(
            t.forms["play-music"],
            ("eden:play_music".into(), vec![id(3)])
        );
        assert_eq!(t.forms["gesture"], ("eden:wave".into(), Vec::new()));
        assert_eq!(t.forms["sit-ground"], ("eden:sit_down".into(), Vec::new()));
        assert!(
            !t.forms.contains_key("read"),
            "a form that needs the thing held"
        );
        let none = Seen {
            nodes: vec![(id(7), "souls:body".to_owned())],
            bodies: BTreeMap::from([(id(10), id(7))]),
            ..Default::default()
        };
        let t = Targets::of(&none, &json::parse(ENTRIES).unwrap());
        assert!(
            t.forms.is_empty(),
            "a body whose kind has no entry offers no form"
        );
    }

    /// #5019 follow-up: a look or a point is at a thing in sight of where the Soul was last sent, not at its nearest
    /// things from where it was born.
    #[test]
    fn a_look_or_a_point_is_at_a_thing_in_sight_of_where_the_soul_was_sent() {
        const BODY_ENTRIES: &str = r#"[
          {"kind": "eden:chair", "slots": {"seat": {"admits": "body", "posture": "sit"}}, "forms": {"sit": {}}},
          {"kind": "eden:lamp", "forms": {}},
          {"kind": "eden:humanoid", "forms": {
            "look_at": {"takes": {"target": {"type": "thing"}}},
            "point": {"takes": {"toward": {"type": "thing"}}}}}
        ]"#;
        let (g, me, body) = (id(100), id(9), id(8));
        let (near_chair, far_chair, near_lamp, far_lamp) = (id(1), id(2), id(3), id(4));
        let at = |x: i64| Place {
            frame: g,
            at: Vec3::new(x, 0, 0),
            turn: Quat::IDENTITY,
        };
        let seen = Seen {
            nodes: vec![
                (near_chair, "eden:chair".to_owned()),
                (far_chair, "eden:chair".to_owned()),
                (near_lamp, "eden:lamp".to_owned()),
                (far_lamp, "eden:lamp".to_owned()),
                (body, "eden:humanoid".to_owned()),
            ],
            bodies: BTreeMap::from([(me, body)]),
            places: BTreeMap::from([
                (body, at(0)),
                (near_chair, at(5_000_000)),
                (far_chair, at(100_000_000)),
                (near_lamp, at(3_000_000)),
                (far_lamp, at(106_000_000)),
            ]),
        };
        let t = Targets::of(&seen, &json::parse(BODY_ENTRIES).unwrap());
        assert_eq!(t.in_sight[&body], [near_lamp, near_chair], "from its birth");
        assert_eq!(t.in_sight[&far_chair], [far_chair, far_lamp]);
        let mut c = Choice::default();
        let arg = |c: &mut Choice, kind| c.next(&t, kind, "eden:x", 0, me, false).unwrap().arg;
        for kind in ["look_at", "point"] {
            let (_, x) = arg(&mut c, kind).expect("a thing");
            assert!(
                [near_lamp, near_chair].contains(&x),
                "{kind} from its birth: {x:?}"
            );
        }
        // Sent to the far chair: its looks and points are at the things around that chair.
        let walked = (0..4)
            .map(|_| {
                c.next(&t, "walk", "eden:walk", 0, me, false)
                    .unwrap()
                    .target
            })
            .any(|w| w == Some(far_chair));
        assert!(walked, "a walk to the far chair");
        for kind in ["look_at", "point", "look_at", "point"] {
            let (_, x) = arg(&mut c, kind).expect("a thing");
            assert!(
                [far_chair, far_lamp].contains(&x),
                "{kind} by the far chair: {x:?}"
            );
        }
    }

    #[test]
    fn a_seated_soul_rises_first_says_are_withheld_and_an_unoffered_kind_walks() {
        let me = id(9);
        let seen = Seen {
            nodes: vec![
                (id(1), "eden:chair".to_owned()),
                (id(8), "eden:humanoid".to_owned()),
            ],
            bodies: BTreeMap::from([(me, id(8))]),
            ..Default::default()
        };
        let t = Targets::of(&seen, &json::parse(ENTRIES).unwrap());
        let mut c = Choice::default();
        let verb = |c: &mut Choice, kind| {
            c.next(&t, kind, "eden:x", 0, me, false)
                .map(|x| (x.verb, x.target))
        };
        assert_eq!(verb(&mut c, "say"), None);
        assert_eq!(verb(&mut c, "sit"), Some(("eden:sit".into(), Some(id(1)))));
        c.seated.store(true, Ordering::Relaxed); // the sit's receipt
        assert_eq!(verb(&mut c, "walk"), Some(("eden:rise".into(), None)));
        assert_eq!(
            verb(&mut c, "walk"),
            Some(("eden:walk".into(), Some(id(1))))
        );
        assert_eq!(
            verb(&mut c, "gesture"),
            Some(("eden:wave".into(), Some(id(8))))
        );
        let read = c.next(&t, "read", "eden:read", 0, me, false).unwrap();
        assert_eq!(
            (read.verb.as_str(), read.stand_in.as_deref()),
            ("eden:walk", Some("read"))
        );
        let other = c.next(&t, "gesture", "eden:wave", 0, id(7), false).unwrap();
        assert_eq!(
            other.stand_in.as_deref(),
            Some("gesture"),
            "a body not in the copy"
        );
        c.next(&t, "sit", "eden:sit", 0, me, false);
        let walk = c.next(&t, "walk", "eden:walk", 0, me, false).unwrap();
        assert_eq!(
            walk.verb, "eden:walk",
            "a sit with no receipt leaves the Soul standing"
        );
        let say = c.next(&t, "say", "eden:say", 0, me, true).unwrap();
        assert!(say.words && say.verb == "eden:say");
    }
}
