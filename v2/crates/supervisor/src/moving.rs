//! Moving a live world to another machine (Engine v2 O9, #2828): four steps, and ownership is the epoch in the
//! directory record (W8), never process order, a lease or a clock. Runbook: `v2/docs/runbook/move-a-world.md`; the
//! drill and the kill table are `v2/tools/ops` (`ops move`, `o9-move.sh`).
//!
//! 1. **Prepare:** the target fetches the newest shipped checkpoint and the pieces after it (O3) while the source runs.
//! 2. **Drain:** the gateway holds new intents (`gatewayd::Gate`); the source runs its queued intents, seals and ships
//!    its last piece, and moves the record's off-machine mark to its last record. It reports the exact version it
//!    sealed ([`Sealed`]) and writes nothing more.
//! 3. **Fence** ([`fence`]): the target fetches the last pieces and proves it reaches that exact version (records,
//!    effects, the public state hash); only then does the epoch rise, naming the target, by compare-and-set on the
//!    source's epoch with the mark at the sealed record. Any failure before the claim: the source resumes.
//! 4. **Resume:** the target starts its clock at the tick after the source's last and runs every owed tick to reach
//!    now (`v2/docs/time.md` rule 11); the gateway points at the new epoch and releases what it held.
//!
//! After a failure at any step, [`owner`] reads the record: whoever its claim in force names owns the world, and is
//! restarted if it died. The source's claim, once taken, is refused at its next write (`claim-taken`); the target's
//! pieces start at the sealed record under its own epoch and token, so the bucket's names show one writer per epoch
//! ([`history`]).

use directoryd::directory::store::{R, Store, refuse};
use directoryd::directory::{Claim, Directory};
use replica::directory::WorldRecord;
use replica::encode::Name;
use replica::ids::Id;

/// The four steps, by name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Prepare,
    Drain,
    Fence,
    Resume,
}

impl Step {
    pub const ALL: [Step; 4] = [Step::Prepare, Step::Drain, Step::Fence, Step::Resume];

    pub fn name(self) -> &'static str {
        match self {
            Step::Prepare => "prepare",
            Step::Drain => "drain",
            Step::Fence => "fence",
            Step::Resume => "resume",
        }
    }

    pub fn parse(s: &str) -> Option<Step> {
        Step::ALL.into_iter().find(|t| t.name() == s)
    }
}

/// The exact version a world holds: its log records, its effects (the tree's next sequence), its public state hash
/// (hex), and the last tick it ran.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sealed {
    pub records: u64,
    pub next: u64,
    pub hash: String,
    pub tick: u64,
}

impl Sealed {
    /// `<records> <next> <hash> <tick>`.
    pub fn line(&self) -> String {
        format!("{} {} {} {}", self.records, self.next, self.hash, self.tick)
    }

    pub fn parse(words: &[&str]) -> Option<Sealed> {
        let [r, n, h, t] = words else {
            return None;
        };
        Some(Sealed {
            records: r.parse().ok()?,
            next: n.parse().ok()?,
            hash: (*h).to_owned(),
            tick: t.parse().ok()?,
        })
    }
}

/// Step 3: the epoch rises, naming this machine, only when `reached` is exactly `sealed` and the record still names
/// the source's epoch with the mark at the sealed record. The claim is compare-and-set (W8), so of two claims from one
/// epoch one wins; a claim that went to another is refused `claimed-by-another`. The new claim's pieces start at the
/// sealed record.
pub fn fence<S: Store>(
    dir: &mut Directory<S>,
    lineage: &[u8; 16],
    zone: Id,
    source_epoch: u64,
    sealed: &Sealed,
    reached: &Sealed,
) -> R<Claim> {
    if reached.records != sealed.records
        || reached.next != sealed.next
        || reached.hash != sealed.hash
    {
        return refuse(
            "fence-short",
            format!("reached {}, sealed {}", reached.line(), sealed.line()),
        );
    }
    let rec = dir.world(lineage, zone)?;
    let epoch = rec.current().map_or(0, |t| t.epoch);
    let want = sealed.records.checked_sub(1);
    if epoch != source_epoch || rec.mark != want {
        return refuse(
            "fence-moved",
            format!(
                "the record holds epoch {epoch} and mark {:?}; the move expected {source_epoch} and {want:?}",
                rec.mark
            ),
        );
    }
    let claim = dir.claim(lineage, zone)?;
    if claim.takeover.epoch != source_epoch + 1 || claim.takeover.from != sealed.records {
        // Another claim got in between our read and ours: what we hold is not the move's.
        return refuse(
            "claimed-by-another",
            format!(
                "claimed epoch {} from {}, the move expected {} from {}",
                claim.takeover.epoch,
                claim.takeover.from,
                source_epoch + 1,
                sealed.records
            ),
        );
    }
    Ok(claim)
}

/// A side of a move.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Source,
    Target,
}

/// Who owns the world now, by the record alone: the target once a claim after the source's epoch names its machine,
/// otherwise the source (restarted on its own machine if it died). Returns the side and the epoch in force.
pub fn owner<S: Store>(
    store: &S,
    lineage: &[u8; 16],
    zone: Id,
    source_epoch: u64,
    target: &Name,
) -> R<(Side, u64)> {
    let Some(o) = store.get(&WorldRecord::key(lineage, zone))? else {
        return refuse("record-missing", WorldRecord::key(lineage, zone));
    };
    let rec = WorldRecord::read(&o.bytes)?;
    let Some(t) = rec.current() else {
        return refuse("unclaimed", "the record has no claim");
    };
    let side = if t.epoch > source_epoch && &t.machine == target {
        Side::Target
    } else {
        Side::Source
    };
    Ok((side, t.epoch))
}

