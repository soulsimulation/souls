//! The directory process (Engine v2, #2635): so far the sign-in (W1, #2704). Arguments: [`start::USAGE`]. It prints
//! `listening on <address>` once it serves, and refuses to start, with a line saying why, on what [`start::parse`]
//! refuses.

use directoryd::accounts::serve::{App, key_digest, run};
use directoryd::accounts::session::{Jwks, Verifier};
use directoryd::accounts::start;
use directoryd::accounts::store::Store;
use directoryd::backup;
use std::collections::BTreeMap;
use std::net::TcpListener;
use std::path::Path;
use std::sync::{Arc, Mutex};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let config = match start::parse(&args) {
        Ok(c) => c,
        Err(why) => {
            eprintln!("directoryd: {why}");
            std::process::exit(2);
        }
    };
    let store = match Store::open(&config.store) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("directoryd: refusing to start: {e}");
            std::process::exit(2);
        }
    };
    let verifier = config
        .provider
        .as_ref()
        .map(|p| Verifier::new(&p.issuer, &p.parties, Box::new(Jwks { url: p.jwks_url() })));
    let pairing = directoryd::pairing::Pairing::start(&config).unwrap_or_else(|e| {
        eprintln!("directoryd: refusing to start: the pairing store: {e}");
        std::process::exit(2)
    });
    let listener = match TcpListener::bind(config.listen) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("directoryd: refusing to start: cannot listen: {e}");
            std::process::exit(2);
        }
    };
    let mailbox_key = match config.mailbox_key.as_deref().map(std::fs::read_to_string) {
        None => None,
        Some(Ok(k)) if !k.trim().is_empty() => Some(key_digest(k.trim())),
        Some(_) => {
            eprintln!("directoryd: refusing to start: --mailbox-key names no readable key");
            std::process::exit(2);
        }
    };
    let app = Arc::new(App {
        store,
        verifier,
        test_sign_in: config.test_sign_in,
        mailbox_key,
        pairing,
        log: Mutex::new(Box::new(std::io::stderr())),
        worlds: match directoryd::worlds::list::from_env("directoryd") {
            Some(Err(e)) => {
                eprintln!(
                    "directoryd: refusing to start: worlds: {}: {}",
                    e.name, e.detail
                );
                std::process::exit(2);
            }
            w => w.and_then(Result::ok),
        },
    });
    // O20's shipper for the directory's stores (O20b, #3523): the account store's copy is handed over by this program,
    // which holds it exclusively; with no bucket set it says so once and ships nothing.
    let mut stores = Vec::new();
    for mut e in backup::owned_by("directoryd", &[]).unwrap_or_default() {
        let at = match e.name.as_str() {
            "accounts" => Some(&config.store),
            "pairing" => config.pairing.as_ref(),
            "gateway-tokens" => config.gateway_tokens.as_ref(),
            _ => None,
        };
        if let Some(at) = at.and_then(|p| std::path::absolute(p).ok()) {
            e.path = at.to_string_lossy().into_owned();
            stores.push(e);
        }
    }
    let owner = Arc::clone(&app);
    let hooks = BTreeMap::from([(
        "accounts".to_owned(),
        Box::new(move |to: &Path| owner.store.backup(to).map_err(|e| e.to_string())) as backup::Hook,
    )]);
    let root = std::path::absolute(&config.store)
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    match backup::run("directoryd", root, stores, hooks, "") {
        Ok(said) => eprintln!("{said}"),
        Err(e) => {
            eprintln!("directoryd: refusing to start: {}: {}", e.name, e.detail);
            std::process::exit(2);
        }
    }
    let addr = listener.local_addr().expect("a bound address");
    println!("listening on {addr}");
    run(listener, app);
}
