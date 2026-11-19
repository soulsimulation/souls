//! The directory process (Engine v2, #2635): so far the sign-in (W1, #2704). Arguments: [`start::USAGE`]. It prints
//! `listening on <address>` once it serves, and refuses to start, with a line saying why, on what [`start::parse`]
//! refuses.

use directoryd::accounts::serve::{App, key_digest, run};
use directoryd::accounts::session::{Jwks, Verifier};
use directoryd::accounts::start;
use directoryd::accounts::store::Store;
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
    let mailbox_key = match config.mailbox_key.as_deref().map(std::fs::read_to_string) {
        None => None,
        Some(Ok(k)) if !k.trim().is_empty() => Some(key_digest(k.trim())),
        Some(_) => {
            eprintln!("directoryd: refusing to start: --mailbox-key names no readable key");
            std::process::exit(2);
        }
    };
    let addr = listener.local_addr().expect("a bound address");
    println!("listening on {addr}");
    let app = App {
        store,
        verifier,
        test_sign_in: config.test_sign_in,
        mailbox_key,
        log: Mutex::new(Box::new(std::io::stderr())),
    };
    run(listener, Arc::new(app));
}
