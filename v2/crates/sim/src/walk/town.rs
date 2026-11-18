//! The walk skill's [`World`] over the engine as it stands: N5's map for routes and lines, N6's mover for steps, N4's
//! links and door writer for crossings, all read from K2's tree.
//!
//! - **Legs.** The route (N5, a body with hands) from where the body stands to the goal; each link it crosses is a
//!   leg's end, at the link's near end on the node the body stands on (N4, read with the open ground: a doorway
//!   between a building and the open ground has one end on each).
//! - **The next corner.** The leg's end when a straight walk on the body's surface reaches it (N6's walk, on a copy of
//!   the body), else the second point of the first line of the route from where it stands to the leg's end.
//! - **A crossing.** At the near end: a shut door is asked to open and the opening written at the end of that tick
//!   (N4's writer, the order as the cause and the walker as the Soul), and the body stands. Then it follows the
//!   link's line at its speed, never a longer step than speed times the tick, and stands on the far floor's surface
//!   at the line's end. The line is followed in the frame of the node the body stands on: a body coming in from the
//!   open ground follows it placed on the ground by the building's frame, and stands at the far end on the floor; a
//!   body going out follows it in the building's frame and stands at the far end on the open ground.
//! - **Turns** (N8). A link under 1.2 m wide is taken in turns (`crate::links::turns`): at the start of each tick
//!   the marks of the last are read into each such link's facts (who waits at which end and how far from it, who is
//!   inside and how far along, whether each end has room to step out into), and its owning node writes who may
//!   enter. Without turns ([`Town::turns`] `None`) every link is free, as N7 walked them.

use super::{Leg, Mark, Pass, World, node_of};
use crate::ground::scene::FLOOR;
use crate::ground::{HUMAN_RADIUS, OpenGround};
use crate::links::turns::{Facts, ROOM, Turns, narrow};
use crate::links::{Building, Doors, F_OPEN, Open, back, ground_doors};
use crate::mover::{Body, Surface};
use crate::routes::{HANDS, Hop, Map};
use replica::effects::{Actor, Cause, Refusal};
use replica::encode::Value;
use replica::ids::Id;
use replica::pose::{ControllerInput, Frame, Mode, Vec3};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::{plain, show};
use std::collections::BTreeMap;

fn refusal(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

/// How far a leg's end may lie off the ground and still be aimed at, mm: a link's end on its piece's edge.
const AT_EDGE: i64 = 20;

/// A crossing under way: the line left to follow (µm, the near node's frame), the node it ends on, and where on it
/// the body stands at the end when that node's frame is another (the far end's middle, its frame).
struct Crossing {
    line: Vec<Vec3>,
    to: Id,
    arrive: Option<Vec3>,
    /// The end it came in by, and where the body stood when it began.
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
    crossings: BTreeMap<Id, Crossing>,
}

impl Town {
    /// Everything on the open ground `ground`; openings are written by `doors`.
    pub fn new(tree: Tree, ground: Id, doors: Doors) -> Result<Town, String> {
        let map = Map::build(&tree, ground, &|_| 0)?;
        let mut surfaces = BTreeMap::new();
        let open = OpenGround::of(&tree, ground, HUMAN_RADIUS)?;
        let (mut pieces, mut meets) = (Vec::new(), Vec::new());
        for (i, j) in open.squares() {
            let p = open.cut_square(i, j);
            pieces.extend(p.pieces);
            meets.extend(p.meets.into_iter().map(|m| ((i, j), m)));
        }
        let gh = tree.handle(ground).ok_or("no such ground")?;
        let gdoors = ground_doors(&tree, ground)?;
        let on = open.on_terrain(&pieces);
        let mut surface = Surface::new(ground, pieces);
        if let Some(t) = open.terrain() {
            surface = surface.on_terrain(t.clone(), on);
        }
        surfaces.insert(ground, surface);
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
            crossings: BTreeMap::new(),
        })
    }

    fn surface(&self, node: Id) -> Result<&Surface, Refusal> {
        self.surfaces
            .get(&node)
            .ok_or_else(|| refusal("no-surface", show(node)))
    }

    fn link(&self, id: Id) -> Option<&crate::links::Link> {
        self.building(id).and_then(|b| b.link(id))
    }

    fn building(&self, link: Id) -> Option<&Building> {
        self.buildings.iter().find(|b| b.link(link).is_some())
    }

    /// Whether a straight walk on the body's surface from where it stands reaches `to` (x and z, µm).
    fn clear(&self, body: &Body, to: [i64; 2]) -> Result<bool, Refusal> {
        let s = self.surface(node_of(body))?;
        let mut b = *body;
        let p = b.pose.position;
        // In one second, at the velocity that is the whole way.
        s.step(&mut b, walk([to[0] - p.x, to[1] - p.z]), 1_000_000, 0)?;
        Ok([b.pose.position.x, b.pose.position.z] == to)
    }
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

