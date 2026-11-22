//! Links: doors that must be opened, stairs and ladders (Engine v2 N4, #2652). A link joins two ends, each a segment
//! on a patch (N3's walkable ground, `crate::ground`), and names the move that crosses it (contract T4). A body
//! crosses a link only by that move, from one end to the other; nothing else takes it from one patch to another.
//!
//! - **What a link is here.** Its id, its kind (a doorway, a stair, a ramp or a ladder: the T2 link's type), the two
//!   nodes it joins, its owning node (T1), its width, the abilities its move needs, and the line a body's centre
//!   follows from one end to the other, in the building's frame, in micrometres. A doorway's ends are where the
//!   passage through it meets the floor's patch on each side (N3's [`Meet`]). A stair's or ladder's ends are its
//!   path's ends, each carried along the floor to the first point of that floor's patch (its apron: the band a floor
//!   is shrunk by at its edge is part of the crossing, as the grown doorway is). Its line is the path in three
//!   dimensions, rising evenly from `y0` to `y1` along its run: a body on it is the path at a distance.
//! - **Doors.** A door is a node standing in its doorway (N1's door thing); open or shut is a field on it
//!   ([`F_OPEN`]), never on the link, and its frame and leaf belong to the link, not to the room's solids (N3 cuts no
//!   obstacle for it). Crossing a shut door is stand, open, cross: the opening is part of the walk order the agent
//!   wrote (a cross leg; the proof walker in `sim/tests/links.rs` writes one), and it is an effect in the stream, a set of the door's field with the event its kind
//!   declares ([`opened_event`]: `eden:door_opened` for Eden's door). The room end owns the doorway link and the door
//!   names it (its field 7); the door node owns its own `open` ([`F_OPEN`]) and `locked` ([`F_LOCKED`]) fields.
//!   Opening needs hands: a body without them is refused at a shut door as `door-needs-hands`, and
//!   the door stays shut. No kind says "close behind" yet, so a door crossed stays open.
//! - **What a link that cannot be crossed is.** A doorway with no width left for the centre (N3's four hall back
//!   doors blocked by content) is `link-too-narrow`. A doorway whose far side has no ground at its height (an upper
//!   storey's door marked "outside") joins nothing walkable: it is not crossable (`link-end-off-ground`), never a
//!   drop. A link is never a way to fall, so a door never strands a body on the far side of nothing.
//! - **Two bodies at one door.** State is read a tick late (T1), so two bodies may both ask to open a shut door in
//!   one tick. The door's own writer takes the asks of a tick together and writes one opening ([`Doors`]).
//!
//! - **Doorways to the open ground.** Read with the open ground ([`Building::read_on`]), a doorway between a room and
//!   the open ground has two ends like any other: one on the room's floor patch, in the building's frame, the other
//!   where its passage meets the open ground's squares (N3's meets, joined into one segment), in the ground's frame.
//!   An end's points are in the frame of its node; the line is in the building's frame, and [`Building::place`] is
//!   the building's frame on the open ground. Read alone ([`Building::read`]), such a doorway has one end and is
//!   `link-end-off-ground`. A doorway the open ground holds both ends of (a gate in a garden wall or a fence, whose
//!   thing has no floor) is a link of the open ground itself ([`Building::of_ground`]), in the ground's frame.
//!
//! - **Steps.** A low floor's open edge (a porch's front, N3's steps) is a [`Kind::Step`] read with the open ground:
//!   one end on the floor's patch, the other where its passage meets the ground's squares, walked. It is no link of
//!   the tree (its id is derived, `ground::scene::step_id`), and an edge with nothing to step down to is no link. A
//!   step between two of a floor's own surfaces (a bridge's deck) has both ends on the floor's patch, each carried
//!   onto its piece as a stair's end is, and joins the floor to itself, read alone or with the ground. An outline
//!   step that meets no open ground beyond ([`Building::loose`]) but lies over another thing's floor within [`crate::ground::STEP`]
//!   of it joins the two floors ([`floor_joins`], #3227: the botanic red bridge's east end onto the tea house's
//!   floor); its far end is the near end carried across the edge onto that floor's patch, and its line is in the
//!   first building's frame. A flight whose top meets nothing of its own floor (a landing too small to stand on) lands
//!   the same way on another thing's floor its top meets at its height (Eden's roof stairs onto their roofs, #1960),
//!   and a flight's foot on the open ground is carried out along it past its own solids, onto the ground.
//! - **Ends on the terrain.** An end on the open ground stands at the ground's height there (#3227,
//!   `ground::scene::Terrain::ground`), as a body on it does (N11a), though N3's pieces of it are a plan at 0.
//! - **Shores** (N11c, #3218). Where dry ground meets wading ground, a [`Kind::Wade`] (`souls:wade`); where wading
//!   ground or dry ground meets swimming water, a [`Kind::Swim`] (`souls:swim`). No link of the tree (its id is
//!   derived, [`shore_id`]): the routes find them along the edges the open ground's pieces share (`crate::routes`).
//!
//! Not here: routes (N5), the mover and walking (N6, N7), turns at a link (N8), who may pass (F6), boarding a moving frame (N12, [`boarding`]), a
//! locked door (the door's `locked` field is not read yet), the durable log (K4).

pub mod boarding;
pub mod turns;

use crate::ground::scene::{DOORWAY, F_OPEN_DOOR_LINK, FLOOR, Terrain, Xform};
use crate::ground::{HUMAN_RADIUS, MARGIN, Meet, Patch, SQUARE, Scene, Turn, cut_floor};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Event, Header, Part, Refusal, Rest,
    read_id,
};
use replica::encode::{Name, Value, encode};
use replica::ids::Id;
use replica::pose::{Quat, Vec3};
use replica::tree::{Rules, Tree};
use replica::world_model::plain;
use std::collections::{BTreeMap, BTreeSet};

