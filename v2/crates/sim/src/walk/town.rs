//! The world's side of walking over the engine as it stands: N5's map for routes and lines, N6's surfaces, N4's links
//! and door writer for crossings, all read from K2's tree. It answers the walk skill's questions ([`View`]) and gives
//! the controller its tracks ([`Links`]); it never moves a body.
//!
//! - **Legs.** The route (N5, a body with hands) from where the body stands to the goal; each link it crosses is a
//!   leg's end, at the link's near end on the node the body stands on (N4, read with the open ground: a doorway
//!   between a building and the open ground has one end on each).
//! - **The next corner.** The leg's end when a straight walk on the body's surface reaches it (N6's walk, on a copy of
//!   the body), else the second point of the first line of the route from where it stands to the leg's end.
//! - **A crossing.** At the near end: a shut door is asked to open and the opening written at the end of that tick
//!   (N4's writer, the world as the cause and the walker as the Soul), and the body stands. Then the controller
//!   carries it along the
//!   link's line at its speed, never a longer step than speed times the tick, and stands on the far floor's surface
//!   at the line's end. The line is followed in the frame of the node the body stands on: a body coming in from the
//!   open ground follows it placed on the ground by the building's frame, and stands at the far end on the floor; a
//!   body going out follows it in the building's frame and stands at the far end on the open ground.
//! - **Turns** (N8). A link under 1.2 m wide is taken in turns (`crate::links::turns`): at the start of each tick
//!   the marks of the last are read into each such link's facts (who waits at which end and how far from it, who is
//!   inside and how far along, whether each end has room to step out into), and its owning node writes who may
//!   enter. Who is inside is every body the controller carries across the link, from the end it went in by and the
//!   point it began at (recorded when the world gives its track). Without turns ([`Town::turns`] `None`) every link
//!   is free, as N7 walked them.
//! - **Standing spots** (N9, `crate::spots`). The marks of the last tick that ask a spot are read into the tables of
//!   their targets' nodes. A place is never in a doorway or on a stair: none within `spots::CLEAR` of a link's end on
//!   the target's node, or within half the link's width and half that of its line (placed on the open ground by its
//!   building's frame).

use super::{Leg, Mark, World, node_of};
use crate::controller::{Controller, Track};
use crate::ground::scene::FLOOR;
use crate::ground::{HUMAN_RADIUS, OpenGround, Scene, exits};
use crate::host::Links;
use crate::links::turns::{Facts, ROOM, Turns, narrow};
use crate::links::{Building, Doors, F_OPEN, Open, back, ground_doors};
use crate::mover::{Body, Surface};
use crate::routes::{HANDS, Hop, Map};
use crate::spots::{Ask, CLEAR, Ground, Spots, Target, flat, to_segment};
use replica::effects::{Actor, Cause, Refusal};
use replica::encode::Value;
use replica::host::{F_GRANTED, F_TURNS, Seen};
use replica::ids::Id;
use replica::pose::{ControllerInput, Frame, Mode, Quat, Vec3};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::{plain, show};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

