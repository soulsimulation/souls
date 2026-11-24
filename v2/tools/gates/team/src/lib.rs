//! The team gate (0.135 lane C): Souls carrying together on the new engine, each step a Soul's own intent through the
//! real gateway. The scenes are its tests (`tests/carry.rs`); each prints the rung it reached.
//!
//! - **Rung 0 (C1, #4051):** two Souls walk to a load by ordinary walks, join by an offer and its accept, lift it,
//!   carry it 25 m and set it down. A Soul alone is refused by name. Every id is conserved, and the log's effects
//!   replayed onto the world as built give the state hash its last part holds.
//! - **Rung 1 (C2):** each load is carried as its kind's entry states (a rack beam, then a rack upright, shorter and
//!   wider). A passage too narrow for the load, a crew too small and a grip out of reach are each refused by name
//!   before the lift, and nothing moves.
//! - **Rung 2 (C3):** a carry that breaks off. A decline and a lapsed offer move nothing. A partner who leaves, a
//!   partner whose connection is gone, and a world restarted, each mid-carry, leave the load set down on the ground
//!   where the carry had it, the world saying why (`souls:carry-set-down`); every leave after is answered at once.
//! - **Crews of up to six (a measure, no rung yet):** five Souls meet today's limits, each by name. A two-role carry
//!   makes a second pair at a third accept; five in one carry that takes six lift a crate that takes three with two at
//!   its grips, and the fifth's leave sets it down (`souls:partner-left`) with four left.
//!
//! `cargo test -p team-gate -- --nocapture`.
