//! A stand-in for the tick loop, which is not built yet (B2, #3137, writes no move records for that reason): the
//! clock thread's step from one tick's inputs to that tick's part (T6), on T8's audience fixture world. Births draw
//! their place from the world's random source (`sim::random`), keyed by the new node, so the step's output depends on
//! the checkpoint and the inputs alone. The seeded script of births, edits and intents stands in for a recording
//! of a real run (the issue's Step 0: nothing can make one yet).

use std::collections::BTreeMap;

use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Refusal, Rest,
    fixture_bytes,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Id, Scope};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::tree::Tree;
use replica::world_model::Audience;
use sim::random::Random;
use sim::recorder::{Input, words_ref};

const HEADER: &str = include_str!("../../../crates/replica/fixtures/audience/header.diag");
const LOG: &str = include_str!("../../../crates/replica/fixtures/audience/log.diag");

/// Ticks a second (the fixture world's rate, T5), and so microseconds a tick.
pub const RATE: u64 = 20;
const TICK_US: i64 = 1_000_000 / RATE as i64;
/// The first id a birth takes in the world's scope.
const FIRST_BORN: u64 = 1000;
/// The most things the script gives birth to.
const MOST_BORN: u64 = 3000;

pub fn id(scope: u8, n: u64) -> Id {
    Id::new(Scope([scope; 16]), n).expect("an id")
}

fn ee(n: u64) -> Id {
    id(0xee, n)
}

/// Creator X's principal, who builds; Soul 100, whose body is `ee(2)`, who speaks.
const X: (u8, u64) = (0x77, 1);
const SOUL: (u8, u64) = (0xdd, 100);

pub fn header() -> Header {
    Header::read(&fixture_bytes(HEADER).expect("bytes")).expect("a header")
}

/// The world a checkpoint is taken of: the fixture's log applied.
pub fn start(h: &Header) -> Tree {
    let mut t = Tree::start(h.zone, h.kinds[0].clone());
    t.apply(
        h,
        &Part::read(&fixture_bytes(LOG).expect("bytes")).expect("a part"),
    )
    .expect("the fixture log applies");
    t
}

/// The world as the clock thread holds it.
pub struct World {
    pub header: Header,
    pub tree: Tree,
    pub random: Random,
    born: u64,
    /// A seeded divergence: at this tick a birth draws with the wrong counter (the bug the tool must locate).
    pub diverge_at: Option<u64>,
}

impl World {
    pub fn new(header: Header, tree: Tree, seed: &[u8]) -> World {
        World {
            header,
            tree,
            random: Random::new(seed),
            born: 0,
            diverge_at: None,
        }
    }

    fn kind(&self, plain: &Name) -> Result<Name, Refusal> {
        self.header
            .kinds
            .iter()
            .find(|k| k.as_str().starts_with(&format!("{}@", plain.as_str())))
            .cloned()
            .ok_or_else(|| Refusal {
                name: "kind-unknown",
                detail: plain.as_str().into(),
            })
    }

