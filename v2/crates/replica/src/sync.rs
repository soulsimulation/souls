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
//!    world or a cache that sends a wrong record is refused by name, once: when it is taken. Records the scope no
//!    longer reaches are let go, so the copy is exactly the scope. A node's big fields are records of their own,
//!    named from its record (key 0, `tree::BIG_FIELD`, #4713), fetched like its children: a Soul walking on the
//!    ground changes the ground's record, which names its children, but not its terrain's.
//! 4. **The bytes are counted** ([`Synced`]): a room of 5,000 children lists 5,000 hashes (34 bytes each) to find one
//!    change.
//!
//! Over the gateway (R5b, #3164), the same steps ([`Copy::compare`], [`Copy::ask`], [`Copy::take`], [`Copy::finish`])
//! run with several requests in flight (N12): a request's answer may come while others are out, and the records it
//! names below are asked for at once, whatever level they are on; a hash asked and not yet answered is never asked
//! again. Over a link with a long round trip the rounds overlap: Eden's first sync is about 156 requests of
//! [`wire::RECORDS_MOST`], one after another 22 s at soul.game's 140 ms. `gatewayd/src/lib.rs` names the frames, and
//! the world answers for the asking actor's scope.
//!
//! 5. **A sync cut off resumes** ([`Copy::abandon`]): the records it took and checked are kept aside, loose, and the
//!    next sync takes each one it reaches from there instead of asking for it again; what it does not reach is let go
//!    when it finishes. A hash names the same record for ever, so a loose record is still the one it names.
//!
//! Not here: missed events (speech to me) are not state and are not restored. The library a client checks with is loaded by its build hash in `v2/client/src/sync/library.mjs`.

use crate::effects::Refusal;
use crate::encode::{Value, decode, encode};
use crate::ids::{Hash, Id, Purpose, Version};
use crate::tree::{Sealed, Tree};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

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

/// A replaced record this large or larger is a big one ([`BIG_SEALS`]).
pub const BIG_RECORD: usize = 64 * 1024;
/// How many seals a replaced big record is still served after (#1960). A record re-sealed often and big is a moving
/// body's ancestor near the top (Eden's ground, before its terrain became a record of its own, #4713), which a descent asks
/// for in its first rounds, right after the hashes answer.
pub const BIG_SEALS: u64 = 16;
/// How many seals a replaced small record (a body, a room) is still served after: a descent of a large scope asks for
/// its leaves many rounds after the hashes answer that named them ([`wire::RECORDS_MOST`] a round).
pub const SMALL_SEALS: u64 = 1024;
/// At most this many bytes of replaced small records are kept; the oldest go first (never the newest seal's).
pub const SMALL_BYTES: usize = 64 << 20;

/// A record a seal replaced: when, whose, its hash and its size.
struct Replaced {
    seal: u64,
    node: (Id, u64),
    hash: Vec<u8>,
    size: usize,
}

/// The world's records by hash: each node's record as last sealed (K5's checkpoint blobs are the same bytes), and
/// the records seals replaced lately, for a descent still under way (#1960: a moving body re-seals itself and its
/// ancestors at each seal, and keeping every record a seal ever gave grew worldd 5 to 9 MB a second while one Soul
/// walked). A replaced record is kept [`BIG_SEALS`] seals if big, else [`SMALL_SEALS`] seals within
/// [`SMALL_BYTES`]; a descent that then asks for it is refused `sync-unknown-hash`, and the client syncs again.
#[derive(Default)]
pub struct Records {
    by_hash: BTreeMap<Vec<u8>, Vec<u8>>,
    /// Each node's record hash as last kept, and each of its big fields' (`(id, 0)` its own, `(id, field)` a field's).
    current: BTreeMap<(Id, u64), Vec<u8>>,
    /// Big and small records seals replaced, oldest first, and the small ones' bytes.
    big: VecDeque<Replaced>,
    small: VecDeque<Replaced>,
    small_bytes: usize,
    /// The last seal each replaced hash was replaced at: a hash replaced again later waits for the later entry.
    replaced_at: BTreeMap<Vec<u8>, u64>,
    seals: u64,
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

