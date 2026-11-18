//! The world: tree, clock, controllers, movers, log. Native only (Engine v2, #2635). Empty so far (K1, #2638).
#![forbid(unsafe_code)]

pub mod clock;
pub mod ground;
pub mod links;
pub mod mover;
pub mod routes;
pub mod unstick;
pub mod walk;
pub mod commit;
pub mod frozen;

#[cfg(test)]
mod tests {
    #[test]
    fn builds_as_sim() {
        assert_eq!(env!("CARGO_PKG_NAME"), "sim");
    }
}
