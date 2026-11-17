//! Durability twice, one writer by epoch, and the directory (contract T11; Engine v2 T11, #2665). The rules are
//! numbered in `v2/docs/durability.md`. Everything here is a fake, in memory: an object store with exactly the
//! conditional writes S3 and R2 offer, the directory's records in it, a machine's disk, and a writer. The real log,
//! shipping and directory (K4, O3, W8) and pinning builds (O1, O7) are not here.

use std::collections::BTreeMap;

use crate::effects::{Refusal, read_id};
use crate::encode::{Name, Value, decode, encode, to_hex};
use crate::ids::Id;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

// --- The object store ---------------------------------------------------------------------------------------------

/// A write's condition (rule 7), the only two a store is asked for: create the object only if it does not exist
/// (`If-None-Match: *`), or replace it only if it is the version read (`If-Match: <etag>`). There is no plain write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum When {
    Absent,
    Is(u64),
}

/// A fake object store (rules 7 and 8): objects by key, each with a version. A write whose condition fails is refused
/// by the store, `precondition-failed` (HTTP 412), whatever the writer believes. A real store's version is an ETag,
/// a hash of the content; that is as good here because a record's takeovers never repeat (rule 10).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Store {
    objects: BTreeMap<String, (u64, Vec<u8>)>,
    next: u64,
}

impl Store {
    pub fn get(&self, key: &str) -> Option<(u64, Vec<u8>)> {
        self.objects.get(key).cloned()
    }

    /// Writes `bytes` under `key` if `when` holds, atomically; returns the new version.
    pub fn put(&mut self, key: &str, bytes: Vec<u8>, when: When) -> R<u64> {
        let now = self.objects.get(key).map(|(v, _)| *v);
        match (when, now) {
            (When::Absent, None) => {}
            (When::Is(v), Some(n)) if v == n => {}
            _ => {
                return refuse(
                    "precondition-failed",
                    format!("{key}: asked {when:?}, the store holds {now:?}"),
                );
            }
        }
        self.next += 1;
        self.objects.insert(key.to_owned(), (self.next, bytes));
        Ok(self.next)
    }

    /// Keys under `prefix`, in order.
    pub fn list(&self, prefix: &str) -> Vec<String> {
        self.objects
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect()
    }
}

// --- The directory --------------------------------------------------------------------------------------------------

/// A claim's token (rule 5): 16 bytes the claimant draws from the operating system's random source each time it
/// claims, like a T3 scope. It, not the machine's name, is what tells one claim from another: two processes on one
/// machine, or one machine claiming again, draw different tokens.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Token(pub [u8; 16]);

impl Token {
    /// Draws a token from the operating system's random source, never from the world's random numbers.
    pub fn draw() -> R<Token> {
        use std::io::Read;
        let mut bytes = [0u8; 16];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut bytes))
            .or_else(|e| refuse("no-random-source", e.to_string()))?;
        Ok(Token(bytes))
    }

    pub fn hex(&self) -> String {
        to_hex(&self.0)
    }
}

/// One claim of a zone (rule 5): its epoch, the sequence it took over at, the machine it runs on, and the token its
/// claimant drew. The token names the claim; the machine is only where it runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Takeover {
    pub epoch: u64,
    pub from: u64,
    pub machine: Name,
    pub token: Token,
}

/// A world's directory record (rules 9 and 10), one per zone of a lineage (a world has one zone today), at
/// `world/<lineage>/<zone>`: `{1: lineage, 2: zone, 3: where it runs, 4: epoch, 5: takeovers, 6: off-machine mark,
/// 7: when it must wake, 8: pinned build}`. 5 is `[[epoch, from, machine, token], ...]` since the last checkpoint, oldest
/// first, its last the claim in force (3 and 4 repeat it). 6 is left out until the first part is off the machine, 7
/// while the world is awake.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldRecord {
    pub lineage: [u8; 16],
    pub zone: Id,
    pub takeovers: Vec<Takeover>,
    /// The last sequence stored off the machine.
    pub mark: Option<u64>,
    /// When a sleeping world must wake: real time in microseconds since 1970.
    pub wake: Option<u64>,
    /// The hash of the build that runs it, which a client's checker is loaded by (T10).
    pub build: Vec<u8>,
}