fn refusal(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

/// How far a leg's end may lie off the ground and still be aimed at, mm: a link's end on its piece's edge.
const AT_EDGE: i64 = 20;
/// How far a crossing's landing may be moved onto the far surface, µm: less than a body's radius (#3168).
const LAND: i64 = HUMAN_RADIUS * 1000;
/// How far from a link's near end a crossing may be asked, µm (the walk asks within 50 mm of it, #3168).
const REACH: i64 = 1_000_000;

/// The squared distance across the ground (x and z), µm².
fn flat2(a: Vec3, b: Vec3) -> i128 {
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    d(a.x, b.x) + d(a.z, b.z)
}

/// A crossing the controller carries: the end it went in by, and where the body stood when it began.
struct Crossing {
    from: u8,
    start: Vec3,
}

/// The engine as the walk skill reads it.
pub struct Town {
    pub tree: Tree,
    pub ground: Id,
    pub map: Map,
    /// Each node's surface for the mover: the open ground (every square), and every floor that cuts.
    pub surfaces: BTreeMap<Id, Surface>,
    pub buildings: Vec<Building>,
    pub doors: Doors,
    /// The turn states of the narrow links, written by their owners; `None` walks every link free.
    pub turns: Option<Turns>,
    /// The standing spots' tables, by owning node (N9).
    pub spots: Spots,
    crossings: BTreeMap<Id, Crossing>,
}

impl Town {
    /// Everything on the open ground `ground`; openings are written by `doors`.
    pub fn new(tree: Tree, ground: Id, doors: Doors) -> Result<Town, String> {
        let map = Map::build(&tree, ground, &|_| 0)?;
        let mut surfaces = BTreeMap::new();
        let open = OpenGround::prepare(&Scene::of(&tree, ground)?, HUMAN_RADIUS)?;
        let (mut pieces, mut meets) = (Vec::new(), Vec::new());
        for (i, j) in open.squares() {
            let p = open.cut_square(i, j);
            pieces.extend(p.pieces);
            meets.extend(p.meets.into_iter().map(|m| ((i, j), m)));
        }
        let gh = tree.handle(ground).ok_or("no such ground")?;
        let gdoors = ground_doors(&tree, ground)?;
        surfaces.insert(ground, Surface::new(ground, pieces));
        let mut buildings = Vec::new();
        let mut stack = vec![gh];
        while let Some(h) = stack.pop() {
            let kids = tree.children(h).ok_or("a node that is gone")?;
            if kids.iter().any(|&c| {
                tree.node(c)
                    .is_some_and(|n| plain(n.kind().as_str()) == FLOOR)
            }) {
                let id = tree.node(h).ok_or("a node that is gone")?.id();
                let on = |sq: (i32, i32), p: [i64; 2]| map.on_square(ground, sq, p);
                let open = Open {
                    ground,
                    place: crate::ground::scene::xform_to(&tree, h, gh)?,
                    meets: &meets,
                    on: &on,
                    doors: &gdoors,
                };
                if let Ok(b) = Building::read_on(&tree, id, Some(open)) {
                    for (&floor, (_, patch)) in &b.floors {
                        surfaces.insert(floor, Surface::new(floor, patch.pieces.clone()));
                    }
                    buildings.push(b);
                }
            }
            stack.extend(kids.iter().rev().copied());
        }
        // The open ground's own links: gates in walls and fences.
        let known = buildings
            .iter()
            .flat_map(|b| b.links.iter().map(|l| l.id))
            .collect();
        let on = |sq: (i32, i32), p: [i64; 2]| map.on_square(ground, sq, p);
        let open = Open {
            ground,
            place: crate::ground::scene::Xform::IDENTITY,
            meets: &meets,
            on: &on,
            doors: &gdoors,
        };
        buildings.push(Building::of_ground(&tree, open, &known)?);
        Ok(Town {
            tree,
            ground,
            map,
            surfaces,
            buildings,
            doors,
            turns: Some(Turns::new()),
            spots: Spots::new(),
            crossings: BTreeMap::new(),
        })
    }

    fn link(&self, id: Id) -> Option<&crate::links::Link> {
        self.building(id).and_then(|b| b.link(id))
    }

    fn building(&self, link: Id) -> Option<&Building> {
        self.buildings.iter().find(|b| b.link(link).is_some())
    }

    /// The town as the host's questions read it in a tick: the map behind a cell (a route is cached as it is
    /// found), the rest shared.
    pub fn view(&mut self) -> View<'_> {
        View {
            tree: &self.tree,
            map: RefCell::new(&mut self.map),
            surfaces: &self.surfaces,
            buildings: &self.buildings,
            turns: self.turns.as_ref(),
        }
    }
}

/// The town as the walk skill's questions read it ([`Town::view`]).
pub struct View<'a> {
    pub tree: &'a Tree,
    map: RefCell<&'a mut Map>,
    surfaces: &'a BTreeMap<Id, Surface>,
    buildings: &'a [Building],
    turns: Option<&'a Turns>,
}