    /// Keeps the records a seal gave, and lets go of the replaced ones past their window.
    pub fn keep(&mut self, sealed: &Sealed) {
        self.seals += 1;
        let seal = self.seals;
        for ((h, bytes), id) in sealed.nodes.iter().zip(&sealed.ids) {
            let h = h.to_bytes();
            self.by_hash
                .entry(h.clone())
                .or_insert_with(|| bytes.clone());
            if let Some(old) = self.current.insert(*id, h.clone())
                && old != h
            {
                let size = self.by_hash.get(&old).map_or(0, Vec::len);
                self.replaced_at.insert(old.clone(), seal);
                let r = Replaced {
                    seal,
                    node: *id,
                    hash: old,
                    size,
                };
                if size >= BIG_RECORD {
                    self.big.push_back(r);
                } else {
                    self.small_bytes += size;
                    self.small.push_back(r);
                }
            }
        }
        while self.big.front().is_some_and(|r| r.seal + BIG_SEALS <= seal) {
            if let Some(r) = self.big.pop_front() {
                self.let_go(r);
            }
        }
        while self.small.front().is_some_and(|r| {
            r.seal + SMALL_SEALS <= seal || (self.small_bytes > SMALL_BYTES && r.seal < seal)
        }) {
            if let Some(r) = self.small.pop_front() {
                self.small_bytes -= r.size;
                self.let_go(r);
            }
        }
    }

    /// Drops a replaced record, unless it was replaced again since (the later entry lets it go) or is its node's
    /// record again.
    fn let_go(&mut self, r: Replaced) {
        if self.replaced_at.get(&r.hash) != Some(&r.seal) {
            return;
        }
        self.replaced_at.remove(&r.hash);
        if self.current.get(&r.node) != Some(&r.hash) {
            self.by_hash.remove(&r.hash);
        }
    }

    /// How far back, in seals, each window reaches now: the seals since the oldest replaced record still kept was
    /// replaced (0 when none is kept). The small window falls under [`SMALL_SEALS`] when [`SMALL_BYTES`] binds.
    pub fn windows(&self) -> Windows {
        let back = |q: &VecDeque<Replaced>| q.front().map_or(0, |r| self.seals - r.seal);
        Windows {
            small: back(&self.small),
            big: back(&self.big),
        }
    }

    pub fn len(&self) -> usize {
        self.by_hash.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_hash.is_empty()
    }

    /// The bytes of the records held (a measure).
    pub fn bytes(&self) -> usize {
        self.by_hash.values().map(Vec::len).sum()
    }
}

/// How far back each of [`Records`]' windows reaches, in seals ([`Records::windows`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Windows {
    pub small: u64,
    pub big: u64,
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
    /// Names the let go looked at ([`Copy::finish`]): the scope's old hashes and what each record let go named, so a
    /// sync that changed little looks at little, however much the copy holds.
    pub walked: usize,
    /// Records taken from a sync cut off before ([`Copy::abandon`]) instead of being asked for again.
    pub reused: usize,
    /// The most requests that were in flight at once.
    pub in_flight: usize,
}

/// A sync under way ([`Copy::compare`]): the records still to ask for in this level, the next level's, the count,
/// the scope's new hashes (the copy's own only once it finishes), and the records it has taken so far.
pub struct Descent {
    want: Vec<Vec<u8>>,
    next: Vec<Vec<u8>>,
    /// Asked and not yet answered, and the requests they are in.
    pending: BTreeSet<Vec<u8>>,
    requests: usize,
    /// Answered withheld in this sync: held empty, never asked for again in it however often they are named.
    withheld: BTreeSet<Vec<u8>>,
    s: Synced,
    roots: BTreeMap<Id, Vec<u8>>,
    taken: Vec<Vec<u8>>,
}