/// One epoch's line in the history: its machine, how many pieces its token named, and the records they hold from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Epoch {
    pub epoch: u64,
    pub machine: String,
    pub from: u64,
    pub pieces: u64,
    pub first: Option<u64>,
    pub last: Option<u64>,
}

/// A5's check: every piece in the bucket (`part/.../<epoch>/<token>/<record>`) carries the token of the claim the
/// record holds for its epoch, and no epoch is held twice. So no two processes wrote under one epoch: a piece's name
/// can only be made by the process that drew that epoch's token.
pub fn history(rec: &WorldRecord, part_keys: &[String]) -> Result<Vec<Epoch>, String> {
    let mut out: Vec<Epoch> = Vec::new();
    for t in &rec.takeovers {
        if out.iter().any(|e| e.epoch == t.epoch) {
            return Err(format!("epoch {} is claimed twice", t.epoch));
        }
        out.push(Epoch {
            epoch: t.epoch,
            machine: t.machine.as_str().to_owned(),
            from: t.from,
            pieces: 0,
            first: None,
            last: None,
        });
    }
    for k in part_keys {
        let mut it = k.rsplit('/');
        let (Some(seq), Some(token), Some(epoch)) = (it.next(), it.next(), it.next()) else {
            return Err(format!("{k}: not a part name"));
        };
        let (Ok(seq), Ok(epoch)) = (seq.parse::<u64>(), epoch.parse::<u64>()) else {
            return Err(format!("{k}: not a part name"));
        };
        let Some(t) = rec.takeovers.iter().find(|t| t.epoch == epoch) else {
            return Err(format!("{k}: epoch {epoch} was never claimed"));
        };
        if t.token.hex() != token {
            return Err(format!(
                "{k}: written under epoch {epoch} by a token that never held it"
            ));
        }
        let Some(e) = out.iter_mut().find(|e| e.epoch == epoch) else {
            return Err(format!("{k}: epoch {epoch} is not in the history"));
        };
        e.pieces += 1;
        e.first = Some(e.first.map_or(seq, |f| f.min(seq)));
        e.last = Some(e.last.map_or(seq, |l| l.max(seq)));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use directoryd::directory::store::Memory;
    use replica::durability::part_key;
    use replica::ids::Scope;

    fn zone() -> Id {
        Id::new(Scope([0x01; 16]), 7).expect("an id")
    }

    fn sealed(records: u64) -> Sealed {
        Sealed {
            records,
            next: 40,
            hash: "ab".into(),
            tick: 9,
        }
    }

    #[test]
    fn the_fence_claims_only_the_exact_version_and_only_once() {
        let store = Memory::default();
        let (lineage, z) = ([0xab; 16], zone());
        let mut a = Directory::new(&store, Name::new("machine-a").expect("a name"));
        a.set_build(&lineage, z, &[0x12; 34]).expect("pinned");
        let mut claim = a.claim(&lineage, z).expect("claimed");
        a.ship(&mut claim, 9).expect("the source's mark");
        let mut b = Directory::new(&store, Name::new("machine-b").expect("a name"));
        let mut short = sealed(10);
        short.hash = "cd".into();
        let e = fence(&mut b, &lineage, z, 1, &sealed(10), &short).unwrap_err();
        assert_eq!(e.name, "fence-short");
        assert_eq!(
            fence(&mut b, &lineage, z, 1, &sealed(11), &sealed(11))
                .unwrap_err()
                .name,
            "fence-moved"
        );
        let got = fence(&mut b, &lineage, z, 1, &sealed(10), &sealed(10)).expect("fenced");
        assert_eq!((got.takeover.epoch, got.takeover.from), (2, 10));
        // A second fence from the same epoch (a retried or rival target) is refused: the epoch already rose.
        assert_eq!(
            fence(&mut b, &lineage, z, 1, &sealed(10), &sealed(10))
                .unwrap_err()
                .name,
            "fence-moved"
        );
        // The source's next write is refused: its claim was taken.
        assert_eq!(a.ship(&mut claim, 12).unwrap_err().name, "claim-taken");
        let target = Name::new("machine-b").expect("a name");
        assert_eq!(
            owner(&store, &lineage, z, 1, &target).expect("read"),
            (Side::Target, 2)
        );
        let rec = a.world(&lineage, z).expect("read");
        let keys = vec![
            part_key(&lineage, z, &rec.takeovers[0], 0),
            part_key(&lineage, z, &rec.takeovers[1], 10),
        ];
        let h = history(&rec, &keys).expect("one writer per epoch");
        assert_eq!((h[0].pieces, h[1].first), (1, Some(10)));
        // A piece under epoch 2 with epoch 1's token: a second writer under one epoch.
        let mut wrong = rec.takeovers[1].clone();
        wrong.token = rec.takeovers[0].token;
        assert!(history(&rec, &[part_key(&lineage, z, &wrong, 11)]).is_err());
    }

    #[test]
    fn before_the_claim_the_source_owns() {
        let store = Memory::default();
        let (lineage, z) = ([0xab; 16], zone());
        let mut a = Directory::new(&store, Name::new("machine-a").expect("a name"));
        a.set_build(&lineage, z, &[0x12; 34]).expect("pinned");
        a.claim(&lineage, z).expect("claimed");
        let target = Name::new("machine-b").expect("a name");
        assert_eq!(
            owner(&store, &lineage, z, 1, &target).expect("read"),
            (Side::Source, 1)
        );
        // The source restarted on its own machine: a new epoch, still the source's side.
        a.claim(&lineage, z).expect("claimed again");
        assert_eq!(
            owner(&store, &lineage, z, 1, &target).expect("read"),
            (Side::Source, 2)
        );
    }
}
