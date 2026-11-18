//! Sync and resume by hash (Engine v2 R5, #2699): a client that was away becomes current by comparing hashes and
//! fetching only what differs. R6's daemon calls this at every reconnect.
//!
//! 1. **The cursor first, and only in the same lineage, zone and epoch** ([`start`]). The client's cursor is the
//!    last version it applied (`v2/docs/ids.md` rule 8). The gateway replays what it still holds after it (I1,
//!    `gatewayd/src/resume.rs`); a cursor from another lineage or zone, from another epoch (a writer that was
//!    superseded may have written past what the next one kept, `v2/docs/durability.md` step 0) or from the future
//!    never resumes: the client compares from the top.
//! 2. **From the top is compare and descend over K5's hashes** ([`Copy::sync`]). A node's sealed hash covers its own
//!    record and its children's hashes (`tree/seal.rs`), so the world gives one node's hash in constant time once
//!    sealed, and a record names its children by hash. The client asks for the hash of each node of its scope
//!    (R4: a node held, or the room a body follows), then fetches every record it does not
//!    hold, one round per level: a subtree whose hash it holds is the same, and is not opened.
//! 3. **Every record is checked against the hash that named it** (`sync-hash`), with its audience's label, so a
//!    world or a cache that sends a wrong record is refused by name. Records the scope no longer reaches are let go,
//!    so the copy is exactly the scope.
//! 4. **The bytes are counted** ([`Synced`]): a room of 5,000 children lists 5,000 hashes (34 bytes each) to find one
//!    change.
//!
//! Not here: missed events (speech to me) are not state and are not restored; the socket request that carries this
//! (R6). The library a client checks with is loaded by its build hash in `v2/client/src/sync/library.mjs`.

use crate::effects::Refusal;
use crate::encode::{Value, decode, encode};
use crate::ids::{Hash, Id, Purpose, Version};
use crate::tree::{Sealed, Tree};
use std::collections::{BTreeMap, HashMap, HashSet};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// How a client that was away starts (rule 1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Start {
    /// Ask the gateway to replay from the cursor; if it cannot, compare from the top.
    Cursor,
    /// Compare from the top.
    FromTop,
}

/// Rule 1: the cursor only in the world's own lineage, zone and epoch, and never from the future.
pub fn start(cursor: Option<&Version>, world: &Version) -> Start {
    match cursor {
        Some(c)
            if c.lineage == world.lineage
                && c.zone == world.zone
                && c.epoch == world.epoch
                && c.sequence <= world.sequence =>
        {
            Start::Cursor
        }
        _ => Start::FromTop,
    }
}

/// What a world answers a syncing client from.
pub trait Source {
    /// Each node's hash as last sealed, none for a node not here.
    fn hashes(&mut self, ids: &[Id]) -> R<Vec<Option<Hash>>>;
    /// The records these hashes (34 bytes each) name, in the same order.
    fn records(&mut self, hashes: &[Vec<u8>]) -> R<Vec<Vec<u8>>>;
}

/// The world's records by hash: every record a seal gave (K5's checkpoint blobs are the same bytes).
#[derive(Default)]
pub struct Records {
    by_hash: HashMap<Vec<u8>, Vec<u8>>,
}

impl Records {
    /// Keeps the records a seal gave.
    pub fn keep(&mut self, sealed: &Sealed) {
        for (h, bytes) in &sealed.nodes {
            self.by_hash
                .entry(h.to_bytes())
                .or_insert_with(|| bytes.clone());
        }
    }

    pub fn len(&self) -> usize {
        self.by_hash.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_hash.is_empty()
    }
}

/// The world's end of a sync: its tree as last sealed, and its records.
pub struct Served<'a> {
    pub tree: &'a Tree,
    pub records: &'a Records,
}

impl Source for Served<'_> {
    fn hashes(&mut self, ids: &[Id]) -> R<Vec<Option<Hash>>> {
        ids.iter()
            .map(
                |id| match self.tree.handle(*id).and_then(|h| self.tree.node(h)) {
                    None => Ok(None),
                    Some(n) => match n.sealed() {
                        Some(h) => Ok(Some(h)),
                        None => refuse("sync-not-sealed", "the world answers from its last seal"),
                    },
                },
            )
            .collect()
    }

    fn records(&mut self, hashes: &[Vec<u8>]) -> R<Vec<Vec<u8>>> {
        hashes
            .iter()
            .map(|h| match self.records.by_hash.get(h) {
                Some(b) => Ok(b.clone()),
                None => refuse("sync-unknown-hash", crate::encode::to_hex(h)),
            })
            .collect()
    }
}