impl Descent {
    /// Requests asked ([`Copy::ask`]) and not yet answered ([`Copy::take`]).
    pub fn in_flight(&self) -> usize {
        self.requests
    }
}

/// A loose record ([`Copy::abandon`]): its bytes, and the hashes it names below it.
type Loose = (Vec<u8>, Vec<Vec<u8>>);

/// A client's copy of its scope: each scope node's hash, and the records it reaches, by hash. A record the world
/// withheld (empty bytes in its answer: under a closed container this asker may not see into, #3915) is held as
/// withheld: a leaf the copy never reads.
#[derive(Clone, Default)]
pub struct Copy {
    roots: BTreeMap<Id, Vec<u8>>,
    records: BTreeMap<Vec<u8>, Vec<u8>>,
    /// The hashes each held record names below it, as [`check`] gave them when it was taken: what the let go follows,
    /// without decoding or hashing a record again (#4713).
    below: BTreeMap<Vec<u8>, Vec<Vec<u8>>>,
    /// How many times each hash is named: once for each scope node at it, and once by each held record that names it
    /// below. A record named by nothing is let go, with what only it named: a sync's let go follows what the sync
    /// changed, not every record held (Eden's 9,588, walked at each confirm, held a daemon's loop for half a second).
    named: BTreeMap<Vec<u8>, u32>,
    /// The bytes of every record held.
    bytes: u64,
    /// Records a sync cut off had taken, checked, with the hashes each names below it: the next sync takes them from
    /// here (rule 5), and lets go of the rest when it finishes.
    loose: BTreeMap<Vec<u8>, Loose>,
}

/// Checks a record against the hash that named it (rule 3) and gives the hashes it names below it: its big fields'
/// records (key 0) and its children's (field 10).
fn check(want: &[u8], bytes: &[u8]) -> R<Vec<Vec<u8>>> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
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
    let mut below = Vec::new();
    match m.get(&0) {
        None => {}
        Some(Value::Array(a)) => {
            for v in a {
                let Value::Array(p) = v else {
                    return refuse("sync-record", "a big field is not [field, hash]");
                };
                match p.as_slice() {
                    [Value::Uint(_), Value::Bytes(b)] if b.len() == 34 => below.push(b.clone()),
                    _ => return refuse("sync-record", "a big field is not [field, hash]"),
                }
            }
        }
        Some(_) => return refuse("sync-record", "big fields are not a list"),
    }
    match m.get(&10) {
        None => {}
        Some(Value::Array(a)) => {
            for v in a {
                match v {
                    Value::Bytes(b) if b.len() == 34 => below.push(b.clone()),
                    _ => return refuse("sync-record", "a child's hash is not 34 bytes"),
                }
            }
        }
        Some(_) => return refuse("sync-record", "children are not a list"),
    }
    Ok(below)
}

fn size(v: &Value) -> u64 {
    encode(v).map_or(0, |b| b.len() as u64)
}

impl Copy {
    /// Each scope node's hash.
    pub fn roots(&self) -> &BTreeMap<Id, Vec<u8>> {
        &self.roots
    }

    /// Whether the record a hash names is held, and not withheld: a withheld one is asked for again at every sync,
    /// since whether it may be seen is not in its hash (who may see into its container can change).
    fn holds(&self, hash: &[u8]) -> bool {
        self.records.get(hash).is_some_and(|b| !b.is_empty())
    }