fn key(lineage: &[u8; 16], zone: Id) -> String {
    format!(
        "{}/{}-{}",
        to_hex(lineage),
        to_hex(&zone.scope().0),
        zone.counter()
    )
}

fn nobody() -> Name {
    Name::new("souls:nobody").unwrap_or_else(|| unreachable!("a name"))
}

impl WorldRecord {
    pub fn key(lineage: &[u8; 16], zone: Id) -> String {
        format!("world/{}", key(lineage, zone))
    }

    /// The claim in force.
    pub fn current(&self) -> Option<&Takeover> {
        self.takeovers.last()
    }

    /// Whose parts are history at `sequence` (rule 8): the last takeover at or before it.
    pub fn in_force(&self, sequence: u64) -> Option<&Takeover> {
        self.takeovers.iter().rev().find(|t| t.from <= sequence)
    }

    pub fn to_bytes(&self) -> R<Vec<u8>> {
        let (machine, epoch) = self
            .current()
            .map_or((nobody(), 0), |t| (t.machine.clone(), t.epoch));
        let takeovers = self
            .takeovers
            .iter()
            .map(|t| {
                Value::Array(vec![
                    Value::Uint(t.epoch),
                    Value::Uint(t.from),
                    Value::Text(t.machine.clone()),
                    Value::Bytes(t.token.0.to_vec()),
                ])
            })
            .collect();
        let mut m = BTreeMap::from([
            (1, Value::Bytes(self.lineage.to_vec())),
            (2, self.zone.to_value()),
            (3, Value::Text(machine)),
            (4, Value::Uint(epoch)),
            (5, Value::Array(takeovers)),
            (8, Value::Bytes(self.build.clone())),
        ]);
        m.extend(self.mark.map(|s| (6, Value::Uint(s))));
        m.extend(self.wake.map(|w| (7, Value::Uint(w))));
        encode(&Value::Map(m)).or_else(|e| refuse("encoding", e.to_string()))
    }

    /// Reads a record, refusing one whose fields 3 and 4 are not its last takeover (`record-inconsistent`).
    pub fn read(bytes: &[u8]) -> R<WorldRecord> {
        let v = decode(bytes)
            .or_else(|e| refuse("encoding", e.to_string()))?
            .value;
        let bad = || {
            refuse(
                "record-not-a-record",
                "{1: lineage, 2: zone, 3: where, 4: epoch, 5: takeovers, 6: mark, 7: wake, 8: build}",
            )
        };
        let Value::Map(m) = v else { return bad() };
        if m.keys().any(|k| *k == 0 || *k > 8) {
            return bad();
        }
        let uint = |k| match m.get(&k) {
            Some(Value::Uint(n)) => Some(*n),
            _ => None,
        };
        let (
            Some(Value::Bytes(lineage)),
            Some(Value::Text(machine)),
            Some(epoch),
            Some(Value::Array(ts)),
            Some(Value::Bytes(build)),
        ) = (m.get(&1), m.get(&3), uint(4), m.get(&5), m.get(&8))
        else {
            return bad();
        };
        let Ok(lineage) = <[u8; 16]>::try_from(lineage.as_slice()) else {
            return bad();
        };
        let mut takeovers = Vec::new();
        for t in ts {
            let Value::Array(t) = t else { return bad() };
            let [
                Value::Uint(e),
                Value::Uint(f),
                Value::Text(n),
                Value::Bytes(k),
            ] = t.as_slice()
            else {
                return bad();
            };
            let Ok(token) = <[u8; 16]>::try_from(k.as_slice()) else {
                return bad();
            };
            takeovers.push(Takeover {
                epoch: *e,
                from: *f,
                machine: n.clone(),
                token: Token(token),
            });
        }
        if build.len() != 34 {
            return bad();
        }
        let rec = WorldRecord {
            lineage,
            zone: read_id(m.get(&2).unwrap_or(&Value::Uint(0)))?,
            takeovers,
            mark: uint(6),
            wake: uint(7),
            build: build.clone(),
        };
        let current = rec
            .current()
            .map_or((nobody(), 0), |t| (t.machine.clone(), t.epoch));
        if current != (machine.clone(), epoch) {
            return refuse(
                "record-inconsistent",
                "fields 3 and 4 are its last takeover",
            );
        }
        Ok(rec)
    }
}

