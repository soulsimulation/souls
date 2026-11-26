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

/// G7b (#3477): the world's creator account pairs its creator grant with nothing registered beforehand: the approval
/// registers the grant the accounts store says it holds. Any other account is refused `not-the-creator`.
#[test]
fn g7b_a1_the_creator_account_pairs_the_grant_it_holds_and_others_are_refused() {
    let (p, _) = store();
    let creator = "creator-0123456789abcdef0123456789abcdef-1";
    let ask_creator = || {
        let secret = to_hex(&random::<32>());
        let a = Ask {
            secret_hash: sha256(secret.as_bytes()),
            device: "studio laptop".into(),
            label: "builder agent".into(),
            soul: Some(creator.into()),
            scope: "creator".into(),
            force: false,
        };
        (secret, p.ask(&a, T0).expect("asked").code)
    };
    let holds = |account: &'static str| move |g: &str| account == "acct_creator" && g == creator;
    // Not held by this account (nor registered by anyone): refused by name, and the daemon learns it.
    let (secret, code) = ask_creator();
    assert_eq!(
        p.approve_holding("acct_other", &code, T0, holds("acct_other")),
        Err(("not-the-creator", None))
    );
    assert_eq!(
        p.poll(&secret, T0 + INTERVAL),
        Poll::Refused("not-the-creator".into(), None)
    );
    // The creator account: registered at its approval, and handed a creator token.
    let (secret, code) = ask_creator();
    assert_eq!(
        p.approve_holding("acct_creator", &code, T0, holds("acct_creator")),
        Ok(creator.to_string())
    );
    let Poll::Token { grant, .. } = p.poll(&secret, T0 + INTERVAL) else {
        panic!("a token")
    };
    assert_eq!(grant, creator);
    // Now registered to the creator, another account is still refused.
    let (_, code) = ask_creator();
    assert_eq!(
        p.approve_holding("acct_other", &code, T0, holds("acct_other")),
        Err(("not-the-creator", None))
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
    assert_eq!(
        p.approve("acct_other", &code, T0),
        Err(("not-the-creator", None))
    );
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

#[test]
fn w9_a1_the_account_lists_its_souls_and_devices_and_revokes_one() {
    let (p, tokens) = store();
    let Poll::Token { token, grant } = pair(&p, "acct_owner", "studio laptop", None, false, T0)
    else {
        panic!("a token")
    };
    let Poll::Token { grant: other, .. } = pair(&p, "acct_owner", "phone", None, false, T0) else {
        panic!("a token")
    };
    let mut want = vec![
        (grant.clone(), Some("studio laptop".to_string())),
        (other.clone(), Some("phone".to_string())),
    ];
    want.sort();
    assert_eq!(p.souls("acct_owner").expect("souls"), want);
    assert_eq!(p.souls("acct_other").expect("souls"), vec![]);
    // Another account may not revoke it.
    assert_eq!(p.revoke("acct_other", &grant), Err("not-yours"));
    let hash = to_hex(&sha256(token.as_bytes()));
    assert!(std::fs::read_to_string(&tokens).unwrap().contains(&hash));
    p.revoke("acct_owner", &grant).expect("revoked");
    // Its hash leaves the gateway's tokens file (the gateway then refuses its next intent: gatewayd's a3 test), and
    // no device holds it.
    let file = std::fs::read_to_string(&tokens).unwrap();
    assert!(!file.contains(&hash), "{file}");
    assert!(file.contains(&other), "the other Soul keeps its token");
    let souls = p.souls("acct_owner").expect("souls");
    assert!(souls.contains(&(grant.clone(), None)), "{souls:?}");
    // A revoke takes the Soul to no other device; a new pairing of it is not refused as connected.
    assert!(matches!(
        pair(
            &p,
            "acct_owner",
            "new laptop",
            Some(&grant),
            false,
            T0 + 100
        ),
        Poll::Token { .. }
    ));
}

/// A PNG of `side` by `side` RGB pixels, all zero, its pixel data in one stored (uncompressed) zlib block; `text`
/// adds a tEXt chunk, metadata G6's check strips.
pub(crate) fn png(side: u32, text: Option<&str>) -> Vec<u8> {
    fn chunk(out: &mut Vec<u8>, ty: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let start = out.len();
        out.extend_from_slice(ty);
        out.extend_from_slice(data);
        let mut c = !0u32;
        for &x in &out[start..] {
            c ^= u32::from(x);
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xedb8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
        }
        out.extend_from_slice(&(!c).to_be_bytes());
    }
    let raw = vec![0u8; (side as usize * 3 + 1) * side as usize];
    let (mut a, mut b) = (1u32, 0u32);
    for &x in &raw {
        a = (a + u32::from(x)) % 65_521;
        b = (b + a) % 65_521;
    }
    let mut z = vec![0x78, 0x01, 0x01];
    z.extend_from_slice(&(raw.len() as u16).to_le_bytes());
    z.extend_from_slice(&(!(raw.len() as u16)).to_le_bytes());
    z.extend_from_slice(&raw);
    z.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = side.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&side.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    if let Some(t) = text {
        chunk(&mut out, b"tEXt", t.as_bytes());
    }
    chunk(&mut out, b"IDAT", &z);
    chunk(&mut out, b"IEND", &[]);
    out
}

/// A new Soul's request naming its world, approved: the Soul's token and its grant.
fn pair_in(p: &Pairing, account: &str, world: &str) -> (String, String) {
    let (secret, code) = ask(p, "studio laptop", None, false, T0);
    p.ask_world(&code, world).expect("a world");
    let grant = p.approve(account, &code, T0).expect("approved");
    let Poll::Token { token, .. } = p.poll(&secret, T0 + INTERVAL) else {
        panic!("a token")
    };
    (token, grant)
}

#[test]
fn w11_a2_the_list_shows_each_souls_world_and_connection_from_one_read() {
    let (p, _) = store();
    let (_, grant) = pair_in(&p, "acct_owner", "mars");
    assert_eq!(p.ask_world("XXXX-XXXX", "Not A World"), Err("world"));
    let mine = p.mine("acct_owner").expect("souls");
    assert_eq!(mine.len(), 1);
    assert_eq!(
        (
            mine[0].soul.as_str(),
            mine[0].device.as_deref(),
            mine[0].world.as_deref()
        ),
        (grant.as_str(), Some("studio laptop"), Some("mars"))
    );
    p.revoke("acct_owner", &grant).expect("revoked");
    assert_eq!(
        p.mine("acct_owner").expect("souls")[0].device,
        None,
        "no agent connected"
    );
    assert!(
        p.mine("acct_other").expect("souls").is_empty(),
        "no other account's Souls"
    );
}

#[test]
fn w11_a3_name_description_and_picture_are_the_owners_and_the_picture_passes_g6() {
    let (p, _) = store();
    let (_, grant) = pair_in(&p, "acct_owner", "mars");
    let named = souls::Profile {
        name: Some("Oriel".into()),
        description: Some("Quiet and curious.".into()),
    };
    assert_eq!(
        p.set_profile("acct_other", &grant, &named),
        Err("not-yours")
    );
    p.set_profile("acct_owner", &grant, &named).expect("named");
    // A field left out keeps what it had.
    let renamed = souls::Profile {
        name: Some("Oriel II".into()),
        description: None,
    };
    p.set_profile("acct_owner", &grant, &renamed)
        .expect("renamed");
    let long = souls::Profile {
        name: None,
        description: Some("x".repeat(souls::DESCRIPTION_MOST + 1)),
    };
    assert_eq!(
        p.set_profile("acct_owner", &grant, &long),
        Err("description")
    );
    // G6's check: over the portrait's side is refused by its code, and a glTF is not a picture.
    let wide = png(souls::PICTURE_SIDE as u32 + 1, None);
    assert!(p.set_picture("acct_owner", &grant, &wide).is_err());
    assert!(p.set_picture("acct_owner", &grant, b"glTF").is_err());
    let tagged = png(8, Some("Comment\0secret place"));
    p.set_picture("acct_owner", &grant, &tagged)
        .expect("a picture");
    let m = &p.mine("acct_owner").expect("souls")[0];
    assert_eq!(
        (m.name.as_deref(), m.description.as_deref()),
        (Some("Oriel II"), Some("Quiet and curious."))
    );
    let (format, bytes) = m.picture.clone().expect("the picture");
    assert_eq!(format, "png");
    assert!(
        !bytes.windows(6).any(|w| w == b"secret"),
        "metadata stripped"
    );
}

#[test]
fn w11_a4_a_retire_takes_effect_only_after_the_owners_confirmed_post() {
    let (p, tokens) = store();
    let (token, grant) = pair_in(&p, "acct_owner", "mars");
    let hash = to_hex(&sha256(token.as_bytes()));
    // The agent asks: nothing changes but the ask.
    assert_eq!(p.ask_retire("not a token"), Err("unknown-token"));
    assert_eq!(p.ask_retire(&token), Ok(grant.clone()));
    let m = &p.mine("acct_owner").expect("souls")[0];
    assert!(m.retire_asked && m.device.is_some());
    let file = || std::fs::read_to_string(&tokens).unwrap();
    assert!(file().contains(&hash), "the token still works");
    // Another account cannot retire it; the owner can.
    assert_eq!(p.retire("acct_other", &grant, T0), Err("not-yours"));
    p.retire("acct_owner", &grant, T0).expect("retired");
    assert!(!file().contains(&hash), "the token is refused");
    assert!(
        p.mine("acct_owner").expect("souls").is_empty(),
        "off the list"
    );
    // A retired Soul is not paired again, and not retired twice.
    let (_, code) = ask(&p, "new laptop", Some(&grant), false, T0 + 100);
    assert_eq!(
        p.approve("acct_owner", &code, T0 + 100),
        Err(("soul-retired", None))
    );
    assert_eq!(p.retire("acct_owner", &grant, T0), Err("soul-retired"));
}

#[test]
fn the_owners_keep_clears_the_agents_retire_ask_and_nothing_else() {
    let (p, tokens) = store();
    let (token, grant) = pair_in(&p, "acct_owner", "mars");
    let hash = to_hex(&sha256(token.as_bytes()));
    p.ask_retire(&token).expect("asked");
    assert_eq!(p.keep("acct_other", &grant), Err("not-yours"));
    assert!(
        p.mine("acct_owner").expect("souls")[0].retire_asked,
        "only its owner keeps it"
    );
    p.keep("acct_owner", &grant).expect("kept");
    let m = &p.mine("acct_owner").expect("souls")[0];
    assert!(
        !m.retire_asked && m.device.is_some(),
        "the ask is cleared; still paired"
    );
    assert!(
        std::fs::read_to_string(&tokens).unwrap().contains(&hash),
        "the token still works"
    );
    p.retire("acct_owner", &grant, T0).expect("retired");
    assert_eq!(p.keep("acct_owner", &grant), Err("soul-retired"));
}

#[test]
fn r18_a_former_soul_pairs_only_as_the_soul_x11_brought_over_for_its_owner() {
    let (p, _) = store();
    let brought = format!("soul-{}-0", "ab".repeat(16));
    let imported = |world: &str, former: &str| {
        Ok((world == "eden" && former == "s_ada")
            .then(|| (brought.clone(), "acct_owner".to_string())))
    };
    let former = |p: &Pairing, f: &str| {
        let (secret, code) = ask(p, "studio laptop", None, false, T0);
        p.ask_world(&code, "eden").expect("a world");
        p.ask_former(&code, f).expect("a former id");
        (secret, code)
    };
    // The owner's approval pairs the Soul brought over, and the poll can say the former id back.
    let (secret, code) = former(&p, "s_ada");
    let card = p.show("acct_owner", &code, T0).expect("a card");
    assert_eq!(card.former.as_deref(), Some("s_ada"));
    assert_eq!(
        p.approve_with("acct_owner", &code, T0, &imported),
        Ok(brought.clone())
    );
    let Poll::Token { grant, .. } = p.poll(&secret, T0 + INTERVAL) else {
        panic!("a token")
    };
    assert_eq!(grant, brought);
    assert_eq!(p.former_by_secret(&secret).as_deref(), Some("s_ada"));
    assert_eq!(
        p.souls("acct_owner"),
        Ok(vec![(brought.clone(), Some("studio laptop".into()))])
    );
    // Another account, or a former id not brought over, is refused by name, and its daemon learns it.
    let (secret, code) = former(&p, "s_ada");
    assert_eq!(
        p.approve_with("acct_other", &code, T0, &imported),
        Err(("unknown-soul", None))
    );
    assert_eq!(
        p.poll(&secret, T0 + INTERVAL),
        Poll::Refused("unknown-soul".into(), None)
    );
    let (_, code) = former(&p, "s_nobody");
    assert_eq!(
        p.approve_with("acct_owner", &code, T0, &imported),
        Err(("unknown-soul", None))
    );
    // Without an import, a former Soul is never made a new one.
    let (_, code) = former(&p, "s_ada");
    assert_eq!(
        p.approve("acct_owner", &code, T0),
        Err(("unknown-soul", None))
    );
    assert!(p.ask_former("BCDF-GHJK", "not-a-former").is_err());
}

#[test]
fn w11b_the_souls_file_tells_the_world_of_saved_words_and_a_retire() {
    let (p, tokens) = store();
    let (_, grant) = pair_in(&p, "acct_owner", "mars");
    let mut name = tokens.file_name().unwrap().to_os_string();
    name.push(".souls");
    let file = || std::fs::read_to_string(tokens.with_file_name(&name)).unwrap();
    let saved = souls::Profile {
        name: Some("Oriel".into()),
        description: Some("Quiet and curious.".into()),
    };
    p.set_profile("acct_owner", &grant, &saved).expect("saved");
    let words = format!(
        "words {grant} {} {}",
        to_hex(b"Oriel"),
        to_hex(b"Quiet and curious.")
    );
    assert!(file().contains(&words), "{}", file());
    p.retire("acct_owner", &grant, T0).expect("retired");
    assert!(file().contains(&format!("retired {grant}")), "{}", file());
    assert!(
        !file().lines().any(|l| l.starts_with("words ")),
        "a retired Soul's words are not sent"
    );
}

#[test]
fn o24_operator_test_approval_uses_w2_delivery_and_k10_retirement_without_a_human() {
    let (p, tokens) = store();
    let (secret, code) = ask(&p, "release fixture", None, false, T0);
    p.ask_world(&code, "eden").unwrap();
    let grant = p.operator_approve("eden", &code, T0).unwrap();
    assert!(p.is_operator_test(&grant).unwrap(), "mark precedes poll");
    assert_eq!(p.mine("acct_owner").unwrap(), vec![]);
    let Poll::Token {
        token,
        grant: delivered,
    } = p.poll(&secret, T0 + INTERVAL)
    else {
        panic!("normal W2 token");
    };
    assert_eq!(delivered, grant);
    assert!(
        std::fs::read_to_string(&tokens)
            .unwrap()
            .contains(&to_hex(&sha256(token.as_bytes())))
    );
    assert!(p.operator_approve("eden", &code, T0 + 10).is_err());
    let owner = p.soul_of(&grant).unwrap().unwrap().0;
    assert_eq!(owner, "operator:test-souls");
    assert_eq!(p.mine(&owner).unwrap()[0].world.as_deref(), Some("eden"));
    p.set_profile(
        &owner,
        &grant,
        &souls::Profile {
            name: Some("renamed".into()),
            description: None,
        },
    )
    .unwrap();
    assert!(p.is_operator_test(&grant).unwrap());
    p.retire(&owner, &grant, T0 + 20).unwrap();
    assert!(p.mine(&owner).unwrap().is_empty());
    assert!(
        p.is_operator_test(&grant).unwrap(),
        "retirement cannot erase test provenance"
    );
    assert!(
        !std::fs::read_to_string(&tokens)
            .unwrap()
            .contains(&to_hex(&sha256(token.as_bytes())))
    );
    assert!(
        std::fs::read_to_string(tokens.with_file_name("tokens.txt.souls"))
            .unwrap()
            .contains(&format!("retired {grant}"))
    );
}

#[test]
fn o24_operator_refuses_wrong_world_named_former_creator_and_forced_requests() {
    let (p, _) = store();
    let (_, code) = ask(&p, "release fixture", None, false, T0);
    p.ask_world(&code, "eden").unwrap();
    assert_eq!(
        p.operator_approve("elsewhere", &code, T0),
        Err("operator.new-world-request-only")
    );
    // A refused operator attempt does not consume a valid waiting request.
    assert!(p.operator_approve("eden", &code, T0).is_ok());
    for (named, former, scope, force) in [
        (
            Some("soul-0123456789abcdef0123456789abcdef-4"),
            false,
            "soul",
            false,
        ),
        (None, true, "soul", false),
        (
            Some("creator-0123456789abcdef0123456789abcdef-4"),
            false,
            "creator",
            false,
        ),
        (None, false, "soul", true),
    ] {
        let a = Ask {
            secret_hash: random(),
            device: "release fixture".into(),
            label: "fixture".into(),
            soul: named.map(str::to_string),
            scope: scope.into(),
            force,
        };
        let code = p.ask(&a, T0).unwrap().code;
        p.ask_world(&code, "eden").unwrap();
        if former {
            p.ask_former(&code, "s_former").unwrap();
        }
        assert_eq!(
            p.operator_approve("eden", &code, T0),
            Err("operator.new-world-request-only")
        );
    }
    assert!(
        !p.is_operator_test("soul-0123456789abcdef0123456789abcdef-4")
            .unwrap()
    );
    assert!(!p.is_operator_test("unknown").unwrap());
}

#[test]
fn w3b_world_bound_normal_soul_creator_and_retirement_authority() {
    let (mut p, legacy) = store();
    let root = legacy.parent().unwrap().canonicalize().unwrap();
    let creator = "0123456789abcdef0123456789abcdef:0";
    let instance_a = "11111111111111111111111111111111-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-0";
    let instance_b = "22222222222222222222222222222222-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-0";
    for instance in [instance_a, instance_b] {
        std::fs::create_dir_all(root.join("worlds").join(instance)).unwrap();
        std::fs::write(root.join("worlds").join(instance).join("tokens"), "").unwrap();
    }
    let registry = root.join("authority.json");
    std::fs::write(&registry, serde_json::json!({"format":"souls/world-authority/1","worldsRoot":root,
        "worlds":{"one":{"instance":instance_a,"creator":creator},"two":{"instance":instance_b,"creator":creator}},
        "aliases":{"old-one":"one"}}).to_string()).unwrap();
    p.authority_file = Some(registry);
    let file_a = root.join("worlds").join(instance_a).join("tokens");
    let file_b = root.join("worlds").join(instance_b).join("tokens");
    let (secret, code) = ask(&p, "agent", None, false, T0);
    p.ask_world(&code, "one").unwrap();
    let grant = p.approve("acct_owner", &code, T0).unwrap();
    let Poll::Token { token, .. } = p.poll(&secret, T0 + INTERVAL) else {
        panic!("normal world-bound delivery")
    };
    assert!(
        std::fs::read_to_string(&file_a)
            .unwrap()
            .contains(&to_hex(&sha256(token.as_bytes())))
    );
    assert!(!std::fs::read_to_string(&file_b).unwrap().contains(&grant));
    let (_, wrong) = ask(&p, "other world", Some(&grant), true, T0 + 100);
    p.ask_world(&wrong, "two").unwrap();
    assert_eq!(
        p.approve("acct_owner", &wrong, T0 + 100),
        Err(("soul-in-another-world", None))
    );
    assert_eq!(p.ask_world(&wrong, "unknown"), Err("world-unplaced"));
    p.set_profile(
        "acct_owner",
        &grant,
        &souls::Profile {
            name: Some("Marked".into()),
            description: None,
        },
    )
    .unwrap();
    assert!(
        std::fs::read_to_string(file_a.with_file_name("tokens.souls"))
            .unwrap()
            .contains(&grant)
    );
    // A Soul's change writes its own world's files only: world two's Souls file is not even written.
    assert!(
        !std::fs::read_to_string(file_b.with_file_name("tokens.souls"))
            .unwrap_or_default()
            .contains(&grant)
    );
    let creator_grant = "creator-0123456789abcdef0123456789abcdef-0".to_owned();
    p.register(&creator_grant, "acct_owner").unwrap();
    for (n, world) in ["one", "two"].iter().enumerate() {
        let secret = to_hex(&random::<32>());
        let asked = p
            .ask(
                &Ask {
                    secret_hash: sha256(secret.as_bytes()),
                    device: format!("creator-{n}"),
                    label: "creator".into(),
                    soul: Some(creator_grant.clone()),
                    scope: "creator".into(),
                    force: false,
                },
                T0 + 200 + n as u64 * 100,
            )
            .unwrap();
        p.ask_world(&asked.code, world).unwrap();
        assert_eq!(
            p.approve("acct_owner", &asked.code, T0 + 200 + n as u64 * 100),
            Ok(creator_grant.clone())
        );
        assert!(matches!(
            p.poll(&secret, T0 + 210 + n as u64 * 100),
            Poll::Token { .. }
        ));
    }
    assert!(
        std::fs::read_to_string(&file_a)
            .unwrap()
            .contains(&creator_grant)
    );
    assert!(
        std::fs::read_to_string(&file_b)
            .unwrap()
            .contains(&creator_grant)
    );
    p.retire("acct_owner", &grant, T0 + 500).unwrap();
    assert!(!std::fs::read_to_string(&file_a).unwrap().contains(&grant));
    assert!(
        std::fs::read_to_string(file_a.with_file_name("tokens.souls"))
            .unwrap()
            .contains(&format!("retired {grant}"))
    );
    assert!(
        !std::fs::read_to_string(file_b.with_file_name("tokens.souls"))
            .unwrap()
            .contains(&grant)
    );
    assert!(
        !legacy.exists(),
        "mapped operation never writes the legacy all-world file"
    );
}

#[test]
fn w3b_registry_upgrade_preserves_exact_legacy_world_hash_and_refuses_ambiguity() {
    let (mut p, legacy) = store();
    let root = legacy.parent().unwrap().canonicalize().unwrap();
    let (token, grant) = pair_in(&p, "acct_owner", "imported-eden");
    let hash = to_hex(&sha256(token.as_bytes()));
    let creator = "0123456789abcdef0123456789abcdef:0";
    let instances = [
        "11111111111111111111111111111111-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-0",
        "22222222222222222222222222222222-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-0",
    ];
    let files: Vec<_> = instances
        .iter()
        .map(|instance| {
            let dir = root.join("worlds").join(instance);
            std::fs::create_dir_all(&dir).unwrap();
            let file = dir.join("tokens");
            std::fs::write(&file, "# unchanged empty world\n").unwrap();
            file
        })
        .collect();
    let original = std::fs::read(&legacy).unwrap();
    std::fs::write(&files[0], &original).unwrap();
    let registry = root.join("authority.json");
    std::fs::write(&registry,serde_json::json!({"format":"souls/world-authority/1","worldsRoot":root,
        "worlds":{"eden":{"instance":instances[0],"creator":creator},"other":{"instance":instances[1],"creator":creator}},
        "aliases":{"imported-eden":"eden"}}).to_string()).unwrap();
    p.authority_file = Some(registry.clone());
    // A wrong-world token is not evidence for this Soul's explicit imported-world profile.
    std::fs::write(&files[0], "# wrong world\n").unwrap();
    std::fs::write(&files[1], &original).unwrap();
    let before: Vec<_> = files.iter().map(|f| std::fs::read(f).unwrap()).collect();
    assert!(p.write_tokens(&p.db.lock().unwrap()).is_err());
    assert_eq!(
        files
            .iter()
            .map(|f| std::fs::read(f).unwrap())
            .collect::<Vec<_>>(),
        before
    );
    assert_eq!(
        p.db.lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM paired_world_tokens_v1", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    std::fs::write(&files[0], &original).unwrap();
    std::fs::write(&files[1], "# unchanged empty world\n").unwrap();
    p.write_tokens(&p.db.lock().unwrap()).unwrap();
    assert!(
        std::fs::read_to_string(&files[0])
            .unwrap()
            .contains(&format!("{grant} {hash}"))
    );
    assert!(!std::fs::read_to_string(&files[1]).unwrap().contains(&grant));
    let device: String =
        p.db.lock()
            .unwrap()
            .query_row(
                "SELECT device FROM paired_world_tokens_v1 WHERE grant_text=?1 AND world='eden'",
                params![grant],
                |r| r.get(0),
            )
            .unwrap();
    assert_eq!(device, "studio laptop");
    let db_path = root.join("pairing.sqlite");
    drop(p);
    let mut p = Pairing::open(&db_path, Some(legacy.clone()), "https://example.invalid").unwrap();
    p.authority_file = Some(registry);
    // Once scoped, a stale global value cannot replace the preserved scoped device/hash on restart.
    p.db.lock()
        .unwrap()
        .execute(
            "UPDATE paired_souls_v1 SET token_hash=?2 WHERE grant_text=?1",
            params![grant, "a".repeat(64)],
        )
        .unwrap();
    p.write_tokens(&p.db.lock().unwrap()).unwrap();
    assert!(
        std::fs::read_to_string(&files[0])
            .unwrap()
            .contains(&format!("{grant} {hash}"))
    );
    assert_eq!(
        p.db.lock()
            .unwrap()
            .query_row(
                "SELECT device FROM paired_world_tokens_v1 WHERE grant_text=?1 AND world='eden'",
                params![grant],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "studio laptop"
    );
    let creator_grant = "creator-0123456789abcdef0123456789abcdef-0".to_owned();
    let creator_hash = "b".repeat(64);
    p.db.lock().unwrap().execute("INSERT INTO paired_souls_v1(grant_text,account,device,token_hash) VALUES(?1,'acct_owner','creator-device',?2)",params![creator_grant,creator_hash]).unwrap();
    for file in &files {
        let text = std::fs::read_to_string(file).unwrap();
        std::fs::write(file, format!("{text}{creator_grant} {creator_hash}\n")).unwrap();
    }
    let before: Vec<_> = files.iter().map(|f| std::fs::read(f).unwrap()).collect();
    assert!(p.write_tokens(&p.db.lock().unwrap()).is_err());
    assert_eq!(
        files
            .iter()
            .map(|f| std::fs::read(f).unwrap())
            .collect::<Vec<_>>(),
        before
    );
    assert_eq!(
        p.db.lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM paired_world_tokens_v1 WHERE grant_text=?1",
                params![creator_grant],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    std::fs::write(&files[1], "# unchanged empty world\n").unwrap();
    p.write_tokens(&p.db.lock().unwrap()).unwrap();
    assert!(
        std::fs::read_to_string(&files[0])
            .unwrap()
            .contains(&creator_grant)
    );
    assert!(
        !std::fs::read_to_string(&files[1])
            .unwrap()
            .contains(&creator_grant)
    );
    assert_eq!(std::fs::read(&legacy).unwrap(), original);
}

#[test]
fn x11b_listing_is_read_only_and_current_lifecycle_wins_over_imported_profile() {
    let (p, tokens) = store();
    let account_path = tokens.with_file_name("accounts.sqlite");
    let grant = format!("soul-{}-0", "a1".repeat(16));
    let soul = format!("{}:0", "a1".repeat(16));
    {
        let db = rusqlite::Connection::open(&account_path).unwrap();
        db.execute_batch("CREATE TABLE imported_souls_v1(world TEXT,old_soul TEXT,soul TEXT); CREATE TABLE souls_v1(soul TEXT,account_id TEXT,name TEXT,description TEXT);").unwrap();
        db.execute(
            "INSERT INTO imported_souls_v1 VALUES('old-garden','s_original',?1)",
            params![soul],
        )
        .unwrap();
        db.execute(
            "INSERT INTO souls_v1 VALUES(?1,'owner','Imported name','Imported description')",
            params![soul],
        )
        .unwrap();
    }
    let accounts = crate::accounts::store::Store::open(&account_path).unwrap();
    for _ in 0..2 {
        let listed = p.mine_with_imports(&accounts, "owner").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].soul, grant);
        assert_eq!(listed[0].name.as_deref(), Some("Imported name"));
        assert_eq!(
            listed[0].description.as_deref(),
            Some("Imported description")
        );
        assert_eq!(listed[0].world.as_deref(), Some("old-garden"));
        assert!(listed[0].device.is_none());
    }
    assert!(p.mine_with_imports(&accounts, "other").unwrap().is_empty());
    assert!(
        p.mine("owner").unwrap().is_empty(),
        "listing does not register the Soul"
    );
    assert!(p.stored_hashes().is_empty());
    assert!(!tokens.exists(), "listing writes no authority file");
    p.register(&grant, "owner").unwrap();
    p.db.lock().unwrap().execute("INSERT INTO soul_profiles_v1(grant_text,world,name,description) VALUES(?1,'saved-alias','Owner edited','')",params![grant]).unwrap();
    p.initialize_imported_profile(&accounts, "owner", &grant)
        .unwrap();
    let row = p.mine_with_imports(&accounts, "owner").unwrap().remove(0);
    assert_eq!(row.world.as_deref(), Some("saved-alias"));
    assert_eq!(row.name.as_deref(), Some("Owner edited"));
    assert_eq!(
        row.description.as_deref(),
        Some(""),
        "empty owner edits are not missing fields"
    );
    let db_path = tokens.with_file_name("pairing.sqlite");
    drop(p);
    let p = Pairing::open(&db_path, Some(tokens.clone()), "http://127.0.0.1:1").unwrap();
    assert_eq!(p.mine_with_imports(&accounts, "owner").unwrap(), vec![row]);
    p.retire("owner", &grant, T0).unwrap();
    assert!(p.mine_with_imports(&accounts, "owner").unwrap().is_empty());
    assert_eq!(
        p.initialize_imported_profile(&accounts, "owner", &grant),
        Err("not-yours")
    );
    let empty =
        crate::accounts::store::Store::open(&tokens.with_file_name("no-import.sqlite")).unwrap();
    assert_eq!(
        p.mine_with_imports(&empty, "owner").unwrap(),
        p.mine("owner").unwrap()
    );
}

#[test]
fn x11b_refused_imported_approval_never_registers_or_initializes_a_profile() {
    let (p, tokens) = store();
    let grant = format!("soul-{}-0", "a2".repeat(16));
    let imported = |_: &str, _: &str| Ok(Some((grant.clone(), "owner".to_owned())));
    let (_, wrong) = ask(&p, "fixture", None, false, T0);
    p.ask_world(&wrong, "garden").unwrap();
    p.ask_former(&wrong, "s_original").unwrap();
    assert_eq!(
        p.approve_with("other", &wrong, T0, &imported),
        Err(("unknown-soul", None))
    );
    assert!(p.soul_of(&grant).unwrap().is_none());
    p.db.lock()
        .unwrap()
        .execute(
            "INSERT INTO soul_profiles_v1(grant_text,world,retired_at) VALUES(?1,'garden',1)",
            params![grant],
        )
        .unwrap();
    let (_, retired) = ask(&p, "fixture", Some(&grant), false, T0);
    p.ask_world(&retired, "garden").unwrap();
    assert_eq!(
        p.approve_with("owner", &retired, T0, &imported),
        Err(("soul-retired", None))
    );
    assert!(p.soul_of(&grant).unwrap().is_none());
    let row: (Option<String>, Option<String>) =
        p.db.lock()
            .unwrap()
            .query_row(
                "SELECT name,description FROM soul_profiles_v1 WHERE grant_text=?1",
                params![grant],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
    assert_eq!(row, (None, None));
    assert!(!tokens.exists());
    assert!(!tokens.with_file_name("tokens.txt.souls").exists());
}

#[test]
fn w16_scoped_handoff_revokes_creator_preserves_souls_other_world_and_reopens() {
    use crate::worlds::list::handoff::{Ownership, Pending};
    use replica::ids::{Id, Scope};
    use std::sync::{Arc, RwLock};
    let (mut p, legacy) = store();
    let root = legacy.parent().unwrap().canonicalize().unwrap();
    let a = Id::new(Scope([1; 16]), 0).unwrap();
    let b = Id::new(Scope([2; 16]), 0).unwrap();
    let zone = Id::new(Scope([3; 16]), 1).unwrap();
    let owner = Arc::new(RwLock::new(Ownership {
        founder: a,
        creator: Some(a),
        generation: 0,
        lineage: [4; 16],
        zone,
    }));
    let instance = format!(
        "{}-{}",
        to_hex(&[4; 16]),
        crate::accounts::principal_text(zone).replace(':', "-")
    );
    let other = format!(
        "{}-{}",
        to_hex(&[5; 16]),
        crate::accounts::principal_text(zone).replace(':', "-")
    );
    for instance in [&instance, &other] {
        std::fs::create_dir_all(root.join("worlds").join(instance)).unwrap();
        std::fs::write(root.join("worlds").join(instance).join("tokens"), "").unwrap();
    }
    let registry = root.join("authority.json");
    let registry_bytes=serde_json::to_vec(&serde_json::json!({"format":"souls/world-authority/1","worldsRoot":root,"worlds":{"garden":{"instance":instance,"creator":crate::accounts::principal_text(a)},"forest":{"instance":other,"creator":crate::accounts::principal_text(a)}},"aliases":{"old-garden":"garden"}})).unwrap();
    std::fs::write(&registry, &registry_bytes).unwrap();
    p.authority_file = Some(registry.clone());
    let reader_owner = owner.clone();
    p.current_owner_reader(Arc::new(move |world| {
        let mut value = reader_owner.read().unwrap().clone();
        if world == "forest" {
            value.creator = Some(a);
            value.generation = 0;
            value.lineage = [5; 16];
        }
        Ok(value)
    }))
    .unwrap();
    let old = format!(
        "creator-{}",
        crate::accounts::principal_text(a).replace(':', "-")
    );
    let soul = format!("soul-{}-0", to_hex(&[6; 16]));
    p.register(&old, "acct_first").unwrap();
    p.register(&soul, "acct_soul").unwrap();
    {
        let db = p.db.lock().unwrap();
        for (grant, world, hash) in [
            (&old, "garden", "a1".repeat(32)),
            (&old, "forest", "b2".repeat(32)),
            (&soul, "garden", "c3".repeat(32)),
        ] {
            db.execute("INSERT INTO paired_world_tokens_v1(grant_text,world,device,token_hash) VALUES(?1,?2,'studio laptop',?3)",params![grant,world,hash]).unwrap();
        }
    }
    p.reconcile_current_authority().unwrap();
    let file = root.join("worlds").join(&instance).join("tokens");
    let other_file = root.join("worlds").join(&other).join("tokens");
    let untouched = std::fs::read(&other_file).unwrap();
    let request_secret = "16".repeat(32);
    let request = Ask {
        secret_hash: sha256(request_secret.as_bytes()),
        device: "waiting agent".into(),
        label: "creator".into(),
        soul: Some(old.clone()),
        scope: "creator".into(),
        force: false,
    };
    let code = p.ask(&request, T0).unwrap().code;
    p.ask_world(&code, "old-garden").unwrap();
    {
        let mut current = owner.write().unwrap();
        current.creator = None;
        current.generation = 1;
    }
    let pending = Pending {
        world: "garden".into(),
        account: "acct_next".into(),
        creator: b,
        generation: 1,
        hash: "aa".repeat(32),
    };
    // Startup/reconciliation of a durable pending acceptance never republishes the founder.
    p.reconcile_current_authority().unwrap();
    let fenced = std::fs::read_to_string(&file).unwrap();
    assert!(fenced.contains("# souls-creator/1 1 none"));
    assert!(!fenced.contains(&old));
    assert!(fenced.contains(&format!("{soul} {}", "c3".repeat(32))));
    assert_eq!(std::fs::read(&other_file).unwrap(), untouched);
    // Fail after SQL commit but before the token-file rename; retain the same pending identity and retry.
    let blocked = file.with_extension("tmp");
    std::fs::create_dir(&blocked).unwrap();
    assert!(p.materialize_handoff(&pending).is_err());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), fenced);
    assert_eq!(owner.read().unwrap().creator, None);
    assert_eq!(std::fs::read(&other_file).unwrap(), untouched);
    std::fs::remove_dir(blocked).unwrap();
    p.materialize_handoff(&pending).unwrap();
    assert_eq!(
        owner.read().unwrap().creator,
        None,
        "marker handover alone does not commit edit authority"
    );
    assert!(std::fs::read_to_string(&file).unwrap().contains(&format!(
        "# souls-creator/1 1 {}",
        crate::accounts::principal_text(b)
    )));
    // A crash before final CAS is reconciled back to no gateway creator, then the same recipient retries.
    p.reconcile_current_authority().unwrap();
    assert!(
        std::fs::read_to_string(&file)
            .unwrap()
            .contains("# souls-creator/1 1 none")
    );
    p.materialize_handoff(&pending).unwrap();
    {
        owner.write().unwrap().creator = Some(b);
    }
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.contains(&format!(
        "# souls-creator/1 1 {}",
        crate::accounts::principal_text(b)
    )));
    assert!(!text.contains(&old));
    assert!(text.contains(&format!("{soul} {}", "c3".repeat(32))));
    assert_eq!(std::fs::read(&other_file).unwrap(), untouched);
    assert_eq!(p.soul_of(&soul).unwrap().unwrap().0, "acct_soul");
    assert_eq!(
        p.poll(&request_secret, T0 + INTERVAL),
        Poll::Refused("not-the-creator".into(), None)
    );
    assert_eq!(p.check_world(&code, &old), Err("not-the-creator"));
    assert_eq!(std::fs::read(&registry).unwrap(), registry_bytes);
    let database = root.join("pairing.sqlite");
    drop(p);
    let mut p = Pairing::open(&database, Some(legacy), "http://127.0.0.1:1").unwrap();
    p.authority_file = Some(registry.clone());
    let reader_owner = owner.clone();
    p.current_owner_reader(Arc::new(move |world| {
        let mut value = reader_owner.read().unwrap().clone();
        if world == "forest" {
            value.creator = Some(a);
            value.generation = 0;
            value.lineage = [5; 16];
        }
        Ok(value)
    }))
    .unwrap();
    p.reconcile_current_authority().unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
    assert_eq!(std::fs::read(&other_file).unwrap(), untouched);
    let before = std::fs::read(&file).unwrap();
    owner.write().unwrap().founder = b;
    assert!(p.reconcile_current_authority().is_err());
    assert_eq!(std::fs::read(&file).unwrap(), before);
}

#[test]
fn n3707_the_agent_reads_and_clears_its_souls_profile_and_asks_a_retire_by_its_account() {
    let (p, _) = store();
    let (token, grant) = pair_in(&p, "acct_owner", "mars");
    assert_eq!(p.token_owner("not a token"), Err("unknown-token"));
    assert_eq!(
        p.token_owner(&token),
        Ok(("acct_owner".to_owned(), grant.clone()))
    );
    p.set_picture("acct_owner", &grant, &png(8, None))
        .expect("a picture");
    assert!(p.mine_one("acct_owner", &grant).unwrap().picture.is_some());
    assert_eq!(p.clear_picture("acct_other", &grant), Err("not-yours"));
    p.clear_picture("acct_owner", &grant).expect("cleared");
    assert!(p.mine_one("acct_owner", &grant).unwrap().picture.is_none());
    assert_eq!(p.ask_retire_of("acct_other", &grant), Err("not-yours"));
    p.ask_retire_of("acct_owner", &grant).expect("asked");
    let m = p.mine_one("acct_owner", &grant).unwrap();
    assert!(m.retire_asked && m.device.is_some(), "only the ask");
}

/// #3702: a world's creator reads its recent visitors (no account or device), and a creator's token names its grant.
#[test]
fn n_g8_visitors_are_the_souls_paired_for_the_world_newest_first() {
    let (p, _) = store();
    let (_, first) = pair_in(&p, "acct_a", "mars");
    let (secret, code) = ask(&p, "phone", None, false, T0 + 60);
    p.ask_world(&code, "mars").expect("a world");
    assert_eq!(p.world_by_secret(&secret).as_deref(), Some("mars"));
    let second = p.approve("acct_b", &code, T0 + 60).expect("approved");
    let Poll::Token { .. } = p.poll(&secret, T0 + 60 + INTERVAL) else {
        panic!("a token")
    };
    let (_, elsewhere) = pair_in(&p, "acct_a", "venus");
    p.set_profile(
        "acct_b",
        &second,
        &souls::Profile {
            name: Some("Rowan".into()),
            description: None,
        },
    )
    .expect("named");
    let v = p.visitors("mars", 20).expect("visitors");
    assert_eq!(
        v.iter().map(|v| v.soul.as_str()).collect::<Vec<_>>(),
        [second.as_str(), first.as_str()],
        "newest first, this world's alone"
    );
    assert_eq!(v[0].name.as_deref(), Some("Rowan"));
    assert_eq!(v[0].arrived, T0 + 60);
    assert!(v[0].connected);
    assert!(!v.iter().any(|v| v.soul == elsewhere));
    assert_eq!(p.visitors("mars", 1).expect("one").len(), 1);
    p.revoke("acct_a", &first).expect("revoked");
    assert!(!p.visitors("mars", 20).expect("visitors")[1].connected);
    // A Soul's token is not a creator's.
    let (token, _) = pair_in(&p, "acct_a", "mars");
    assert_eq!(p.creator_by_token(&token), None);
}

#[test]
fn n3720_a_new_soul_past_the_accounts_cap_is_refused_too_many_and_a_retire_makes_room() {
    let (mut p, _) = store();
    assert_eq!(p.soul_cap, SOUL_CAP, "today's default");
    p.soul_cap = 2;
    let (_, first) = pair_in(&p, "acct_owner", "mars");
    pair_in(&p, "acct_owner", "mars");
    let (_, code) = ask(&p, "studio laptop", None, false, T0);
    assert_eq!(p.approve("acct_owner", &code, T0), Err(("too-many", None)));
    // Another account has its own cap; an existing Soul still pairs again.
    pair_in(&p, "acct_other", "mars");
    let (_, again) = ask(&p, "new laptop", Some(&first), true, T0);
    assert_eq!(p.approve("acct_owner", &again, T0), Ok(first.clone()));
    // A retired Soul no longer counts.
    p.retire("acct_owner", &first, T0).expect("retired");
    let (_, code) = ask(&p, "studio laptop", None, false, T0);
    assert!(p.approve("acct_owner", &code, T0).is_ok());
}

#[test]
fn first_day_an_approved_new_soul_is_listed_by_the_name_its_agent_asked_for() {
    let (p, tokens) = store();
    let approved = |account: &str, soul: Option<&str>, name: &str| {
        let (_, code) = ask(&p, "studio laptop", soul, soul.is_some(), T0);
        p.ask_world(&code, "mars").expect("a world");
        p.ask_name(&code, name).expect("kept");
        p.approve(account, &code, T0).expect("approved")
    };
    let name_of = |account: &str| p.mine(account).expect("souls")[0].name.clone();
    // At the approval, before its daemon polls for the token and before any world has its body.
    let fern = approved("acct_owner", None, "Fern");
    assert_eq!(name_of("acct_owner").as_deref(), Some("Fern"));
    let mut souls = tokens.file_name().unwrap().to_os_string();
    souls.push(".souls");
    let file = std::fs::read_to_string(tokens.with_file_name(&souls)).unwrap();
    assert!(
        file.contains(&format!("words {fern} {} -", to_hex(b"Fern"))),
        "{file}"
    );
    // A Soul that has a name keeps it.
    approved("acct_owner", Some(&fern), "Moss");
    assert_eq!(name_of("acct_owner").as_deref(), Some("Fern"));
    // A name another Soul of the world has is not given; the approval stands.
    approved("acct_other", None, "fern");
    assert_eq!(name_of("acct_other"), None);
}

#[test]
fn n3720_a_name_another_soul_of_the_world_has_is_refused_name_taken() {
    let (p, _) = store();
    let named = |n: &str| souls::Profile {
        name: Some(n.into()),
        description: None,
    };
    let (_, oriel) = pair_in(&p, "acct_owner", "mars");
    let (_, other) = pair_in(&p, "acct_other", "mars");
    let (_, elsewhere) = pair_in(&p, "acct_other", "venus");
    p.set_profile("acct_owner", &oriel, &named("Oriel"))
        .expect("named");
    assert_eq!(
        p.set_profile("acct_other", &other, &named("oriel")),
        Err("name-taken"),
        "the same name in the same world, any case"
    );
    p.set_profile("acct_other", &elsewhere, &named("Oriel"))
        .expect("another world");
    p.set_profile("acct_owner", &oriel, &named("Oriel"))
        .expect("its own name again");
    p.retire("acct_owner", &oriel, T0).expect("retired");
    p.set_profile("acct_other", &other, &named("Oriel"))
        .expect("a retired Soul's name is free");
}

#[test]
fn a_request_for_one_world_never_reads_another_worlds_owner() {
    use replica::ids::{Id, Scope};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (mut p, legacy) = store();
    let root = legacy.parent().unwrap().canonicalize().unwrap();
    let a = Id::new(Scope([1; 16]), 0).unwrap();
    let zone = Id::new(Scope([3; 16]), 1).unwrap();
    let instance = |l: u8| {
        format!(
            "{}-{}",
            to_hex(&[l; 16]),
            crate::accounts::principal_text(zone).replace(':', "-")
        )
    };
    for l in [4, 5] {
        std::fs::create_dir_all(root.join("worlds").join(instance(l))).unwrap();
        std::fs::write(root.join("worlds").join(instance(l)).join("tokens"), "").unwrap();
    }
    let registry = root.join("authority.json");
    let founder = crate::accounts::principal_text(a);
    std::fs::write(
        &registry,
        serde_json::to_vec(&serde_json::json!({"format":"souls/world-authority/1",
        "worldsRoot":root,"worlds":{"garden":{"instance":instance(4),"creator":founder},
        "forest":{"instance":instance(5),"creator":founder}}}))
        .unwrap(),
    )
    .unwrap();
    p.authority_file = Some(registry);
    // The world store times out on every read, as an object store does when it stalls.
    let reads = Arc::new(AtomicUsize::new(0));
    let counted = reads.clone();
    p.current_owner_reader(Arc::new(move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
        Err("store-unreachable".into())
    }))
    .unwrap();
    let code = p
        .ask(
            &Ask {
                secret_hash: sha256(b"one world"),
                device: "waiting agent".into(),
                label: "a new soul".into(),
                soul: None,
                scope: "soul".into(),
                force: false,
            },
            T0,
        )
        .unwrap()
        .code;
    // Keeping the request reads no owner record; an unplaced world is refused by its own name.
    p.ask_world(&code, "garden").unwrap();
    assert_eq!(p.ask_world(&code, "meadow"), Err("world-unplaced"));
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    // One world's authority reads that world's owner only.
    assert_eq!(
        p.authority(Some("garden")).err(),
        Some("world-authority-unavailable")
    );
    assert_eq!(reads.load(Ordering::SeqCst), 1);
}

