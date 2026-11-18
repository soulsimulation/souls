//! The world: tree, clock, controllers, movers, log. Native only (Engine v2, #2635). Empty so far (K1, #2638).
#![forbid(unsafe_code)]

pub mod audit;
pub mod checkpoint;
pub mod clock;
pub mod ground;
pub mod links;
pub mod log;
pub mod mover;
pub mod routes;
pub mod text;
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
