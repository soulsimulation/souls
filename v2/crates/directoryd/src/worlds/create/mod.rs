//! The create call (Engine v2 G9, #2798): a new world, from a template or from its creator's own world, with a name,
//! its own lineage and exactly one creator.
//!
//! 1. **The name first.** A world's name record, at `world-name/<name>`, is written create-only before anything else:
//!    `{1: name (UTF-8 bytes), 2: lineage, 3: zone, 4: creator, 5: source lineage}`. It records the world's founder:
//!    one field, written once, never replaced (but removed when the create ends unplaced, list rule 10); the validated world-list records later creator handoffs. Of two creates of one name, the store lets one through and the other
//!    is refused, `name-taken`. Today's reserved names (`eden`, `api`, `god`, `assets`) are refused, `name-reserved`.
//! 2. **Then the first epoch:** the world's record, its build pinned (W8 `set_build`, create-only), then claimed (W8
//!    `claim`, epoch 1), so the machine that forks is the one that holds the claim.
//! 3. **Then the fork**, the caller's (`worldd::start`): it runs with the claim in hand. A crash in it leaves a name
//!    record with its creator and a claimed world record: never a world nobody owns. The lineage is the caller's fresh
//!    16 bytes, the same the fork mints under.
//! 4. **A creator's own world** may be the source ([`Source::Own`]): refused `not-your-world` unless the name record
//!    and effective world-list authority name the current creator. Forking another person's world is not offered (Gene's decision).

use replica::effects::{Refusal, read_id};
use replica::encode::{Value, decode, encode};
use replica::ids::Id;

use crate::directory::store::{R, Store, When, refuse};
use crate::directory::{Claim, Directory};

/// Names no world may take.
pub const RESERVED: [&str; 4] = ["eden", "api", "god", "assets"];

/// A world's name record (rule 1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NameRecord {
    pub name: String,
    pub lineage: [u8; 16],
    pub zone: Id,
    pub creator: Id,
    /// The lineage of the template or world it was forked from.
    pub source: [u8; 16],
}

impl NameRecord {
    pub fn key(name: &str) -> String {
        format!("world-name/{name}")
    }

    pub fn to_bytes(&self) -> R<Vec<u8>> {
        encode(&Value::Map(
            [
                (1, Value::Bytes(self.name.as_bytes().to_vec())),
                (2, Value::Bytes(self.lineage.to_vec())),
                (3, self.zone.to_value()),
                (4, self.creator.to_value()),
                (5, Value::Bytes(self.source.to_vec())),
            ]
            .into(),
        ))
        .or_else(|e| refuse("encoding", e.to_string()))
    }

    pub fn read(bytes: &[u8]) -> R<NameRecord> {
        let bad = || -> R<NameRecord> {
            refuse(
                "record-not-a-record",
                "{1: name, 2: lineage, 3: zone, 4: creator, 5: source}",
            )
        };
        let v = decode(bytes)
            .or_else(|e| refuse("encoding", e.to_string()))?
            .value;
        let Value::Map(m) = v else { return bad() };
        let b16 = |k| match m.get(&k) {
            Some(Value::Bytes(b)) => <[u8; 16]>::try_from(b.as_slice()).ok(),
            _ => None,
        };
        let (Some(Value::Bytes(name)), Some(lineage), Some(zone), Some(creator), Some(source)) =
            (m.get(&1), b16(2), m.get(&3), m.get(&4), b16(5))
        else {
            return bad();
        };
        if m.len() != 5 {
            return bad();
        }
        let Ok(name) = String::from_utf8(name.clone()) else {
            return bad();
        };
        Ok(NameRecord {
            name,
            lineage,
            zone: read_id(zone)?,
            creator: read_id(creator)?,
            source,
        })
    }
}

/// What a world is made from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    /// A published template: its lineage.
    Template { lineage: [u8; 16] },
    /// The creator's own world, by name.
    Own { name: String },
}

/// A create request. `lineage` is fresh (16 bytes from the operating system), the scope the fork mints under; `zone`
/// is the source's root, which the fork keeps.
pub struct Create<'a> {
    pub name: &'a str,
    pub creator: Id,
    pub source: Source,
    pub lineage: [u8; 16],
    pub zone: Id,
    pub build: &'a [u8],
}

/// A name a world may take: 1 to 40 of `a-z`, `0-9` and `-`, not starting or ending with `-`, and not reserved.
pub fn check_name(name: &str) -> R<()> {
    let ok = (1..=40).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-');
    if !ok {
        return refuse(
            "name-not-allowed",
            format!("{name:?}: 1 to 40 of a-z, 0-9 and -"),
        );
    }
    if RESERVED.contains(&name) {
        return refuse("name-reserved", name.to_owned());
    }
    Ok(())
}

/// A world's name record, read from the store, or `None`.
pub fn named<S: Store>(dir: &Directory<S>, name: &str) -> R<Option<NameRecord>> {
    match dir.store.get(&NameRecord::key(name))? {
        Some(o) => Ok(Some(NameRecord::read(&o.bytes)?)),
        None => Ok(None),
    }
}

/// Makes a world (rules 1 to 4): its name record, then its record and first epoch, then `fork` with the claim.
pub fn create<S: Store, T>(
    dir: &mut Directory<S>,
    c: Create,
    fork: impl FnOnce(&Claim) -> R<T>,
) -> R<(Claim, T)> {
    check_name(c.name)?;
    let source = match &c.source {
        Source::Template { lineage } => *lineage,
        Source::Own { name } => match named(dir, name)? {
            Some(r) => {
                let owner = if dir.store.get(crate::worlds::list::KEY)?.is_none() {
                    // G9's standalone library has no served list or handoff authority.
                    Some(r.creator)
                } else {
                    crate::worlds::list::creator_of(&dir.store, &r.lineage, r.zone)?
                };
                if owner != Some(c.creator) {
                    return refuse("not-your-world", name.clone());
                }
                r.lineage
            }
            None => return refuse("world-missing", name.clone()),
        },
    };
    let rec = NameRecord {
        name: c.name.to_owned(),
        lineage: c.lineage,
        zone: c.zone,
        creator: c.creator,
        source,
    };
    match dir
        .store
        .put(&NameRecord::key(c.name), &rec.to_bytes()?, When::Absent)
    {
        Ok(_) => {}
        Err(e) if e.name == "precondition-failed" => {
            return Err(Refusal {
                name: "name-taken",
                detail: c.name.to_owned(),
            });
        }
        Err(e) => return Err(e),
    }
    dir.set_build(&c.lineage, c.zone, c.build)?;
    let claim = dir.claim(&c.lineage, c.zone)?;
    let out = fork(&claim)?;
    Ok((claim, out))
}