/// A door's field: 1 open, 0 shut (N1's `F_OPEN`).
pub const F_OPEN: u64 = 6;
/// A floor's stairs, ramps and ladders (N1's `F_STAIRS`): `[[link, kind, to, width, y0, y1, [[x, z] …]] …]` mm.
pub const F_STAIRS: u64 = 21;
/// A floor's level (N1's `F_LEVEL`).
pub const F_LEVEL: u64 = 5;
/// The event an opening of Eden's door carries, and the name any door falls back to ([`opened_event`]); its field 1
/// is the doorway link.
pub const DOOR_OPENED: &str = "eden:door_opened";
/// A door's field: 1 locked, 0 not (the door entry's `locked`). The door node holds it, as it holds [`F_OPEN`].
pub const F_LOCKED: u64 = 24;

/// The event an opening of a door of kind `kind` emits: the one its kind declares. Eden's door (`eden:door`) declares
/// `door_opened`, so `eden:door_opened`. Until K3 loads kinds' entries the tree holds no kind's events (Eden's doors
/// are imported as `core:door`), so any other kind falls back to that name.
pub fn opened_event(kind: &str) -> &'static str {
    match plain(kind) {
        "eden:door" => "eden:door_opened",
        _ => DOOR_OPENED,
    }
}

/// The id of the open ground `ground`'s shore link number `n` (N11c, #3218): derived, as a step's is
/// (`ground::scene::step_id`), since a shore is no link of the tree.
pub fn shore_id(ground: Id, n: u64) -> Id {
    let mut input = b"souls:shore\0".to_vec();
    input.extend_from_slice(&ground.scope().0);
    input.extend_from_slice(&ground.counter().to_be_bytes());
    let h = replica::ids::sha256(&input);
    let mut scope = [0u8; 16];
    scope.copy_from_slice(&h[..16]);
    Id::new(replica::ids::Scope(scope), n).expect("a shore's number is below 2^53")
}

/// A link's kind: its T2 type, and the move that crosses it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Doorway,
    Stairs,
    Ramp,
    Ladder,
    /// A low floor's open edge stepped down to the open ground, or a step between two of a floor's surfaces (N3's
    /// steps): no link of the tree, walked.
    Step,
    /// A shore between dry ground and wading ground (N11c, #3218): no link of the tree ([`shore_id`]), waded.
    Wade,
    /// A shore between wading ground, or dry ground, and swimming water (N11c, #3218): no link of the tree, swum.
    Swim,
    /// Between the ground at a stop and a moving frame's deck, crossable only while the frame stands at that stop
    /// ([`boarding`], N12): walked.
    Boarding,
}

impl Kind {
    fn of(ty: &str) -> Option<Kind> {
        Some(match ty {
            DOORWAY => Kind::Doorway,
            "eden:stairs" => Kind::Stairs,
            "eden:ramp" => Kind::Ramp,
            "eden:ladder" => Kind::Ladder,
            _ => return None,
        })
    }

    /// The move that crosses it (contract T4).
    pub fn move_name(self) -> &'static str {
        match self {
            Kind::Doorway | Kind::Ramp | Kind::Step | Kind::Boarding => "souls:walk",
            Kind::Stairs => "souls:stairs",
            Kind::Ladder => "souls:climb",
            Kind::Wade => "souls:wade",
            Kind::Swim => "souls:swim",
        }
    }

    /// What its move needs of a body. Opening a shut door needs hands besides.
    pub fn needs(self) -> Abilities {
        Abilities {
            legs: self != Kind::Swim,
            hands: self == Kind::Ladder,
        }
    }
}

/// What a body has, as far as a link asks (its family's resources, T9).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Abilities {
    pub legs: bool,
    pub hands: bool,
}

/// One end of a link: the segment where it meets a patch (µm, in the frame of that patch's node), and that node: a
/// floor of the building, or the open ground.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct End {
    pub floor: Id,
    pub a: Vec3,
    pub b: Vec3,
}

impl End {
    /// The segment's middle: where a crossing starts or ends.
    pub fn middle(&self) -> Vec3 {
        Vec3::new(
            (self.a.x + self.b.x) / 2,
            (self.a.y + self.b.y) / 2,
            (self.a.z + self.b.z) / 2,
        )
    }
}

/// A link as a body crosses it.
#[derive(Clone, Debug)]
pub struct Link {
    pub id: Id,
    pub kind: Kind,
    /// The nodes it joins (rooms, floors, or a room and the open ground), as the T2 link holds them.
    pub nodes: [Id; 2],
    pub owner: Id,
    /// The doorway's or the flight's width, µm.
    pub width: i64,
    /// Its two ends on patches, when each has one.
    pub ends: [Option<End>; 2],
    /// The line a body's centre follows from end 0 to end 1, µm, in the building's frame (empty when it cannot be
    /// crossed).
    pub line: Vec<Vec3>,
    /// The door standing in a doorway, if it has one.
    pub door: Option<Id>,
    /// Why it cannot be crossed, if it cannot.
    pub blocked: Option<&'static str>,
}

/// The links of one building, with the patch of each of its floors, all in the building's frame.
#[derive(Clone)]
pub struct Building {
    pub thing: Id,
    pub links: Vec<Link>,
    /// Each floor node's patch for today's walking body, and its level.
    pub floors: BTreeMap<Id, (i64, Patch)>,
    /// The building's frame on the open ground it was read with (the identity when read alone).
    pub place: Xform,
    /// Its floors' outline steps that meet no open ground beyond (#3227): another thing's floor may lie there
    /// ([`floor_joins`]).
    pub loose: Vec<Loose>,
}

/// An outline step of a building's floor whose far side meets no open ground: its link, its end on the floor (the
/// building's frame), the unit off the floor (µm per metre), its width (µm) and the radius it was cut for (mm). Or a
/// flight whose top meets no floor of its own (`stair`): its lower end, and the unit along it at the top.
#[derive(Clone, Debug)]
pub struct Loose {
    pub link: Id,
    pub end: End,
    pub across: [i64; 2],
    pub width: i64,
    pub radius: i64,
    pub stair: Option<LooseStair>,
}

/// A flight's top that meets no floor of its own building: its kind, its lower node, its line so far (the building's
/// frame, from its lower end), its top (the line's end there) and its end's half-width for the centre (µm).
#[derive(Clone, Debug)]
pub struct LooseStair {
    pub kind: Kind,
    pub from: Id,
    pub line: Vec<Vec3>,
    pub top: Vec3,
    pub half: i64,
}

