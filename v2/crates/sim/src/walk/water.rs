//! Walking through water (Engine v2, #3225): a body that may wade or swim walks a route across shore links (N11c,
//! `souls:wade`, `souls:swim`), and its gait changes at the shore.
//!
//! - **Abilities.** Each body's abilities are [`Water::abilities`] (`crate::routes`' masks); a body not listed has
//!   hands only, so it neither wades nor swims and its routes, lines and steps are the ones it had before.
//! - **A ground for each body.** The open ground's wading ground and water are surfaces of their own for the mover
//!   (cut from the map's wet pieces once a body may use them, [`Water::cut`]), one each, so a body on one ground slides
//!   along its edge and never walks onto another. The controller keeps the ground each body stands on and steps it on
//!   that ground's surfaces (`crate::controller`); the world reads it at each tick's start ([`Water::grounds`]).
//! - **Crossing a shore.** At a shore's near end (the middle of the edge the two grounds share) the world gives a
//!   track to the nearest point of the far piece, at the wetter ground's gait, and names the ground it lands on
//!   ([`Water::lands`]); the controller carries the body there and stands it on that ground's surface. No jump: the
//!   track is followed at its speed. Into the water a body goes only with the move the shore needs: one without it
//!   is refused by name (`link-needs-wade`, `link-needs-swim`) before it moves, where it stands. Any body may come out.
//! - **Its gait.** Off dry ground the controller cuts the velocity asked to the ground's gait
//!   ([`crate::gaits::WADE`], [`crate::gaits::SWIM`]), so every driver wades and swims at those speeds.
//!
//! Not here: the planner's copy of the town (K18b) routes every body dry; the ladder (N10) and an edit's regrounding
//! (G3) find bodies on dry ground only; body classes other than the standard one never leave dry ground.

use crate::gaits::Ground;
use crate::ground::{Terrain, exits};
use crate::links::Kind;
use crate::mover::{Body, Surface};
use crate::routes::{HANDS, Map, Mask, Spot, needs};
use replica::effects::Refusal;
use replica::ids::Id;
use replica::pose::Vec3;
use std::collections::BTreeMap;
use std::sync::Arc;

/// The open ground's wet surfaces and each body's abilities and ground.
#[derive(Clone, Default)]
pub struct Water {
    /// Each body's abilities; a body not listed has hands only.
    pub abilities: BTreeMap<Id, Mask>,
    /// The bodies off dry ground and theirs, as the controller left them at the tick's start.
    pub grounds: BTreeMap<Id, Ground>,
    /// Wading ground and water: each a surface of the open ground with its pieces' numbers in the map.
    wet: Vec<(Ground, BTreeMap<Id, Surface>, Vec<u32>)>,
    /// Whether [`Water::cut`] has run: once a body may wade or swim.
    pub built: bool,
    /// The ground the shore track last given lands each body on, until the runner takes it.
    pub lands: BTreeMap<Id, Ground>,
}

fn mm(um: i64) -> i64 {
    (um + 500 * um.signum()) / 1000
}

/// The spot of piece `q` of `map` at `p` (µm).
fn spot_at(map: &Map, q: u32, p: Vec3) -> Spot {
    let y = map
        .piece(q)
        .vertices
        .first()
        .map_or(0, |v| i64::from(v[1]));
    Spot {
        piece: q,
        at: [mm(p.x), y, mm(p.z)],
    }
}

impl Water {
    /// `body`'s abilities: hands only when not listed.
    pub fn has(&self, body: Id) -> Mask {
        self.abilities.get(&body).copied().unwrap_or(HANDS)
    }

    /// The ground `body` stands on.
    pub fn ground(&self, body: Id) -> Ground {
        self.grounds.get(&body).copied().unwrap_or(Ground::Dry)
    }

