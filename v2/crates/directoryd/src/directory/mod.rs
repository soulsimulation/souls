//! The directory (Engine v2 W8, #2729; contract T11, `v2/docs/durability.md` rules 5 to 12): where each world runs,
//! its epoch, when it must wake and its pinned build, and where each Soul is.
//!
//! - **Its truth is objects in the object store** ([`store::Store`], [`s3::S3`] for a real one): a world's record at
//!   `world/<lineage>/<zone>` and a Soul's at `soul/<soul>` (`replica::directory`). Every write is conditional:
//!   create if absent, or replace if still the version read. There is no database.
//! - **Four calls change it:** [`Directory::claim`], [`Directory::set_alarm`], [`Directory::set_build`] and
//!   [`Directory::set_place`]. The claim holder's own durable write, moving the off-machine mark, is
//!   [`Directory::ship`]. Each reads the store first and is decided by the store's condition, never by the cache; with
//!   the store out of reach each is refused, `store-unreachable`, and nothing is decided.
//! - **A claim is compare-and-set on the epoch:** epoch n becomes n + 1 only if it is still n. Of two claims from n,
//!   the store lets one through and the other is refused, `claimed-by-another`. A writer whose claim was taken (one
//!   that paused and came back) is refused at its next ship, `claim-taken`: its write names the version it read, and
//!   the claim in force no longer carries its token.
//! - **The cached copy** is what this machine last read or wrote, for readers ([`Directory::cached_world`],
//!   [`Directory::cached_soul`]). It decides nothing, and dropping it loses nothing.
//!
//! When a writer may claim (a lease passed with the record unchanged, rule 6) is the supervisor's (O1, O2). A world
//! never waits on the directory: its tick runs whatever the store does.

pub mod s3;
pub mod store;

use std::collections::BTreeMap;

use replica::directory::{Place, SoulRecord, Takeover, Token, WorldRecord};
use replica::encode::Name;
use replica::ids::Id;

use store::{Object, R, Store, When, refuse};

/// How many times a call reads again after its write was refused because another field changed in between.
const ATTEMPTS: usize = 16;

/// A claim held: the takeover it wrote, and the record and version it last read or wrote. [`Directory::ship`] writes
/// on condition of that version.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub takeover: Takeover,
    record: WorldRecord,
    etag: String,
}

/// The directory as one machine sees it: the store, the machine's name (where a world it claims runs), and its
/// cached copy.
pub struct Directory<S: Store> {
    pub store: S,
    machine: Name,
    cache: BTreeMap<String, Object>,
}

impl<S: Store> Directory<S> {
    pub fn new(store: S, machine: Name) -> Directory<S> {
        Directory {
            store,
            machine,
            cache: BTreeMap::new(),
        }
    }

    // --- Reading ----------------------------------------------------------------------------------------------------

    /// Reads `key` from the store, and keeps what it read in the cached copy.
    fn read(&mut self, key: &str) -> R<Option<Object>> {
        let got = self.store.get(key)?;
        match &got {
            Some(o) => self.cache.insert(key.to_owned(), o.clone()),
            None => self.cache.remove(key),
        };
        Ok(got)
    }

    /// Writes `key` in the store on condition `when`, and keeps what it wrote in the cached copy.
    fn write(&mut self, key: &str, bytes: Vec<u8>, when: When) -> R<String> {
        let etag = self.store.put(key, &bytes, when)?;
        self.cache.insert(
            key.to_owned(),
            Object {
                etag: etag.clone(),
                bytes,
            },
        );
        Ok(etag)
    }

    fn read_world(&mut self, lineage: &[u8; 16], zone: Id) -> R<(String, WorldRecord)> {
        let key = WorldRecord::key(lineage, zone);
        match self.read(&key)? {
            Some(o) => Ok((o.etag, WorldRecord::read(&o.bytes)?)),
            None => refuse("record-missing", key),
        }
    }

