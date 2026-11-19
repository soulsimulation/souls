//! Sync and resume by hash (Engine v2 R5, #2699): a client that was away becomes current by comparing hashes and
//! fetching only what differs. R6's daemon runs it when the gateway cannot resume its stream (R5b, #3164).
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
//! Over the gateway (R5b, #3164), the same steps ([`Copy::compare`], [`Copy::ask`], [`Copy::take`], [`Copy::finish`])
//! run one request at a time: `gatewayd/src/lib.rs` names the frames, and the world answers for the asking actor's
//! scope.
//!
//! Not here: missed events (speech to me) are not state and are not restored. The library a client checks with is loaded by its build hash in `v2/client/src/sync/library.mjs`.

use crate::effects::Refusal;
use crate::encode::{Value, decode, encode};
use crate::ids::{Hash, Id, Purpose, Version};
use crate::tree::{Sealed, Tree};
use std::collections::{BTreeMap, BTreeSet};

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
    by_hash: BTreeMap<Vec<u8>, Vec<u8>>,
}

impl Records {
    /// Keeps previously validated records, such as the blobs of a restored checkpoint.
    pub fn extend<'a>(&mut self, records: impl IntoIterator<Item = (&'a [u8], &'a [u8])>) {
        for (hash, bytes) in records {
            self.by_hash
                .entry(hash.to_vec())
                .or_insert_with(|| bytes.to_vec());
        }
    }

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

/// A sync under way ([`Copy::compare`]): the records still to ask for in this level, the next level's, the count,
/// the scope's new hashes (the copy's own only once it finishes), and the records it has taken so far.
pub struct Descent {
    want: Vec<Vec<u8>>,
    next: Vec<Vec<u8>>,
    s: Synced,
    roots: BTreeMap<Id, Vec<u8>>,
    taken: Vec<Vec<u8>>,
}