    /// The record a hash names, if held; none for one withheld.
    pub fn record(&self, hash: &[u8]) -> Option<&[u8]> {
        self.records
            .get(hash)
            .filter(|b| !b.is_empty())
            .map(Vec::as_slice)
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
            if !self.holds(&h) {
                want.push(h.clone());
            }
            roots.insert(*id, h);
        }
        Descent {
            want: Vec::new(),
            next: want,
            pending: BTreeSet::new(),
            requests: 0,
            withheld: BTreeSet::new(),
            s,
            roots,
            taken: Vec::new(),
        }
    }

    /// The next records to ask for, at most `most`: the rest of what is known to be wanted, else what the answers
    /// since named below, not held and not asked already. A record a sync cut off took (rule 5) is taken here, not
    /// asked for. Empty when nothing more is to be asked for now: the descent is done once no request is in flight
    /// ([`Descent::in_flight`]) either.
    pub fn ask(&mut self, d: &mut Descent, most: usize) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        while out.len() < most {
            if d.want.is_empty() {
                // A child named twice, or asked for already, is fetched once.
                d.want = std::mem::take(&mut d.next);
                d.want.retain(|c| {
                    !self.holds(c) && !d.pending.contains(c) && !d.withheld.contains(c)
                });
                d.want.sort();
                d.want.dedup();
                d.want.reverse(); // taken from the end, in order
                if d.want.is_empty() {
                    break;
                }
            }
            let Some(h) = d.want.pop() else { break };
            if self.holds(&h) || d.pending.contains(&h) || d.withheld.contains(&h) {
                continue;
            }
            if let Some((bytes, below)) = self.loose.remove(&h) {
                d.s.reused += 1;
                self.keep(d, h, bytes, below);
                continue;
            }
            d.pending.insert(h.clone());
            out.push(h);
        }
        if !out.is_empty() {
            d.requests += 1;
            d.s.in_flight = d.s.in_flight.max(d.requests);
        }
        out
    }

    /// Records asked for by someone else's [`Copy::ask`], whose answer this copy will take: a mirror of another
    /// client's sync, which sees its requests and their answers go by (`v2/client/served`'s relays).
    pub fn expect(&mut self, d: &mut Descent, asked: &[Vec<u8>]) {
        d.pending.extend(asked.iter().cloned());
        d.requests += 1;
        d.s.in_flight = d.s.in_flight.max(d.requests);
    }

    /// Whether the descent is done: nothing in flight, and every record it knows of held or answered withheld.
    pub fn done(&self, d: &Descent) -> bool {
        d.requests == 0
            && d.want
                .iter()
                .chain(&d.next)
                .all(|h| self.holds(h) || d.withheld.contains(h))
    }

    /// A record checked against its hash, kept, and what it names below asked for next if not held.
    fn keep(&mut self, d: &mut Descent, h: Vec<u8>, bytes: Vec<u8>, below: Vec<Vec<u8>>) {
        for c in &below {
            if !self.holds(c) {
                d.next.push(c.clone());
            }
        }
        if self.holds(&h) {
            return; // held already: a hash names the same record for ever
        }
        // Withheld before (an empty record, naming nothing), or not held: kept as it came.
        for c in &below {
            *self.named.entry(c.clone()).or_default() += 1;
        }
        self.bytes += bytes.len() as u64;
        if let Some(old) = self.records.insert(h.clone(), bytes) {
            self.bytes -= old.len() as u64;
        }
        self.below.insert(h.clone(), below);
        d.taken.push(h);
    }

    /// The records `asked` came back as: each checked against its hash (rule 3), kept, and its children not held
    /// asked for in the next level.
    pub fn take(&mut self, d: &mut Descent, asked: &[Vec<u8>], got: Vec<Vec<u8>>) -> R<()> {
        if got.len() != asked.len() {
            return refuse("sync-record", "an answer of another length");
        }
        if !asked.iter().all(|h| d.pending.contains(h)) {
            return refuse("sync-record", "an answer to records not asked for");
        }
        d.requests = d.requests.saturating_sub(1);
        d.s.rounds += 1;
        d.s.sent += asked.iter().map(|h| h.len() as u64).sum::<u64>();
        for (h, bytes) in asked.iter().zip(got) {
            let below = check(h, &bytes)?;
            d.pending.remove(h);
            if bytes.is_empty() {
                d.withheld.insert(h.clone());
            }
            d.s.got += bytes.len() as u64;
            d.s.fetched += 1;
            self.keep(d, h.clone(), bytes, below);
        }
        Ok(())
    }

    /// Rule 3's let go, once [`Copy::ask`] gives nothing more: the scope's new hashes become the copy's, and a record
    /// no longer named is let go with what only it named. A record held before this sync holds everything below it
    /// (the copy is whole after each finish), so the scope is whole when each new hash and everything named by a
    /// record taken now is held: nothing else is looked at, and nothing is decoded or hashed again.
    pub fn finish(&mut self, mut d: Descent) -> R<Synced> {
        let missing = d
            .roots
            .values()
            .chain(
                d.taken
                    .iter()
                    .flat_map(|t| self.below.get(t).into_iter().flatten()),
            )
            .find(|h| !self.below.contains_key(*h))
            .cloned();
        if let Some(h) = missing {
            self.abandon(d);
            return refuse("sync-missing", crate::encode::to_hex(&h));
        }
        // Loose records this sync did not reach are no longer the scope's.
        self.loose.clear();
        let old = std::mem::replace(&mut self.roots, std::mem::take(&mut d.roots));
        for h in self.roots.values() {
            *self.named.entry(h.clone()).or_default() += 1;
        }
        let mut stack: Vec<Vec<u8>> = old.into_values().collect();
        while let Some(h) = stack.pop() {
            d.s.walked += 1;
            if !self.unname(&h) {
                continue;
            }
            if let Some(below) = self.below.remove(&h) {
                self.bytes -= self.records.remove(&h).map_or(0, |b| b.len() as u64);
                stack.extend(below);
            }
        }
        d.s.held = self.below.len();
        Ok(d.s)
    }

    /// One name of `h` gone; whether it is named no more.
    fn unname(&mut self, h: &[u8]) -> bool {
        match self.named.get_mut(h) {
            Some(n) if *n > 1 => {
                *n -= 1;
                false
            }
            Some(_) => {
                self.named.remove(h);
                true
            }
            None => true,
        }
    }

    /// A sync that will not finish (its socket closed, or an answer was refused): the records it took are let go and
    /// the copy is as it was. Compare only descends from a hash it does not hold, so it must never hold a record
    /// without the records below it, or the next sync would stop short of them (`sync-missing`, #3424). A record it
    /// took that something held before still names was withheld before (only those are asked for again), and is
    /// withheld again. What it took is kept loose (rule 5): the next sync takes it from there, never asking twice.
    pub fn abandon(&mut self, d: Descent) {
        for h in &d.taken {
            let Some(below) = self.below.remove(h) else {
                continue;
            };
            let bytes = self.records.remove(h).unwrap_or_default();
            self.bytes -= bytes.len() as u64;
            for c in &below {
                self.unname(c);
            }
            if !bytes.is_empty() {
                self.loose.insert(h.clone(), (bytes, below));
            }
        }
        for h in d.taken {
            if self.named.contains_key(&h) && !self.below.contains_key(&h) {
                self.records.insert(h.clone(), Vec::new());
                self.below.insert(h, Vec::new());
            }
        }
    }

    /// Field `n` of a node whose record is `record`: from its field 6, or from its big field's own record (key 0,
    /// `tree::BIG_FIELD`) if held. None when it has no such field or that record is not held.
    pub fn field(&self, record: &BTreeMap<u64, Value>, n: u64) -> Option<Value> {
        if let Some(Value::Map(f)) = record.get(&6)
            && let Some(v) = f.get(&n)
        {
            return Some(v.clone());
        }
        let Some(Value::Array(bigs)) = record.get(&0) else {
            return None;
        };
        let h = bigs.iter().find_map(|p| match p {
            Value::Array(p) => match p.as_slice() {
                [Value::Uint(f), Value::Bytes(h)] if *f == n => Some(h),
                _ => None,
            },
            _ => None,
        })?;
        match decode(self.record(h)?).ok()?.value {
            Value::Map(mut r) => match r.remove(&6) {
                Some(Value::Map(mut f)) => f.remove(&n),
                _ => None,
            },
            _ => None,
        }
    }

    /// The bytes of every record held: what a snapshot of the scope (a sync from nothing) would fetch.
    pub fn held_bytes(&self) -> u64 {
        self.bytes
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
