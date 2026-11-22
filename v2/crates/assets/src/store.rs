//! A world's uploads (G6, #2747): the store by hash, each upload's record, the upload call and the gate a place
//! passes.
//!
//! - **By reference (T8, `v2/docs/audience.md` rule 6):** an upload is kept apart under a minted reference, and a thing
//!   names it as `{21: id}`. The record says which bytes, by their `souls/upload/1` hash; the bytes are kept once
//!   per hash. Removing deletes the bytes and lists the reference for redaction (W9's button).
//! - **A record's state** is allowed, held, hidden or removed. Only an allowed upload is served or placed.
//! - **Hide and show (#3698):** the world's creator hides an allowed upload: it stops being served and placed, and its
//!   bytes and reference are kept, so showing it again makes it allowed as before. Only an allowed upload is hidden
//!   and only a hidden one shown (`upload.not-allowed`, `upload.not-hidden`); a held upload waits for its release.
//! - **Per world:** at most [`WorldLimits::default`]'s 10,000 uploads and 2 GB, refused by name.
//! - **The upload call** is the creator's, as G1's gate checks an edit (`upload.not-the-creator`): one call takes the
//!   file and answers with the reference or the refusal. Check (in a child), hold point, store.
//! - **The place gate:** [`placeable`] runs beside G1's check on every edit. A placed or set value that is a
//!   reference to an upload must name an allowed one (`upload.not-placeable`). It names no kind.

use crate::check::{Checked, Format, Refused};
use crate::child::Checker;
use crate::hold::{CLASSIFY_WITHIN, Classifier, NoClassifier, Verdict, judge};
use replica::audience::reference;
use replica::edit::{Edit, Op};
use replica::effects::Actor;
use replica::ids::{Hash, Id, Minter};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

/// Where an upload stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum State {
    Allowed,
    /// Kept, neither served nor placeable until released; the hold point's reason.
    Held(String),
    /// Hidden by the world's creator: kept, neither served nor placeable until shown again.
    Hidden,
    Removed,
}

/// One upload: the bytes it names by hash, what they are, and where it stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub hash: Hash,
    pub format: Format,
    pub bytes: u64,
    pub state: State,
}

/// A world's limits on its uploads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorldLimits {
    pub count: u64,
    pub bytes: u64,
}

impl Default for WorldLimits {
    fn default() -> WorldLimits {
        WorldLimits {
            count: 10_000,
            bytes: 2_000_000_000,
        }
    }
}

/// What the upload call answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    /// The reference a thing names, `{21: id}`.
    pub reference: Id,
    pub hash: Hash,
    pub state: State,
}

/// A world's uploads and how they are taken.
pub struct Store {
    pub creator: Id,
    pub checker: Checker,
    pub classifier: Arc<dyn Classifier>,
    pub classify_within: Duration,
    pub limits: WorldLimits,
    minter: Minter,
    blobs: BTreeMap<Hash, Vec<u8>>,
    records: BTreeMap<Id, Record>,
}

fn refuse<T>(
    code: &'static str,
    measured: Option<u64>,
    limit: Option<u64>,
    detail: String,
) -> Result<T, Refused> {
    Err(Refused {
        code,
        measured,
        limit,
        detail,
    })
}

impl Store {
    /// An empty store for `creator`'s world, minting references with `minter`, with no classifier plugged in.
    pub fn new(creator: Id, minter: Minter, checker: Checker) -> Store {
        Store {
            creator,
            checker,
            classifier: Arc::new(NoClassifier),
            classify_within: CLASSIFY_WITHIN,
            limits: WorldLimits::default(),
            minter,
            blobs: BTreeMap::new(),
            records: BTreeMap::new(),
        }
    }