/// A client's copy of its scope: each scope node's hash, and the records it reaches, by hash.
#[derive(Clone, Default)]
pub struct Copy {
    roots: BTreeMap<Id, Vec<u8>>,
    records: BTreeMap<Vec<u8>, Vec<u8>>,
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
        let now = src.hashes(scope)?;
        let mut d = self.compare(
            scope,
            now.into_iter().map(|h| h.map(Hash::to_bytes)).collect(),
        );
        loop {
            let asked = self.ask(&mut d, usize::MAX);
            if asked.is_empty() {
                return self.finish(d);
            }
            if let Err(e) = src
                .records(&asked)
                .and_then(|got| self.take(&mut d, &asked, got))
            {
                self.abandon(d);
                return Err(e);
            }
        }
    }

    /// [`Copy::sync`] one step at a time, for a client whose answers come over a socket (R5b, #3164): the first
    /// round's answer, each scope node's hash, gives the records to fetch.
    pub fn compare(&mut self, scope: &[Id], now: RootHashes) -> Descent {
        let mut s = Synced {
            rounds: 1,
            sent: size(&Value::Array(
                scope.iter().map(|id| id.to_value()).collect(),
            )),
            ..Synced::default()
        };
        let mut roots = BTreeMap::new();
        let mut want = Vec::new();
        for (id, h) in scope.iter().zip(now) {
            let Some(h) = h else { continue };
            s.got += h.len() as u64;
            if self.roots.get(id) != Some(&h) {
                s.changed += 1;
            }
            if !self.records.contains_key(&h) {
                want.push(h.clone());
            }
            roots.insert(*id, h);
        }
        Descent {
            want: Vec::new(),
            next: want,
            s,
            roots,
            taken: Vec::new(),
        }
    }

    /// The next records to ask for, at most `most`: the rest of this level, else the next level's not yet held.
    /// Empty when the descent is done.
    pub fn ask(&self, d: &mut Descent, most: usize) -> Vec<Vec<u8>> {
        if d.want.is_empty() {
            // A child named twice in one level, or also asked for in it, is fetched once.
            d.want = std::mem::take(&mut d.next);
            d.want.retain(|c| !self.records.contains_key(c));
            d.want.sort();
            d.want.dedup();
        }
        let n = most.min(d.want.len());
        d.want.drain(..n).collect()
    }

    /// The records `asked` came back as: each checked against its hash (rule 3), kept, and its children not held
    /// asked for in the next level.
    pub fn take(&mut self, d: &mut Descent, asked: &[Vec<u8>], got: Vec<Vec<u8>>) -> R<()> {
        if got.len() != asked.len() {
            return refuse("sync-record", "an answer of another length");
        }
        d.s.rounds += 1;
        d.s.sent += asked.iter().map(|h| h.len() as u64).sum::<u64>();
        for (h, bytes) in asked.iter().zip(got) {
            for c in check(h, &bytes)? {
                if !self.records.contains_key(&c) {
                    d.next.push(c);
                }
            }
            d.s.got += bytes.len() as u64;
            d.s.fetched += 1;
            self.records.insert(h.clone(), bytes);
            d.taken.push(h.clone());
        }
        Ok(())
    }

    /// Rule 3's let go, once [`Copy::ask`] gives nothing more: the scope's new hashes become the copy's.
    pub fn finish(&mut self, mut d: Descent) -> R<Synced> {
        let reached = match self.reach_from(&d.roots) {
            Ok(r) => r,
            Err(e) => {
                self.abandon(d);
                return Err(e);
            }
        };
        self.roots = std::mem::take(&mut d.roots);
        self.records.retain(|h, _| reached.contains(h));
        d.s.held = reached.len();
        Ok(d.s)
    }

    /// A sync that will not finish (its socket closed, or an answer was refused): the records it took are let go and
    /// the copy is as it was. Compare only descends from a hash it does not hold, so it must never hold a record
    /// without the records below it, or the next sync would stop short of them (`sync-missing`, #3424).
    pub fn abandon(&mut self, d: Descent) {
        for h in d.taken {
            self.records.remove(&h);
        }
    }

    /// The bytes of every record held: what a snapshot of the scope (a sync from nothing) would fetch.
    pub fn held_bytes(&self) -> u64 {
        self.records.values().map(|b| b.len() as u64).sum()
    }

    /// The hashes the scope reaches, each record held and checked; refused by name if one is missing.
    pub fn reach(&self) -> R<BTreeSet<Vec<u8>>> {
        self.reach_from(&self.roots)
    }

    fn reach_from(&self, roots: &BTreeMap<Id, Vec<u8>>) -> R<BTreeSet<Vec<u8>>> {
        let mut seen = BTreeSet::new();
        let mut stack: Vec<Vec<u8>> = roots.values().cloned().collect();
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

/// Sync over a socket (R5b, #3164): the keys of a request and its answer, beside an intent's (1 to 11), so the
/// gateway tells the two apart by key 20. A client asks `{20: n, 21: [ids]}` (their hashes; no ids asks for the scope
/// the world grants it) or `{20: n, 22: [hashes]}` (their records). The gateway adds 23, the asking actor's bytes, and
/// numbers the request its own way. The world answers `{20: n, 1: version, 25: [ids], 21: [hashes]}` (empty bytes for
/// a node not here or not granted), `{20: n, 22: [records]}`, or `{20: n, 24: refusal name}`.
pub mod wire {
    pub const ASK: u64 = 20;
    pub const IDS: u64 = 21;
    pub const RECORDS: u64 = 22;
    pub const ACTOR: u64 = 23;
    pub const REFUSED: u64 = 24;
    pub const SCOPE: u64 = 25;
    /// Hashes asked for in one request: 64 of 36 bytes fits an intent's limit (T10 rule 11), which a request shares.
    pub const RECORDS_MOST: usize = 64;
}

/// The world's answer to one sync request ([`wire`]) from an actor granted the scope `granted`, at version `now`;
/// the caller adds the request's number.
pub fn answer(
    src: &mut dyn Source,
    granted: &[Id],
    ask: &BTreeMap<u64, Value>,
    now: Value,
) -> BTreeMap<u64, Value> {
    let r = (|| -> R<BTreeMap<u64, Value>> {
        match (ask.get(&wire::IDS), ask.get(&wire::RECORDS)) {
            (Some(Value::Array(ids)), None) => {
                let ids: Vec<Id> = if ids.is_empty() {
                    granted.to_vec()
                } else {
                    ids.iter().map(crate::effects::read_id).collect::<R<_>>()?
                };
                let hashes = src
                    .hashes(&ids)?
                    .into_iter()
                    .zip(&ids)
                    .map(|(h, id)| match h {
                        Some(h) if granted.contains(id) => Value::Bytes(h.to_bytes()),
                        _ => Value::Bytes(Vec::new()),
                    })
                    .collect();
                Ok(BTreeMap::from([
                    (1, now),
                    (wire::IDS, Value::Array(hashes)),
                    (
                        wire::SCOPE,
                        Value::Array(ids.iter().map(|id| id.to_value()).collect()),
                    ),
                ]))
            }
            (None, Some(Value::Array(hs))) if hs.len() <= wire::RECORDS_MOST => {
                let hs = hs
                    .iter()
                    .map(|h| match h {
                        Value::Bytes(b) => Ok(b.clone()),
                        _ => refuse("sync-ask", "a hash is not bytes"),
                    })
                    .collect::<R<Vec<_>>>()?;
                let got = src.records(&hs)?;
                Ok(BTreeMap::from([(
                    wire::RECORDS,
                    Value::Array(got.into_iter().map(Value::Bytes).collect()),
                )]))
            }
            _ => refuse("sync-ask", "ids, or at most 64 hashes"),
        }
    })();
    r.unwrap_or_else(|e| {
        let name =
            crate::encode::Name::new(e.name).unwrap_or_else(|| unreachable!("a refusal's name"));
        BTreeMap::from([(wire::REFUSED, Value::Text(name))])
    })
}

/// Each scope node's hash as its bytes, none for a node not here or not granted.
pub type RootHashes = Vec<Option<Vec<u8>>>;

/// A hashes answer's scope ids and hashes ([`wire`]), as [`Copy::compare`] takes them.
pub fn read_hashes(m: &BTreeMap<u64, Value>) -> R<(Vec<Id>, RootHashes)> {
    let (Some(Value::Array(ids)), Some(Value::Array(hs))) =
        (m.get(&wire::SCOPE), m.get(&wire::IDS))
    else {
        return refuse("sync-answer", "not ids and hashes");
    };
    if ids.len() != hs.len() {
        return refuse("sync-answer", "ids and hashes of other lengths");
    }
    let ids = ids
        .iter()
        .map(crate::effects::read_id)
        .collect::<R<Vec<_>>>()?;
    let hs = hs
        .iter()
        .map(|h| match h {
            Value::Bytes(b) if b.is_empty() => Ok(None),
            Value::Bytes(b) if b.len() == 34 => Ok(Some(b.clone())),
            _ => refuse("sync-answer", "a hash is not 34 bytes"),
        })
        .collect::<R<Vec<_>>>()?;
    Ok((ids, hs))
}

/// A records answer's records ([`wire`]).
pub fn read_records(m: &BTreeMap<u64, Value>) -> R<Vec<Vec<u8>>> {
    let Some(Value::Array(rs)) = m.get(&wire::RECORDS) else {
        return refuse("sync-answer", "not records");
    };
    rs.iter()
        .map(|r| match r {
            Value::Bytes(b) => Ok(b.clone()),
            _ => refuse("sync-answer", "a record is not bytes"),
        })
        .collect()
}
