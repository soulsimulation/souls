//! Durability twice, one writer by epoch, and the directory (contract T11; Engine v2 T11, #2665). The rules are
//! numbered in `v2/docs/durability.md`. Everything here is a fake, in memory: an object store with exactly the
//! conditional writes S3 and R2 offer, the directory's records in it, a machine's disk, and a writer. The real log,
//! shipping and directory (K4, O3, W8) and pinning builds (O1, O7) are not here.

use std::collections::BTreeMap;

use crate::effects::{Refusal, read_id};
use crate::encode::{Name, Value, decode, encode};
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

/// A fake object store (rules 7 and 8): objects by key, each with a version (its etag). A write whose condition fails
/// is refused by the store, `precondition-failed` (HTTP 412), whatever the writer believes.
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

/// A world's directory record (rules 9 and 10), one per zone (a world has one zone today), at `world/<zone>`:
/// `{1: zone, 2: where it runs, 3: epoch, 4: from sequence, 5: off-machine mark, 6: when it must wake, 7: pinned
/// build}`. 6 is left out while the world is awake; 5 is left out until the first part is off the machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldRecord {
    pub zone: Id,
    /// The machine that runs it, by name (never a host or an address in anything published).
    pub runs_on: Name,
    /// A number that only grows; each claim takes the next.
    pub epoch: u64,
    /// The sequence this epoch took over at: older epochs' records from here on are ignored (`superseded-epoch`).
    pub from: u64,
    /// The last sequence stored off the machine.
    pub mark: Option<u64>,
    /// When a sleeping world must wake: real time in microseconds since the Unix epoch.
    pub wake: Option<i64>,
    /// The hash of the build that runs it, which a client's checker is loaded by (T10).
    pub build: Vec<u8>,
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

impl WorldRecord {
    pub fn key(zone: Id) -> String {
        format!("world/{}", crate::world_model::show(zone))
    }

    pub fn to_bytes(&self) -> R<Vec<u8>> {
        let mut m = BTreeMap::from([
            (1, self.zone.to_value()),
            (2, Value::Text(self.runs_on.clone())),
            (3, Value::Uint(self.epoch)),
            (4, Value::Uint(self.from)),
            (7, Value::Bytes(self.build.clone())),
        ]);
        m.extend(self.mark.map(|s| (5, Value::Uint(s))));
        m.extend(self.wake.map(|w| (6, int(w))));
        encode(&Value::Map(m)).or_else(|e| refuse("encoding", e.to_string()))
    }