/// Steps between two things' floors (#3227): where an outline step of one building's floor ([`Building::loose`])
/// lies over a floor of another, within [`crate::ground::STEP`] of it (the botanic red bridge's east end over the tea
/// house's floor, 82 mm below), the step joins the two floors: a [`Kind::Step`] link owned by the first building,
/// its far end the near end carried across the edge, by twice the clearance it was cut with, onto the other floor's
/// patch. Each is returned with the index in `bs` of the building that owns it. A step over open ground, or over
/// nothing a body can stand on, joins nothing.
pub fn floor_joins(bs: &[&Building]) -> Vec<(usize, Link)> {
    let mut out = Vec::new();
    for (i, b) in bs.iter().enumerate() {
        for s in &b.loose {
            if let Some(st) = &s.stair {
                out.extend(stair_join(bs, i, s, st).map(|l| (i, l)));
                continue;
            }
            let d = 2 * (s.radius + MARGIN + 1) * 1000;
            let over = |p: Vec3| {
                Vec3::new(
                    p.x + s.across[0] * d / 1_000_000,
                    p.y,
                    p.z + s.across[1] * d / 1_000_000,
                )
            };
            let (Ok(wa), Ok(wb)) = (b.place.point(over(s.end.a)), b.place.point(over(s.end.b)))
            else {
                continue;
            };
            let found = bs
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i)
                .find_map(|(_, c)| {
                    let (a, bb) = (back(&c.place, wa).ok()?, back(&c.place, wb).ok()?);
                    c.floors.iter().find_map(|(&f, (_, patch))| {
                        // The heights of the floor's pieces within a step of the step's, in that building's frame.
                        let ys: BTreeSet<i32> = patch
                            .pieces
                            .iter()
                            .filter_map(|pc| pc.vertices.first().map(|v| v[1]))
                            .filter(|&y| {
                                (i64::from(y) * 1000 - a.y).abs() <= crate::ground::STEP * 1000
                            })
                            .collect();
                        ys.into_iter().find_map(|y| {
                            let at = |p: Vec3| Vec3::new(p.x, i64::from(y) * 1000, p.z);
                            let e = End {
                                floor: f,
                                a: at(a),
                                b: at(bb),
                            };
                            on_patch(patch, e.middle(), MEET_ON).then_some((e, c.place))
                        })
                    })
                });
            if let Some((far, place)) = found {
                let there = place.point(far.middle()).and_then(|p| back(&b.place, p));
                let Ok(there) = there else {
                    continue;
                };
                out.push((
                    i,
                    Link {
                        id: s.link,
                        kind: Kind::Step,
                        nodes: [s.end.floor, far.floor],
                        owner: s.end.floor,
                        width: s.width,
                        ends: [Some(s.end), Some(far)],
                        line: vec![s.end.middle(), there],
                        door: None,
                        blocked: None,
                    },
                ));
            }
        }
    }
    out
}

/// A flight whose top meets no floor of its own building (`bs[i]`'s loose stair `s`) lands on another building's
/// floor that its top meets at its height, within [`crate::ground::STEP`] (a roof terrace's flight: Eden's office roof
/// stairs, whose landing is too small to stand on and lies over the roof): the top is carried along the flight onto
/// that floor's patch, as onto its own (its apron). The link keeps its kind and its lower end; its upper end is on the
/// other floor, in that building's frame, and its line, in the first building's frame, ends there.
fn stair_join(bs: &[&Building], i: usize, s: &Loose, st: &LooseStair) -> Option<Link> {
    let b = bs[i];
    let ahead = |p: Vec3| Vec3::new(p.x + s.across[0], p.y, p.z + s.across[1]);
    let (wt, wd) = (
        b.place.point(st.top).ok()?,
        b.place.point(ahead(st.top)).ok()?,
    );
    let (far, place) = bs
        .iter()
        .enumerate()
        .filter(|(j, _)| *j != i)
        .find_map(|(_, c)| {
            let (t, d) = (back(&c.place, wt).ok()?, back(&c.place, wd).ok()?);
            let dir = unit(t, d);
            c.floors.iter().find_map(|(&f, (_, patch))| {
                let ys: BTreeSet<i32> = patch
                    .pieces
                    .iter()
                    .filter_map(|pc| pc.vertices.first().map(|v| v[1]))
                    .filter(|&y| (i64::from(y) * 1000 - t.y).abs() <= crate::ground::STEP * 1000)
                    .collect();
                ys.into_iter().find_map(|y| {
                    let q = apron(patch, Vec3::new(t.x, i64::from(y) * 1000, t.z), dir)?;
                    let h = st.half;
                    let e = End {
                        floor: f,
                        a: Vec3::new(
                            q.x - dir[1] * h / 1_000_000,
                            q.y,
                            q.z + dir[0] * h / 1_000_000,
                        ),
                        b: Vec3::new(
                            q.x + dir[1] * h / 1_000_000,
                            q.y,
                            q.z - dir[0] * h / 1_000_000,
                        ),
                    };
                    Some((e, c.place))
                })
            })
        })?;
    let there = back(&b.place, place.point(far.middle()).ok()?).ok()?;
    let mut line = st.line.clone();
    if line.last() != Some(&there) {
        line.push(there);
    }
    Some(Link {
        id: s.link,
        kind: st.kind,
        nodes: [st.from, far.floor],
        owner: st.from,
        width: s.width,
        ends: [Some(s.end), Some(far)],
        line,
        door: None,
        blocked: None,
    })
}

/// A meet of one of the open ground's squares, with that square.
pub type SquareMeet = ((i32, i32), Meet);

