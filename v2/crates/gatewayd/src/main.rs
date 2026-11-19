//! `gatewayd`: agents' sockets, held apart from the world (Engine v2 I1, #2683; see the crate's `lib.rs`).
//!
//! `gatewayd --listen <addr:port> --world <local socket path> --tokens <file> --build <hex>` prints
//! `listening <addr:port>` once it accepts sockets. The tokens file holds `<grant> <sha-256 hex> [<account>]` lines,
//! never a token. View subscriptions go to the world's view tier at `--views` (default: the world's socket path with
//! `.views`). With `--receipts <dir>` (the world's `<worlds root>/worlds/<world>/receipts`), each answered intent
//! is a line in `<dir>/<UTC day>.jsonl` (see `receipts.rs`).

use std::path::PathBuf;

use gatewayd::receipts::Receipts;
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
            "usage: gatewayd --listen <addr:port> --world <local socket> --tokens <file> --build <hex> [--receipts <dir>] [--views <path>]"
        );
        std::process::exit(2);
    };
    let tokens_file = tokens.clone();
    let tokens = std::fs::read_to_string(&tokens)
        .map_err(|e| e.to_string())
        .and_then(|t| Tokens::read(&t));
    let (Ok(tokens), Ok(build)) = (tokens, from_hex(&build)) else {
        eprintln!("gatewayd: the tokens file or the build hash could not be read");
        std::process::exit(2);
    };
    let receipts = arg("--receipts").map_or_else(Receipts::off, |d| Receipts::to_dir(d.into()));
    let gw = Gateway::with_receipts(tokens, build, stderr_log(), receipts);
    let views = arg("--views").map_or_else(
        || PathBuf::from(&world).with_extension("views"),
        PathBuf::from,
    );
    tokio::spawn(gatewayd::views::run(gw.clone(), views));
    tokio::spawn(world_link::run(gw.clone(), PathBuf::from(world)));
    // The tokens file is read again every 2 s, so a pairing or a revoke (W9, #2827) holds within seconds.
    let reread = gw.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if let Ok(Ok(t)) = std::fs::read_to_string(&tokens_file).map(|t| Tokens::read(&t)) {
                *reread.tokens.write().unwrap_or_else(|e| e.into_inner()) = t;
            }
        }
    });
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
