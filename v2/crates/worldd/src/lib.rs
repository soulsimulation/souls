//! The world process's library (Engine v2, #2635): what `main`, its tests and the benches share: its checkers (I3,
//! #2686) and its view tier (R3, #2697), which `v2/tools/bench/view-tier` drives. The binary is `main.rs`.
#![forbid(unsafe_code)]

pub mod acts;
pub mod answers;
pub mod bodies;
pub mod checkers;
pub mod engine;
pub mod measures;
pub mod moves;
pub mod testbodies;
pub mod view_out;
pub mod views;
pub mod words;
