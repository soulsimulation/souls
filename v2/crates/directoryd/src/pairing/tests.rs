//! Pairing (W2, #2705): A3, A4 and A5's server side. A1 and A2 run end to end in `v2/client/src/pair/pair.test.mjs`.

use super::*;

const T0: u64 = 1_800_000_000;

fn store() -> (Pairing, PathBuf) {
    let dir = std::env::temp_dir().join(format!("souls-w2-{}", to_hex(&random::<8>())));
    std::fs::create_dir_all(&dir).expect("a test folder");
    let tokens = dir.join("tokens.txt");
    let p = Pairing::open(
        &dir.join("pairing.sqlite"),
        Some(tokens.clone()),
        "http://127.0.0.1:1",
    )
    .expect("the store");
    (p, tokens)
}

/// A daemon's secret and its request.
fn ask(p: &Pairing, device: &str, soul: Option<&str>, force: bool, now: u64) -> (String, String) {
    let secret = to_hex(&random::<32>());
    let a = Ask {
        secret_hash: sha256(secret.as_bytes()),
        device: device.into(),
        label: "test agent".into(),
        soul: soul.map(str::to_string),
        scope: "soul".into(),
        force,
    };
    (secret, p.ask(&a, now).expect("asked").code)
}

/// Pairs a device end to end; the Soul's grant and its token.
fn pair(
    p: &Pairing,
    account: &str,
    device: &str,
    soul: Option<&str>,
    force: bool,
    now: u64,
) -> Poll {
    let (secret, code) = ask(p, device, soul, force, now);
    let _ = p.approve(account, &code, now);
    p.poll(&secret, now + INTERVAL)
}

#[test]
fn a3_the_card_shows_the_request_and_nothing_is_approved_without_the_owner() {
    let (p, _) = store();
    let (secret, code) = ask(&p, "studio laptop", None, false, T0);
    let card = p.show("acct_owner", &code, T0 + 42).expect("a card");
    assert_eq!(
        (
            card.device.as_str(),
            card.label.as_str(),
            card.soul,
            card.code.as_str(),
            card.age
        ),
        ("studio laptop", "test agent", None, code.as_str(), 42)
    );
    // Showing it (what opening the link leads to) approves nothing.
    assert_eq!(p.poll(&secret, T0 + 50), Poll::Pending);
    // A code typed in lower case, without its dash, is the same code.
    let typed = code.replace('-', "").to_lowercase();
    assert!(p.approve("acct_owner", &typed, T0 + 60).is_ok());
    assert!(matches!(p.poll(&secret, T0 + 70), Poll::Token { .. }));
    // Handed over once.
    assert_eq!(
        p.poll(&secret, T0 + 80),
        Poll::Refused("delivered".into(), None)
    );
    for page in ["Device", "Agent", "Soul", "Code", "Asked", "matches"] {
        assert!(route::CARD.contains(page), "the card shows {page}");
    }
}