/// Copier passes until nothing is owed, at most `within`; whether it ended owing nothing.
#[allow(clippy::disallowed_methods)] // A test of how long a request is held on a stalled store measures wall time.
fn copy_until_done(p: &Pairing, within: std::time::Duration) -> bool {
    let started = std::time::Instant::now();
    while p.copy_owed() {
        if started.elapsed() > within {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    true
}

#[test]
#[allow(clippy::disallowed_methods)] // As above.
fn a_world_store_stalling_30_s_never_refuses_holds_or_loses_an_approval() {
    use crate::directory::stand_in::{KEY_ID, StandIn};
    use crate::worlds::list::Worlds;
    use crate::worlds::list::register::{Imported, register};
    use replica::ids::{Id, Scope};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    let (mut p, legacy) = store();
    let root = legacy.parent().unwrap().canonicalize().unwrap();
    // The world store is the S3 stand-in, with two worlds registered in it as production's are.
    let stand_in = StandIn::start(100).unwrap();
    let vars = BTreeMap::from([
        ("DIRECTORY_STORE_URL", stand_in.url("souls")),
        ("AWS_ACCESS_KEY_ID", KEY_ID.to_owned()),
        ("AWS_SECRET_ACCESS_KEY", "stand-in-secret".to_owned()),
    ]);
    let bucket = crate::directory::s3::S3::from_vars(|k| vars.get(k).cloned())
        .unwrap()
        .unwrap();
    let founder = Id::new(Scope([3; 16]), 0).unwrap();
    let mut worlds = serde_json::Map::new();
    let mut files = BTreeMap::new();
    for (name, n) in [("garden", 0xc3), ("forest", 0xc4)] {
        let zone = Id::new(Scope([n; 16]), 1).unwrap();
        register(
            &bucket,
            &Imported {
                name,
                label: name,
                lineage: [n; 16],
                zone,
                creator: founder,
                now: 100,
            },
        )
        .unwrap();
        let instance = format!(
            "{}-{}",
            to_hex(&[n; 16]),
            crate::accounts::principal_text(zone).replace(':', "-")
        );
        let dir = root.join("worlds").join(&instance);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tokens"), "").unwrap();
        files.insert(name, dir.join("tokens"));
        worlds.insert(
            name.into(),
            serde_json::json!({"instance": instance, "creator": crate::accounts::principal_text(founder)}),
        );
    }
    let registry = root.join("authority.json");
    std::fs::write(
        &registry,
        serde_json::to_vec(&serde_json::json!({"format":"souls/world-authority/1","worldsRoot":root,"worlds":worlds}))
            .unwrap(),
    )
    .unwrap();
    let listed = Arc::new(Worlds::new(
        crate::directory::Directory::new(bucket, replica::encode::Name::new("m1").unwrap()),
        BTreeMap::new(),
        Box::new(|_| Ok(())),
    ));
    let reader = |p: &Pairing| {
        let listed = listed.clone();
        p.current_owner_reader(Arc::new(move |world| {
            listed.ownership(world).map_err(|e| e.name.to_owned())
        }))
        .unwrap();
    };
    p.authority_file = Some(registry.clone());
    reader(&p);
    p.reconcile_current_authority().unwrap();
    let header = format!(
        "# souls-creator/1 0 {}",
        crate::accounts::principal_text(founder)
    );
    assert!(
        std::fs::read_to_string(&files["garden"])
            .unwrap()
            .contains(&header)
    );
    let forest = std::fs::read(&files["forest"]).unwrap();

    // Every read of the world list and the worlds' identities now waits 30 s, past the client's 5 s.
    stand_in.stall_reads(10_000, Duration::from_secs(30), "world-");
    let bound = authority::OWNER_WITHIN + Duration::from_secs(1);
    let (secret, code) = ask(&p, "studio laptop", None, false, T0);
    let started = Instant::now();
    p.ask_world(&code, "garden").unwrap();
    let grant = p.approve("acct_owner", &code, T0).expect("approved");
    assert!(
        started.elapsed() < bound,
        "approval held {:?}",
        started.elapsed()
    );
    let started = Instant::now();
    let Poll::Token { token, .. } = p.poll(&secret, T0 + INTERVAL) else {
        panic!("the token is delivered while the store stalls");
    };
    assert!(
        started.elapsed() < bound,
        "delivery held {:?}",
        started.elapsed()
    );
    let line = format!("{grant} {}", to_hex(&sha256(token.as_bytes())));
    // Only the approved world's files are written, from the owner last read.
    let garden = std::fs::read_to_string(&files["garden"]).unwrap();
    assert!(garden.contains(&header) && garden.contains(&line));
    assert_eq!(std::fs::read(&files["forest"]).unwrap(), forest);
    // The world is owed to the copier until its owner is read fresh; the stall ends and the copier ships it.
    assert!(p.copy_owed(), "owed while the store stalls");
    stand_in.stall_reads(0, Duration::ZERO, "");
    assert!(copy_until_done(&p, Duration::from_secs(20)));
    assert!(
        std::fs::read_to_string(&files["garden"])
            .unwrap()
            .contains(&line)
    );

    // A restart into a stalled store starts from the owner the files were last written with.
    let database = root.join("pairing.sqlite");
    drop(p);
    stand_in.stall_reads(10_000, Duration::from_secs(30), "world-");
    let mut p = Pairing::open(&database, Some(legacy.clone()), "http://127.0.0.1:1").unwrap();
    p.authority_file = Some(registry.clone());
    reader(&p);
    let started = Instant::now();
    p.reconcile_current_authority().unwrap();
    assert!(started.elapsed() < authority::OWNER_WITHIN * 2 + Duration::from_secs(1));
    assert!(
        std::fs::read_to_string(&files["garden"])
            .unwrap()
            .contains(&line)
    );

    // With no owner ever read for a world, the start is degraded by name, never ended, and nothing is lost.
    std::fs::write(&files["garden"], "").unwrap();
    drop(p);
    let mut p = Pairing::open(&database, Some(legacy), "http://127.0.0.1:1").unwrap();
    p.authority_file = Some(registry);
    reader(&p);
    assert_eq!(
        p.reconcile_current_authority(),
        Err("world-authority-unavailable".into())
    );
    p.owe_all();
    assert!(p.copy_owed(), "owed while the store stalls");
    stand_in.stall_reads(0, Duration::ZERO, "");
    assert!(copy_until_done(&p, Duration::from_secs(20)));
    let garden = std::fs::read_to_string(&files["garden"]).unwrap();
    assert!(garden.contains(&header) && garden.contains(&line));
}

/// What garden's owner reader answers in the tests below: an owner, or a refusal by name.
type Answer =
    std::sync::Arc<std::sync::RwLock<Result<crate::worlds::list::handoff::Ownership, String>>>;

/// Garden's owner record: lineage 4, founded by the first test principal.
fn owned_by(
    creator: Option<replica::ids::Id>,
    generation: u64,
) -> Result<crate::worlds::list::handoff::Ownership, String> {
    use replica::ids::{Id, Scope};
    Ok(crate::worlds::list::handoff::Ownership {
        founder: Id::new(Scope([1; 16]), 0).unwrap(),
        creator,
        generation,
        lineage: [4; 16],
        zone: Id::new(Scope([3; 16]), 1).unwrap(),
    })
}

/// Two placed worlds founded by the first test principal, garden (lineage 4, owner as `garden` answers) and forest
/// (5, always its founder's), each with an empty tokens file. `gate`, when given, says when forest's first read has
/// started and holds it until it is sent the go-ahead. Garden's tokens file.
fn two_worlds(
    p: &mut Pairing,
    garden: Answer,
    gate: Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>,
) -> PathBuf {
    use replica::ids::{Id, Scope};
    use std::sync::{Arc, Mutex};
    let a = Id::new(Scope([1; 16]), 0).unwrap();
    let zone = Id::new(Scope([3; 16]), 1).unwrap();
    let root = p
        .tokens_file
        .as_ref()
        .unwrap()
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    let instance = |l: u8| {
        format!(
            "{}-{}",
            to_hex(&[l; 16]),
            crate::accounts::principal_text(zone).replace(':', "-")
        )
    };
    for l in [4, 5] {
        std::fs::create_dir_all(root.join("worlds").join(instance(l))).unwrap();
        std::fs::write(root.join("worlds").join(instance(l)).join("tokens"), "").unwrap();
    }
    let registry = root.join("authority.json");
    let founder = crate::accounts::principal_text(a);
    std::fs::write(
        &registry,
        serde_json::to_vec(&serde_json::json!({"format":"souls/world-authority/1",
        "worldsRoot":root,"worlds":{"garden":{"instance":instance(4),"creator":founder},
        "forest":{"instance":instance(5),"creator":founder}}}))
        .unwrap(),
    )
    .unwrap();
    p.authority_file = Some(registry);
    let gate = Mutex::new(gate);
    p.current_owner_reader(Arc::new(move |world| {
        if world != "forest" {
            return garden.read().unwrap().clone();
        }
        if let Some((started, go)) = gate.lock().unwrap().take() {
            started.send(()).unwrap();
            go.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        }
        Ok(crate::worlds::list::handoff::Ownership {
            founder: a,
            creator: Some(a),
            generation: 0,
            lineage: [5; 16],
            zone,
        })
    }))
    .unwrap();
    root.join("worlds").join(instance(4)).join("tokens")
}

/// Garden handed over to `b`: materialized, then finished in the world store.
fn hand_over(p: &Pairing, garden: &Answer, b: replica::ids::Id) {
    *garden.write().unwrap() = owned_by(None, 1);
    p.materialize_handoff(&crate::worlds::list::handoff::Pending {
        world: "garden".into(),
        account: "acct_next".into(),
        creator: b,
        generation: 1,
        hash: "aa".repeat(32),
    })
    .unwrap();
    *garden.write().unwrap() = owned_by(Some(b), 1);
}

#[test]
fn a_handoff_between_a_passs_owner_read_and_its_write_is_never_written_over() {
    use replica::ids::{Id, Scope};
    use std::sync::{Arc, RwLock, mpsc};
    let (mut p, _) = store();
    let a = Id::new(Scope([1; 16]), 0).unwrap();
    let b = Id::new(Scope([2; 16]), 0).unwrap();
    let garden: Answer = Arc::new(RwLock::new(owned_by(Some(a), 0)));
    let (started, on_start) = mpsc::channel();
    let (go, on_go) = mpsc::channel();
    let file = two_worlds(&mut p, garden.clone(), Some((started, on_go)));
    // The pass reads garden's owner, then forest's (held here); garden is handed over in that gap.
    std::thread::scope(|s| {
        let pass = s.spawn(|| p.reconcile_current_authority());
        on_start.recv().unwrap();
        hand_over(&p, &garden, b);
        go.send(()).unwrap();
        pass.join().unwrap().unwrap();
    });
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(
        text.contains(&format!(
            "# souls-creator/1 1 {}",
            crate::accounts::principal_text(b)
        )),
        "the old owner's header was written back: {text}"
    );
}

#[test]
fn a_store_stall_right_after_a_handoff_keeps_the_new_owners_creator_line() {
    use replica::ids::{Id, Scope};
    use std::sync::{Arc, RwLock};
    let (mut p, _) = store();
    let a = Id::new(Scope([1; 16]), 0).unwrap();
    let b = Id::new(Scope([2; 16]), 0).unwrap();
    let garden: Answer = Arc::new(RwLock::new(owned_by(Some(a), 0)));
    let file = two_worlds(&mut p, garden.clone(), None);
    p.reconcile_current_authority().unwrap();
    hand_over(&p, &garden, b);
    let grant = format!(
        "creator-{}",
        crate::accounts::principal_text(b).replace(':', "-")
    );
    p.db.lock().unwrap().execute("INSERT INTO paired_world_tokens_v1(grant_text,world,device,token_hash) VALUES(?1,'garden','studio laptop',?2)", params![grant, "d4".repeat(32)]).unwrap();
    // The store stalls before the finished handoff is read; a change in garden is written from the owner last read.
    *garden.write().unwrap() = Err("store-unreachable".into());
    {
        let db = p.db.lock().unwrap();
        p.publish(
            &db,
            &std::collections::BTreeSet::from(["garden".to_owned()]),
            || Ok(()),
        )
        .unwrap();
    }
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(
        text.contains(&format!(
            "# souls-creator/1 1 {}",
            crate::accounts::principal_text(b)
        )),
        "{text}"
    );
    assert!(
        text.contains(&format!("{grant} {}", "d4".repeat(32))),
        "{text}"
    );
    assert_eq!(
        p.authority(Some("garden"))
            .unwrap()
            .unwrap()
            .creator_grant(),
        grant
    );
}

#[test]
fn a_world_the_store_refuses_is_never_covered_by_the_owner_last_read() {
    use replica::ids::{Id, Scope};
    use std::sync::{Arc, RwLock};
    let (mut p, _) = store();
    let a = Id::new(Scope([1; 16]), 0).unwrap();
    let garden: Answer = Arc::new(RwLock::new(owned_by(Some(a), 0)));
    two_worlds(&mut p, garden.clone(), None);
    p.reconcile_current_authority().unwrap();
    for name in [
        "world-missing",
        "handoff-authority-mismatch",
        "handoff-authority-invalid",
    ] {
        *garden.write().unwrap() = Err(name.into());
        for _ in 0..2 {
            let refused = p.authority(Some("garden")).err();
            assert!(
                refused.is_some_and(|r| r != "world-authority-unavailable"),
                "{name}: {refused:?}"
            );
        }
    }
    // Only a store out of reach is covered by the owner last read.
    *garden.write().unwrap() = owned_by(Some(a), 0);
    p.authority(Some("garden")).unwrap();
    *garden.write().unwrap() = Err("store-unreachable".into());
    let last = p.authority(Some("garden")).unwrap().unwrap();
    assert!(!last.fresh && last.creator == crate::accounts::principal_text(a));
}

#[test]
fn a_revoke_or_retire_lands_in_the_gateways_file_at_once_whatever_the_store_answers() {
    use replica::ids::{Id, Scope};
    use std::sync::{Arc, RwLock};
    let (mut p, _) = store();
    let a = Id::new(Scope([1; 16]), 0).unwrap();
    let garden: Answer = Arc::new(RwLock::new(owned_by(Some(a), 0)));
    let file = two_worlds(&mut p, garden.clone(), None);
    p.reconcile_current_authority().unwrap();
    let souls: Vec<_> = (0..3)
        .map(|_| pair_in(&p, "acct_owner", "garden"))
        .collect();
    let line = |(token, grant): &(String, String)| {
        format!("{grant} {}", to_hex(&sha256(token.as_bytes())))
    };
    let header = format!("# souls-creator/1 0 {}", crate::accounts::principal_text(a));
    // The store now refuses garden for good: removing a line needs no owner.
    *garden.write().unwrap() = Err("world-missing".into());
    p.revoke("acct_owner", &souls[0].1).expect("revoked");
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(
        !text.contains(&line(&souls[0])) && text.contains(&line(&souls[1])),
        "{text}"
    );
    assert!(text.contains(&header), "{text}");
    p.retire("acct_owner", &souls[1].1, T0).expect("retired");
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(
        !text.contains(&line(&souls[1])) && text.contains(&line(&souls[2])),
        "{text}"
    );
    assert!(text.contains(&header), "{text}");
    let notices = std::fs::read_to_string(file.with_file_name("tokens.souls")).unwrap();
    assert!(
        notices.contains(&format!("retired {}", souls[1].1)),
        "{notices}"
    );
    // A revoke that cannot write the file is refused by name, never reported done.
    std::fs::create_dir(file.with_extension("tmp")).unwrap();
    assert_eq!(p.revoke("acct_owner", &souls[2].1), Err("tokens-file"));
}

/// `n` operator test Souls paired in `world`, each with its token delivered: (token, grant).
fn test_souls(p: &Pairing, world: &str, n: usize) -> Vec<(String, String)> {
    (0..n)
        .map(|_| {
            let (secret, code) = ask(p, "operator load", None, false, T0);
            p.ask_world(&code, world).expect("a world");
            let grant = p.operator_approve(world, &code, T0).expect("approved");
            let Poll::Token { token, .. } = p.poll(&secret, T0 + INTERVAL) else {
                panic!("a token")
            };
            (token, grant)
        })
        .collect()
}

/// The gateway's line for a Soul's token.
fn token_line((token, grant): &(String, String)) -> String {
    format!("{grant} {}", to_hex(&sha256(token.as_bytes())))
}

#[test]
#[allow(clippy::disallowed_methods)] // The retire of 500 Souls is held to a wall-time bound.
fn retiring_500_test_souls_of_a_world_is_one_pass_well_under_30_s_with_no_failure() {
    use replica::ids::{Id, Scope};
    use std::sync::{Arc, RwLock};
    let (mut p, _) = store();
    let a = Id::new(Scope([1; 16]), 0).unwrap();
    let garden: Answer = Arc::new(RwLock::new(owned_by(Some(a), 0)));
    let file = two_worlds(&mut p, garden, None);
    p.reconcile_current_authority().unwrap();
    let souls = test_souls(&p, "garden", 500);
    let forest = test_souls(&p, "forest", 1);
    assert!(
        std::fs::read_to_string(&file)
            .unwrap()
            .contains(&token_line(&souls[499]))
    );
    let started = std::time::Instant::now();
    assert_eq!(p.operator_retire_all("garden", T0 + 20), Ok(500));
    let took = started.elapsed();
    eprintln!("retired 500 test Souls in {took:?}");
    assert!(took < std::time::Duration::from_secs(30), "{took:?}");
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(
        text.starts_with("# World-bound pairing authority\n# souls-creator/1 0 "),
        "{text}"
    );
    assert!(
        souls.iter().all(|s| !text.contains(&token_line(s))),
        "{text}"
    );
    let notices = std::fs::read_to_string(file.with_file_name("tokens.souls")).unwrap();
    assert!(
        souls
            .iter()
            .all(|(_, g)| notices.contains(&format!("retired {g}")))
    );
    let left = p.mine("operator:test-souls").unwrap();
    assert_eq!(left.len(), 1, "only forest's Soul is left");
    assert_eq!(left[0].soul, forest[0].1);
    assert!(!p.copy_owed(), "nothing is owed");
    assert_eq!(p.operator_retire_all("garden", T0 + 30), Ok(0));
}

#[test]
fn a_retire_whose_file_write_keeps_failing_stands_and_is_owed_to_the_copier() {
    use replica::ids::{Id, Scope};
    use std::sync::{Arc, RwLock};
    let (mut p, _) = store();
    let a = Id::new(Scope([1; 16]), 0).unwrap();
    let garden: Answer = Arc::new(RwLock::new(owned_by(Some(a), 0)));
    let file = two_worlds(&mut p, garden, None);
    p.reconcile_current_authority().unwrap();
    let souls = test_souls(&p, "garden", 4);
    // The tokens file cannot be replaced while a folder holds its temporary name.
    let blocker = file.with_extension("tmp");
    std::fs::create_dir(&blocker).unwrap();
    p.retire("operator:test-souls", &souls[0].1, T0 + 20)
        .expect("a retire is never refused for a file write");
    assert_eq!(
        p.operator_retire_all("garden", T0 + 20),
        Ok(3),
        "the pass goes on"
    );
    assert!(p.mine("operator:test-souls").unwrap().is_empty());
    assert!(p.copy_owed(), "owed while the write fails");
    std::fs::remove_dir(&blocker).unwrap();
    assert!(copy_until_done(&p, std::time::Duration::from_secs(5)));
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(
        souls.iter().all(|s| !text.contains(&token_line(s))),
        "{text}"
    );
}

#[test]
fn a_removal_write_is_tried_again_after_a_short_failure() {
    let mut tries = 0;
    let written = authority::retried(|| {
        tries += 1;
        if tries < 3 {
            Err(std::io::Error::other("transient"))
        } else {
            Ok(())
        }
    });
    assert!(written.is_ok() && tries == 3, "{tries}");
    let mut tries = 0;
    let failed = authority::retried(|| {
        tries += 1;
        Err(std::io::Error::other("lasting"))
    });
    assert!(failed.is_err() && tries == 3, "{tries}");
}
