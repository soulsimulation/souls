//! The walk skill's [`World`] over the engine as it stands: N5's map for routes and lines, N6's mover for steps, N4's
//! links and door writer for crossings, all read from K2's tree.
//!
//! - **Legs.** The route (N5, a body with hands) from where the body stands to the goal; each link it crosses is a
//!   leg's end, at the link's near end on the body's floor (N4). A doorway between a building and the open ground
//!   has no near end in N4's building (it is read with one end only), so a route across one is refused as
//!   `link-not-walked` for now.
//! - **The next corner.** The leg's end when a straight walk on the body's surface reaches it (N6's walk, on a copy of
//!   the body), else the second point of the first line of the route from where it stands to the leg's end.
//! - **A crossing.** At the near end: a shut door is asked to open and the opening written at the end of that tick
//!   (N4's writer, the order as the cause and the walker as the Soul), and the body stands. Then it follows the
//!   link's line at its speed, never a longer step than speed times the tick, and stands on the far floor's surface
//!   at the line's end.

use super::{Leg, World, node_of};
use crate::ground::scene::FLOOR;
use crate::ground::{HUMAN_RADIUS, OpenGround, Scene};
use crate::links::{Building, Doors, F_OPEN};
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

/// A crossing under way: the line left to follow (µm), and the floor it ends on.
struct Crossing {
    line: Vec<Vec3>,
    to: Id,
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
    crossings: BTreeMap<Id, Crossing>,
}

impl Town {
    /// Everything on the open ground `ground`; openings are written by `doors`.
    pub fn new(tree: Tree, ground: Id, doors: Doors) -> Result<Town, String> {
        let map = Map::build(&tree, ground, &|_| 0)?;
        let mut surfaces = BTreeMap::new();
        let open = OpenGround::prepare(&Scene::of(&tree, ground)?, HUMAN_RADIUS)?;
        let mut pieces = Vec::new();
        for (i, j) in open.squares() {
            pieces.extend(open.cut_square(i, j).pieces);
        }
        surfaces.insert(ground, Surface::new(ground, pieces));
        let mut buildings = Vec::new();
        let mut stack = vec![tree.handle(ground).ok_or("no such ground")?];
        while let Some(h) = stack.pop() {
            let kids = tree.children(h).ok_or("a node that is gone")?;
            if kids.iter().any(|&c| {
                tree.node(c)
                    .is_some_and(|n| plain(n.kind().as_str()) == FLOOR)
            }) {
                let id = tree.node(h).ok_or("a node that is gone")?.id();
                if let Ok(b) = Building::read(&tree, id) {
                    for (&floor, (_, patch)) in &b.floors {
                        surfaces.insert(floor, Surface::new(floor, patch.pieces.clone()));
                    }
                    buildings.push(b);
                }
            }
            stack.extend(kids.iter().rev().copied());
        }
        Ok(Town {
            tree,
            ground,
            map,
            surfaces,
            buildings,
            doors,
            crossings: BTreeMap::new(),
        })
    }

    fn surface(&self, node: Id) -> Result<&Surface, Refusal> {
        self.surfaces
            .get(&node)
            .ok_or_else(|| refusal("no-surface", show(node)))
    }

    fn link(&self, id: Id) -> Option<&crate::links::Link> {
        self.buildings.iter().find_map(|b| b.link(id))
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
    fn plan(&mut self, body: &Body, node: Id, goal: Vec3) -> Result<Vec<Leg>, Refusal> {
        let here = node_of(body);
        let from = self
            .map
            .spot(here, body.pose.position)
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
            self.map.spot(node, body.pose.position),
            self.map.spot(node, to),
        ) else {
            return Err(refusal("off-ground", show(node)));
        };
        let r = self.map.route(&self.tree, from, goal, HANDS)?;
        let c = r
            .first_line
            .get(1)
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
            let to = l.ends[1 - near].map_or(here, |e| e.floor);
            let mut line = l.line.clone();
            if near == 1 {
                line.reverse();
            }
            let door = l.door;
            self.crossings.insert(body.id, Crossing { line, to });
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
        let to = c.to;
        self.crossings.remove(&body.id);
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
