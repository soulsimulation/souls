//! The world process's library (Engine v2, #2635): what `main`, its tests and the benches share: its checkers (I3,
//! #2686), its view tier (R3, #2697), which `v2/tools/bench/view-tier` drives, and the shipping of its log off the
//! machine (O3, #2732). The binary is `main.rs`.
#![forbid(unsafe_code)]

pub mod answers;
pub mod bodies;
pub mod checkers;
pub mod measures;
pub mod shipping;
pub mod view_out;
pub mod views;