fn walk(v: [i64; 2]) -> ControllerInput {
    ControllerInput {
        velocity: Vec3::new(v[0], 0, v[1]),
        mode: Mode::Surface,
    }
}

fn dist2(a: Vec3, b: Vec3) -> i128 {
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    d(a.x, b.x) + d(a.y, b.y) + d(a.z, b.z)
}

/// Whether `p` (µm, the frame of `node`) lies in a doorway or on a stair: within [`CLEAR`] of the end on `node` of a
/// link, or within half the link's width and half [`CLEAR`] of its line.
fn in_passage(buildings: &[Building], ground: Id, node: Id, p: Vec3) -> bool {
    buildings.iter().any(|b| {
        b.links.iter().any(|l| {
            let ends = l.ends.iter().flatten().filter(|e| e.floor == node);
            let mut on = false;
            for e in ends {
                on = true;
                if to_segment(p, e.a, e.b) < CLEAR {
                    return true;
                }
            }
            on && l.line.windows(2).any(|s| {
                let (a, c) = if node == ground {
                    (
                        b.place.point(s[0]).unwrap_or(s[0]),
                        b.place.point(s[1]).unwrap_or(s[1]),
                    )
                } else {
                    (s[0], s[1])
                };
                to_segment(p, a, c) < l.width / 2 + CLEAR / 2
            })
        })
    })
}

/// The town as the spot tables read it (N9): N5's map for walkable ground and routes, N6's surfaces for a straight
/// walk, N4's links for doorways and stairs.
struct Grounds<'a> {
    tree: &'a Tree,
    map: &'a mut Map,
    surfaces: &'a BTreeMap<Id, Surface>,
    buildings: &'a [Building],
    ground: Id,
}

impl Ground for Grounds<'_> {
    fn stand(&self, node: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
        let s = self.map.spot(node, p)?;
        let w = self.map.world(s.piece, s.at);
        let um = |v: [i64; 3]| Vec3::new(v[0] * 1000, v[1] * 1000, v[2] * 1000);
        Some((um(s.at), um(w)))
    }

    fn passage(&self, node: Id, p: Vec3) -> bool {
        in_passage(self.buildings, self.ground, node, p)
    }

    fn walk(&mut self, an: Id, a: Vec3, bn: Id, b: Vec3) -> Option<i64> {
        // A straight walk on the surface (N6's walk, as the next corner is found), else N5's route.
        if an == bn
            && let Some(s) = self.surfaces.get(&an)
            && let Ok(mut body) = s.place(
                an,
                Frame {
                    node: an,
                    slot: None,
                },
                a,
                Quat::IDENTITY,
            )
            && s.step(&mut body, walk([b.x - a.x, b.z - a.z]), 1_000_000, 0)
                .is_ok()
            && [body.pose.position.x, body.pose.position.z] == [b.x, b.z]
        {
            return Some(flat(a, b));
        }
        let from = self.map.spot_near(an, a, AT_EDGE)?;
        let to = self.map.spot_near(bn, b, AT_EDGE)?;
        let r = self.map.route(self.tree, from, to, HANDS).ok()?;
        Some(r.length as i64 * 1000)
    }
}

impl World for Town {
    fn spots(&mut self, marks: &[Mark], at: Micros) -> Result<(), Refusal> {
        let asks: Vec<Ask> = marks
            .iter()
            .filter_map(|m| {
                m.spot.map(|(target, order)| Ask {
                    who: m.who,
                    order,
                    node: m.node,
                    from: m.at,
                    target,
                })
            })
            .collect();
        let Town {
            spots,
            map,
            tree,
            buildings,
            ground,
            surfaces,
            ..
        } = self;
        let mut g = Grounds {
            tree,
            map,
            surfaces,
            buildings,
            ground: *ground,
        };
        spots.write(&mut g, &asks, at)
    }