impl World for Town {
    fn turns(&mut self, marks: &[Mark], at: Micros) -> Result<(), Refusal> {
        let Town {
            turns,
            buildings,
            crossings,
            ..
        } = self;
        let Some(turns) = turns.as_mut() else {
            return Ok(());
        };
        // The links waited for, crossed, or with a state already.
        let mut ids: std::collections::BTreeSet<Id> = marks
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

    fn pass(&self, link: Id, who: Id) -> Pass {
        let (Some(turns), Some(l)) = (self.turns.as_ref(), self.link(link)) else {
            return Pass::Free;
        };
        if !narrow(l) {
            Pass::Free
        } else if turns.granted(l, who) {
            Pass::Granted
        } else {
            Pass::Wait
        }
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

    fn corner(&mut self, body: &Body, to: Vec3) -> Result<[i64; 2], Refusal> {
        if self.clear(body, [to.x, to.z])? {
            return Ok([to.x, to.z]);
        }
        let node = node_of(body);
        let (Some(from), Some(goal)) = (
            self.map.spot_near(node, body.pose.position, AT_EDGE),
            // A link's near end lies on its piece's edge, within the grid's rounding.
            self.map.spot_near(node, to, AT_EDGE),
        ) else {
            return Err(refusal("off-ground", show(node)));
        };
        let r = self.map.route(&self.tree, from, goal, HANDS)?;
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

    fn step(
        &mut self,
        body: &mut Body,
        velocity: [i64; 2],
        dt: Micros,
        at: Micros,
    ) -> Result<(), Refusal> {
        let s = self.surface(node_of(body))?;
        s.step(body, walk(velocity), dt, at)?;
        Ok(())
    }

    fn cross(
        &mut self,
        body: &mut Body,
        link: Id,
        order: Id,
        speed: i64,
        dt: Micros,
        at: Micros,
    ) -> Result<bool, Refusal> {
        if !self.crossings.contains_key(&body.id) {
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
            // The line is in the building's frame; on the open ground it is followed placed there. Between frames it
            // ends where the body stands on the far side: the far end's middle, on its piece (it may lie on the
            // piece's edge, within the grid's rounding).
            let mut arrive = None;
            if here == self.ground || to == self.ground {
                let place = self
                    .building(link)
                    .map(|b| b.place)
                    .ok_or_else(|| refusal("link-missing", show(link)))?;
                let out = |e: String| refusal("out-of-range", e);
                if let Some(e) = far {
                    let s = self
                        .map
                        .spot_near(to, e.middle(), AT_EDGE)
                        .ok_or_else(|| refusal("link-end-off-ground", show(link)))?;
                    let stand = Vec3::new(s.at[0] * 1000, s.at[1] * 1000, s.at[2] * 1000);
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
            }
            let door = l.door;
            self.crossings.insert(
                body.id,
                Crossing {
                    line,
                    to,
                    arrive,
                    from: near as u8,
                    start: p,
                },
            );
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
                    // Stand, open: the opening is written at the end of this tick and read the next.
                    self.doors
                        .ask(door, link, Cause::Intent(order), Actor::Soul(body.id));
                    self.doors.flush(&mut self.tree, at)?;
                    body.linear = Vec3::ZERO;
                    return Ok(false);
                }
            }
        }
        // Along the line, at most speed times the tick.
        let mut reach = i128::from(speed) * i128::from(dt) / 1_000_000;
        let c = self.crossings.get_mut(&body.id).expect("a crossing");
        let mut p = body.pose.position;
        while let Some(&next) = c.line.first() {
            let d = dist2(p, next).isqrt();
            if d <= reach {
                reach -= d;
                p = next;
                c.line.remove(0);
                continue;
            }
            let part = |a: i64, b: i64| a + (i128::from(b - a) * reach / d) as i64;
            p = Vec3::new(part(p.x, next.x), part(p.y, next.y), part(p.z, next.z));
            break;
        }
        let old = body.pose.position;
        body.linear = Vec3::new(
            ((i128::from(p.x - old.x) * 1_000_000) / i128::from(dt)) as i64,
            ((i128::from(p.y - old.y) * 1_000_000) / i128::from(dt)) as i64,
            ((i128::from(p.z - old.z) * 1_000_000) / i128::from(dt)) as i64,
        );
        body.pose.position = p;
        if !c.line.is_empty() {
            return Ok(false);
        }
        let (to, arrive) = (c.to, c.arrive);
        self.crossings.remove(&body.id);
        let p = arrive.unwrap_or(p);
        let linear = body.linear;
        let frame = Frame {
            node: to,
            slot: None,
        };
        *body = self
            .surface(to)?
            .place(body.id, frame, p, body.pose.orientation)?;
        body.linear = linear;
        Ok(true)
    }
}