    /// The upload call: `actor` sends `file`; the answer is the reference or the refusal (see the module's notes). A
    /// refused or rejected file stores nothing.
    pub fn upload(&mut self, actor: Actor, file: &[u8]) -> Result<Receipt, Refused> {
        if actor != Actor::Creator(self.creator) {
            return refuse(
                "upload.not-the-creator",
                None,
                None,
                "only the world's creator uploads to it".into(),
            );
        }
        let checked = self.checker.check(file).result?;
        let count = self.records.len() as u64 + 1;
        if count > self.limits.count {
            return refuse(
                "upload.world-count",
                Some(count),
                Some(self.limits.count),
                format!("{count} uploads, over {}", self.limits.count),
            );
        }
        let used: u64 = self
            .records
            .values()
            .filter(|r| r.state != State::Removed)
            .map(|r| r.bytes)
            .sum();
        let bytes = used + checked.bytes.len() as u64;
        if bytes > self.limits.bytes {
            return refuse(
                "upload.world-bytes",
                Some(bytes),
                Some(self.limits.bytes),
                format!("{bytes} bytes of uploads, over {}", self.limits.bytes),
            );
        }
        let checked = Arc::new(checked);
        let state = match judge(
            self.classifier.clone(),
            checked.clone(),
            self.classify_within,
        ) {
            Verdict::Allow => State::Allowed,
            Verdict::Hold(why) => State::Held(why),
            Verdict::Reject(why) => return refuse("upload.rejected", None, None, why),
        };
        let reference = self
            .minter
            .mint()
            .or_else(|e| refuse("upload.ids-exhausted", None, None, e.to_string()))?;
        let Checked { hash, format, .. } = *checked;
        let len = checked.bytes.len() as u64;
        self.blobs
            .entry(hash)
            .or_insert_with(|| checked.bytes.clone());
        self.records.insert(
            reference,
            Record {
                hash,
                format,
                bytes: len,
                state: state.clone(),
            },
        );
        Ok(Receipt {
            reference,
            hash,
            state,
        })
    }

    /// The creator hides an allowed upload (see the module's notes); answers its record.
    pub fn hide(&mut self, actor: Actor, reference: Id) -> Result<&Record, Refused> {
        self.switch(
            actor,
            reference,
            State::Allowed,
            State::Hidden,
            "upload.not-allowed",
        )
    }

    /// The creator shows a hidden upload again; answers its record.
    pub fn show(&mut self, actor: Actor, reference: Id) -> Result<&Record, Refused> {
        self.switch(
            actor,
            reference,
            State::Hidden,
            State::Allowed,
            "upload.not-hidden",
        )
    }

    fn switch(
        &mut self,
        actor: Actor,
        reference: Id,
        from: State,
        to: State,
        code: &'static str,
    ) -> Result<&Record, Refused> {
        if actor != Actor::Creator(self.creator) {
            return refuse(
                "upload.not-the-creator",
                None,
                None,
                "only the world's creator hides or shows its uploads".into(),
            );
        }
        let Some(r) = self.records.get_mut(&reference) else {
            return refuse(
                "upload.missing",
                None,
                None,
                format!("no upload {reference:?}"),
            );
        };
        if r.state != from {
            return refuse(
                code,
                None,
                None,
                format!("upload {reference:?} is {:?}", r.state),
            );
        }
        r.state = to;
        Ok(r)
    }

    pub fn record(&self, reference: Id) -> Option<&Record> {
        self.records.get(&reference)
    }

    /// The bytes kept for `reference` whatever its state, to keep them on disk (#3697): never to serve.
    pub fn kept(&self, reference: Id) -> Option<&[u8]> {
        let r = self.records.get(&reference)?;
        (r.state != State::Removed).then(|| self.blobs.get(&r.hash).map(Vec::as_slice))?
    }

    /// The bytes a viewer may be sent for `reference`: only an allowed upload's.
    pub fn served(&self, reference: Id) -> Option<&[u8]> {
        let r = self.records.get(&reference)?;
        (r.state == State::Allowed).then(|| self.blobs.get(&r.hash).map(Vec::as_slice))?
    }
}

/// The place gate (see the module's notes): every placed or set value in `edit` that is a reference to an upload in
/// `store` must name an allowed one. Runs beside `replica::edit::check`; a refusal names the operation.
pub fn placeable(edit: &Edit, store: &Store) -> Result<(), replica::edit::Refused> {
    for (i, op) in edit.ops.iter().enumerate() {
        let values: Vec<_> = match op {
            Op::Place { fields, .. } => fields.values().collect(),
            Op::Set { to, .. } => vec![to],
            _ => continue,
        };
        for v in values {
            let Some(id) = reference(v) else { continue };
            match store.record(id).map(|r| &r.state) {
                None | Some(State::Allowed) => {}
                Some(state) => {
                    return Err(replica::edit::Refused {
                        op: Some(i),
                        name: "upload.not-placeable",
                        detail: format!("upload {id:?} is {state:?}"),
                    });
                }
            }
        }
    }
    Ok(())
}
