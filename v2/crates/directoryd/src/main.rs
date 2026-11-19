//! The directory process (Engine v2, #2635): so far the sign-in (W1, #2704). Arguments: [`start::USAGE`]. It prints
//! `listening on <address>` once it serves, and refuses to start, with a line saying why, on what [`start::parse`]
//! refuses.

use directoryd::accounts::serve::{App, now, run};
use directoryd::accounts::session::{Jwks, Verifier};
use directoryd::accounts::start;
use directoryd::accounts::store::Store;
use directoryd::accounts::view::ViewKey;
use std::net::TcpListener;
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
    let view_key = match &config.view_key {
        None => None,
        Some(path) => match std::fs::read_to_string(path)
            .ok()
            .and_then(|t| ViewKey::read(&t))
        {
            Some(k) => Some(k),
            None => {
                eprintln!("directoryd: refusing to start: --view-key is a file of 64 hex digits");
                std::process::exit(2);
            }
        },
    };
    // A test person's Souls and worlds, for local and test worlds (`--test-own`, only with the test sign-in).
    for (name, grant, follow) in &config.test_own {
        let owned = store
            .sign_in(start::TEST_ISSUER, name, now())
            .and_then(|a| store.own(&a.account, grant, follow.as_deref()));
        if let Err(e) = owned {
            eprintln!("directoryd: refusing to start: {e}");
            std::process::exit(2);
        }
    }
    let verifier = config
        .provider
        .as_ref()
        .map(|p| Verifier::new(&p.issuer, &p.parties, Box::new(Jwks { url: p.jwks_url() })));
    let listener = match TcpListener::bind(config.listen) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("directoryd: refusing to start: cannot listen: {e}");
            std::process::exit(2);
        }
    };
    let addr = listener.local_addr().expect("a bound address");
    println!("listening on {addr}");
    let app = App {
        store,
        verifier,
        test_sign_in: config.test_sign_in,
        view_key,
        origin: Some(config.public_url.trim_end_matches('/').to_string()),
        log: Mutex::new(Box::new(std::io::stderr())),
    };
    run(listener, Arc::new(app));
}
