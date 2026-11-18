//! The built-in skills (Engine v2 T9, #2663; `v2/docs/bodies.md`). They touch the world only through
//! `replica::host::Host`, the same interface a creator's module will have, and this crate depends on `replica`
//! alone: the world's state lives in `sim`, which it cannot name. `scan` checks what the compiler cannot refuse.
#![forbid(unsafe_code)]
// No float in what a skill decides (lane note 4; K14).
#![deny(clippy::float_arithmetic)]

pub mod scan;
pub mod walk;
