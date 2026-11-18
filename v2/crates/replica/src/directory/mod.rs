//! The directory's records (Engine v2 W8, #2729; contract T11, `v2/docs/durability.md` rules 9 to 12). A world's
//! record is T11's [`WorldRecord`]: where it runs (the machine of the claim in force), its epoch, its takeovers, the
//! off-machine mark, when it must wake and its pinned build. A Soul's record, here, says where the Soul is: in exactly
//! one world, or in transit under one transfer (X9). The calls that change them, by conditional writes to the object
//! store, are `directoryd`'s (`v2/crates/directoryd/src/directory`).

use std::collections::BTreeMap;

use crate::effects::{Refusal, read_id};
use crate::encode::{Value, decode, encode, to_hex};
use crate::ids::Id;

pub use crate::durability::{Takeover, Token, WorldRecord};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// Where a Soul is: one world (its lineage and zone), or between worlds under a transfer's id. Never two worlds: a
/// Soul has one record, and this is its only place.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Place {
    World { lineage: [u8; 16], zone: Id },
    Transit { transfer: [u8; 16] },
}

/// A Soul's record (rule 11), at `soul/<soul>`: `{1: soul, 2: lineage, 3: zone, 5: writes}` in a world, or
/// `{1: soul, 4: transfer, 5: writes}` in transit. 5 counts the writes, one more at every write, so a Soul that
/// leaves a world and comes back is never the same bytes, and a real store's ETag never repeats (rule 10).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SoulRecord {
    pub soul: Id,
    pub place: Place,
    pub writes: u64,
}

impl SoulRecord {
    pub fn key(soul: Id) -> String {
        format!("soul/{}-{}", to_hex(&soul.scope().0), soul.counter())
    }

    pub fn to_bytes(&self) -> R<Vec<u8>> {
        let mut m = BTreeMap::from([(1, self.soul.to_value()), (5, Value::Uint(self.writes))]);
        match &self.place {
            Place::World { lineage, zone } => {
                m.insert(2, Value::Bytes(lineage.to_vec()));
                m.insert(3, zone.to_value());
            }
            Place::Transit { transfer } => {
                m.insert(4, Value::Bytes(transfer.to_vec()));
            }
        }
        encode(&Value::Map(m)).or_else(|e| refuse("encoding", e.to_string()))
    }

    /// Reads a record, refusing one that names both a world and a transfer, or neither.
    pub fn read(bytes: &[u8]) -> R<SoulRecord> {
        let bad = || {
            refuse(
                "record-not-a-record",
                "{1: soul, 2: lineage, 3: zone, 5: writes} or {1: soul, 4: transfer, 5: writes}",
            )
        };
        let v = decode(bytes)
            .or_else(|e| refuse("encoding", e.to_string()))?
            .value;
        let Value::Map(m) = v else { return bad() };
        let bytes16 = |k| match m.get(&k) {
            Some(Value::Bytes(b)) => <[u8; 16]>::try_from(b.as_slice()).ok(),
            _ => None,
        };
        let (Some(soul), Some(Value::Uint(writes))) = (m.get(&1), m.get(&5)) else {
            return bad();
        };
        let place = match (m.get(&2), m.get(&3), m.get(&4)) {
            (Some(_), Some(zone), None) => match bytes16(2) {
                Some(lineage) => Place::World {
                    lineage,
                    zone: read_id(zone)?,
                },
                None => return bad(),
            },
            (None, None, Some(_)) => match bytes16(4) {
                Some(transfer) => Place::Transit { transfer },
                None => return bad(),
            },
            _ => return bad(),
        };
        if m.keys().any(|k| *k == 0 || *k > 5) {
            return bad();
        }
        Ok(SoulRecord {
            soul: read_id(soul)?,
            place,
            writes: *writes,
        })
    }
}
