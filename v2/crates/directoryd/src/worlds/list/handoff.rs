//! One explicit handoff, on the same conditional object as the world's current creator. Name records stay immutable.
use super::*;

const OFFER_SECONDS: u64 = 7 * 24 * 3600;
const OFFER: &str = "_handoff_offer";
const PENDING: &str = "_handoff_pending";
const USED: &str = "_handoff_used";
const GENERATION: &str = "_creator_generation";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ownership {
    pub founder: Id,
    pub creator: Option<Id>,
    pub generation: u64,
    pub lineage: [u8; 16],
    pub zone: Id,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pending {
    pub world: String,
    pub account: String,
    pub creator: Id,
    pub generation: u64,
    pub hash: String,
}

fn field<'a>(row: &'a Json, name: &str) -> R<&'a str> {
    row.get(name).and_then(Json::as_str).ok_or_else(|| Refusal {
        name: "handoff-authority-invalid",
        detail: "a world authority field is missing".into(),
    })
}

pub(super) fn ownership<S: Store>(store: &S, row: &Json) -> R<Ownership> {
    let name = field(row, "name")?;
    let bytes = store.get(&NameRecord::key(name))?.ok_or_else(|| Refusal {
        name: "handoff-authority-missing",
        detail: "the immutable world identity is missing".into(),
    })?;
    let identity = NameRecord::read(&bytes.bytes)?;
    if identity.name != name
        || field(row, "lineage")? != to_hex(&identity.lineage)
        || field(row, "zone")? != principal_text(identity.zone)
    {
        return refuse("handoff-authority-mismatch", "world identity differs");
    }
    let creator =
        crate::accounts::principal_from_text(field(row, "creator")?).ok_or_else(|| Refusal {
            name: "handoff-authority-invalid",
            detail: "current creator is invalid".into(),
        })?;
    let generation = match row.get(GENERATION) {
        None => 0,
        Some(v) => v.as_u64().ok_or_else(|| Refusal {
            name: "handoff-authority-invalid",
            detail: "creator generation is invalid".into(),
        })?,
    };
    if generation == 0 && creator != identity.creator {
        return refuse("handoff-authority-mismatch", "initial creator differs");
    }
    let (creator, generation) = if let Some(p) = row.get(PENDING) {
        let next = generation.checked_add(1).ok_or_else(|| Refusal {
            name: "handoff-generation",
            detail: "generation exhausted".into(),
        })?;
        let parsed = pending(name, p)?;
        if parsed.generation != next || field(p, "from")? != principal_text(creator) {
            return refuse("handoff-authority-invalid", "pending authority differs");
        }
        (None, next)
    } else {
        (Some(creator), generation)
    };
    Ok(Ownership {
        founder: identity.creator,
        creator,
        generation,
        lineage: identity.lineage,
        zone: identity.zone,
    })
}

fn pending(world: &str, value: &Json) -> R<Pending> {
    let creator =
        crate::accounts::principal_from_text(field(value, "creator")?).ok_or_else(|| Refusal {
            name: "handoff-authority-invalid",
            detail: "recipient principal is invalid".into(),
        })?;
    let hash = field(value, "hash")?;
    if hash.len() != 64 || from_hex(hash).is_err() {
        return refuse("handoff-authority-invalid", "offer hash is invalid");
    }
    Ok(Pending {
        world: world.to_owned(),
        account: field(value, "account")?.to_owned(),
        creator,
        generation: value
            .get("generation")
            .and_then(Json::as_u64)
            .ok_or_else(|| Refusal {
                name: "handoff-authority-invalid",
                detail: "pending generation is invalid".into(),
            })?,
        hash: hash.to_owned(),
    })
}

pub(super) fn public_row(row: &mut Json) {
    if let Some(o) = row.as_object_mut() {
        for key in [OFFER, PENDING, USED, GENERATION] {
            o.remove(key);
        }
    }
}

