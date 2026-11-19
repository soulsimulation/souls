//! Starting a world from a fork (Engine v2 G9, #2798): a new world begins as a fork of a template's checkpoint, or of
//! its creator's own world, through its creator (K6, `sim::checkpoint::fork`), and serves its first part.
//!
//! 1. **The fork** is K6's: the source's newest good checkpoint, seen through the creator, with every body removed and
//!    what each held set down where it stood. Ids carried keep their ids; the request's fresh scope is the new
//!    world's lineage, so whatever it makes afterwards carries that scope (T3 rule 5).
//! 2. **The first tick** is one part, from the world, on the zone: applied to the tree, appended to the log and
//!    handed to the view tier (R3), as the clock thread does.
//! 3. **The first served part** is the view tier's first frame of the zone's public key (R3), handed to a subscriber
//!    that joined before the first tick: what a viewer receives first. V1's stream writer is not used: its copy of the
//!    view starts at the world's first sequence, and a fork starts mid-sequence (V1 has no snapshot chunks yet).
//!
//! Who may start a world, its name and its one creator are the directory's (`directoryd::worlds::create`), claimed
//! before this runs. Not here: the ticker that runs it afterwards, and catching up a template's pending timers.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use replica::effects::{Actor, Body, Cause, Effect, Envelope, Part, Refusal, Rest};
use replica::encode::{Value, encode};
use replica::time::TimeEffect;
use replica::views::{Key, Level, Redactions};
use replica::world_model::Audience;
use sim::checkpoint::fork::{Forked, Request, fork};

use crate::views::{Delivery, Tier};

/// How long the first frame may take before the start is refused, `start-no-frame`.
const FIRST_FRAME: Duration = Duration::from_secs(30);

type R<T> = Result<T, Refusal>;

fn fault(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

/// A world started: the fork, and the first frame it served.
pub struct Started {
    pub forked: Forked,
    /// The log record of the first tick, and the first frame of the zone's public key.
    pub record: u64,
    pub frame: Arc<[u8]>,
}

/// Starts a new world in `dir` from the newest good checkpoint in `source`, through `req.through` (its creator), and
/// serves its first part (rules 1 to 3).
pub fn start(source: &Path, dir: &Path, req: Request) -> R<Started> {
    let mut f = fork(source, dir, req)?;
    let zone = f
        .tree
        .node(f.tree.root())
        .map(|n| n.id())
        .ok_or_else(|| fault("start-no-root", dir.display().to_string()))?;
    let at = f
        .tree
        .time()
        .iter()
        .rev()
        .find_map(|t| match t {
            TimeEffect::Mapping(m) => Some(m.world_us),
            _ => None,
        })
        .unwrap_or(0);

    // Rule 3: the tier on the state after the head of the log, and a subscriber that joins before the first tick.
    let tier = Tier::start(
        f.header.clone(),
        f.tree.to_state(),
        Redactions::default(),
        f.log.durable_mark(),
    )?;
    let key = Key {
        node: zone,
        level: Level::Full,
        audience: Audience::Everyone,
    };
    let sub = tier.subscribe(vec![key], 64);

    // Rule 2: the first tick.
    let tick = Effect {
        envelope: Envelope {
            sequence: f.tree.next(),
            at,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node: zone,
        },
        body: Body::Changes(Vec::new()),
        events: None,
        rest: Rest::new(),
    };
    let raw = encode(&Value::Map(
        [
            (1, Value::Bytes(f.header.hash().to_bytes())),
            (2, Value::Array(vec![tick.to_value()])),
        ]
        .into(),
    ))
    .map_err(|e| fault("encoding", e.to_string()))?;
    let part = Part::read(&raw)?;
    f.tree.apply(&f.header, &part)?;
    let record = f.log.append(part.stored().to_vec())?;
    tier.offer(record, part.stored().to_vec());

    // The first part is served when the subscriber is handed the tick's frame.
    let frame = match sub.recv_timeout(FIRST_FRAME) {
        Some(Delivery::Frame { bytes, .. }) => bytes,
        _ => {
            let stats = tier.close();
            return Err(stats
                .fault
                .unwrap_or_else(|| fault("start-no-frame", dir.display().to_string())));
        }
    };
    drop(sub);
    if let Some(e) = tier.close().fault {
        return Err(e);
    }
    Ok(Started {
        forked: f,
        record,
        frame,
    })
}