/// What one sync did: rounds asked, scope nodes whose hash changed, records fetched, bytes each way, records held.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Synced {
    pub rounds: u32,
    pub changed: usize,
    pub fetched: usize,
    pub sent: u64,
    pub got: u64,
    pub held: usize,
}

/// A client's copy of its scope: each scope node's hash, and the records it reaches, by hash.
#[derive(Clone, Default)]
pub struct Copy {
    roots: BTreeMap<Id, Vec<u8>>,
    records: HashMap<Vec<u8>, Vec<u8>>,
}

/// Checks a record against the hash that named it (rule 3) and gives its children's hashes (field 10).
fn check(want: &[u8], bytes: &[u8]) -> R<Vec<Vec<u8>>> {
    let Ok(d) = decode(bytes) else {
        return refuse("sync-record", "not a record");
    };
    let Value::Map(m) = d.value else {
        return refuse("sync-record", "not a map");
    };
    let public = matches!(m.get(&5), Some(Value::Map(a)) if a.get(&1) == Some(&Value::Uint(1)));
    let purpose = if public {
        Purpose::StatePublic
    } else {
        Purpose::StatePrivate
    };
    if Hash::of(purpose, bytes).to_bytes() != want {
        return refuse(
            "sync-hash",
            format!("{} does not hash to its name", crate::encode::to_hex(want)),
        );
    }
    match m.get(&10) {
        None => Ok(Vec::new()),
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| match v {
                Value::Bytes(b) if b.len() == 34 => Ok(b.clone()),
                _ => refuse("sync-record", "a child's hash is not 34 bytes"),
            })
            .collect(),
        Some(_) => refuse("sync-record", "children are not a list"),
    }
}

fn size(v: &Value) -> u64 {
    encode(v).map_or(0, |b| b.len() as u64)
}

impl Copy {
    /// Each scope node's hash.
    pub fn roots(&self) -> &BTreeMap<Id, Vec<u8>> {
        &self.roots
    }

    /// The record a hash names, if held.
    pub fn record(&self, hash: &[u8]) -> Option<&[u8]> {
        self.records.get(hash).map(Vec::as_slice)
    }

    /// Rule 2: the hash of each node of `scope`, then every record not held, one round per level; then rule 3's let
    /// go. Its first sync, with nothing held, takes the whole scope.
    pub fn sync(&mut self, scope: &[Id], src: &mut dyn Source) -> R<Synced> {
        let mut s = Synced::default();
        let now = src.hashes(scope)?;
        s.rounds = 1;
        s.sent += size(&Value::Array(
            scope.iter().map(|id| id.to_value()).collect(),
        ));
        let mut roots = BTreeMap::new();
        let mut want = Vec::new();
        for (id, h) in scope.iter().zip(now) {
            let Some(h) = h else { continue };
            let h = h.to_bytes();
            s.got += h.len() as u64;
            if self.roots.get(id) != Some(&h) {
                s.changed += 1;
            }
            if !self.records.contains_key(&h) {
                want.push(h.clone());
            }
            roots.insert(*id, h);
        }
        self.roots = roots;
        while !want.is_empty() {
            want.sort();
            want.dedup();
            let got = src.records(&want)?;
            if got.len() != want.len() {
                return refuse("sync-record", "an answer of another length");
            }
            s.rounds += 1;
            s.sent += want.iter().map(|h| h.len() as u64).sum::<u64>();
            let mut next = Vec::new();
            for (h, bytes) in want.iter().zip(got) {
                for c in check(h, &bytes)? {
                    if !self.records.contains_key(&c) {
                        next.push(c);
                    }
                }
                s.got += bytes.len() as u64;
                s.fetched += 1;
                self.records.insert(h.clone(), bytes);
            }
            // A child named twice in one round, or also asked for in it, is fetched once.
            next.retain(|c| !self.records.contains_key(c));
            want = next;
        }
        let reached = self.reach()?;
        self.records.retain(|h, _| reached.contains(h));
        s.held = reached.len();
        Ok(s)
    }

    /// The hashes the scope reaches, each record held and checked; refused by name if one is missing.
    pub fn reach(&self) -> R<HashSet<Vec<u8>>> {
        let mut seen = HashSet::new();
        let mut stack: Vec<Vec<u8>> = self.roots.values().cloned().collect();
        while let Some(h) = stack.pop() {
            if seen.contains(&h) {
                continue;
            }
            let Some(bytes) = self.records.get(&h) else {
                return refuse("sync-missing", crate::encode::to_hex(&h));
            };
            stack.extend(check(&h, bytes)?);
            seen.insert(h);
        }
        Ok(seen)
    }
}
