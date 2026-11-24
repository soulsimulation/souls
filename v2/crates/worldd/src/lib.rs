//! The world process's library (Engine v2, #2635): what `main`, its tests and the benches share: its checkers (I3,
//! #2686), its view tier (R3, #2697), which `v2/tools/bench/view-tier` drives, and the shipping of its log off the
//! machine (O3, #2732), and the thread that answers sync requests (C16, #3450). The binary is `main.rs`.
#![forbid(unsafe_code)]

pub mod acts;
pub mod answers;
pub mod assembly;
pub mod bodies;
pub mod buildsafe;
pub mod carrier;
pub mod checkers;
pub mod closed;
pub mod directory;
mod edit_places;
pub mod engine;
pub mod handover;
pub mod loose;
pub mod measures;
pub mod moves;
pub mod needs;
pub mod orders;
pub mod places;
pub mod setdown;
pub mod shipping;
pub mod start;
mod syncs;
pub use syncs::SEAL_EVERY;
pub mod testbodies;
pub mod undo;
pub mod unstick;
pub mod view_out;
pub mod views;
pub mod words;