    pub fn read(bytes: &[u8]) -> R<WorldRecord> {
        let v = decode(bytes)
            .or_else(|e| refuse("encoding", e.to_string()))?
            .value;
        let bad = || {
            refuse(
                "record-not-a-record",
                "{1: zone, 2: where, 3: epoch, 4: from, 5: mark, 6: wake, 7: build}",
            )
        };
        let Value::Map(m) = v else { return bad() };
        if m.keys().any(|k| *k == 0 || *k > 7) {
            return bad();
        }
        let uint = |k| match m.get(&k) {
            Some(Value::Uint(n)) => Some(*n),
            _ => None,
        };
        let (Some(Value::Text(runs_on)), Some(epoch), Some(from), Some(Value::Bytes(build))) =
            (m.get(&2), uint(3), uint(4), m.get(&7))
        else {
            return bad();
        };
        let wake = match m.get(&6) {
            None => None,
            Some(Value::Uint(u)) => {
                Some(i64::try_from(*u).or_else(|_| refuse("int-out-of-range", "wake"))?)
            }
            Some(Value::Nint(n)) => {
                Some(-1 - i64::try_from(*n).or_else(|_| refuse("int-out-of-range", "wake"))?)
            }
            Some(_) => return bad(),
        };
        if build.len() != 34 {
            return bad();
        }
        Ok(WorldRecord {
            zone: read_id(m.get(&1).unwrap_or(&Value::Uint(0)))?,
            runs_on: runs_on.clone(),
            epoch,
            from,
            mark: uint(5),
            wake,
            build: build.clone(),
        })
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
pub fn read_record(store: &Store, zone: Id) -> R<(u64, WorldRecord)> {
    let Some((v, bytes)) = store.get(&WorldRecord::key(zone)) else {
        return refuse("record-missing", WorldRecord::key(zone));
    };
    Ok((v, WorldRecord::read(&bytes)?))
}

/// Changes a world's record by a conditional write on the version read (rule 10): `change` sees the record as read.
/// A write between the read and this one makes it `precondition-failed`; the caller reads again.
pub fn change(store: &mut Store, zone: Id, read: u64, rec: &WorldRecord) -> R<u64> {
    store.put(&WorldRecord::key(zone), rec.to_bytes()?, When::Is(read))
}

// --- Writers, disks and parts -------------------------------------------------------------------------------------

/// A part's name in the object store (rule 8): zone, epoch and sequence, created only, never replaced.
pub fn part_key(zone: Id, epoch: u64, sequence: u64) -> String {
    format!(
        "part/{}/{epoch:020}/{sequence:020}",
        crate::world_model::show(zone)
    )
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

/// One zone's writer (rules 4 to 8): its machine, its epoch once claimed, its lease measured on its own machine's
/// clock, the record's version it last wrote, and the effects it has written and not yet acknowledged.
#[derive(Clone, Debug)]
pub struct Writer {
    pub machine: Name,
    pub zone: Id,
    pub epoch: Option<u64>,
    pub version: u64,
    pub disk: Disk,
    /// Elapsed microseconds on this machine since the lease was last renewed, and the lease's length.
    pub since_renewed: u64,
    pub lease: u64,
    pub next: u64,
    pub waiting: Vec<(u64, Stakes)>,
    pub acknowledged: Vec<u64>,
}

impl Writer {
    pub fn new(machine: &str, zone: Id, lease: u64) -> Writer {
        Writer {
            machine: Name::new(machine)
                .unwrap_or_else(|| unreachable!("a machine's name is a name")),
            zone,
            epoch: None,
            version: 0,
            disk: Disk::default(),
            since_renewed: 0,
            lease,
            next: 0,
            waiting: Vec::new(),
            acknowledged: Vec::new(),
        }
    }

    /// Claims the zone (rule 5): reads the record and writes it back with the next epoch, this machine, and the
    /// sequence it takes over at, conditional on the version read. Of two claims on one record, the store lets one
    /// through.
    pub fn claim(&mut self, store: &mut Store) -> R<u64> {
        let read = read_record(store, self.zone)?;
        self.claim_from(store, read)
    }

    /// Claims the zone from a record already read (two writers starting at once both read first).
    pub fn claim_from(&mut self, store: &mut Store, read: (u64, WorldRecord)) -> R<u64> {
        let (v, mut rec) = read;
        rec.epoch += 1;
        rec.runs_on = self.machine.clone();
        rec.from = rec.mark.map_or(0, |m| m + 1);
        self.version = change(store, self.zone, v, &rec)?;
        self.epoch = Some(rec.epoch);
        self.next = rec.from;
        self.since_renewed = 0;
        Ok(rec.epoch)
    }

    /// Time passes on this machine (a pause is time passing).
    pub fn elapse(&mut self, micros: u64) {
        self.since_renewed = self.since_renewed.saturating_add(micros);
    }

    /// Writes an effect to the machine's disk (rule 1), and acknowledges it now if its stakes allow and the lease has
    /// not lapsed (rule 6: a writer past its lease acknowledges nothing).
    pub fn write(&mut self, stakes: Stakes) -> R<u64> {
        let Some(epoch) = self.epoch else {
            return refuse(
                "not-claimed",
                "a writer writes only under an epoch it holds",
            );
        };
        let s = self.next;
        self.disk.write(epoch, s)?;
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

    /// Ships what is on the disk off the machine (rule 2): each part created only, under its zone, epoch and
    /// sequence, then the record's off-machine mark moved, conditional on the version this writer last wrote. A
    /// writer whose epoch was taken is refused there by the store (`precondition-failed`), so its mark never moves and
    /// nothing waiting for it is acknowledged. A success renews the lease.
    pub fn ship(&mut self, store: &mut Store) -> R<u64> {
        let Some(epoch) = self.epoch else {
            return refuse("not-claimed", "a writer ships only under an epoch it holds");
        };
        let Some(last) = self.disk.entries.keys().next_back().copied() else {
            return refuse("nothing-to-ship", "the disk is empty");
        };
        for s in self.disk.entries.keys() {
            let key = part_key(self.zone, epoch, *s);
            if store.get(&key).is_none() {
                store.put(&key, vec![0xa0], When::Absent)?;
            }
        }
        let (_, mut rec) = read_record(store, self.zone)?;
        rec.mark = Some(last);
        rec.epoch = epoch;
        self.version = change(store, self.zone, self.version, &rec)?;
        self.since_renewed = 0;
        self.acknowledge(Some(last));
        Ok(last)
    }
}

/// The parts a reader keeps, as (epoch, sequence), and those it ignores, with the name why.
pub type Readable = (Vec<(u64, u64)>, Vec<(u64, u64, &'static str)>);

/// The parts a reader keeps (rule 8): those named in the store, less any of an older epoch at or after the sequence
/// the record's epoch took over at, each of which is ignored as `superseded-epoch`.
pub fn readable(store: &Store, zone: Id) -> R<Readable> {
    let (_, rec) = read_record(store, zone)?;
    let prefix = format!("part/{}/", crate::world_model::show(zone));
    let mut kept = Vec::new();
    let mut ignored = Vec::new();
    for k in store.list(&prefix) {
        let mut it = k[prefix.len()..].split('/');
        let (Some(e), Some(s)) = (it.next(), it.next()) else {
            continue;
        };
        let (Ok(e), Ok(s)) = (e.parse::<u64>(), s.parse::<u64>()) else {
            continue;
        };
        if e < rec.epoch && s >= rec.from {
            ignored.push((e, s, "superseded-epoch"));
        } else {
            kept.push((e, s));
        }
    }
    Ok((kept, ignored))
}
