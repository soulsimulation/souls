//! The scripted worlds the archive is measured and proved on: the benches' world (K2's and K5's, rooms of bodies
//! holding things), kept busy with K5's restart load (100 bodies take a step each 50 ms tick), or quiet (one act an
//! hour). Some acts are speech: a field set to a text reference, with the words kept apart in a text store (T8).
//! I10's driver (#2693) is not merged; this is the busiest scripted load there is.

#[path = "../../bench/src/world.rs"]
#[allow(clippy::new_without_default)]
pub mod world;

use std::collections::BTreeMap;

use replica::audience::REFERENCE;
use replica::effects::{Change, Event};
use replica::encode::{Name, Value};
use replica::ids::{Id, Scope};
use replica::pose::{HandOff, Owner, Vec3};
pub use world::World;

/// A tick, µs of world time: K5's bench ticks at 20 a second.
pub const TICK: i64 = 50_000;

/// Words the scripted Souls say; they live in the text store only, never in the log, an object or a bundle.
pub const SAID: [&str; 3] = [
    "meet me by the fountain at noon",
    "the bread here is very good",
    "who left the gate open",
];

/// A world of `rooms` rooms of ten bodies and `things` things each, built at world time 0, its parts handed to `log`
/// as they commit.
pub fn world(rooms: usize, things: usize, log: Option<world::Logger>) -> World {
    let mut w = World::new();
    w.log = log;
    for _ in 0..rooms {
        w.room(10, things);
    }
    w
}

/// The text reference to words `i` of [`SAID`] (T8: `{21: id}`).
pub fn reference(i: usize) -> Value {
    let id = Id::new(Scope([0x7e; 16]), i as u64).expect("an id");
    Value::Map(BTreeMap::from([(REFERENCE, id.to_value())]))
}

/// One tick at world time `tick` × [`TICK`]: `movers` bodies, in turn, each take a step; every `say_every` ticks
/// (none when 0) the first of them also says something, by reference. Returns the part's bytes, as the log holds them.
pub fn tick(w: &mut World, tick: u64, movers: usize, say_every: u64) -> Vec<u8> {
    let n = w.bodies.len();
    let at = tick as i64 * TICK;
    let entries = (0..movers)
        .map(|i| {
            let ix = (tick as usize * movers + i) % n;
            let (b, room) = (w.bodies[ix], w.rooms[ix / 10]);
            let x = (ix % 10) as i64 * 1000 + (tick % 1000) as i64;
            let mut changes = vec![Change::Motion(HandOff {
                node: b,
                at,
                from: Owner::Mover,
                to: Owner::Mover,
                pose: world::pose(room, None, x),
                linear: Vec3::new(20_000, 0, 0),
                angular: Vec3::ZERO,
            })];
            let says = i == 0 && say_every > 0 && tick.is_multiple_of(say_every);
            if says {
                changes.push(Change::Set {
                    node: b,
                    field: 9,
                    to: reference((tick / say_every) as usize % SAID.len()),
                    by: None,
                });
            }
            let mut e = w.entry(b, changes);
            e.envelope.at = at;
            if says {
                // The Soul says it (V4's event index names the actor).
                e.envelope.actor = replica::effects::Actor::Soul(b);
                e.events = Some(vec![Event {
                    name: Name::new("souls:said").expect("a name"),
                    fields: BTreeMap::from([(
                        1,
                        reference((tick / say_every) as usize % SAID.len()),
                    )]),
                    changes: vec![1],
                    rest: Default::default(),
                }]);
            }
            e
        })
        .collect();
    w.commit(entries)
}
