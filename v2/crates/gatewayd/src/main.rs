//! `gatewayd`: agents' sockets, held apart from the world (Engine v2 I1, #2683; see the crate's `lib.rs`).
//!
//! `gatewayd --listen <addr:port> --world <local socket path> --tokens <file> --build <hex>` prints
//! `listening <addr:port>` once it accepts sockets. The tokens file holds `<grant> <sha-256 hex> [<account>]` lines,
//! never a token; it is read again whenever it changes (C3). View subscriptions go to the world's view tier at
//! `--views` (default: the world's socket path with `.views`). With `--receipts <dir>` (the world's `<worlds root>/worlds/<world>/receipts`), each answered intent
//! is a line in `<dir>/<UTC day>.jsonl` (see `receipts.rs`). With `--view-key <file>` (64 hex digits, the key the
//! directory signs view tokens with, V13b) a page signs in with a view token for a view socket. With `--mailbox
//! <directory addr:port> --mailbox-key <file>`, the owner's messages reach their Souls' sockets (R13, `mailbox.rs`).
//! With `--creator <32 hex>-<n> --directory <addr:port>`, a page signed in as that creator exchanges its session for a
//! short token (W5, `creator.rs`). With `--entries <dir>` (the world's `<world>/entries`) a signed-in client fetches
//! the world's kind entries at `GET /v2/entries` (#3760, `entries.rs`); a folder that is unreadable or holds no
//! entry stops it at start. Without the flag it says so on stderr and clients get no kinds.
//!
//! On SIGTERM or SIGINT it stops accepting, closes every signed-in socket with 1012 and exits within [`DRAIN`]
//! (O16, #2809; `v2/docs/runbook/gateway-upgrade.md`).

use std::path::PathBuf;
use std::time::Duration;

use gatewayd::receipts::Receipts;
use gatewayd::token::{Source, Tokens, ViewKey};
use gatewayd::{Gateway, creator, mailbox, socket, stderr_log, world_link};
use replica::encode::from_hex;
use replica::ids::{Id, Scope};
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
            "usage: gatewayd --listen <addr:port> --world <local socket> --tokens <file> --build <hex> [--receipts <dir>] [--views <path>] [--view-key <file>] [--mailbox <addr:port> --mailbox-key <file>] [--creator <32 hex>-<n> --directory <addr:port>] [--entries <dir>]"
        );
        std::process::exit(2);
    };
    let tokens_file = tokens.clone();
    // The tokens file is read again when it changes, so a Soul paired while the gateway runs signs in at once (C3).
    let read = Source::open(std::path::Path::new(&tokens));
    let (Ok((source, tokens)), Ok(build)) = (read, from_hex(&build)) else {
        eprintln!("gatewayd: the tokens file or the build hash could not be read");
        std::process::exit(2);
    };
    let receipts = arg("--receipts").map_or_else(Receipts::off, |d| Receipts::to_dir(d.into()));
    let gw = Gateway::with_receipts(tokens, build, stderr_log(), receipts);
    let _ = gw.tokens_file.set(source);
    let control_path = PathBuf::from(&tokens_file).with_file_name(gatewayd::control::NAME);
    let control_listener = match gatewayd::control::bind(&control_path).await {
        Ok(listener) => listener,
        Err(name) => {
            eprintln!("gatewayd: {name}");
            std::process::exit(1);
        }
    };
    tokio::spawn(gatewayd::control::run(
        gw.clone(),
        control_path,
        control_listener,
    ));
    if let Some(path) = arg("--view-key") {
        let key = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| ViewKey::read(&t));
        let Some(key) = key else {
            eprintln!("gatewayd: --view-key is a file of 64 hex digits");
            std::process::exit(2);
        };
        let _ = gw.view_key.set(key);
    }
    if let (Some(addr), Some(key)) = (arg("--mailbox"), arg("--mailbox-key")) {
        let Ok(key) = std::fs::read_to_string(&key) else {
            eprintln!("gatewayd: the mailbox key could not be read");
            std::process::exit(2);
        };
        let key = key.trim().to_owned();
        let _ = gw.mailbox.set(mailbox::Mailbox { addr, key });
        tokio::spawn(mailbox::run(gw.clone()));
    }
    if args.iter().any(|a| a == "--creator-authority-required")
        && (arg("--creator").is_none() || arg("--directory").is_none())
    {
        eprintln!("gatewayd: required creator authority needs --creator and --directory");
        std::process::exit(2);
    }
    if let (Some(c), Some(directory)) = (arg("--creator"), arg("--directory")) {
        let Some(creator) = c.split_once('-').and_then(|(scope, n)| {
            Id::new(
                Scope(from_hex(scope).ok()?.try_into().ok()?),
                n.parse().ok()?,
            )
        }) else {
            eprintln!("gatewayd: --creator is <32 hex>-<counter>");
            std::process::exit(2);
        };
        let _ = gw.exchange.set(creator::Exchange {
            creator,
            directory,
            authority_required: args.iter().any(|a| a == "--creator-authority-required"),
        });
    }
    match arg("--entries") {
        Some(dir) => match gatewayd::entries::Entries::open(std::path::Path::new(&dir)) {
            Ok(e) => {
                (gw.log)(&format!("entries: {} served at {}", e.current().count, gatewayd::entries::PATH));
                let _ = gw.entries.set(e);
            }
            Err(why) => {
                eprintln!("gatewayd: --entries cannot be served: {why}");
                std::process::exit(2);
            }
        },
        None => eprintln!("gatewayd: no --entries: paired clients get none of the world's kinds (#3760)"),
    }
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