    /// A world's record, read from the store.
    pub fn world(&mut self, lineage: &[u8; 16], zone: Id) -> R<WorldRecord> {
        Ok(self.read_world(lineage, zone)?.1)
    }

    /// A Soul's record, read from the store, or `None` for a Soul the directory has never placed.
    pub fn soul(&mut self, soul: Id) -> R<Option<SoulRecord>> {
        match self.read(&SoulRecord::key(soul))? {
            Some(o) => Ok(Some(SoulRecord::read(&o.bytes)?)),
            None => Ok(None),
        }
    }

    /// A world's record as this machine last saw it, for readers only. It decides nothing.
    pub fn cached_world(&self, lineage: &[u8; 16], zone: Id) -> Option<WorldRecord> {
        let o = self.cache.get(&WorldRecord::key(lineage, zone))?;
        WorldRecord::read(&o.bytes).ok()
    }

    /// A Soul's record as this machine last saw it, for readers only. It decides nothing.
    pub fn cached_soul(&self, soul: Id) -> Option<SoulRecord> {
        let o = self.cache.get(&SoulRecord::key(soul))?;
        SoulRecord::read(&o.bytes).ok()
    }

    /// Drops the cached copy. Nothing is lost: the store holds the truth.
    pub fn forget(&mut self) {
        self.cache.clear();
    }

    /// Changes a world's record by a conditional write on the version just read, counting the write (rule 10).
    /// `change` sees the record read and may refuse; a write refused because the record changed in between reads
    /// again and asks `change` again.
    fn change_world(
        &mut self,
        lineage: &[u8; 16],
        zone: Id,
        mut change: impl FnMut(&mut WorldRecord) -> R<()>,
    ) -> R<(String, WorldRecord)> {
        let key = WorldRecord::key(lineage, zone);
        let mut last = None;
        for _ in 0..ATTEMPTS {
            let (etag, mut rec) = self.read_world(lineage, zone)?;
            change(&mut rec)?;
            rec.writes = rec.writes.wrapping_add(1);
            match self.write(&key, rec.to_bytes()?, When::Is(&etag)) {
                Ok(etag) => return Ok((etag, rec)),
                Err(e) if e.name == "precondition-failed" => last = Some(e),
                Err(e) => return Err(e),
            }
        }
        refuse("contended", format!("{key}: {last:?}"))
    }

    // --- The four calls ---------------------------------------------------------------------------------------------

    /// Claims a world for this machine: the next epoch, from the off-machine mark plus one, under a token drawn now
    /// (rule 5), written on condition that the record is the version read and its epoch is still the one read first.
    /// Refused `claimed-by-another` when another claim got there first, `record-missing` for a world whose build was
    /// never pinned.
    pub fn claim(&mut self, lineage: &[u8; 16], zone: Id) -> R<Claim> {
        let token = Token::draw()?;
        let machine = self.machine.clone();
        let mut seen = None;
        let (etag, record) = self.change_world(lineage, zone, |rec| {
            let epoch = rec.current().map_or(0, |t| t.epoch);
            if *seen.get_or_insert(epoch) != epoch {
                return refuse(
                    "claimed-by-another",
                    format!("epoch {} became {epoch}", seen.unwrap_or(0)),
                );
            }
            rec.takeovers.push(Takeover {
                epoch: epoch + 1,
                from: rec.mark.map_or(0, |m| m + 1),
                machine: machine.clone(),
                token,
            });
            Ok(())
        })?;
        let takeover = record
            .current()
            .cloned()
            .unwrap_or_else(|| unreachable!("a takeover was just added"));
        Ok(Claim {
            takeover,
            record,
            etag,
        })
    }

    /// Sets when a world must wake (real time, µs since 1970), or clears it while it is awake.
    pub fn set_alarm(&mut self, lineage: &[u8; 16], zone: Id, wake: Option<u64>) -> R<()> {
        self.change_world(lineage, zone, |rec| {
            rec.wake = wake;
            Ok(())
        })?;
        Ok(())
    }

