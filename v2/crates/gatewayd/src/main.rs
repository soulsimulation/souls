//! `gatewayd`: agents' sockets, held apart from the world (Engine v2 I1, #2683; see the crate's `lib.rs`).
//!
//! `gatewayd --listen <addr:port> --world <local socket path> --tokens <file> --build <hex>` prints
//! `listening <addr:port>` once it accepts sockets. The tokens file holds `<grant> <sha-256 hex>` lines, never a token.

use std::path::PathBuf;

use gatewayd::token::Tokens;
use gatewayd::{Gateway, socket, stderr_log, world_link};
use replica::encode::from_hex;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|k| args.get(k + 1))
            .cloned()
    };
    let (Some(listen), Some(world), Some(tokens), Some(build)) = (
        arg("--listen"),
        arg("--world"),
        arg("--tokens"),
        arg("--build"),
    ) else {
        eprintln!(
            "usage: gatewayd --listen <addr:port> --world <local socket> --tokens <file> --build <hex>"
        );
        std::process::exit(2);
    };
    let tokens = std::fs::read_to_string(&tokens)
        .map_err(|e| e.to_string())
        .and_then(|t| Tokens::read(&t));
    let (Ok(tokens), Ok(build)) = (tokens, from_hex(&build)) else {
        eprintln!("gatewayd: the tokens file or the build hash could not be read");
        std::process::exit(2);
    };
    let gw = Gateway::new(tokens, build, stderr_log());
    tokio::spawn(world_link::run(gw.clone(), PathBuf::from(world)));
    let listener = match tokio::net::TcpListener::bind(&listen).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("gatewayd: listen: {e}");
            std::process::exit(1);
        }
    };
    if let Ok(addr) = listener.local_addr() {
        println!("listening {addr}");
    }
    if let Err(e) = axum::serve(listener, socket::router(gw)).await {
        eprintln!("gatewayd: {e}");
        std::process::exit(1);
    }
}