/// Where a Soul is (rule 11), at `soul/<soul>`: `{1: soul, 2: lineage of its world, 3: zone}`. It changes by the same
/// conditional write, when a Soul travels (T1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SoulRecord {
    pub soul: Id,
    pub lineage: Vec<u8>,
    pub zone: Id,
}

impl SoulRecord {
    pub fn to_bytes(&self) -> R<Vec<u8>> {
        let v = Value::Map(BTreeMap::from([
            (1, self.soul.to_value()),
            (2, Value::Bytes(self.lineage.clone())),
            (3, self.zone.to_value()),
        ]));
        encode(&v).or_else(|e| refuse("encoding", e.to_string()))
    }
}

/// Reads a world's record and its version.
pub fn read_record(store: &Store, lineage: &[u8; 16], zone: Id) -> R<(u64, WorldRecord)> {
    let Some((v, bytes)) = store.get(&WorldRecord::key(lineage, zone)) else {
        return refuse("record-missing", WorldRecord::key(lineage, zone));
    };
    Ok((v, WorldRecord::read(&bytes)?))
}

/// Changes a world's record by a conditional write on the version read (rule 10). A write between the read and this
/// one makes it `precondition-failed`; the caller reads again.
pub fn change(store: &mut Store, read: u64, rec: &WorldRecord) -> R<u64> {
    store.put(
        &WorldRecord::key(&rec.lineage, rec.zone),
        rec.to_bytes()?,
        When::Is(read),
    )
}

// --- Writers, disks and parts -------------------------------------------------------------------------------------

/// A part's name in the object store (rule 8): `part/<lineage>/<zone>/<epoch>/<token>/<sequence>`, the token in hex
/// and the numbers as 20 digits, created only, never replaced. No other writer makes a part under a claim, because no
/// other drew its token. The machine is not in the name.
pub fn part_key(lineage: &[u8; 16], zone: Id, t: &Takeover, sequence: u64) -> String {
    format!(
        "part/{}/{:020}/{}/{sequence:020}",
        key(lineage, zone),
        t.epoch,
        t.token.hex()
    )
}

/// A part's bytes: `[epoch, sequence]` (the fake's stand-in for the entries it carries).
fn part_bytes(epoch: u64, sequence: u64) -> R<Vec<u8>> {
    encode(&Value::Array(vec![
        Value::Uint(epoch),
        Value::Uint(sequence),
    ]))
    .or_else(|e| refuse("encoding", e.to_string()))
}

/// A machine's disk (rule 1), the first durable point: what is written there, by sequence, with the epoch that wrote
/// it. It refuses a write of an epoch lower than one it has seen (`epoch-stale`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Disk {
    pub entries: BTreeMap<u64, u64>,
    pub highest: u64,
}

impl Disk {
    pub fn write(&mut self, epoch: u64, sequence: u64) -> R<()> {
        if epoch < self.highest {
            return refuse(
                "epoch-stale",
                format!("epoch {epoch} after {}", self.highest),
            );
        }
        self.highest = epoch;
        self.entries.insert(sequence, epoch);
        Ok(())
    }
}

/// How far an effect must be durable before it is acknowledged (rules 2 and 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stakes {
    /// Acknowledged once it is on the machine's disk: every act, a swap of things or amounts included.
    Disk,
    /// Cannot be undone (travel between worlds, and what the owner names later): acknowledged only once the
    /// off-machine mark covers it.
    OffMachine,
}