/// The open ground a building stands on, as its doorways meet it.
#[derive(Clone, Copy)]
pub struct Open<'a> {
    pub ground: Id,
    /// The building's frame in the ground's frame.
    pub place: Xform,
    /// N3's meets of the open ground's squares, each with its square, in the ground's frame (a doorway's may come
    /// once from each square).
    pub meets: &'a [SquareMeet],
    /// Whether a point (mm, the ground's frame) lies on a piece of a square: N3 gives a side's segment to each piece
    /// its passage overlaps, and only one whose middle lies on its square's ground is an end there.
    pub on: &'a dyn Fn((i32, i32), [i64; 2]) -> bool,
    /// The doors standing on the open ground, by the doorway each stands in ([`ground_doors`]): a building's outer
    /// door may be a thing of the ground, not of the building.
    pub doors: &'a BTreeMap<Id, Id>,
    /// The open ground's terrain (N1b), if any: an end on the open ground stands at its height (#3227), as a body
    /// there does (N11a's mover), though N3's pieces of it are a plan at 0.
    pub terrain: Option<&'a Terrain>,
}

/// An end on the open ground lifted onto its terrain `t`: each of its points at the open ground's height there under
/// something at `y` (µm, the ground's frame; [`Terrain::ground`]).
fn lift(e: End, t: Option<&Terrain>, y: i64) -> End {
    let up = |p: Vec3| Vec3::new(p.x, Terrain::ground(t, p.x, p.z, y), p.z);
    End {
        a: up(e.a),
        b: up(e.b),
        ..e
    }
}

/// The doors that stand on the open ground `ground` (its children), by the doorway link each stands in.
pub fn ground_doors(tree: &Tree, ground: Id) -> Result<BTreeMap<Id, Id>, String> {
    let gh = tree.handle(ground).ok_or("no such ground")?;
    let mut doors = BTreeMap::new();
    for &c in tree.children(gh).ok_or("a node that is gone")? {
        let n = tree.node(c).ok_or("a node that is gone")?;
        if let Some(l) = n.fields().get(&F_OPEN_DOOR_LINK) {
            doors.insert(read_id(l).map_err(|e| e.detail)?, n.id());
        }
    }
    Ok(doors)
}

/// `p` (µm, the ground's frame) in the frame `x` places on the ground: the turn back, after the shift.
pub fn back(x: &Xform, p: Vec3) -> Result<Vec3, String> {
    let [w, i, j, k] = x.rot.parts();
    let inv = Quat::new(w, -i, -j, -k)
        .or_else(|_| Quat::new(-w, i, j, k))
        .map_err(|e| format!("{e:?}"))?;
    let d = p.minus(x.pos).map_err(|e| format!("{e:?}"))?;
    inv.rotate(d).map_err(|e| format!("{e:?}"))
}

/// A square's meet, cut to its part inside that square (a square's meet is the doorway's whole width, measured
/// against that square's pieces only), when that part's middle lies on the square's ground (`on`).
fn own_part(on: &dyn Fn((i32, i32), [i64; 2]) -> bool, (sq, m): &SquareMeet) -> Option<Meet> {
    let (x, z) = (i64::from(sq.0) * SQUARE, i64::from(sq.1) * SQUARE);
    let (a, b) = crate::routes::clip(
        [i64::from(m.a[0]), i64::from(m.a[2])],
        [i64::from(m.b[0]), i64::from(m.b[2])],
        [x, z, x + SQUARE, z + SQUARE],
    )?;
    if !on(*sq, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) {
        return None;
    }
    let p = |v: [i64; 2]| [v[0] as i32, m.a[1], v[1] as i32];
    Some(Meet {
        a: p(a),
        b: p(b),
        ..m.clone()
    })
}

/// One segment for the meets in `ms` (on one line), on `node`'s patch: the longest unbroken stretch of them (meets
/// that touch or overlap, within [`MEET_ON`]), from its two farthest points. A mouth broken by ground of another
/// height (Eden's pond jetty, a deck 200 mm up, between the outer ends of the kerb's two gates, #3187) is never
/// spanned: the end's middle is where a crossing starts or lands, so it must lie on the ground.
fn joined(ms: &[&Meet], node: Id) -> Option<End> {
    let pts: Vec<[i32; 3]> = ms.iter().flat_map(|m| [m.a, m.b]).collect();
    let d2 = |p: [i32; 3], q: [i32; 3]| sq(i64::from(p[0] - q[0])) + sq(i64::from(p[2] - q[2]));
    let mut far: Option<([i32; 3], [i32; 3])> = None;
    for (u, &p) in pts.iter().enumerate() {
        for &q in &pts[u..] {
            if far.is_none_or(|(a, b)| d2(p, q) > d2(a, b)) {
                far = Some((p, q));
            }
        }
    }
    let (o, f) = far?;
    // Each meet as a span along the line from `o` to `f`, in mm (the projection of its ends).
    let (dx, dz) = (i64::from(f[0] - o[0]), i64::from(f[2] - o[2]));
    let len = (sq(dx) + sq(dz)).isqrt().max(1) as i64;
    let along = |p: [i32; 3]| (i64::from(p[0] - o[0]) * dx + i64::from(p[2] - o[2]) * dz) / len;
    let mut spans: Vec<(i64, i64, [i32; 3], [i32; 3])> = ms
        .iter()
        .map(|m| {
            let (s, t) = (along(m.a), along(m.b));
            if s <= t {
                (s, t, m.a, m.b)
            } else {
                (t, s, m.b, m.a)
            }
        })
        .collect();
    spans.sort_by_key(|s| (s.0, s.1));
    // Unbroken stretches, each as (start, end, its first point, its last point); the longest wins, the first on a tie.
    let mut runs: Vec<(i64, i64, [i32; 3], [i32; 3])> = Vec::new();
    for s in spans {
        match runs.last_mut() {
            Some(r) if s.0 <= r.1 + MEET_ON => {
                if s.1 > r.1 {
                    (r.1, r.3) = (s.1, s.3);
                }
            }
            _ => runs.push(s),
        }
    }
    let r = runs.iter().rev().max_by_key(|r| r.1 - r.0).copied()?;
    Some(End {
        floor: node,
        a: um(r.2),
        b: um(r.3),
    })
}

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

fn row(v: &Value) -> &[Value] {
    match v {
        Value::Array(a) => a,
        _ => &[],
    }
}

fn um(p: [i32; 3]) -> Vec3 {
    Vec3::new(
        i64::from(p[0]) * 1000,
        i64::from(p[1]) * 1000,
        i64::from(p[2]) * 1000,
    )
}