#[test]
fn a4_a_connected_soul_is_refused_naming_its_device_unless_forced() {
    let (p, tokens) = store();
    let Poll::Token {
        token: first,
        grant,
    } = pair(&p, "acct_owner", "studio laptop", None, false, T0)
    else {
        panic!("paired")
    };
    // Unforced: refused at approval, naming the device, and the daemon hears the same at its poll.
    let (secret, code) = ask(&p, "garage mini", Some(&grant), false, T0 + 100);
    let card = p.show("acct_owner", &code, T0 + 100).expect("a card");
    assert_eq!(card.connected.as_deref(), Some("studio laptop"));
    assert_eq!(
        p.approve("acct_owner", &code, T0 + 100),
        Err(("soul-connected", Some("studio laptop".into())))
    );
    assert_eq!(
        p.poll(&secret, T0 + 110),
        Poll::Refused("soul-connected".into(), Some("studio laptop".into()))
    );
    // Another account cannot take it, forced or not.
    let (_, code) = ask(&p, "stranger", Some(&grant), true, T0 + 120);
    assert_eq!(
        p.approve("acct_other", &code, T0 + 120),
        Err(("not-yours", None))
    );
    // Forced: the new device holds it, and the old token's hash is gone.
    let Poll::Token { token: second, .. } = pair(
        &p,
        "acct_owner",
        "garage mini",
        Some(&grant),
        true,
        T0 + 200,
    ) else {
        panic!("forced")
    };
    let file = std::fs::read_to_string(&tokens).expect("the tokens file");
    let hash = |t: &str| to_hex(&sha256(t.as_bytes()));
    assert!(file.contains(&hash(&second)) && !file.contains(&hash(&first)));
    assert_eq!(p.stored_hashes(), vec![(grant.clone(), hash(&second))]);
    // An unconnected Soul (held, no device) moves freely.
    let free = "soul-0123456789abcdef0123456789abcdef-4";
    p.register(free, "acct_owner").expect("registered");
    assert!(matches!(
        pair(
            &p,
            "acct_owner",
            "studio laptop",
            Some(free),
            false,
            T0 + 300
        ),
        Poll::Token { .. }
    ));
}

#[test]
fn a5_short_code_guesses_are_limited() {
    let (p, _) = store();
    let (_, code) = ask(&p, "studio laptop", None, false, T0);
    for k in 0..GUESSES_MOST {
        assert_eq!(
            p.show("acct_guesser", &format!("BCDF-GH{k:02}"), T0 + k as u64),
            Err("unknown-code")
        );
    }
    // Over the limit, even the right code is refused, for this account only, until the window passes.
    assert_eq!(p.show("acct_guesser", &code, T0 + 10), Err("code-guesses"));
    assert_eq!(
        p.approve("acct_guesser", &code, T0 + 10),
        Err(("code-guesses", None))
    );
    assert!(p.show("acct_owner", &code, T0 + 10).is_ok());
    assert!(p.show("acct_guesser", &code, T0 + GUESS_WINDOW + 5).is_ok());
}

#[test]
fn a5_polling_too_soon_is_told_to_slow_down_by_5_s() {
    let (p, _) = store();
    let (secret, _) = ask(&p, "studio laptop", None, false, T0);
    assert_eq!(p.poll(&secret, T0 + INTERVAL), Poll::Pending);
    assert_eq!(
        p.poll(&secret, T0 + INTERVAL + 1),
        Poll::SlowDown(INTERVAL + 5)
    );
    // The interval stays grown: a poll 5 s later is still too soon.
    assert_eq!(
        p.poll(&secret, T0 + INTERVAL + 6),
        Poll::SlowDown(INTERVAL + 10)
    );
    assert_eq!(
        p.poll(&secret, T0 + INTERVAL + 6 + INTERVAL + 10),
        Poll::Pending
    );
}

#[test]
fn a_request_is_checked_before_it_is_kept() {
    let (p, _) = store();
    let mut a = Ask {
        secret_hash: [7; 32],
        device: "d".into(),
        label: "l".into(),
        soul: None,
        scope: "creator".into(),
        force: false,
    };
    assert_eq!(p.ask(&a, T0), Err("not-a-creator"));
    a.scope = "god".into();
    assert_eq!(p.ask(&a, T0), Err("scope-unknown"));
    a.scope = "soul".into();
    a.soul = Some("creator-00-1".into());
    assert_eq!(p.ask(&a, T0), Err("not-a-soul"));
    a.soul = None;
    assert!(p.ask(&a, T0).is_ok());
    assert_eq!(p.ask(&a, T0), Err("secret-used"));
}

#[test]
fn a_code_that_is_not_ascii_is_a_wrong_guess_and_breaks_nothing() {
    let (p, _) = store();
    let (_, code) = ask(&p, "studio laptop", None, false, T0);
    // 8 bytes, not 8 letters: sliced by bytes, it panicked inside the guesses lock.
    for bad in ["abcédef", "ÉÉÉÉ", "BCDF-GHJ1", "BCDFGHJKL"] {
        assert_eq!(p.show("acct_owner", bad, T0), Err("unknown-code"), "{bad}");
    }
    assert!(p.show("acct_owner", &code, T0).is_ok());
    assert!(p.approve("acct_owner", &code, T0).is_ok());
}

