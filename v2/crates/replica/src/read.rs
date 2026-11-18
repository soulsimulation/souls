//! The read interface (Engine v2 K8, #2671): R1's queries as a trait, so a rule (R2) or a checker (I3) runs the same
//! on the live replica and on a frozen copy of it (`sim::frozen`). Every node carries its version stamp: the version
//! at which an entry last changed it (`apply.rs`), removed nodes included, 0 for one never changed. A checker keeps
//! the stamps of what it read and, at commit, compares them with the live replica's: equal stamps mean unchanged.

use crate::apply::Replica;
use crate::encode::Value;
use crate::ids::Id;
use crate::query::LinkAt;

/// What a reader may ask of a zone's copy. Each method is R1's query of the same name (`query.rs`).
pub trait Read {
    /// The version the copy stands at: the number of log entries applied.
    fn version(&self) -> u64;
    /// The node's version stamp (see the module's notes).
    fn stamp(&self, id: Id) -> u64;
    /// The node's record, with its stamp as field 10, or none if it is not here.
    fn node(&self, id: Id) -> Option<Value>;
    /// The node's children in id order, only those of `kind` when given (a full or plain kind name).
    fn children(&self, id: Id, kind: Option<&str>) -> Option<Vec<Id>>;
    /// The links at an end, a node here or not, in link id order.
    fn links(&self, end: Id) -> Vec<LinkAt>;
    /// The node, its parent, and so on to the zone's root.
    fn path(&self, id: Id) -> Option<Vec<Id>>;
}

impl Read for Replica {
    fn version(&self) -> u64 {
        Replica::version(self)
    }

    fn stamp(&self, id: Id) -> u64 {
        self.changed_at.get(&id).copied().unwrap_or(0)
    }

    fn node(&self, id: Id) -> Option<Value> {
        Replica::node(self, id)
    }

    fn children(&self, id: Id, kind: Option<&str>) -> Option<Vec<Id>> {
        Replica::children(self, id, kind)
    }

    fn links(&self, end: Id) -> Vec<LinkAt> {
        Replica::links(self, end)
    }

    fn path(&self, id: Id) -> Option<Vec<Id>> {
        Replica::path(self, id)
    }
}