fn sq(v: i64) -> i128 {
    i128::from(v) * i128::from(v)
}

/// The squared distance from `p` to the segment `a`–`b` on the ground plane, compared with `tol` (all mm): within?
fn near_segment(p: [i64; 2], a: [i64; 2], b: [i64; 2], tol: i64) -> bool {
    let (ex, ez) = (i128::from(b[0] - a[0]), i128::from(b[1] - a[1]));
    let (px, pz) = (i128::from(p[0] - a[0]), i128::from(p[1] - a[1]));
    let l2 = ex * ex + ez * ez;
    let dot = px * ex + pz * ez;
    let t2 = i128::from(tol) * i128::from(tol);
    if l2 == 0 || dot <= 0 {
        return px * px + pz * pz <= t2;
    }
    if dot >= l2 {
        let (qx, qz) = (i128::from(p[0] - b[0]), i128::from(p[1] - b[1]));
        return qx * qx + qz * qz <= t2;
    }
    let cross = px * ez - pz * ex;
    cross * cross <= t2 * l2
}

/// Whether the point `p` (µm) stands on the patch: inside a triangle of a piece at its height, or within `tol` mm of
/// one (a point the grid put on a piece's edge).
pub fn on_patch(patch: &Patch, p: Vec3, tol: i64) -> bool {
    let (x, y, z) = (
        (p.x + 500 * p.x.signum()) / 1000,
        (p.y + 500 * p.y.signum()) / 1000,
        (p.z + 500 * p.z.signum()) / 1000,
    );
    patch.pieces.iter().any(|pc| {
        pc.vertices.first().is_some_and(|v| i64::from(v[1]) == y)
            && pc.triangles.iter().any(|t| {
                let v = |k: usize| {
                    let w = pc.vertices[t[k] as usize];
                    [i64::from(w[0]), i64::from(w[2])]
                };
                let (a, b, c) = (v(0), v(1), v(2));
                let side = |a: [i64; 2], b: [i64; 2]| {
                    (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0])
                };
                let (s0, s1, s2) = (side(a, b), side(b, c), side(c, a));
                let inside = (s0 >= 0 && s1 >= 0 && s2 >= 0) || (s0 <= 0 && s1 <= 0 && s2 <= 0);
                inside
                    || (tol > 0
                        && [(a, b), (b, c), (c, a)]
                            .iter()
                            .any(|(a, b)| near_segment([x, z], *a, *b, tol)))
            })
    })
}

/// How far a doorway's segment may lie off its patch and still be an end there, mm (the grid's rounding).
const MEET_ON: i64 = 20;

/// How far a stair's end is carried along the floor, at most, to reach its patch (the clearance and then some), mm.
const APRON_MAX: i64 = 1_000;

/// The first point of the patch from `end` (µm) along the unit `dir` (µm per metre, on the ground plane).
fn apron(patch: &Patch, end: Vec3, dir: [i64; 2]) -> Option<Vec3> {
    (0..=APRON_MAX).find_map(|k| {
        let q = Vec3::new(end.x + dir[0] * k / 1000, end.y, end.z + dir[1] * k / 1000);
        on_patch(patch, q, 0).then_some(q)
    })
}

/// The unit (µm per metre) from `a` to `b` on the ground plane.
fn unit(a: Vec3, b: Vec3) -> [i64; 2] {
    let (dx, dz) = (b.x - a.x, b.z - a.z);
    let l = (sq(dx) + sq(dz)).isqrt().max(1) as i64;
    [dx * 1_000_000 / l, dz * 1_000_000 / l]
}

impl Building {
    /// Reads the links of the building `thing` from the tree: its floors' patches (N3), its doorways from where they
    /// meet those patches, its stairs and ladders from its floors' rows, and the doors standing in its doorways.
    pub fn read(tree: &Tree, thing: Id) -> Result<Building, String> {
        Building::read_on(tree, thing, None)
    }

    /// As [`Building::read`], with the open ground it stands on: each doorway to the open ground gets its end there.
    pub fn read_on(tree: &Tree, thing: Id, open: Option<Open>) -> Result<Building, String> {
        Building::read_sized(tree, thing, open, HUMAN_RADIUS)
    }