    fn spot(&self, who: Id, target: &Target) -> Option<Result<Vec3, &'static str>> {
        self.spots.of(who, target)
    }

    fn turns(&mut self, marks: &[Mark], at: Micros) -> Result<(), Refusal> {
        let Town {
            turns,
            buildings,
            crossings,
            ..
        } = self;
        // A crossing ends when the controller no longer carries the body.
        let carried: BTreeSet<Id> = marks
            .iter()
            .filter(|m| m.crossing.is_some())
            .map(|m| m.who)
            .collect();
        crossings.retain(|who, _| carried.contains(who));
        let Some(turns) = turns.as_mut() else {
            return Ok(());
        };
        // The links waited for, crossed, or with a state already.
        let mut ids: BTreeSet<Id> = marks
            .iter()
            .flat_map(|m| [m.waiting.map(|w| w.0), m.crossing])
            .flatten()
            .collect();
        ids.extend(turns.owners.values().flat_map(|m| m.keys().copied()));
        for id in ids {
            let Some(l) = buildings.iter().find_map(|b| b.link(id)) else {
                continue;
            };
            if !narrow(l) {
                continue;
            }
            let mut f = Facts::default();
            for m in marks {
                if let Some((w, gap)) = m.waiting
                    && w == id
                    && let Some(k) = (0..2)
                        .filter(|&k| l.ends[k].is_some_and(|e| e.floor == m.node))
                        .min_by_key(|&k| l.ends[k].map_or(i128::MAX, |e| dist2(m.at, e.middle())))
                {
                    f.waiting[k].push((gap, m.who));
                }
                if m.crossing == Some(id)
                    && let Some(c) = crossings.get(&m.who)
                {
                    f.inside
                        .push((c.from, dist2(c.start, m.at).isqrt() as i64, m.who));
                }
            }
            for (k, e) in l.ends.iter().enumerate() {
                f.room[k] = e.is_some_and(|e| {
                    !marks.iter().any(|m| {
                        m.node == e.floor
                            && m.crossing.is_none()
                            && !m.staying
                            && m.waiting.map(|w| w.0) != Some(id)
                            && dist2(m.at, e.middle()) < i128::from(ROOM) * i128::from(ROOM)
                    })
                });
            }
            turns.write(l.owner, l, &f, at)?;
        }
        Ok(())
    }

    fn plan(&mut self, body: &Body, node: Id, goal: Vec3) -> Result<Vec<Leg>, Refusal> {
        let here = node_of(body);
        let from = self
            .map
            .spot_near(here, body.pose.position, AT_EDGE)
            .ok_or_else(|| refusal("off-ground", show(here)))?;
        let to = self
            .map
            .spot(node, goal)
            .ok_or_else(|| refusal("off-ground", show(node)))?;
        let route = self.map.route(&self.tree, from, to, HANDS)?;
        let (mut legs, mut on, mut at) = (Vec::new(), here, body.pose.position);
        for h in &route.hops {
            let Hop::Link { id, .. } = h else { continue };
            let l = self
                .link(*id)
                .ok_or_else(|| refusal("link-not-walked", show(*id)))?;
            let near = (0..2)
                .filter(|&k| l.ends[k].is_some_and(|e| e.floor == on))
                .min_by_key(|&k| l.ends[k].map_or(i128::MAX, |e| dist2(at, e.middle())))
                .ok_or_else(|| refusal("link-not-walked", show(*id)))?;
            let (a, b) = (l.ends[near], l.ends[1 - near]);
            let (Some(a), Some(b)) = (a, b) else {
                return Err(refusal("link-not-walked", show(*id)));
            };
            legs.push(Leg {
                to: a.middle(),
                link: Some(*id),
            });
            (on, at) = (b.floor, b.middle());
        }
        legs.push(Leg {
            to: goal,
            link: None,
        });
        Ok(legs)
    }
}

