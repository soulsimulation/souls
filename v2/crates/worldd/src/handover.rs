//! The gateway's connections over the world's life (I4's durable half; the gateway's end is `gatewayd`'s
//! `world_link`). An intent's answer goes back on the connection it came on ([`crate::answers::serve`]). A gateway
//! that restarts (an upgrade, a crash, `kill -9`) takes its connection with it, while the world goes on: a walk
//! accepted before the restart ends after it, and its answer, sent to the ended connection, was lost. The Soul's act
//! never got its receipt.
//!
//! So a gateway says on each connection that it is the world's gateway ([`ask`]), and the world hands an ended
//! gateway connection's answers on: each answer to an intent (a frame naming an actor and a sequence) that the ended
//! connection can no longer take goes to the newest gateway connection still up, or, while none is up, is held (at
//! most [`HELD_MOST`]) and goes to the next one as it asks, oldest first. The gateway passes an answer for an intent
//! it does not hold to its actor's socket, once. Nothing else is handed on: a sync answer or the Souls' words were
//! for the ended connection's own asks.
//!
//! Every gateway connection still up is kept, not only the newest: each connection is served on its own thread, so
//! a connection that ended at once (its gateway restarted under it) can ask after the one that replaced it, and its
//! end must leave the newer one taking answers rather than none.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::mpsc::Sender;

use replica::encode::{Value, decode, encode};

/// The key of the frame a gateway sends first on each connection: `{31: []}` (gatewayd's `world_link::HANDOVER`).
pub const ASK: u64 = 31;

/// Answers held while no gateway is connected; past it the oldest goes.
pub const HELD_MOST: usize = 4096;

/// The frame a gateway sends to be handed ended connections' answers.
pub fn ask() -> Vec<u8> {
    encode(&Value::Map([(ASK, Value::Array(Vec::new()))].into())).unwrap_or_default()
}

/// Whether `frame` answers an intent: `{1: version, 2: {1: actor, 2: sequence, ..}}`.
pub fn answers_an_intent(frame: &[u8]) -> bool {
    let Ok(d) = decode(frame) else { return false };
    let Value::Map(m) = d.value else { return false };
    let Some(Value::Map(a)) = m.get(&2) else {
        return false;
    };
    m.contains_key(&1) && a.contains_key(&1) && matches!(a.get(&2), Some(Value::Uint(_)))
}

#[derive(Default)]
pub struct Handover {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    next: u64,
    /// The gateway connections up, by number, with their queues, in the order they asked: the last is the newest.
    gateways: Vec<(u64, Sender<Vec<u8>>)>,
    held: VecDeque<Vec<u8>>,
}

impl Handover {
    /// A new connection's number.
    pub fn connection(&self) -> u64 {
        let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        s.next += 1;
        s.next
    }

    /// Connection `n` is the gateway's (it sent [`ask`]): the answers held go to it, then those handed on after.
    pub fn asked(&self, n: u64, reply: &Sender<Vec<u8>>) {
        let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        while let Some(f) = s.held.pop_front() {
            if let Err(e) = reply.send(f) {
                s.held.push_front(e.0);
                return;
            }
        }
        s.gateways.push((n, reply.clone()));
    }

    /// Connection `n` ended: answers are no longer handed to it.
    pub fn ended(&self, n: u64) {
        let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        s.gateways.retain(|(c, _)| *c != n);
    }

    /// A frame ended connection `n` could not take: an intent's answer goes to the newest other gateway connection
    /// up, or is held for the next; anything else is dropped.
    pub fn hand_on(&self, n: u64, mut frame: Vec<u8>) {
        if !answers_an_intent(&frame) {
            return;
        }
        let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        // `n` has ended (that is why it hands on) even while its `ended` is still to run: never hand back to it.
        s.gateways.retain(|(c, _)| *c != n);
        for (_, tx) in s.gateways.iter().rev() {
            match tx.send(frame) {
                Ok(()) => return,
                Err(e) => frame = e.0,
            }
        }
        if s.held.len() == HELD_MOST {
            s.held.pop_front();
        }
        s.held.push_back(frame);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    fn answer(sequence: u64) -> Vec<u8> {
        let a = Value::Map(
            [
                (1, Value::Bytes(vec![1, 2])),
                (2, Value::Uint(sequence)),
                (3, Value::Uint(1)),
            ]
            .into(),
        );
        encode(&Value::Map([(1, Value::Array(Vec::new())), (2, a)].into())).unwrap()
    }

    #[test]
    fn an_ended_connections_answers_go_to_the_next_gateway_once_in_order() {
        let h = Handover::default();
        let (a, b) = (h.connection(), h.connection());
        let (to_a, _from_a) = channel();
        h.asked(a, &to_a);
        // Gone with none newer: held, and never handed back to the ended connection itself.
        h.ended(a);
        h.hand_on(a, answer(1));
        h.hand_on(a, answer(2));
        // Not an intent's answer (a sync answer, the Souls' words): dropped.
        h.hand_on(
            a,
            encode(&Value::Map([(20, Value::Uint(1))].into())).unwrap(),
        );
        let (to_b, from_b) = channel();
        h.asked(b, &to_b);
        h.hand_on(a, answer(3));
        let got: Vec<Vec<u8>> = from_b.try_iter().collect();
        assert_eq!(got, vec![answer(1), answer(2), answer(3)]);
        // The newest connection's own frames are never handed to itself.
        h.hand_on(b, answer(4));
        assert!(from_b.try_iter().next().is_none());
    }

    /// A connection that ended at once can ask after the one that replaced it (each is served on its own thread):
    /// its end leaves the newer one taking answers, so nothing waits for a gateway that is already up.
    #[test]
    fn an_ended_connection_that_asked_late_leaves_the_newer_one_taking_answers() {
        let h = Handover::default();
        let (old, new) = (h.connection(), h.connection());
        let (to_old, _from_old) = channel();
        let (to_new, from_new) = channel();
        h.asked(new, &to_new);
        h.asked(old, &to_old);
        h.ended(old);
        h.hand_on(old, answer(1));
        assert_eq!(from_new.try_iter().collect::<Vec<_>>(), vec![answer(1)]);
    }
}
