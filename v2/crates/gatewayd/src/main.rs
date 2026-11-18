//! Agents' sockets (Engine v2, #2635). The process is empty so far (K1, #2638); the gate a moving world's intents
//! pass through (O9, #2828) is the library, driven by `v2/tools/ops` (`ops move`).

fn main() {}

#[cfg(test)]
mod tests {
    #[test]
    fn builds_as_gatewayd() {
        assert_eq!(env!("CARGO_PKG_NAME"), "gatewayd");
    }
}
