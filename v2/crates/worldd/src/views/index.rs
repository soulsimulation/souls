//! The world-wide index and the Soul list in the view tier (Engine v2 E1, #2708; `replica::index`). One public
//! output, built once however many hold it.
//!
//! 1. **A subscriber starts from the file, then changes.** It is handed the index as one file named by its hash
//!    ([`IndexPart::File`]) and the whole Soul list ([`IndexPart::Souls`]), then, on each tick that changed the
//!    index, that tick's changes ([`IndexPart::Changes`]), and once a world second the Soul list's changes in it
//!    ([`IndexPart::Moves`]). A subscriber that falls behind is handed the file and the list again.
//! 2. **One frame per change set,** encoded once and shared by every subscriber (R3 rule 3).
//! 3. **Only touched nodes are read again** (`replica::index::Index::update`): a tick's entries name the nodes they
//!    touch; a removal or a transfer reads the whole state again.

use std::collections::BTreeSet;
use std::sync::Arc;

use replica::effects::{Body, Change, Effect, Refusal, State};
use replica::encode::encode;
use replica::ids::Id;
use replica::index::{Config, Index, SoulChanges, Souls};

use super::{Delivery, Inbox};

type R<T> = Result<T, Refusal>;

/// What an index delivery holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndexPart {
    /// The whole index (`Index::to_bytes`); its name is `replica::index::file_name` of the bytes.
    File,
    /// The whole Soul list, as changes from empty (`SoulChanges`).
    Souls,
    /// One tick's index changes (`Index::changes_value`).
    Changes,
    /// One world second's Soul list changes (`SoulChanges`).
    Moves,
}

/// The nodes a tick's entries touched, and whether links changed or the whole state must be read again.
#[derive(Default)]
pub(super) struct Touched {
    nodes: BTreeSet<Id>,
    links: bool,
    sweep: bool,
}

impl Touched {
    pub(super) fn add(&mut self, e: &Effect) {
        self.nodes.insert(e.envelope.node);
        match &e.body {
            Body::Changes(cs) => {
                for c in cs {
                    match &c.change {
                        Change::Create { node, .. }
                        | Change::Reparent { node, .. }
                        | Change::Set { node, .. } => {
                            self.nodes.insert(*node);
                        }
                        Change::Remove { node } => {
                            self.nodes.insert(*node);
                            self.sweep = true;
                        }
                        Change::Motion(h) => {
                            self.nodes.insert(h.node);
                        }
                        Change::Link { .. } | Change::Unlink { .. } => self.links = true,
                    }
                }
            }
            Body::Transfer(_) => self.sweep = true,
            Body::Time(_) | Body::Timers(_) => {}
        }
    }
}

pub(super) struct Out {
    cfg: Config,
    index: Index,
    souls: Souls,
    pub(super) inboxes: Vec<Arc<Inbox>>,
    pending: SoulChanges,
    second: Option<i64>,
    file: Option<Arc<[u8]>>,
}

fn bytes(v: &replica::encode::Value) -> R<Arc<[u8]>> {
    encode(v).map(Arc::from).map_err(|e| Refusal {
        name: "encoding",
        detail: e.to_string(),
    })
}

impl Out {
    pub(super) fn new(cfg: Config, state: &State) -> Out {
        let index = Index::build(state, &cfg);
        let mut souls = Souls::default();
        souls.relink(state, &index);
        Out {
            cfg,
            index,
            souls,
            inboxes: Vec::new(),
            pending: SoulChanges::default(),
            second: None,
            file: None,
        }
    }

    /// The file and the whole Soul list, at `record` (rule 1).
    pub(super) fn snapshot(&mut self, record: u64) -> R<Vec<Delivery>> {
        let file = match &self.file {
            Some(f) => f.clone(),
            None => {
                let f: Arc<[u8]> = Arc::from(self.index.to_bytes()?);
                self.file = Some(f.clone());
                f
            }
        };
        let souls = bytes(&self.souls.snapshot().to_value(&self.index))?;
        Ok(vec![
            Delivery::Index {
                part: IndexPart::File,
                record,
                bytes: file,
            },
            Delivery::Index {
                part: IndexPart::Souls,
                record,
                bytes: souls,
            },
        ])
    }

    /// One tick: the index's changes, and the Soul list's once a world second. Gives the frames encoded.
    pub(super) fn tick(&mut self, state: &State, t: &Touched, record: u64, at_us: i64) -> R<u64> {
        self.inboxes.retain(|i| Arc::strong_count(i) > 1);
        let mut frames = 0;
        let nodes: BTreeSet<Id> = if t.sweep {
            state.nodes.keys().copied().collect()
        } else {
            t.nodes.clone()
        };
        let changes = self.index.update(state, &self.cfg, &nodes, t.sweep);
        if !changes.is_empty() {
            self.file = None;
            let b = bytes(&self.index.changes_value(&changes))?;
            frames += 1;
            for i in &self.inboxes {
                i.push(Delivery::Index {
                    part: IndexPart::Changes,
                    record,
                    bytes: b.clone(),
                });
            }
        }
        if t.links || t.sweep || !changes.is_empty() {
            let c = self.souls.relink(state, &self.index);
            self.pending.merge(c);
        }
        let c = self.souls.moved(state, &self.index, &nodes);
        self.pending.merge(c);
        let second = at_us.div_euclid(1_000_000);
        if self.second != Some(second) {
            self.second = Some(second);
            if !self.pending.is_empty() {
                let b = bytes(&std::mem::take(&mut self.pending).to_value(&self.index))?;
                frames += 1;
                for i in &self.inboxes {
                    i.push(Delivery::Index {
                        part: IndexPart::Moves,
                        record,
                        bytes: b.clone(),
                    });
                }
            }
        }
        let behind: Vec<Arc<Inbox>> = self
            .inboxes
            .iter()
            .filter(|i| i.behind())
            .cloned()
            .collect();
        for i in behind {
            let s = self.snapshot(record)?;
            i.resume(s);
        }
        Ok(frames)
    }
}
