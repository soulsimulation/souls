//! `gatewayd`: agents' sockets, held apart from the world (Engine v2 I1, #2683; see the crate's `lib.rs`).
//!
//! `gatewayd --listen <addr:port> --world <local socket path> --tokens <file> --build <hex>` prints
//! `listening <addr:port>` once it accepts sockets. The tokens file holds `<grant> <sha-256 hex> [<account>]` lines,
//! never a token. View subscriptions go to the world's view tier at `--views` (default: the world's socket path with
//! `.views`). With `--receipts <dir>` (the world's `<worlds root>/worlds/<world>/receipts`), each answered intent
//! is a line in `<dir>/<UTC day>.jsonl` (see `receipts.rs`).
//!
//! On SIGTERM or SIGINT it stops accepting, closes every signed-in socket with 1012 and exits within [`DRAIN`]
//! (O16, #2809; `v2/docs/runbook/gateway-upgrade.md`).

use std::path::PathBuf;
use std::time::Duration;

use gatewayd::receipts::Receipts;
use gatewayd::token::Tokens;
use gatewayd::{Gateway, socket, stderr_log, world_link};
use replica::encode::from_hex;
use tokio::signal::unix::{SignalKind, signal};

/// How long a stopping gateway waits for its sockets' 1012 closes to go out before it exits anyway.
const DRAIN: Duration = Duration::from_secs(2);

/// SIGTERM (systemd's stop) or SIGINT.
async fn stop_asked() {
    let (Ok(mut term), Ok(mut int)) = (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
    ) else {
        return std::future::pending().await;
    };
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
}

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
    // Stop accepting first, then close every signed-in socket with 1012; exit once they are closed, or after DRAIN.
    let stopping = {
        let gw = gw.clone();
        async move {
            stop_asked().await;
            (gw.log)("stopping: sockets close with 1012");
            gw.closing.send_replace(true);
        }
    };
    if let Err(e) = axum::serve(listener, socket::router(gw.clone()))
        .with_graceful_shutdown(stopping)
        .await
    {
        eprintln!("gatewayd: {e}");
        std::process::exit(1);
    }
    let _ = tokio::time::timeout(DRAIN, async {
        while gw.closing.receiver_count() > 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    (gw.log)("stopped");
}