    /// Pins the build that runs a world, by hash. The first pin creates the world's record, unclaimed, create-only.
    pub fn set_build(&mut self, lineage: &[u8; 16], zone: Id, build: &[u8]) -> R<()> {
        if build.len() != 34 {
            return refuse("build-not-a-hash", "a build is named by its 34-byte hash");
        }
        let key = WorldRecord::key(lineage, zone);
        if self.read(&key)?.is_none() {
            let rec = WorldRecord {
                lineage: *lineage,
                zone,
                takeovers: Vec::new(),
                mark: None,
                wake: None,
                build: build.to_vec(),
                writes: 0,
            };
            match self.write(&key, rec.to_bytes()?, When::Absent) {
                Ok(_) => return Ok(()),
                Err(e) if e.name == "precondition-failed" => {}
                Err(e) => return Err(e),
            }
        }
        self.change_world(lineage, zone, |rec| {
            rec.build = build.to_vec();
            Ok(())
        })?;
        Ok(())
    }

    /// Moves a Soul from `from` (`None`: the directory has never placed it) to `to`, on condition that it is still at
    /// `from`: refused `soul-moved` when it is not. A Soul has one record, so it is never in two worlds.
    pub fn set_place(&mut self, soul: Id, from: Option<&Place>, to: Place) -> R<()> {
        let key = SoulRecord::key(soul);
        let mut last = None;
        for _ in 0..ATTEMPTS {
            let read = self.read(&key)?;
            let now = match &read {
                Some(o) => Some(SoulRecord::read(&o.bytes)?),
                None => None,
            };
            if now.as_ref().map(|r| &r.place) != from {
                return refuse(
                    "soul-moved",
                    format!("{key}: expected {from:?}, the directory holds {now:?}"),
                );
            }
            let rec = SoulRecord {
                soul,
                place: to.clone(),
                writes: now.map_or(0, |r| r.writes.wrapping_add(1)),
            };
            let when = match &read {
                Some(o) => When::Is(&o.etag),
                None => When::Absent,
            };
            match self.write(&key, rec.to_bytes()?, when) {
                Ok(_) => return Ok(()),
                Err(e) if e.name == "precondition-failed" => last = Some(e),
                Err(e) => return Err(e),
            }
        }
        refuse("contended", format!("{key}: {last:?}"))
    }

    // --- The claim holder's durable write ---------------------------------------------------------------------------

    /// Moves the off-machine mark to `mark` (rule 1), which also renews the claim (rule 6). It writes on condition of
    /// the version the claim last read or wrote, so a writer whose claim was taken is refused by the store; it then
    /// reads again, and is refused `claim-taken` unless the claim in force still carries its token (rule 7). A write
    /// refused only because another field changed (an alarm, a build) is made again on the new version.
    pub fn ship(&mut self, claim: &mut Claim, mark: u64) -> R<()> {
        let key = WorldRecord::key(&claim.record.lineage, claim.record.zone);
        for _ in 0..ATTEMPTS {
            let mut rec = claim.record.clone();
            rec.mark = Some(rec.mark.map_or(mark, |m| m.max(mark)));
            rec.writes = rec.writes.wrapping_add(1);
            match self.write(&key, rec.to_bytes()?, When::Is(&claim.etag)) {
                Ok(etag) => {
                    claim.record = rec;
                    claim.etag = etag;
                    return Ok(());
                }
                Err(e) if e.name == "precondition-failed" => {}
                Err(e) => return Err(e),
            }
            let (etag, now) = self.read_world(&claim.record.lineage, claim.record.zone)?;
            if now.current().map(|t| t.token) != Some(claim.takeover.token) {
                return refuse(
                    "claim-taken",
                    format!(
                        "{key}: epoch {} is no longer in force (now {})",
                        claim.takeover.epoch,
                        now.current().map_or(0, |t| t.epoch)
                    ),
                );
            }
            claim.record = now;
            claim.etag = etag;
        }
        refuse("contended", key)
    }
}