impl View<'_> {
    /// Whether a straight walk on the body's surface from where it stands reaches `to` (x and z, µm).
    fn clear(&self, body: &Body, to: [i64; 2]) -> Result<bool, Refusal> {
        let node = node_of(body);
        let s = self
            .surfaces
            .get(&node)
            .ok_or_else(|| refusal("no-surface", show(node)))?;
        let p = body.pose.position;
        // In one second, at the velocity that is the whole way: the controller's dry run, moving nothing.
        let b = Controller::probe(s, body, walk([to[0] - p.x, to[1] - p.z]), 1_000_000, 0)?;
        Ok([b.pose.position.x, b.pose.position.z] == to)
    }

    /// Where `body` aims next on its way to `to` (on the node it stands on), x and z µm: `to` when a straight walk
    /// reaches it, else the next corner of the line there.
    pub fn corner(&self, body: &Body, to: Vec3) -> Result<[i64; 2], Refusal> {
        if self.clear(body, [to.x, to.z])? {
            return Ok([to.x, to.z]);
        }
        let node = node_of(body);
        let mut map = self.map.borrow_mut();
        let (Some(from), Some(goal)) = (
            map.spot_near(node, body.pose.position, AT_EDGE),
            // A link's near end lies on its piece's edge, within the grid's rounding.
            map.spot_near(node, to, AT_EDGE),
        ) else {
            return Err(refusal("off-ground", show(node)));
        };
        let r = map.route(self.tree, from, goal, HANDS)?;
        // The first point of the line that is not where the body stands (the funnel may repeat a point).
        let c = r
            .first_line
            .iter()
            .skip(1)
            .find(|&&c| c != [from.at[0], from.at[2]])
            .copied()
            .unwrap_or([goal.at[0], goal.at[2]]);
        Ok([c[0] * 1000, c[1] * 1000])
    }

    /// A link taken in turns as the walk reads it ([`Town::read_link`]).
    pub fn read_link(&self, link: Id) -> Option<Seen> {
        link_seen(self.turns, self.buildings, self.tree, link)
    }
}

impl Town {
    /// The track across `link` for `body` from where it stands, at `speed`, and the end it goes in by. A shut door
    /// in the link is asked open and the opening written at once (`cause`, the body as the acting Soul), and there is
    /// no track yet: the body stands this tick and asks again the next (T1).
    fn track_of(
        &mut self,
        body: &Body,
        link: Id,
        cause: Cause,
        speed: i64,
        at: Micros,
    ) -> Result<(u8, Option<Track>), Refusal> {
        let l = self
            .link(link)
            .ok_or_else(|| refusal("link-missing", show(link)))?;
        if let Some(why) = l.blocked {
            return Err(refusal(why, show(link)));
        }
        let here = node_of(body);
        let p = body.pose.position;
        let near = (0..2)
            .filter(|&k| l.ends[k].is_some_and(|e| e.floor == here))
            .min_by_key(|&k| l.ends[k].map_or(i128::MAX, |e| dist2(p, e.middle())))
            .ok_or_else(|| refusal("link-not-here", show(link)))?;
        let far = l.ends[1 - near];
        let to = far.map_or(here, |e| e.floor);
        let mut line = l.line.clone();
        if near == 1 {
            line.reverse();
        }
        let door = l.door;
        // The line is in the building's frame; on the open ground it is followed placed there. Between frames it
        // ends where the body stands on the far side: the far end's middle, on its piece (it may lie on the
        // piece's edge, within the grid's rounding). Every landing is one the far surface's mover holds
        // ([`Town::landing`]), or the crossing is refused before the body moves.
        let mut arrive = None;
        if here == self.ground || to == self.ground {
            let place = self
                .building(link)
                .map(|b| b.place)
                .ok_or_else(|| refusal("link-missing", show(link)))?;
            let out = |e: String| refusal("out-of-range", e);
            if let Some(e) = far {
                // Where the map stands it, else the end's middle; then on the mover's surface (#3168).
                let stand = self
                    .map
                    .spot_near(to, e.middle(), AT_EDGE)
                    .map_or(e.middle(), |s| {
                        Vec3::new(s.at[0] * 1000, s.at[1] * 1000, s.at[2] * 1000)
                    });
                let stand = self
                    .landing(to, stand)
                    .ok_or_else(|| refusal("link-end-off-ground", show(link)))?;
                let last = if to == self.ground {
                    back(&place, stand).map_err(out)?
                } else {
                    stand
                };
                if let Some(p) = line.last_mut() {
                    *p = last;
                }
                arrive = Some(stand);
            }
            if here == self.ground {
                for p in &mut line {
                    *p = place.point(*p).map_err(out)?;
                }
            }
        } else if let Some(last) = line.last_mut() {
            *last = self
                .landing(to, *last)
                .ok_or_else(|| refusal("link-end-off-ground", show(link)))?;
        }
        // The carry starts at the near end: a body asking from further off would be carried there in a straight
        // line, through whatever stands between (#3168).
        if line
            .first()
            .is_some_and(|s| flat2(*s, p) > i128::from(REACH) * i128::from(REACH))
        {
            return Err(refusal(
                "link-not-here",
                format!("{} from {} µm", show(link), flat2(line[0], p).isqrt()),
            ));
        }
        if let Some(door) = door {
            let shut = self
                .tree
                .node(
                    self.tree
                        .handle(door)
                        .ok_or_else(|| refusal("node-missing", show(door)))?,
                )
                .and_then(|n| n.fields().get(&F_OPEN).cloned())
                != Some(Value::Uint(1));
            if shut {
                self.doors.ask(door, link, cause, Actor::Soul(body.id));
                self.doors.flush(&mut self.tree, at)?;
                return Ok((near as u8, None));
            }
        }
        Ok((
            near as u8,
            Some(Track {
                link: Some(link),
                line,
                speed,
                to,
                arrive,
            }),
        ))
    }

