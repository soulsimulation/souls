//! `gatewayd`: agents' sockets, held apart from the world (Engine v2 I1, #2683; see the crate's `lib.rs`).
//!
//! `gatewayd --listen <addr:port> --world <local socket path> --tokens <file> --build <hex>` prints
//! `listening <addr:port>` once it accepts sockets. The tokens file holds `<grant> <sha-256 hex> [<account>]` lines,
//! never a token. With `--receipts <dir>` (the world's `<worlds root>/worlds/<world>/receipts`), each answered intent
//! is a line in `<dir>/<UTC day>.jsonl` (see `receipts.rs`). With `--wake <alarm daemon's socket> --world-name
//! <world>` (O2, #2731), an intent for the world while it sleeps is held and the alarm daemon asked to wake it.

use std::path::PathBuf;
use std::sync::Arc;

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
            "usage: gatewayd --listen <addr:port> --world <local socket> --tokens <file> --build <hex> [--receipts <dir>] [--wake <socket> --world-name <world>]"
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
    let receipts = arg("--receipts").map_or_else(Receipts::off, |d| Receipts::to_dir(d.into()));
    let gw = Gateway::with_receipts(tokens, build, stderr_log(), receipts);
    if let (Some(socket), Some(name)) = (arg("--wake"), arg("--world-name")) {
        gw.link.set_wake(Arc::new(move || {
            let (socket, name) = (socket.clone(), name.clone());
            // Off the socket's task: one line to the local daemon, its answer read and dropped.
            std::thread::spawn(move || {
                use std::io::{Read, Write};
                match std::os::unix::net::UnixStream::connect(&socket) {
                    Ok(mut s) => {
                        let _ = s.write_all(format!("wake {name}\n").as_bytes());
                        let _ = s.read(&mut [0u8; 64]);
                    }
                    Err(e) => eprintln!("gatewayd: wake {name}: {e}"),
                }
            });
        }));
    }
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
