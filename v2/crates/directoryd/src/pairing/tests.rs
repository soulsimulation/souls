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
