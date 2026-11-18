//! Agents' sockets (Engine v2, #2635). So far the gate a world's intents pass through while it moves to another
//! machine (O9, #2828; `v2/docs/runbook/move-a-world.md`): it forwards each intent to the writer under that writer's
//! epoch, holds new intents while the world moves, points at the new writer by its epoch, and releases what it held.
//! Requests wait; they never fail for a move. Every intent reaches exactly one named end: acknowledged by the epoch it
//! was sent under, or refused by name.
//!
//! The epoch is checked where it is stored: the gate never points back at a lower epoch (`epoch-stale`), and an
//! acknowledgement counts only from the epoch the intent was sent under (`epoch-other`). The writer refuses an intent
//! stamped with an epoch it does not hold.

use std::collections::{BTreeMap, VecDeque};

/// An intent's end.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum End {
    /// Acknowledged by the writer under `epoch`, in its log record `record`, at `at` (µs).
    Acked { epoch: u64, record: u64, at: u64 },
    /// Refused by name at `at` (µs).
    Refused { name: String, at: u64 },
}

/// One intent's line in the gate's ledger.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub agent: u32,
    /// When it reached the gate (µs).
    pub submitted: u64,
    /// The epoch it was sent under, once sent; `None` while held.
    pub sent: Option<u64>,
    /// Whether it waited in the hold.
    pub held: bool,
    pub end: Option<End>,
}

/// An intent to send: its id, its agent, and the epoch it is stamped with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Send {
    pub id: u64,
    pub agent: u32,
    pub epoch: u64,
}

/// The gate: the writer's epoch, the hold, and the ledger.
#[derive(Debug, Default)]
pub struct Gate {
    writer: Option<u64>,
    holding: bool,
    held: VecDeque<u64>,
    pub ledger: BTreeMap<u64, Entry>,
}

impl Gate {
    /// A gate pointing at the writer under `epoch`.
    pub fn new(epoch: u64) -> Gate {
        Gate {
            writer: Some(epoch),
            ..Gate::default()
        }
    }

    pub fn writer(&self) -> Option<u64> {
        self.writer
    }

    pub fn holding(&self) -> bool {
        self.holding
    }

    /// An intent arrives: sent at once under the writer's epoch, or held while the world moves.
    pub fn submit(&mut self, id: u64, agent: u32, now: u64) -> Option<Send> {
        let send = match (self.holding, self.writer) {
            (false, Some(epoch)) => Some(Send { id, agent, epoch }),
            _ => {
                self.held.push_back(id);
                None
            }
        };
        self.ledger.insert(
            id,
            Entry {
                agent,
                submitted: now,
                sent: send.map(|s| s.epoch),
                held: send.is_none(),
                end: None,
            },
        );
        send
    }

    /// Step 2: new intents wait here.
    pub fn hold(&mut self) {
        self.holding = true;
    }

    /// Points at the writer under `epoch`, never back at a lower one. Intents sent to an older writer that has not
    /// answered stay open until it does or it dies ([`Gate::writer_died`]).
    pub fn point(&mut self, epoch: u64) -> Result<(), String> {
        if self.writer.is_some_and(|w| epoch < w) {
            return Err(format!(
                "epoch-stale: {epoch} is below the writer's {:?}",
                self.writer
            ));
        }
        self.writer = Some(epoch);
        Ok(())
    }

    /// Step 4: stops holding and sends what was held, in order, under the writer's epoch.
    pub fn release(&mut self) -> Vec<Send> {
        self.holding = false;
        let Some(epoch) = self.writer else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for id in std::mem::take(&mut self.held) {
            if let Some(e) = self.ledger.get_mut(&id) {
                e.sent = Some(epoch);
                out.push(Send {
                    id,
                    agent: e.agent,
                    epoch,
                });
            }
        }
        out
    }

    /// The writer under `epoch` acknowledged intent `id` in record `record`. Refused `epoch-other` when the intent
    /// was not sent under that epoch, `ended` when it already has an end.
    pub fn acked(&mut self, id: u64, epoch: u64, record: u64, now: u64) -> Result<(), String> {
        let Some(e) = self.ledger.get_mut(&id) else {
            return Err(format!("unknown: intent {id}"));
        };
        if e.sent != Some(epoch) {
            return Err(format!(
                "epoch-other: intent {id} was sent under {:?}, acknowledged under {epoch}",
                e.sent
            ));
        }
        if e.end.is_some() {
            return Err(format!("ended: intent {id}"));
        }
        e.end = Some(End::Acked {
            epoch,
            record,
            at: now,
        });
        Ok(())
    }

    /// The writer refused intent `id` by `name`.
    pub fn refused(&mut self, id: u64, name: &str, now: u64) {
        if let Some(e) = self.ledger.get_mut(&id)
            && e.end.is_none()
        {
            e.end = Some(End::Refused {
                name: name.to_owned(),
                at: now,
            });
        }
    }

    /// The writer under `epoch` died: what was sent to it and not answered ends `writer-died` (the agent may send it
    /// again). Returns how many.
    pub fn writer_died(&mut self, epoch: u64, now: u64) -> usize {
        let mut n = 0;
        for e in self.ledger.values_mut() {
            if e.sent == Some(epoch) && e.end.is_none() {
                e.end = Some(End::Refused {
                    name: "writer-died".into(),
                    at: now,
                });
                n += 1;
            }
        }
        n
    }

    /// Intents with no end yet: held, or sent and not answered.
    pub fn open(&self) -> usize {
        self.ledger.values().filter(|e| e.end.is_none()).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_move_holds_then_releases_under_the_new_epoch() {
        let mut g = Gate::new(1);
        assert_eq!(
            g.submit(0, 7, 0),
            Some(Send {
                id: 0,
                agent: 7,
                epoch: 1
            })
        );
        g.hold();
        assert_eq!(g.submit(1, 8, 10), None);
        assert_eq!(g.submit(2, 9, 20), None);
        // The source answers what it was sent before the hold.
        g.acked(0, 1, 5, 30).expect("acked");
        assert!(g.point(0).is_err(), "never back to a lower epoch");
        g.point(2).expect("the target");
        let sent = g.release();
        assert_eq!(
            sent.iter().map(|s| (s.id, s.epoch)).collect::<Vec<_>>(),
            [(1, 2), (2, 2)]
        );
        assert!(
            g.acked(1, 1, 6, 40).is_err(),
            "the source's epoch cannot acknowledge what the target was sent"
        );
        g.acked(1, 2, 6, 40).expect("acked");
        assert_eq!(g.open(), 1);
        assert_eq!(g.writer_died(2, 50), 1);
        assert_eq!(g.open(), 0);
        assert!(g.ledger[&1].held && !g.ledger[&0].held);
    }
}
