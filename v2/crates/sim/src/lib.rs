//! The world: tree, clock, controllers, movers, log. Native only (Engine v2, #2635). Empty so far (K1, #2638).
#![forbid(unsafe_code)]

pub mod checkpoint;
pub mod clock;
pub mod commit;
pub mod controller;
pub mod forms;
pub mod frozen;
pub mod ground;
pub mod host;
pub mod index;
pub mod links;
pub mod log;
pub mod mover;
pub mod moves;
pub mod routes;
pub mod slots;
pub mod speech;
pub mod spots;
pub mod timers;
pub mod unstick;
pub mod walk;

#[cfg(test)]
mod tests {
    #[test]
    fn builds_as_sim() {
        assert_eq!(env!("CARGO_PKG_NAME"), "sim");
    }
}