    /// One tick: its inputs become one part, applied to the tree; returns the part's bytes (none for no inputs).
    pub fn step(&mut self, tick: u64, inputs: &[Input]) -> Result<Option<Vec<u8>>, Refusal> {
        let at = tick as i64 * TICK_US;
        let mut effects = Vec::new();
        for input in inputs {
            let sequence = self.tree.next() + effects.len() as u64;
            let (cause, actor, node, change) = match input {
                Input::Time { .. } | Input::Planned { .. } => continue,
                Input::Birth { by, kind } => {
                    let node = ee(FIRST_BORN + self.born);
                    self.born += 1;
                    let counter = u64::from(self.diverge_at == Some(tick));
                    let place = |p: &str| {
                        self.random.below(node, p, counter, 20_000_001) as i64 - 10_000_000
                    };
                    let change = Change::Create {
                        node,
                        kind: self.kind(kind)?,
                        pose: Pose {
                            frame: Frame {
                                node: ee(1),
                                slot: None,
                            },
                            position: Vec3 {
                                x: place("birth-x"),
                                y: 0,
                                z: place("birth-z"),
                            },
                            orientation: Quat::IDENTITY,
                            support: Support::Surface {
                                surface: ee(1),
                                height: 0,
                            },
                        },
                        audience: Audience::Everyone,
                        fields: BTreeMap::new(),
                    };
                    (Cause::World, Actor::Creator(*by), ee(1), change)
                }
                Input::Edit {
                    by,
                    node,
                    field,
                    to,
                } => {
                    let change = Change::Set {
                        node: *node,
                        field: *field,
                        to: to.clone(),
                        by: None,
                    };
                    (Cause::World, Actor::Creator(*by), *node, change)
                }
                Input::Intent {
                    id,
                    soul,
                    verb,
                    words,
                } => {
                    let to = match words {
                        Some(w) => words_ref(*w),
                        None => Value::Text(verb.clone()),
                    };
                    let change = Change::Set {
                        node: ee(2),
                        field: 9,
                        to,
                        by: None,
                    };
                    (Cause::Intent(*id), Actor::Soul(*soul), ee(2), change)
                }
            };
            effects.push(Effect {
                envelope: Envelope {
                    sequence,
                    at,
                    cause,
                    actor,
                    audience: Audience::Everyone,
                    node,
                },
                body: Body::Changes(vec![ChangeRec {
                    change,
                    rest: Rest::new(),
                }]),
                events: None,
                rest: Rest::new(),
            });
        }
        if effects.is_empty() {
            return Ok(None);
        }
        let v = Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (
                2,
                Value::Array(effects.iter().map(Effect::to_value).collect()),
            ),
        ]));
        let bytes = encode(&v).map_err(|e| Refusal {
            name: "encoding",
            detail: e.to_string(),
        })?;
        self.tree.apply(&self.header, &Part::read(&bytes)?)?;
        Ok(Some(bytes))
    }
}

/// The seeded script: `minutes` of ticks under load (about 4,800 inputs a minute: a steady 0 to 5 a tick and a
/// two-second burst of 25 a tick every 30 s), births, edits of what was born, and intents whose words are held by
/// reference. Its own draws come from `seed`, apart from the world's.
pub fn script(minutes: u64, seed: &[u8]) -> Vec<(u64, Vec<Input>)> {
    let r = Random::new(seed);
    let src = ee(0);
    let mut c = 0u64;
    let mut draw = |n: u64| {
        c += 1;
        r.below(src, "script", c, n)
    };
    let crate_kind = Name::new("souls:crate").expect("a name");
    let say = Name::new("say").expect("a name");
    let (mut born, mut intents) = (0u64, 0u64);
    let mut out = Vec::new();
    for tick in 0..minutes * 60 * RATE {
        let n = match tick % (30 * RATE) < 2 * RATE {
            true => 25,
            false => draw(6),
        };
        let mut inputs = Vec::new();
        if tick == 0 {
            inputs.push(Input::Time {
                real: 1_763_337_600_000_000,
            });
        }
        for _ in 0..n {
            let roll = draw(100);
            if born == 0 || (roll < 10 && born < MOST_BORN) {
                inputs.push(Input::Birth {
                    by: id(X.0, X.1),
                    kind: crate_kind.clone(),
                });
                born += 1;
            } else if roll < 85 {
                inputs.push(Input::Edit {
                    by: id(X.0, X.1),
                    node: ee(FIRST_BORN + draw(born)),
                    field: 1 + draw(4),
                    to: Value::Uint(draw(1_000_000)),
                });
            } else {
                intents += 1;
                inputs.push(Input::Intent {
                    id: id(SOUL.0, 10_000 + intents),
                    soul: id(SOUL.0, SOUL.1),
                    verb: say.clone(),
                    words: Some(id(0xcc, intents)),
                });
            }
        }
        if !inputs.is_empty() {
            out.push((tick, inputs));
        }
    }
    out
}
