//! The directory (Engine v2, #2635): where a world runs, when it wakes, where a Soul is (W8, #2729): see
//! [`directory`]; its accounts (W1, #2704): see [`accounts`]; pairing a Soul to an agent (W2, #2705): see [`pairing`];
//! making a world (G9, #2798): see [`worlds`]; and shipping the stores the log does not hold (O20, #2812): see
//! [`backup`].

pub mod accounts;
pub mod backup;
pub mod directory;
pub mod pairing;
pub mod worlds;