/// One zone's writer (rules 4 to 8): its machine, its claim once made, its lease measured on its own machine's clock
/// from when its last renewing write was sent, the record's version it last wrote, and the effects it has written and
/// not yet acknowledged.
#[derive(Clone, Debug)]
pub struct Writer {
    pub machine: Name,
    pub lineage: [u8; 16],
    pub zone: Id,
    pub claim: Option<Takeover>,
    pub version: u64,
    pub disk: Disk,
    pub since_renewed: u64,
    pub lease: u64,
    pub next: u64,
    pub waiting: Vec<(u64, Stakes)>,
    pub acknowledged: Vec<u64>,
}

impl Writer {
    pub fn new(machine: &str, lineage: [u8; 16], zone: Id, lease: u64) -> Writer {
        Writer {
            machine: Name::new(machine)
                .unwrap_or_else(|| unreachable!("a machine's name is a name")),
            lineage,
            zone,
            claim: None,
            version: 0,
            disk: Disk::default(),
            since_renewed: 0,
            lease,
            next: 0,
            waiting: Vec::new(),
            acknowledged: Vec::new(),
        }
    }

    /// Claims the zone (rule 5): reads the record and writes it back with a new takeover (the next epoch, the mark
    /// plus one, this machine, and a token drawn now), conditional on the version read.
    pub fn claim(&mut self, store: &mut Store) -> R<u64> {
        let read = read_record(store, &self.lineage, self.zone)?;
        self.claim_from(store, read)
    }

    /// Claims the zone from a record already read (two writers starting at once both read first). Its disk then keeps
    /// nothing at or after the takeover, and nothing waits on what it dropped (rule 3).
    pub fn claim_from(&mut self, store: &mut Store, read: (u64, WorldRecord)) -> R<u64> {
        let (v, mut rec) = read;
        let t = Takeover {
            epoch: rec.current().map_or(0, |t| t.epoch) + 1,
            from: rec.mark.map_or(0, |m| m + 1),
            machine: self.machine.clone(),
            token: Token::draw()?,
        };
        rec.takeovers.push(t.clone());
        self.version = change(store, v, &rec)?;
        self.disk.entries.retain(|s, _| *s < t.from);
        self.waiting.clear();
        self.next = t.from;
        self.since_renewed = 0;
        let epoch = t.epoch;
        self.claim = Some(t);
        Ok(epoch)
    }

    /// Time passes on this machine (a pause is time passing).
    pub fn elapse(&mut self, micros: u64) {
        self.since_renewed = self.since_renewed.saturating_add(micros);
    }

    /// Writes an effect to the machine's disk (rule 1), and acknowledges it now if its stakes allow and the lease has
    /// not lapsed (rule 6: a writer past its lease acknowledges nothing).
    pub fn write(&mut self, stakes: Stakes) -> R<u64> {
        let Some(t) = &self.claim else {
            return refuse("not-claimed", "a writer writes only under a claim it holds");
        };
        let s = self.next;
        self.disk.write(t.epoch, s)?;
        self.next += 1;
        self.waiting.push((s, stakes));
        self.acknowledge(None);
        Ok(s)
    }

    fn acknowledge(&mut self, mark: Option<u64>) {
        if self.since_renewed > self.lease {
            return;
        }
        let (now, later): (Vec<_>, Vec<_>) = self
            .waiting
            .iter()
            .partition(|(s, k)| *k == Stakes::Disk || mark.is_some_and(|m| *s <= m));
        self.acknowledged.extend(now.iter().map(|(s, _)| *s));
        self.waiting = later;
    }

