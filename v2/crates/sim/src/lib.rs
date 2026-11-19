//! The world: tree, clock, controllers, movers, log. Native only (Engine v2, #2635). Empty so far (K1, #2638).
#![forbid(unsafe_code)]

pub mod activity;
pub mod audit;
pub mod checkpoint;
pub mod clock;
pub mod commit;
pub mod controller;
pub mod daylight;
pub mod edit;
pub mod forms;
pub mod frozen;
pub mod gaits;
pub mod gesture;
pub mod ground;
pub mod host;
pub mod index;
pub mod links;
pub mod log;
pub mod mover;
pub mod moves;
pub mod par;
pub mod random;
pub mod recorder;
pub mod refresh;
pub mod routes;
pub mod slots;
pub mod speech;
pub mod spots;
pub mod timed;
pub mod timers;
pub mod tracks;
pub mod unit;
pub mod unstick;
pub mod walk;

#[cfg(test)]
mod tests {
    #[test]
    fn builds_as_sim() {
        assert_eq!(env!("CARGO_PKG_NAME"), "sim");
    }
}
