//! The team gate (0.135 lane C): Souls carrying together on the new engine, each step a Soul's own intent through the
//! real gateway. The scenes are its tests (`tests/carry.rs`); each prints the rung it reached.
//!
//! - **Rung 0 (C1, #4051):** two Souls walk to a load by ordinary walks, join by an offer and its accept, lift it,
//!   carry it 25 m and set it down. A Soul alone is refused by name. Every id is conserved, and the log's effects
//!   replayed onto the world as built give the state hash its last part holds.
//! - **Rung 1 (C2):** each load is carried as its kind's entry states (a rack beam, then a rack upright, shorter and
//!   wider). A passage too narrow for the load, a crew too small and a grip out of reach are each refused by name
//!   before the lift, and nothing moves.
//!
//! `cargo test -p team-gate -- --nocapture`.
