//! `gatewayd`: agents' sockets, held apart from the world (Engine v2 I1, #2683; see the crate's `lib.rs`).
//!
//! `gatewayd --listen <addr:port> --world <local socket path> --tokens <file> --build <hex>` prints
//! `listening <addr:port>` once it accepts sockets. The tokens file holds `<grant> <sha-256 hex> [<account>]` lines,
//! never a token; it is read again whenever it changes (C3). With `--receipts <dir>` (the world's `<worlds root>/worlds/<world>/receipts`), each answered intent
//! is a line in `<dir>/<UTC day>.jsonl` (see `receipts.rs`).

use std::path::PathBuf;

use gatewayd::receipts::Receipts;
use gatewayd::token::Source;
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
            "usage: gatewayd --listen <addr:port> --world <local socket> --tokens <file> --build <hex> [--receipts <dir>]"
        );
        std::process::exit(2);
    };
    // The tokens file is read again when it changes, so a Soul paired while the gateway runs signs in at once (C3).
    let read = Source::open(std::path::Path::new(&tokens));
    let (Ok((source, tokens)), Ok(build)) = (read, from_hex(&build)) else {
        eprintln!("gatewayd: the tokens file or the build hash could not be read");
        std::process::exit(2);
    };
    let receipts = arg("--receipts").map_or_else(Receipts::off, |d| Receipts::to_dir(d.into()));
    let gw = Gateway::with_receipts(tokens, build, stderr_log(), receipts);
    let _ = gw.tokens_file.set(source);
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