    /// As [`Building::read_on`], for a body of `radius` mm (B12: one cut per size class).
    pub fn read_sized(
        tree: &Tree,
        thing: Id,
        open: Option<Open>,
        radius: i64,
    ) -> Result<Building, String> {
        let th = tree.handle(thing).ok_or("no such thing")?;
        let mut floors = BTreeMap::new();
        let mut doors: BTreeMap<Id, Id> = BTreeMap::new();
        let mut widths: BTreeMap<Id, i64> = BTreeMap::new();
        let mut acrosses: BTreeMap<Id, [i64; 2]> = BTreeMap::new();
        let mut loose = Vec::new();
        let mut all_floors = Vec::new();
        for &c in tree.children(th).ok_or("a node that is gone")? {
            let n = tree.node(c).ok_or("a node that is gone")?;
            if plain(n.kind().as_str()) == FLOOR {
                all_floors.push(n.id());
                let level = n.fields().get(&F_LEVEL).and_then(int).unwrap_or(0);
                // A floor that does not cut (N3 lists a stair's floor with no surfaces) has no patch: no link's end
                // is on it.
                let Ok(scene) = Scene::of(tree, n.id()) else {
                    continue;
                };
                for d in &scene.doorways {
                    widths.insert(d.link, d.width);
                    acrosses.insert(d.link, d.across);
                }
                if let Ok(patch) = cut_floor(&scene, radius, Turn::NONE) {
                    floors.insert(n.id(), (level, patch));
                }
            } else if let Some(l) = n.fields().get(&F_OPEN_DOOR_LINK) {
                doors.insert(read_id(l).map_err(|e| e.detail)?, n.id());
            }
        }
        let mut links = Vec::new();
        // Doorways: where each meets its floor's patch, on each side.
        let mut seen = std::collections::BTreeSet::new();
        for (&floor, (_, patch)) in &floors {
            let mut by_link: BTreeMap<Id, Vec<&Meet>> = BTreeMap::new();
            for m in &patch.meets {
                by_link.entry(m.link).or_default().push(m);
            }
            for (id, ms) in by_link {
                if !seen.insert(id) {
                    continue;
                }
                // A step (N3's steps) is no link of the tree: it joins its floor to the open ground, owned by the floor.
                // Read alone it joins nothing, so it is not a link.
                let step = ms.iter().any(|m| m.step);
                // A step between two of this floor's surfaces (N3's inner steps) meets the floor on both sides, at two
                // heights: it joins the floor to itself, read alone or with the ground.
                let inner = step
                    && ms.iter().any(|m| m.side < 0)
                    && ms.iter().any(|m| m.side > 0)
                    && ms.iter().any(|m| m.a[1] != ms[0].a[1]);
                let (kind, nodes, owner) = match open {
                    _ if inner => (Kind::Step, [floor, floor], floor),
                    Some(o) if step => (Kind::Step, [floor, o.ground], floor),
                    None if step => continue,
                    _ => {
                        let (ty, nodes, owning, _) =
                            tree.link(id).ok_or("a doorway that is gone")?;
                        let kind = Kind::of(ty.as_str()).unwrap_or(Kind::Doorway);
                        let owner = nodes[usize::from(owning == replica::world_model::End::Second)];
                        (kind, nodes, owner)
                    }
                };
                // N3 gives a side's segment to every piece its passage overlaps; the end is one whose middle lies on
                // the patch (within the grid's rounding), else the first.
                let side = |s: i8| {
                    let end = |m: &&Meet| End {
                        floor,
                        a: um(m.a),
                        b: um(m.b),
                    };
                    let of = || ms.iter().filter(|m| m.side == s);
                    of().find(|m| on_patch(patch, end(m).middle(), MEET_ON))
                        .or_else(|| of().next())
                        .map(end)
                };
                let mut ends = [side(-1), side(1)];
                // An inner step's ends lie on its pieces' edges, within the grid's rounding (a deck along a slant): each
                // is carried onto its piece, away from the other end, as a stair's is (its apron), so a body that
                // crosses it stands on the far piece.
                if inner && let [Some(e0), Some(e1)] = ends {
                    for (k, (e, o)) in [(e0, e1), (e1, e0)].into_iter().enumerate() {
                        let (m, to) = (e.middle(), o.middle());
                        if let Some(q) = apron(patch, m, unit(to, m)) {
                            let shift = |p: Vec3| Vec3::new(p.x + q.x - m.x, p.y, p.z + q.z - m.z);
                            ends[k] = Some(End {
                                floor,
                                a: shift(e.a),
                                b: shift(e.b),
                            });
                        }
                    }
                }
                let mut width_left = ms.iter().map(|m| m.width_left).max().unwrap_or(0);
                // N3 cuts a floor's heights one at a time, so an inner step's two sides come from two cuts, neither of
                // which sees the other side: met on both, it goes through, as a step to the ground does below.
                let mut through = inner || ms.iter().all(|m| m.through);
                // A doorway to the open ground: its other end is where its passage meets the ground's squares. Each
                // patch holds one end, so there is no one passage through a patch to ask for.
                let to_ground = open.filter(|o| nodes.contains(&o.ground));
                if let Some(o) = to_ground
                    && let Some(k) = (0..2).find(|&k| ends[k].is_none())
                {
                    let s = if k == 0 { -1 } else { 1 };
                    let gm: Vec<Meet> = o
                        .meets
                        .iter()
                        .filter(|(_, m)| m.link == id && m.side == s)
                        .filter_map(|sm| own_part(o.on, sm))
                        .collect();
                    if let Some(e) = joined(&gm.iter().collect::<Vec<_>>(), o.ground) {
                        // At the height of the open ground beside the floor's end, in the ground's frame.
                        let y = ends[1 - k]
                            .and_then(|f| o.place.point(f.middle()).ok())
                            .map_or(0, |p| p.y);
                        ends[k] = Some(lift(e, o.terrain, y));
                        width_left = gm.iter().map(|m| m.width_left).fold(width_left, i64::min);
                        through = true;
                    }
                }
                let blocked = if ends.iter().any(Option::is_none) {
                    Some("link-end-off-ground")
                } else if width_left <= 0 || !through {
                    Some("link-too-narrow")
                } else {
                    None
                };
                let local = |e: End| match to_ground {
                    Some(o) if e.floor == o.ground => back(&o.place, e.middle()),
                    _ => Ok(e.middle()),
                };
                // A step that cannot be crossed is an edge with nothing to step down to (a wall, a rail, water): no
                // link at all.
                let ground = to_ground.map(|o| o.ground);
                if step
                    && (blocked.is_some()
                        || (!inner && ends[1].is_none_or(|e| Some(e.floor) != ground)))
                {
                    // Met on the floor and nothing beyond: another thing's floor may lie there (#3227).
                    if let (Some(e), None, Some(_), false) = (ends[0], ends[1], ground, inner) {
                        loose.push(Loose {
                            link: id,
                            end: e,
                            across: acrosses.get(&id).copied().unwrap_or([0, 0]),
                            width: widths.get(&id).copied().unwrap_or(0),
                            radius,
                            stair: None,
                        });
                    }
                    continue;
                }
                let line = match (blocked, ends) {
                    (None, [Some(a), Some(b)]) => vec![local(a)?, local(b)?],
                    _ => Vec::new(),
                };
                let width = widths.get(&id).copied().unwrap_or(0);
                links.push(Link {
                    id,
                    kind,
                    nodes,
                    owner,
                    width,
                    ends,
                    line,
                    door: doors
                        .get(&id)
                        .or_else(|| to_ground.and_then(|o| o.doors.get(&id)))
                        .copied(),
                    blocked,
                });
            }
        }
        // Stairs, ramps and ladders: each floor's rows, owned by the lower floor.
        for &floor in &all_floors {
            let n = tree
                .node(tree.handle(floor).ok_or("a floor that is gone")?)
                .ok_or("a floor that is gone")?;
            for r in n.fields().get(&F_STAIRS).map(row).unwrap_or(&[]) {
                let r = row(r);
                let id = r
                    .first()
                    .map(read_id)
                    .transpose()
                    .map_err(|e| e.detail)?
                    .ok_or("a stair row's link")?;
                let (ty, nodes, owning, _) = tree.link(id).ok_or("a stair that is gone")?;
                let owner = nodes[usize::from(owning == replica::world_model::End::Second)];
                let kind = Kind::of(ty.as_str()).ok_or("a stair of no known kind")?;
                let n = |k: usize| r.get(k).and_then(int).ok_or("a stair row");
                let (width, y0, y1) = (n(3)? * 1000, n(4)? * 1000, n(5)? * 1000);
                let pts: Vec<[i64; 2]> = r
                    .get(6)
                    .map(row)
                    .unwrap_or(&[])
                    .iter()
                    .map(|p| match row(p) {
                        [x, z, ..] => Ok([
                            int(x).ok_or("a point")? * 1000,
                            int(z).ok_or("a point")? * 1000,
                        ]),
                        _ => Err("a point is [x, z]"),
                    })
                    .collect::<Result<_, _>>()?;
                if pts.len() < 2 {
                    return Err("a stair path of fewer than two points".into());
                }
                // Rising evenly along its run: each point's height by the run walked to it.
                let mut run = vec![0i64];
                for w in pts.windows(2) {
                    let l = (sq(w[1][0] - w[0][0]) + sq(w[1][1] - w[0][1])).isqrt() as i64;
                    run.push(run[run.len() - 1] + l);
                }
                let total = run[run.len() - 1].max(1);
                let mut line: Vec<Vec3> = pts
                    .iter()
                    .zip(&run)
                    .map(|(p, d)| {
                        let y = y0
                            + ((i128::from(y1 - y0) * i128::from(*d)) / i128::from(total)) as i64;
                        Vec3::new(p[0], y, p[1])
                    })
                    .collect();
                let k = line.len();
                let patch = |f: Id| floors.get(&f).map(|(_, p)| p);
                let lo = patch(nodes[0]).map(|p| apron(p, line[0], unit(line[1], line[0])));
                let hi =
                    patch(nodes[1]).map(|p| apron(p, line[k - 1], unit(line[k - 2], line[k - 1])));
                let half = (width / 2 - (radius + MARGIN) * 1000).max(0);
                let end = |f: Id, at: Vec3, d: [i64; 2]| End {
                    floor: f,
                    a: Vec3::new(
                        at.x - d[1] * half / 1_000_000,
                        at.y,
                        at.z + d[0] * half / 1_000_000,
                    ),
                    b: Vec3::new(
                        at.x + d[1] * half / 1_000_000,
                        at.y,
                        at.z - d[0] * half / 1_000_000,
                    ),
                };
                // A flight whose lower floor has no surface to stand on (a raised building's outside stair, its foot on
                // the open ground: the Mars campus's kitchen) starts on the open ground beside the building, at the
                // ground's height there, as a doorway to the open ground ends there.
                let foot = open.filter(|_| lo.is_none());
                let (db, top) = (unit(line[k - 2], line[k - 1]), line[k - 1]);
                let lower = match (lo.flatten(), foot) {
                    (Some(a), _) => {
                        let da = unit(line[0], line[1]);
                        if a != line[0] {
                            line.insert(0, a);
                        }
                        Some(end(nodes[0], a, da))
                    }
                    (None, Some(o)) => {
                        let up = unit(line[0], line[1]);
                        // Carried out along the flight onto the open ground (past its own solids, grown by the
                        // clearance: Eden's flights stand on a box as long as they are), as its top onto its floor.
                        let out = unit(line[1], line[0]);
                        let on_ground = |q: Vec3| {
                            o.place.point(q).is_ok_and(|w| {
                                let (x, z) = (w.x.div_euclid(1000), w.z.div_euclid(1000));
                                let sq = (x.div_euclid(SQUARE) as i32, z.div_euclid(SQUARE) as i32);
                                (o.on)(sq, [x, z])
                            })
                        };
                        // A square's piece is met within the map's rounding (60 mm): the foot is taken 100 mm past
                        // the first point met, on the piece itself.
                        let along = |d: i64| {
                            Vec3::new(
                                line[0].x + out[0] * d / 1000,
                                line[0].y,
                                line[0].z + out[1] * d / 1000,
                            )
                        };
                        let foot = (0..=APRON_MAX / 10)
                            .map(|k| k * 10)
                            .find(|&d| on_ground(along(d)))
                            .map_or(line[0], |d| if d == 0 { line[0] } else { along(d + 100) });
                        if foot != line[0] {
                            line.insert(0, foot);
                        }
                        let e = end(nodes[0], foot, up);
                        let on = End {
                            floor: o.ground,
                            a: o.place.point(e.a)?,
                            b: o.place.point(e.b)?,
                        };
                        let y = on.middle().y;
                        Some(lift(on, o.terrain, y))
                    }
                    (None, None) => None,
                };
                let (ends, blocked) = match (lower, hi.flatten()) {
                    (Some(a), Some(b)) => {
                        if b != top {
                            line.push(b);
                        }
                        ([Some(a), Some(end(nodes[1], b, db))], None)
                    }
                    // A flight whose top meets nothing of its own floor (a landing too small to stand on) may land on
                    // another thing's floor at its height (the roof it leads to): kept loose for [`floor_joins`].
                    (Some(a), None) => {
                        loose.push(Loose {
                            link: id,
                            end: a,
                            across: db,
                            width,
                            radius,
                            stair: Some(LooseStair {
                                kind,
                                from: nodes[0],
                                line: std::mem::take(&mut line),
                                top,
                                half,
                            }),
                        });
                        ([None, None], Some("link-end-off-ground"))
                    }
                    _ => {
                        line.clear();
                        ([None, None], Some("link-end-off-ground"))
                    }
                };
                links.push(Link {
                    id,
                    kind,
                    nodes,
                    owner,
                    width,
                    ends,
                    line,
                    door: None,
                    blocked,
                });
            }
        }
        Ok(Building {
            thing,
            links,
            floors,
            place: open.map_or(Xform::IDENTITY, |o| o.place),
            loose,
        })
    }