    /// Ships its claim's entries off the machine (rules 7 and 8): each part created only, under this claim's token,
    /// then the record's mark moved by a write conditional on the version of the same read it writes from. A part
    /// already there with the same bytes is this claim's own earlier ship, retried; any other refused create stops the
    /// ship (`part-exists`). The claim must still be in force, token and all; otherwise it was taken, and nothing
    /// waiting is acknowledged. A record write refused because the record changed after that read is read and tried
    /// once more. With nothing new it still rewrites the record: a heartbeat. A success renews the lease from before
    /// its write was sent.
    pub fn ship(&mut self, store: &mut Store) -> R<Option<u64>> {
        let Some(t) = self.claim.clone() else {
            return refuse("not-claimed", "a writer ships only under a claim it holds");
        };
        let sent = self.since_renewed;
        let mine: Vec<u64> = self
            .disk
            .entries
            .iter()
            .filter(|(s, e)| **e == t.epoch && **s >= t.from)
            .map(|(s, _)| *s)
            .collect();
        for s in &mine {
            let k = part_key(&self.lineage, self.zone, &t, *s);
            let bytes = part_bytes(t.epoch, *s)?;
            if store.put(&k, bytes.clone(), When::Absent).is_err()
                && store.get(&k).map(|(_, b)| b) != Some(bytes)
            {
                return refuse("part-exists", k);
            }
        }
        let last = mine.last().copied();
        for _ in 0..2 {
            let (v, mut rec) = read_record(store, &self.lineage, self.zone)?;
            if rec.current() != Some(&t) {
                return refuse("precondition-failed", "the claim was taken");
            }
            if let Some(l) = last {
                rec.mark = Some(rec.mark.map_or(l, |m| m.max(l)));
            }
            if let Ok(n) = change(store, v, &rec) {
                self.version = n;
                self.since_renewed = self.since_renewed.saturating_sub(sent);
                self.acknowledge(rec.mark);
                return Ok(rec.mark);
            }
        }
        refuse("precondition-failed", "the record kept changing")
    }
}

/// What a reader makes of a zone's parts (rule 8).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Readable {
    /// The history, as (epoch, sequence).
    pub kept: Vec<(u64, u64)>,
    /// Parts ignored, as (epoch, sequence, why): `superseded-epoch` or `past-the-mark`.
    pub ignored: Vec<(u64, u64, &'static str)>,
    /// Keys under the zone's prefix that are not a part's name, named, never skipped silently.
    pub unreadable: Vec<String>,
}

/// A part's name after the zone's prefix: `<epoch>/<token>/<sequence>`, 20 digits, 32 lowercase hex, 20 digits.
fn parse_part(rest: &str) -> Option<(u64, &str, u64)> {
    let digits = |p: &str| {
        (p.len() == 20 && p.bytes().all(|b| b.is_ascii_digit()))
            .then(|| p.parse::<u64>().ok())
            .flatten()
    };
    let hex = |p: &str| p.len() == 32 && p.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let [e, k, s] = rest.split('/').collect::<Vec<_>>()[..] else {
        return None;
    };
    Some((digits(e)?, hex(k).then_some(k)?, digits(s)?))
}

/// The parts a reader keeps (rule 8): a part is history only if its claim (epoch and token) is the one in force at
/// its sequence and it is at or before the mark. Any other is ignored by name: `superseded-epoch` (another claim holds
/// that sequence) or `past-the-mark` (not acknowledged off the machine). A key that is not a part's name is listed as
/// unreadable.
pub fn readable(store: &Store, lineage: &[u8; 16], zone: Id) -> R<Readable> {
    let (_, rec) = read_record(store, lineage, zone)?;
    let prefix = format!("part/{}/", key(lineage, zone));
    let mut out = Readable::default();
    for k in store.list(&prefix) {
        let Some((e, token, s)) = parse_part(&k[prefix.len()..]) else {
            out.unreadable.push(k);
            continue;
        };
        let force = rec.in_force(s);
        if force.is_none_or(|t| t.epoch != e || t.token.hex() != token) {
            out.ignored.push((e, s, "superseded-epoch"));
        } else if rec.mark.is_none_or(|m| s > m) {
            out.ignored.push((e, s, "past-the-mark"));
        } else {
            out.kept.push((e, s));
        }
    }
    Ok(out)
}