    /// Cuts the open ground `ground`'s wading ground and water into surfaces of their own from `map`'s wet pieces,
    /// wading ground on `terrain` (its bed), water at its level.
    pub fn cut(&mut self, map: &Map, ground: Id, terrain: Option<&Arc<Terrain>>) {
        self.wet.clear();
        for g in [Ground::Wading, Ground::Water] {
            let idx: Vec<u32> = (0..map.counts().0 as u32)
                .filter(|&q| map.piece(q).ground == g && map.patch_of(q).node == ground)
                .collect();
            let pieces: Vec<_> = idx.iter().map(|&q| map.piece(q).clone()).collect();
            let on = pieces
                .iter()
                .map(|p| vec![terrain.is_some() && g == Ground::Wading; p.triangles.len()])
                .collect();
            let mut s = Surface::new(ground, pieces);
            if let Some(t) = terrain {
                s = s.on_terrain_shared(Arc::clone(t), on);
            }
            self.wet.push((g, BTreeMap::from([(ground, s)]), idx));
        }
        self.built = true;
    }

    /// The surfaces of wet ground `g`, by node (the open ground's alone).
    pub fn surfaces(&self, g: Ground) -> Option<&BTreeMap<Id, Surface>> {
        self.wet.iter().find(|w| w.0 == g).map(|w| &w.1)
    }

    fn surface(&self, g: Ground) -> Option<(&Surface, &[u32])> {
        let w = self.wet.iter().find(|w| w.0 == g)?;
        Some((w.1.values().next()?, &w.2))
    }

    /// Where `body` stands as a spot of `map`, when it stands on wet ground: its own piece.
    pub fn here(&self, map: &Map, body: &Body) -> Option<Spot> {
        let g = self.ground(body.id);
        if g == Ground::Dry {
            return None;
        }
        let (_, idx) = self.surface(g)?;
        Some(spot_at(map, *idx.get(body.piece as usize)?, body.pose.position))
    }

    /// The spot of wet ground `g` at `at` (µm), or its nearest point (a shore's end on its piece's edge).
    pub fn near(&self, map: &Map, g: Ground, at: Vec3) -> Option<Spot> {
        let (s, idx) = self.surface(g)?;
        let (k, p) = exits::nearest(s.pieces(), at)?;
        Some(spot_at(map, *idx.get(k as usize)?, p))
    }

    /// Crossing shore `link` of `map` for `body` from where it stands: the middle of the edge the two grounds share
    /// (µm), the far piece and the far ground, or the refusal naming why it may not go in. `None` for any other link.
    pub fn shore(&self, map: &Map, body: Id, link: Id) -> Option<Result<Shore, Refusal>> {
        let (kind, pieces, a, b) = map.shore(link)?;
        let wetter = map.piece(pieces[1]).ground;
        let out = self.ground(body) == wetter;
        let far = pieces[usize::from(!out)];
        // Out of the water any body may come; in, only with the move the shore needs.
        if !out && needs(kind) & !self.has(body) != 0 {
            let name = if kind == Kind::Wade {
                "link-needs-wade"
            } else {
                "link-needs-swim"
            };
            return Some(Err(Refusal {
                name,
                detail: replica::world_model::show(link),
            }));
        }
        Some(Ok(Shore {
            middle: Vec3::new((a[0] + b[0]) * 500, 0, (a[1] + b[1]) * 500),
            far,
            ground: map.piece(far).ground,
            gait: if wetter == Ground::Water {
                crate::gaits::SWIM.speed
            } else {
                crate::gaits::WADE.speed
            },
        }))
    }

    /// Where a shore crossing lands a body on `far` ground (piece `piece` of `map`), from `middle` (µm): the nearest
    /// point of that piece, then of the ground's surface (`dry`, the open ground's, for dry ground).
    pub fn landing(
        &self,
        map: &Map,
        dry: &Surface,
        far: Ground,
        piece: u32,
        middle: Vec3,
    ) -> Option<Vec3> {
        let (_, p) = exits::nearest(std::slice::from_ref(map.piece(piece)), middle)?;
        let s = match far {
            Ground::Dry => dry,
            g => self.surface(g)?.0,
        };
        exits::nearest(s.pieces(), p).map(|(_, q)| q)
    }
}

/// A shore crossing as [`Water::shore`] reads it.
#[derive(Clone, Copy, Debug)]
pub struct Shore {
    /// The middle of the edge the two grounds share, µm (height 0: the open ground's plan).
    pub middle: Vec3,
    /// The far piece of the map, and its ground.
    pub far: u32,
    pub ground: Ground,
    /// The wetter ground's gait speed, µm a second.
    pub gait: i64,
}