impl<S: Store> Worlds<S> {
    /// Uncached and bound to the immutable name: used by the protected topology registry's internal reader.
    pub fn ownership(&self, world: &str) -> R<Ownership> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let (_, rows) = read_rows(&inner.dir.store)?;
        let row = rows
            .iter()
            .find(|r| r.get("name").and_then(Json::as_str) == Some(world))
            .ok_or_else(|| Refusal {
                name: "world-missing",
                detail: "world not found".into(),
            })?;
        ownership(&inner.dir.store, row)
    }

    pub fn offer_handoff(&self, world: &str, who: Id, to: Option<&str>, now: u64) -> R<Json> {
        if let Some(to) = to
            && (!(3..=48).contains(&to.len())
                || !to
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_:.-".contains(&b)))
        {
            return refuse(
                "handoff-recipient-invalid",
                "recipient is an account identifier",
            );
        }
        let secret = crate::accounts::b64url(&random::<24>());
        let hash = to_hex(&sha256(secret.as_bytes()));
        let expiry = now.checked_add(OFFER_SECONDS).ok_or_else(|| Refusal {
            name: "handoff-expiry",
            detail: "expiry overflow".into(),
        })?;
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let (etag, rows) = read_rows(&inner.dir.store)?;
        let (saved, ()) = write_rows(&inner.dir.store, etag, rows, |rows| {
            let row = rows
                .iter_mut()
                .find(|r| r.get("name").and_then(Json::as_str) == Some(world))
                .ok_or_else(|| Refusal {
                    name: "world-missing",
                    detail: "world not found".into(),
                })?;
            if ownership(&inner.dir.store, row)?.creator != Some(who) {
                return refuse("not-the-creator", "only the current creator");
            }
            row[OFFER] = json!({"hash":hash,"from":principal_text(who),"to":to,"expires":expiry});
            Ok(())
        })?;
        *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(saved);
        Ok(json!({"code":secret,"expires":expiry,"world":world}))
    }

    pub fn cancel_handoff(&self, world: &str, who: Id) -> R<()> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let (etag, rows) = read_rows(&inner.dir.store)?;
        let (saved, ()) = write_rows(&inner.dir.store, etag, rows, |rows| {
            let row = rows
                .iter_mut()
                .find(|r| r.get("name").and_then(Json::as_str) == Some(world))
                .ok_or_else(|| Refusal {
                    name: "world-missing",
                    detail: "world not found".into(),
                })?;
            if ownership(&inner.dir.store, row)?.creator != Some(who) {
                return refuse("not-the-creator", "only the current creator");
            }
            row.as_object_mut().unwrap().remove(OFFER);
            Ok(())
        })?;
        *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(saved);
        Ok(())
    }

    /// Durable fence first; materialization happens after this method releases the Worlds mutex.
    pub fn begin_handoff(
        &self,
        world: &str,
        code: &str,
        account: &str,
        recipient: Id,
        now: u64,
    ) -> R<Pending> {
        if code.len() != 32
            || !code
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return refuse("handoff-invalid", "offer code is invalid");
        }
        let hash = to_hex(&sha256(code.as_bytes()));
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let (etag, rows) = read_rows(&inner.dir.store)?;
        let (saved, result) = write_rows(&inner.dir.store, etag, rows, |rows| {
            let row = rows
                .iter_mut()
                .find(|r| r.get("name").and_then(Json::as_str) == Some(world))
                .ok_or_else(|| Refusal {
                    name: "world-missing",
                    detail: "world not found".into(),
                })?;
            let authority = ownership(&inner.dir.store, row)?;
            if let Some(p) = row.get(PENDING) {
                let p = pending(world, p)?;
                return if p.hash == hash && p.account == account && p.creator == recipient {
                    Ok(p)
                } else {
                    refuse("handoff-pending", "another acceptance is pending")
                };
            }
            if row.get(USED).and_then(Json::as_str) == Some(&hash) {
                return refuse("handoff-used", "offer was already accepted");
            }
            let offer = row.get(OFFER).ok_or_else(|| Refusal {
                name: "handoff-unknown",
                detail: "no matching offer".into(),
            })?;
            if offer.get("hash").and_then(Json::as_str) != Some(&hash) {
                return refuse("handoff-unknown", "no matching offer");
            }
            if offer
                .get("expires")
                .and_then(Json::as_u64)
                .is_none_or(|e| now >= e)
            {
                return refuse("handoff-expired", "offer expired");
            }
            if offer
                .get("to")
                .and_then(Json::as_str)
                .is_some_and(|to| to != account)
            {
                return refuse("handoff-not-for-you", "offer names another account");
            }
            let Some(from) = authority.creator else {
                return refuse("handoff-pending", "authority is pending");
            };
            if from == recipient {
                return refuse("handoff-already-owner", "recipient already owns the world");
            }
            if offer.get("from").and_then(Json::as_str) != Some(&principal_text(from)) {
                return refuse("handoff-stale", "offer author is no longer creator");
            }
            let generation = authority.generation.checked_add(1).ok_or_else(|| Refusal {
                name: "handoff-generation",
                detail: "generation exhausted".into(),
            })?;
            row[PENDING] = json!({"hash":hash,"account":account,"creator":principal_text(recipient),"from":principal_text(from),"generation":generation});
            pending(world, &row[PENDING])
        })?;
        *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(saved);
        Ok(result)
    }

    pub fn finish_handoff(&self, p: &Pending) -> R<()> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let (etag, rows) = read_rows(&inner.dir.store)?;
        let (saved, ()) = write_rows(&inner.dir.store, etag, rows, |rows| {
            let row = rows
                .iter_mut()
                .find(|r| r.get("name").and_then(Json::as_str) == Some(&p.world))
                .ok_or_else(|| Refusal {
                    name: "world-missing",
                    detail: "world not found".into(),
                })?;
            ownership(&inner.dir.store, row)?;
            if pending(
                &p.world,
                row.get(PENDING).ok_or_else(|| Refusal {
                    name: "handoff-used",
                    detail: "no pending acceptance".into(),
                })?,
            )? != *p
            {
                return refuse("handoff-stale", "acceptance changed");
            }
            row["creator"] = json!(principal_text(p.creator));
            row[GENERATION] = json!(p.generation);
            row[USED] = json!(p.hash);
            let o = row.as_object_mut().unwrap();
            o.remove(OFFER);
            o.remove(PENDING);
            Ok(())
        })?;
        *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(saved);
        Ok(())
    }
}