    /// Adds a link [`floor_joins`] found, in place of the one of the same id read alone (a flight's loose top).
    pub fn join(&mut self, l: Link) {
        match self.links.iter_mut().find(|x| x.id == l.id) {
            Some(x) => *x = l,
            None => self.links.push(l),
        }
    }

    pub fn link(&self, id: Id) -> Option<&Link> {
        self.links.iter().find(|l| l.id == id)
    }

    /// The open ground's own links: each doorway it meets that no building in `known` holds (a gate in a wall or a
    /// fence, both ends on the ground; or a room's doorway its floor never meets, with one end), in the ground's
    /// frame. A gate's passage must be one piece where one square holds both its ends (N3's `through`).
    pub fn of_ground(tree: &Tree, open: Open, known: &BTreeSet<Id>) -> Result<Building, String> {
        let mut by_link: BTreeMap<Id, Vec<&SquareMeet>> = BTreeMap::new();
        for sm in open.meets {
            // A step is a building's floor's, never the ground's own.
            if !sm.1.step && !known.contains(&sm.1.link) {
                by_link.entry(sm.1.link).or_default().push(sm);
            }
        }
        // Each gate's width, and its height (in the ground's frame: its ends stand on the ground there).
        let widths: BTreeMap<Id, (i64, i64)> = if by_link.is_empty() {
            BTreeMap::new()
        } else {
            Scene::of(tree, open.ground)?
                .doorways
                .iter()
                .map(|d| (d.link, (d.width, d.y)))
                .collect()
        };
        let mut links = Vec::new();
        for (id, ms) in by_link {
            let (ty, nodes, owning, _) = tree.link(id).ok_or("a doorway that is gone")?;
            let owner = nodes[usize::from(owning == replica::world_model::End::Second)];
            let side = |s: i8| {
                let of: Vec<Meet> = ms
                    .iter()
                    .filter(|sm| sm.1.side == s)
                    .filter_map(|sm| own_part(open.on, sm))
                    .collect();
                let y = widths.get(&id).map_or(0, |w| w.1);
                joined(&of.iter().collect::<Vec<_>>(), open.ground)
                    .map(|e| lift(e, open.terrain, y))
            };
            let ends = [side(-1), side(1)];
            let both = |sq: (i32, i32)| {
                ms.iter()
                    .filter(|o| o.0 == sq)
                    .map(|o| o.1.side)
                    .collect::<BTreeSet<_>>()
                    .len()
                    == 2
            };
            let blocked = if ends.iter().any(Option::is_none) {
                Some("link-end-off-ground")
            } else if ms
                .iter()
                .any(|(sq, m)| m.width_left <= 0 || (both(*sq) && !m.through))
            {
                Some("link-too-narrow")
            } else {
                None
            };
            let line = match (blocked, ends) {
                (None, [Some(a), Some(b)]) => vec![a.middle(), b.middle()],
                _ => Vec::new(),
            };
            links.push(Link {
                id,
                kind: Kind::of(ty.as_str()).unwrap_or(Kind::Doorway),
                nodes,
                owner,
                width: widths.get(&id).map_or(0, |w| w.0),
                ends,
                line,
                door: open.doors.get(&id).copied(),
                blocked,
            });
        }
        Ok(Building {
            thing: open.ground,
            links,
            floors: BTreeMap::new(),
            place: Xform::IDENTITY,
            loose: Vec::new(),
        })
    }
}

