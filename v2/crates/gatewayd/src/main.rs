//! Agents' sockets (Engine v2, #2635). Empty so far (K1, #2638).

fn main() {}

#[cfg(test)]
mod tests {
    #[test]
    fn builds_as_gatewayd() {
        assert_eq!(env!("CARGO_PKG_NAME"), "gatewayd");
    }
}
