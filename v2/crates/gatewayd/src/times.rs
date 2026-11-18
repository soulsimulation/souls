//! The gateway's stamps on an answer (Engine v2 O4, #2694): its time in, the link to the world each way, its time
//! out, and its whole time from the intent's receipt to the answer's send, added to the world's block
//! (`replica::intents::ANSWER_TIMES`). The client's wait less the whole is the network.
//!
//! Stamps are this machine's steady clock (`CLOCK_MONOTONIC`, [`stamp`]), which the world, one local socket away on
//! the same machine, reads too: its block's first integer is its first stamp, so the gateway places the link's time
//! each way. A stamp is never subtracted from another machine's, and the client gets only µs between stamps:
//!
//! `[whole, gateway.in, link.in, world.in, check, tick.wait, commit, log.sync, world.out, link.out, gateway.out]`
//!
//! As it reads an answer, the gateway keeps its receipt and read stamps in the block, with a 0 that marks it
//! unsent; the socket that sends it turns them into the whole and the time out ([`finish`]).

use replica::encode::{Value, decode, encode};
use replica::intents::ANSWER_TIMES;
use std::collections::BTreeMap;

/// The world's block: its first stamp and six parts.
const WORLD_BLOCK: usize = 7;
/// The block as the client gets it.
pub const CLIENT_BLOCK: usize = 11;

/// This machine's steady clock, µs (`CLOCK_MONOTONIC`, as `worldd::measures::steady_us`).
pub fn stamp() -> u64 {
    let t = rustix::time::clock_gettime(rustix::time::ClockId::Monotonic);
    let (s, ns) = (
        u64::try_from(t.tv_sec).unwrap_or(0),
        u64::try_from(t.tv_nsec).unwrap_or(0),
    );
    s * 1_000_000 + ns / 1_000
}

type Map = BTreeMap<u64, Value>;

fn block(frame: &[u8]) -> Option<(Map, Vec<u64>)> {
    let Value::Map(m) = decode(frame).ok()?.value else {
        return None;
    };
    let Some(Value::Array(b)) = m.get(&ANSWER_TIMES) else {
        return None;
    };
    let b = b
        .iter()
        .map(|x| match x {
            Value::Uint(n) => Some(*n),
            _ => None,
        })
        .collect::<Option<Vec<u64>>>()?;
    Some((m, b))
}

fn with(mut m: Map, b: Vec<u64>) -> Option<Vec<u8>> {
    m.insert(
        ANSWER_TIMES,
        Value::Array(b.into_iter().map(Value::Uint).collect()),
    );
    encode(&Value::Map(m)).ok()
}

/// An answer read from the world at `read`, for an intent received at `received` and handed to the world link at
/// `handed`: the world's parts with the gateway's and the link's around them. A frame without the world's block is
/// left alone.
pub fn read_from_world(frame: Vec<u8>, received: u64, handed: u64, read: u64) -> Vec<u8> {
    let Some((m, world)) = block(&frame).filter(|(_, b)| b.len() == WORLD_BLOCK) else {
        return frame;
    };
    let (first, parts) = (world[0], &world[1..]);
    let last = first.saturating_add(parts.iter().sum());
    let mut b = Vec::with_capacity(CLIENT_BLOCK + 1);
    b.push(received);
    b.push(handed.saturating_sub(received));
    b.push(first.saturating_sub(handed));
    b.extend_from_slice(parts);
    b.push(read.saturating_sub(last));
    b.push(read);
    b.push(0);
    with(m, b).unwrap_or(frame)
}

/// A frame about to be sent to a client: a block the gateway carries gets its whole and its time out, as of now.
pub fn finish(frame: Vec<u8>) -> Vec<u8> {
    // Only an answer with a block is touched: a map of three.
    if frame.first() != Some(&0xa3) {
        return frame;
    }
    let now = stamp();
    let Some((m, mut b)) = block(&frame).filter(|(_, b)| b.len() == CLIENT_BLOCK + 1) else {
        return frame;
    };
    b.pop();
    let (received, read) = (b[0], b[CLIENT_BLOCK - 1]);
    b[0] = now.saturating_sub(received);
    b[CLIENT_BLOCK - 1] = now.saturating_sub(read);
    with(m, b).unwrap_or(frame)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gateway_places_the_link_and_finishes_at_send() {
        let t0 = stamp();
        // The world: first stamp 3 ms after receipt, six parts summing to 20 ms.
        let world = encode(&Value::Map(
            [
                (1, Value::Uint(1)),
                (2, Value::Uint(2)),
                (
                    ANSWER_TIMES,
                    Value::Array(
                        [t0 + 3_000, 1_000, 2_000, 3_000, 4_000, 5_000, 5_000]
                            .into_iter()
                            .map(Value::Uint)
                            .collect(),
                    ),
                ),
            ]
            .into(),
        ))
        .unwrap();
        let mid = read_from_world(world, t0, t0 + 1_000, t0 + 24_000);
        std::thread::sleep(std::time::Duration::from_millis(30));
        let done = finish(mid);
        let (_, b) = block(&done).unwrap();
        assert_eq!(b.len(), CLIENT_BLOCK);
        assert_eq!(
            &b[1..10],
            &[
                1_000, 2_000, 1_000, 2_000, 3_000, 4_000, 5_000, 5_000, 1_000
            ]
        );
        assert!(b[0] >= 30_000 && b[10] >= 6_000, "{b:?}");
        assert_eq!(b[0], b[1..].iter().sum::<u64>(), "the parts are the whole");
        assert_eq!(finish(done.clone()), done, "a sent block is left as it is");
    }
}
