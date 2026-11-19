//! The ladder's reads of the engine as it stands ([`Town`]): N8's turn states, N4's links and N6's surfaces.

use super::Unstick;
use crate::ground::exits;
use crate::links::turns::Turn;
use crate::walk::town::Town;
use replica::ids::Id;
use replica::pose::Vec3;
use replica::time::Micros;

fn dist2(a: Vec3, b: Vec3) -> i128 {
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    d(a.x, b.x) + d(a.y, b.y) + d(a.z, b.z)
}

impl Unstick for Town {
    fn moved(&self, link: Id) -> Option<Micros> {
        let l = self.buildings.iter().find_map(|b| b.link(link))?;
        let s = self.turns.as_ref()?.state(l)?;
        s.timeline.last().map(|t| match *t {
            Turn::Change { at, .. } | Turn::Grant { at, .. } => at,
        })
    }

    fn far_end(&self, link: Id, node: Id, at: Vec3) -> Option<(Id, Vec3)> {
        let l = self.buildings.iter().find_map(|b| b.link(link))?;
        let near = (0..2)
            .filter(|&k| l.ends[k].is_some_and(|e| e.floor == node))
            .min_by_key(|&k| l.ends[k].map_or(i128::MAX, |e| dist2(at, e.middle())))?;
        l.ends[1 - near].map(|e| (e.floor, e.middle()))
    }

    fn nearest(&self, node: Id, at: Vec3) -> Option<Vec3> {
        let s = self.surfaces.get(&node)?;
        exits::nearest(s.pieces(), at).map(|(_, p)| p)
    }
}