/// A door's writer: the asks to open made in one tick, written together as one opening per door.
pub struct Doors {
    pub header: Header,
    pub rules: Rules,
    /// The zone's next sequence.
    pub next: u64,
    /// Every effect written, in order: the stream.
    pub stream: Vec<Effect>,
    asks: BTreeMap<Id, (Id, Cause, Actor)>,
}

impl Doors {
    pub fn new(header: Header, rules: Rules, next: u64) -> Doors {
        Doors {
            header,
            rules,
            next,
            stream: Vec::new(),
            asks: BTreeMap::new(),
        }
    }

    /// Asks that `door` (standing in `link`) be opened, by `actor` for the order `cause`.
    pub fn ask(&mut self, door: Id, link: Id, cause: Cause, actor: Actor) {
        self.asks.entry(door).or_insert((link, cause, actor));
    }

    /// Writes the tick's openings at world time `at`: one effect per door still shut, committed to the tree.
    pub fn flush(&mut self, tree: &mut Tree, at: i64) -> Result<(), Refusal> {
        for (door, (link, cause, actor)) in std::mem::take(&mut self.asks) {
            let n = tree
                .node(tree.handle(door).ok_or_else(|| gone(door))?)
                .ok_or_else(|| gone(door))?;
            if n.fields().get(&F_OPEN) == Some(&Value::Uint(1)) {
                continue;
            }
            let audience = n.audience();
            let effect = Effect {
                envelope: Envelope {
                    sequence: self.next,
                    at,
                    cause,
                    actor,
                    audience,
                    node: door,
                },
                body: Body::Changes(vec![ChangeRec {
                    change: Change::Set {
                        node: door,
                        field: F_OPEN,
                        to: Value::Uint(1),
                        by: None,
                    },
                    rest: Rest::new(),
                }]),
                events: Some(vec![Event {
                    name: Name::new(opened_event(n.kind().as_str())).expect("a name"),
                    fields: BTreeMap::from([(1, link.to_value())]),
                    changes: vec![0],
                    rest: Rest::new(),
                }]),
                rest: Rest::new(),
            };
            let bytes = encode(&Value::Map(BTreeMap::from([
                (1, Value::Bytes(self.header.hash().to_bytes())),
                (2, Value::Array(vec![effect.to_value()])),
            ])))
            .map_err(|e| refusal("encoding", e.to_string()))?;
            tree.commit(&self.header, &Part::read(&bytes)?, &self.rules)?;
            self.next += 1;
            self.stream.push(effect);
        }
        Ok(())
    }
}

fn gone(id: Id) -> Refusal {
    Refusal {
        name: "node-missing",
        detail: replica::world_model::show(id),
    }
}

fn refusal(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}