#[test]
fn an_old_approval_does_not_take_a_soul_connected_since() {
    let (p, _) = store();
    let free = "soul-0123456789abcdef0123456789abcdef-5";
    p.register(free, "acct_owner").expect("registered");
    // Approved while the Soul was free, not yet collected...
    let (late, late_code) = ask(&p, "garage mini", Some(free), false, T0);
    assert!(p.approve("acct_owner", &late_code, T0).is_ok());
    // ...then another device pairs it and collects first.
    assert!(matches!(
        pair(&p, "acct_owner", "studio laptop", Some(free), false, T0 + 1),
        Poll::Token { .. }
    ));
    assert_eq!(
        p.poll(&late, T0 + 10),
        Poll::Refused("soul-connected".into(), Some("studio laptop".into()))
    );
    assert_eq!(p.stored_hashes().len(), 1);
}

#[test]
fn a_request_is_approved_once() {
    let (p, _) = store();
    let (secret, code) = ask(&p, "studio laptop", None, false, T0);
    assert!(p.approve("acct_owner", &code, T0).is_ok());
    // A second approval finds no pending request and changes nothing.
    assert_eq!(
        p.approve("acct_owner", &code, T0),
        Err(("unknown-code", None))
    );
    assert!(matches!(p.poll(&secret, T0 + INTERVAL), Poll::Token { .. }));
    assert_eq!(
        p.poll(&secret, T0 + 2 * INTERVAL),
        Poll::Refused("delivered".into(), None)
    );
}

/// G7 (#2796): a creator pairs like a Soul, for a world's creator grant its account holds, and is handed a creator
/// token, which the gateway's tokens file then lists.
#[test]
fn g7_a_creator_pairs_with_a_creator_scope_token() {
    let (p, tokens) = store();
    let creator = "creator-0123456789abcdef0123456789abcdef-0";
    p.register(creator, "acct_owner").expect("registered");
    let creator_ask = |device: &str| {
        let secret = to_hex(&random::<32>());
        let a = Ask {
            secret_hash: sha256(secret.as_bytes()),
            device: device.into(),
            label: "builder agent".into(),
            soul: Some(creator.into()),
            scope: "creator".into(),
            force: false,
        };
        (secret, p.ask(&a, T0).expect("asked").code)
    };
    // Someone else's account cannot approve it.
    let (_, code) = creator_ask("their laptop");
    assert_eq!(
        p.show("acct_owner", &code, T0).expect("a card").scope,
        "creator"
    );
    assert_eq!(p.approve("acct_other", &code, T0), Err(("not-yours", None)));
    // The holder approves once; the daemon is handed a creator token.
    let (secret, code) = creator_ask("studio laptop");
    assert_eq!(p.approve("acct_owner", &code, T0), Ok(creator.to_string()));
    let Poll::Token { token, grant } = p.poll(&secret, T0 + INTERVAL) else {
        panic!("a token")
    };
    assert_eq!(grant, creator);
    assert!(token.starts_with(&format!("{creator}.")));
    let file = std::fs::read_to_string(tokens).expect("the tokens file");
    assert!(file.contains(&format!("{creator} {}", to_hex(&sha256(token.as_bytes())))));
    assert!(!file.contains(&token));
    // A creator is never made by a pairing.
    let mut a = Ask {
        secret_hash: [9; 32],
        device: "d".into(),
        label: "l".into(),
        soul: None,
        scope: "creator".into(),
        force: false,
    };
    assert_eq!(p.ask(&a, T0), Err("not-a-creator"));
    a.soul = Some("soul-0123456789abcdef0123456789abcdef-0".into());
    assert_eq!(p.ask(&a, T0), Err("not-a-creator"));
}