    /// A link taken in turns as the walk skill reads it (T9b A3): [`F_TURNS`], and [`F_GRANTED`] the walker its
    /// owner lets in now. Any other link, or none, reads as free (`None`).
    pub fn read_link(&self, link: Id) -> Option<Seen> {
        link_seen(self.turns.as_ref(), &self.buildings, &self.tree, link)
    }

    /// Where a crossing stands a body on `node` for the point `at` (µm, its frame): `at` when the mover's surface
    /// holds it, else the surface's nearest legal point within [`LAND`] (N5's map and N6's mover cut the ground
    /// apart, so a link's end on a map piece's edge can lie just off the mover's), else none (#3168).
    fn landing(&self, node: Id, at: Vec3) -> Option<Vec3> {
        let s = self.surfaces.get(&node)?;
        let frame = Frame { node, slot: None };
        if s.place(node, frame, at, Quat::IDENTITY).is_ok() {
            return Some(at);
        }
        let (_, q) = exits::nearest(s.pieces(), at)?;
        (flat2(q, at) <= i128::from(LAND) * i128::from(LAND)).then_some(q)
    }
}

fn link_seen(turns: Option<&Turns>, buildings: &[Building], tree: &Tree, link: Id) -> Option<Seen> {
    let l = buildings.iter().find_map(|b| b.link(link))?;
    if !narrow(l) {
        return None;
    }
    let mut fields = BTreeMap::from([(F_TURNS, Value::Uint(1))]);
    if let Some(who) = turns?.state(l).and_then(|s| s.granted) {
        fields.insert(F_GRANTED, who.to_value());
    }
    Some(Seen {
        id: link,
        kind: tree.link(link)?.0.clone(),
        parent: None,
        position: Vec3::ZERO,
        fields,
    })
}

impl Links for Town {
    fn track(
        &mut self,
        body: &Body,
        link: Id,
        speed: i64,
        at: Micros,
    ) -> Result<Option<Track>, Refusal> {
        // The world opens a shut door for the walker: its own rule, the walker as the acting Soul.
        let (from, track) = self.track_of(body, link, Cause::World, speed, at)?;
        if track.is_some() {
            let start = body.pose.position;
            self.crossings.insert(body.id, Crossing { from, start });
        }
        Ok(track)
    }
}
