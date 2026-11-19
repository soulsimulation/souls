//! The built-in skills (Engine v2 T9, #2663; `v2/docs/bodies.md`). They touch the world only through
//! `replica::host::Host`, the same interface a creator's module will have, and this crate depends on `replica`
//! alone: the world's state lives in `sim`, which it cannot name. `scan` checks what the compiler cannot refuse.
#![forbid(unsafe_code)]
// No float in what a skill decides (lane note 4; K14).
#![deny(clippy::float_arithmetic)]

pub mod close;
/// The form runner (F1, #2766).
pub mod form_runner;
/// The three standing orders (B7, #2726).
pub mod orders;
/// N7's walk through the host (T9b #3120).
pub mod route;
pub mod scan;
pub mod walk;
/// A Soul's body chosen (B15a, #2750).
pub mod wear;
