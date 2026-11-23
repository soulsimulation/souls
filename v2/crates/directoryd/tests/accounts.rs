//! Accounts (Engine v2 W1, #2704). Each `aN_` test is one acceptance box. Tokens are signed
//! here with RSA keys generated for the run (`openssl genpkey`); nothing calls a provider.

use directoryd::accounts::session::{KeySource, PublicKey, Refused, Verifier, parse_jwks};
use directoryd::accounts::store::Store;
use directoryd::accounts::{b64url, start};
use ring::rand::SystemRandom;
use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

const ISSUER: &str = "https://clerk.example.test";
const PAGE: &str = "https://world.example.test";
const T0: u64 = 1_800_000_000;

/// A signing key made for this run, and its key id.
struct Key {
    kid: String,
    pair: RsaKeyPair,
}

impl Key {
    fn new(kid: &str) -> Key {
        // OpenSSL writes an RSA key in DER as an RSAPrivateKey (PKCS#1), which ring reads.
        let out = Command::new("openssl")
            .args([
                "genpkey",
                "-algorithm",
                "RSA",
                "-pkeyopt",
                "rsa_keygen_bits:2048",
                "-outform",
                "DER",
            ])
            .stderr(Stdio::null())
            .output()
            .expect("openssl makes a test key");
        assert!(out.status.success(), "openssl genpkey");
        Key {
            kid: kid.to_string(),
            pair: RsaKeyPair::from_der(&out.stdout).expect("an RSA key"),
        }
    }

    fn public(&self) -> PublicKey {
        let c: ring::rsa::PublicKeyComponents<Vec<u8>> = self.pair.public().into();
        PublicKey { n: c.n, e: c.e }
    }

    fn sign(&self, header: &Value, claims: &Value) -> String {
        let input = format!(
            "{}.{}",
            b64url(header.to_string().as_bytes()),
            b64url(claims.to_string().as_bytes())
        );
        let mut sig = vec![0; self.pair.public().modulus_len()];
        self.pair
            .sign(
                &RSA_PKCS1_SHA256,
                &SystemRandom::new(),
                input.as_bytes(),
                &mut sig,
            )
            .expect("a signature");
        format!("{input}.{}", b64url(&sig))
    }

    fn token(&self, claims: &Value) -> String {
        self.sign(
            &json!({"alg": "RS256", "typ": "JWT", "kid": self.kid}),
            claims,
        )
    }
}

fn claims(now: u64, sub: &str) -> Value {
    json!({"iss": ISSUER, "sub": sub, "sid": "sess_1", "azp": PAGE, "iat": now, "nbf": now - 10, "exp": now + 60})
}

/// The provider's published keys, as a test sets them, counting the fetches.
#[derive(Clone, Default)]
struct Published {
    keys: Arc<Mutex<BTreeMap<String, PublicKey>>>,
    fetches: Arc<AtomicU64>,
}

impl Published {
    fn publish(&self, key: &Key) {
        self.keys
            .lock()
            .unwrap()
            .insert(key.kid.clone(), key.public());
    }
}

impl KeySource for Published {
    fn fetch(&self) -> Result<BTreeMap<String, PublicKey>, String> {
        self.fetches.fetch_add(1, Ordering::SeqCst);
        Ok(self.keys.lock().unwrap().clone())
    }
}

fn verifier(p: &Published) -> Verifier {
    Verifier::new(ISSUER, &[PAGE.to_string()], Box::new(p.clone()))
}

#[test]
fn a1_ten_thousand_requests_fetch_the_keys_once_per_key_change() {
    let keys = [Key::new("k1"), Key::new("k2"), Key::new("k3")];
    let p = Published::default();
    let v = verifier(&p);
    // Requests every 100 ms; the provider rotates its key twice, publishing the new one first, as Clerk does.
    let (mut ok, mut changes, mut current) = (0, 0, usize::MAX);
    for i in 0..10_000u64 {
        let now = T0 + i / 10;
        let k = (i * 3 / 10_000) as usize;
        if k != current {
            p.publish(&keys[k]);
            current = k;
            changes += 1;
        }
        let s = v
            .verify(&keys[k].token(&claims(now, "user_a1")), now)
            .expect("verified");
        assert_eq!(s.subject, "user_a1");
        ok += 1;
    }
    let fetches = p.fetches.load(Ordering::SeqCst);
    println!("a1: {ok} requests verified, {changes} keys in use, {fetches} key fetches");
    assert_eq!(ok, 10_000);
    assert_eq!(fetches, changes);
    assert_eq!(v.fetches(), fetches);
}

#[test]
fn a1_an_unknown_key_id_refetches_at_most_once_a_minute() {
    let (known, stranger) = (Key::new("k1"), Key::new("forged"));
    let p = Published::default();
    p.publish(&known);
    let v = verifier(&p);
    v.verify(&known.token(&claims(T0, "user_a")), T0)
        .expect("verified");
    for s in 0..120 {
        let now = T0 + s;
        assert_eq!(
            v.verify(&stranger.token(&claims(now, "user_a")), now),
            Err(Refused::UnknownKey)
        );
    }
    // The first fetch at T0, then one at T0 + 60 for the unknown id: two in two minutes of a request a second.
    assert_eq!(p.fetches.load(Ordering::SeqCst), 2);
}

#[test]
fn a3_each_bad_token_is_refused_by_name() {
    let key = Key::new("k1");
    let p = Published::default();
    p.publish(&key);
    let v = verifier(&p);
    let good = claims(T0, "user_a3");
    assert!(v.verify(&key.token(&good), T0).is_ok());
    let with = |f: &str, val: Value| {
        let mut c = good.clone();
        c[f] = val;
        c
    };
    let without = |f: &str| {
        let mut c = good.clone();
        c.as_object_mut().unwrap().remove(f);
        c
    };

    // The wrong algorithm: HS256 (its "signature" made with the public key as a secret, the classic confusion), none,
    // and RS512, each refused before any key is used.
    for alg in ["HS256", "none", "RS512", "PS256"] {
        let t = key.sign(&json!({"alg": alg, "kid": "k1"}), &good);
        assert_eq!(v.verify(&t, T0), Err(Refused::Algorithm), "{alg}");
    }
    // The wrong issuer: another origin, one with a path, and none.
    for iss in [
        json!("https://evil.example.test"),
        json!(format!("{ISSUER}/")),
        json!(null),
    ] {
        assert_eq!(
            v.verify(&key.token(&with("iss", iss.clone())), T0),
            Err(Refused::Issuer),
            "{iss}"
        );
    }
    // Each claim missing, and each of the wrong type.
    for c in ["exp", "nbf", "iat", "sub", "sid", "azp"] {
        assert_eq!(
            v.verify(&key.token(&without(c)), T0),
            Err(Refused::MissingClaim(c)),
            "{c}"
        );
        let wrong = if ["exp", "nbf", "iat"].contains(&c) {
            json!("soon")
        } else {
            json!(7)
        };
        assert_eq!(
            v.verify(&key.token(&with(c, wrong)), T0),
            Err(Refused::MissingClaim(c)),
            "{c} typed"
        );
    }
    // An azp off the list.
    for azp in ["https://evil.example.test", "http://world.example.test", ""] {
        let r = v.verify(&key.token(&with("azp", json!(azp))), T0);
        assert!(
            matches!(r, Err(Refused::Party | Refused::MissingClaim("azp"))),
            "{azp}: {r:?}"
        );
    }
    // And the rest: expired, not yet valid, a changed payload, another key's signature, not a token at all.
    assert_eq!(
        v.verify(&key.token(&with("exp", json!(T0 - 6))), T0),
        Err(Refused::Expired)
    );
    assert_eq!(
        v.verify(&key.token(&with("nbf", json!(T0 + 6))), T0),
        Err(Refused::NotYet)
    );
    let t = key.token(&good);
    let mut parts: Vec<&str> = t.split('.').collect();
    let other = b64url(with("sub", json!("user_b")).to_string().as_bytes());
    parts[1] = &other;
    assert_eq!(v.verify(&parts.join("."), T0), Err(Refused::Signature));
    let imposter = Key::new("k1");
    assert_eq!(
        v.verify(&imposter.token(&good), T0),
        Err(Refused::Signature)
    );
    for junk in ["", "a.b", "a.b.c.d", "!!.!!.!!"] {
        assert_eq!(v.verify(junk, T0), Err(Refused::Shape), "{junk}");
    }
}

#[test]
fn a3_jwks_keeps_rsa_signing_keys_only() {
    let doc = r#"{"keys":[
      {"kty":"RSA","kid":"a","n":"AQAB","e":"AQAB","alg":"RS256","use":"sig"},
      {"kty":"RSA","kid":"b","n":"AQAB","e":"AQAB","alg":"RS512"},
      {"kty":"RSA","kid":"c","n":"AQAB","e":"AQAB","use":"enc"},
      {"kty":"EC","kid":"d","crv":"P-256","x":"AQAB","y":"AQAB"},
      {"kty":"RSA","kid":"e","n":"AQAB","e":"AQAB"}]}"#;
    let keys = parse_jwks(doc).expect("a JWKS");
    assert_eq!(keys.keys().collect::<Vec<_>>(), ["a", "e"]);
}

fn scratch(name: &str) -> PathBuf {
    let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("accounts-{name}"));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("a scratch dir");
    d
}

fn directoryd(args: &[&str]) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_directoryd"));
    c.args(args);
    c
}

/// Sends one request and returns the status and the JSON body.
fn post(addr: &str, path: &str, body: &str) -> (u16, Value) {
    let mut s = TcpStream::connect(addr).expect("connects");
    write!(
        s,
        "POST {path} HTTP/1.1\r\nhost: {addr}\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    let status = out[9..12].parse().unwrap();
    let body = out.split("\r\n\r\n").nth(1).unwrap();
    (status, serde_json::from_str(body).unwrap())
}

#[test]
fn a4_the_test_sign_in_works_on_loopback_and_refuses_a_public_address() {
    let dir = scratch("a4");
    let store = dir.join("accounts.sqlite");
    let store = store.to_str().unwrap();
    let refusals = [
        // A public https address, a host that is not loopback, a listener that is not loopback, the real provider.
        vec![
            "--listen",
            "127.0.0.1:0",
            "--public-url",
            "https://world.example.test",
            "--store",
            store,
            "--test-sign-in",
        ],
        vec![
            "--listen",
            "127.0.0.1:0",
            "--public-url",
            "http://world.example.test",
            "--store",
            store,
            "--test-sign-in",
        ],
        vec![
            "--listen",
            "127.0.0.1:0",
            "--public-url",
            "http://203.0.113.9:8080",
            "--store",
            store,
            "--test-sign-in",
        ],
        vec![
            "--listen",
            "0.0.0.0:0",
            "--public-url",
            "http://127.0.0.1:8080",
            "--store",
            store,
            "--test-sign-in",
        ],
        vec![
            "--listen",
            "127.0.0.1:0",
            "--public-url",
            "http://127.0.0.1:8080",
            "--store",
            store,
            "--test-sign-in",
            "--issuer",
            ISSUER,
            "--parties",
            "http://127.0.0.1:8080",
        ],
    ];
    for args in &refusals {
        let out = directoryd(args).output().expect("runs");
        let err = String::from_utf8_lossy(&out.stderr);
        println!("a4: {}", err.trim());
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(err.contains("refusing to start"), "{err}");
        assert!(out.stdout.is_empty(), "never listened: {args:?}");
    }
    assert!(
        !dir.join("accounts.sqlite").exists(),
        "a refused start opens no store"
    );

    // On loopback it starts, and signs a test person in with no provider: the same person gets the same principal.
    let mut child = directoryd(&[
        "--listen",
        "127.0.0.1:0",
        "--public-url",
        "http://127.0.0.1:8080",
        "--store",
        store,
        "--test-sign-in",
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .expect("starts");
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let addr = line
        .trim()
        .strip_prefix("listening on ")
        .expect("listening")
        .to_string();
    let (s1, a) = post(&addr, "/v1/account/test-sign-in", r#"{"name":"Ada"}"#);
    let (s2, b) = post(&addr, "/v1/account/test-sign-in", r#"{"name":"Ada"}"#);
    let (s3, c) = post(&addr, "/v1/account/test-sign-in", r#"{"name":"Bo"}"#);
    let (s4, d) = post(&addr, "/v1/account/session", "");
    child.kill().unwrap();
    child.wait().unwrap();
    let mut log = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut log)
        .unwrap();
    println!("a4: Ada {a}\na4: Bo {c}\na4: no provider: {s4} {d}\na4: log:\n{log}");
    assert_eq!((s1, s2, s3, s4), (200, 200, 200, 404));
    assert_eq!(a, b);
    assert_ne!(a["principal"], c["principal"]);
    assert!(a["account"].as_str().unwrap().starts_with("acct_"));
    assert!(!log.contains("Ada") && !log.contains(a["account"].as_str().unwrap()));
}

#[test]
fn a5_one_owner_and_a_consistent_copy_while_in_use() {
    let dir = scratch("a5");
    let path = dir.join("accounts.sqlite");
    let store = Arc::new(Store::open(&path).expect("opens"));
    // One owning program: a second open of the same file, as another program would, is refused.
    match Store::open(&path) {
        Err(e) => assert!(e.to_string().starts_with("store-owned"), "{e}"),
        Ok(_) => panic!("a second owner opened the store"),
    }
    // Four writers sign new people in until the copies are taken, so every copy is taken while they write.
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let writers: Vec<_> = (0..4)
        .map(|w| {
            let (store, stop) = (store.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut i = 0;
                while !stop.load(Ordering::SeqCst) {
                    store
                        .sign_in(start::TEST_ISSUER, &format!("p{w}-{i}"), T0)
                        .expect("signed in");
                    i += 1;
                }
            })
        })
        .collect();
    let mut copies = Vec::new();
    let mut last = 0;
    for n in 0..5 {
        while store.accounts().unwrap() < last + 100 {
            std::thread::yield_now();
        }
        let to = dir.join(format!("copy-{n}.sqlite"));
        store.backup(&to).expect("a copy");
        last = store.accounts().unwrap();
        copies.push(to);
    }
    stop.store(true, Ordering::SeqCst);
    for w in writers {
        w.join().unwrap();
    }
    let total = store.accounts().unwrap();
    let mut counts = Vec::new();
    for to in &copies {
        let db = rusqlite::Connection::open(to).unwrap();
        let check: String = db
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap();
        let accounts: i64 = db
            .query_row("SELECT COUNT(*) FROM provider_accounts_v1", [], |r| {
                r.get(0)
            })
            .unwrap();
        let paired: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM provider_accounts_v1 a JOIN account_principals_v1 p USING (account_id)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        println!(
            "a5: {}: integrity {check}, {accounts} accounts, {paired} with their principal",
            to.file_name().unwrap().to_string_lossy()
        );
        assert_eq!(check, "ok");
        assert_eq!(
            accounts, paired,
            "every account in a copy has its principal"
        );
        counts.push(accounts as u64);
    }
    println!("a5: the store holds {total} accounts when the writers stop");
    assert!(
        counts.windows(2).all(|w| w[0] < w[1]) && counts[4] < total,
        "{counts:?} then {total}"
    );
}

/// One request: its status, its headers and its JSON body (`null` when empty).
fn request(
    addr: &str,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: &str,
) -> (u16, String, Value) {
    let mut s = TcpStream::connect(addr).expect("connects");
    let auth = bearer.map_or(String::new(), |t| format!("authorization: Bearer {t}\r\n"));
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nhost: {addr}\r\n{auth}content-length: {}\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    let (head, body) = out.split_once("\r\n\r\n").unwrap();
    let body = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(body).unwrap()
    };
    (head[9..12].parse().unwrap(), head.to_string(), body)
}

const VIEW_KEY: [u8; 32] = [0x5a; 32];

fn soul_grant(n: u64) -> String {
    format!("soul-{}-{n}", "01".repeat(16))
}

/// V13b (#3407) A1: a test person's session exchanges for a view token scoped to what they own, signed with the key the
/// gateways hold; it reaches neither the log nor the store, and only the page's origin may read the answer.
#[test]
fn v13b_a1_a_session_exchanges_for_a_view_token_of_what_the_account_owns() {
    let dir = scratch("v13b-a1");
    let store = dir.join("accounts.sqlite");
    let key = dir.join("view.key");
    std::fs::write(&key, replica::encode::to_hex(&VIEW_KEY)).unwrap();
    let own = format!("Ada={}@0707.10", soul_grant(1));
    let own2 = format!("Ada={}", soul_grant(4));
    let mut child = directoryd(&[
        "--listen",
        "127.0.0.1:0",
        "--public-url",
        "http://127.0.0.1:8080",
        "--store",
        store.to_str().unwrap(),
        "--test-sign-in",
        "--view-key",
        key.to_str().unwrap(),
        "--test-own",
        &own,
        "--test-own",
        &own2,
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .expect("starts");
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let addr = line
        .trim()
        .strip_prefix("listening on ")
        .expect("listening")
        .to_string();

    let before = directoryd::accounts::serve::now();
    let (status, head, got) = request(
        &addr,
        "POST",
        "/v1/account/view-token",
        None,
        r#"{"name":"Ada"}"#,
    );
    let (none, _, nothing) = request(
        &addr,
        "POST",
        "/v1/account/view-token",
        None,
        r#"{"name":"Bo"}"#,
    );
    let (pre, pre_head, _) = request(&addr, "OPTIONS", "/v1/account/view-token", None, "");
    child.kill().unwrap();
    child.wait().unwrap();
    let mut log = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut log)
        .unwrap();

    assert_eq!(status, 200, "{got}");
    let token = got["token"].as_str().unwrap();
    let (body, mac) = token.rsplit_once('.').unwrap();
    let expires = got["expires"].as_u64().unwrap();
    assert_eq!(
        body,
        format!("view.{expires}.{}/{}", soul_grant(1), soul_grant(4)),
        "scoped to what Ada owns"
    );
    let k = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &VIEW_KEY);
    ring::hmac::verify(&k, body.as_bytes(), &directoryd_hex(mac))
        .expect("signed with the shared key");
    let ttl = directoryd::accounts::view::VIEW_TTL_S;
    assert!(
        expires >= before + ttl && expires <= before + ttl + 2,
        "short-lived"
    );
    assert_eq!(got["owned"][0]["follow"], "0707.10");
    assert_eq!(got["owned"][1]["follow"], Value::Null);
    assert!(head.contains("cache-control: no-store"));
    assert!(head.contains("access-control-allow-origin: http://127.0.0.1:8080"));
    assert_eq!(
        (none, nothing["refused"].as_str()),
        (404, Some("nothing-owned"))
    );
    assert_eq!(pre, 204);
    assert!(pre_head.contains("access-control-allow-headers: authorization, content-type"));
    assert!(
        !log.contains(mac) && !log.contains("view."),
        "the token is never logged: {log}"
    );
    let file = std::fs::read(&store).unwrap();
    assert!(
        !file.windows(mac.len()).any(|w| w == mac.as_bytes()),
        "nor stored"
    );
    println!(
        "v13b a1: owned {}; expires in {} s; log:\n{log}",
        got["owned"],
        expires - before
    );
}

fn directoryd_hex(text: &str) -> Vec<u8> {
    replica::encode::from_hex(text).unwrap()
}

/// V13b (#3407) A3: an expired provider session, or one signed out, gets no view token; a live one does.
#[test]
fn v13b_a3_an_expired_or_signed_out_session_gets_no_view_token() {
    use directoryd::accounts::serve::{App, now, run};
    use directoryd::accounts::view::ViewKey;
    let dir = scratch("v13b-a3");
    let p = Published::default();
    let k = Key::new("k1");
    p.publish(&k);
    let store = Store::open(&dir.join("accounts.sqlite")).unwrap();
    let account = store.sign_in(ISSUER, "user_1", now()).unwrap().account;
    store
        .own(&account, &soul_grant(1), Some("0707.10"))
        .unwrap();
    let app = App {
        store,
        verifier: Some(verifier(&p)),
        test_sign_in: false,
        view_key: Some(ViewKey::new(&VIEW_KEY)),
        origin: Some(PAGE.to_string()),
        mailbox_key: None,
        pairing: None,
        log: Mutex::new(Box::new(std::io::sink())),
        worlds: None,
    };
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    std::thread::spawn(move || run(listener, Arc::new(app)));

    let t = now();
    let live = k.token(&claims(t, "user_1"));
    let mut old = claims(t, "user_1");
    old["exp"] = json!(t - 60);
    let expired = k.token(&old);
    let path = "/v1/account/view-token";
    let (s1, _, a) = request(&addr, "POST", path, Some(&live), "");
    let (s2, _, b) = request(&addr, "POST", path, Some(&expired), "");
    let (s3, _, _) = request(&addr, "POST", "/v1/account/sign-out", Some(&live), "");
    let (s4, _, c) = request(&addr, "POST", path, Some(&live), "");
    println!("v13b a3: live {s1}; expired {s2} {b}; signed out {s3}; after sign-out {s4} {c}");
    assert_eq!(s1, 200);
    assert!(a["token"].as_str().unwrap().starts_with("view."));
    assert_eq!((s2, b["refused"].as_str()), (401, Some("token-expired")));
    assert_eq!(s3, 200);
    assert_eq!((s4, c["refused"].as_str()), (401, Some("session-revoked")));
    assert!(b.get("token").is_none() && c.get("token").is_none());
}

/// V13c (#3418) A1: a completed pairing (W2) records the Soul, and the body the page follows (the Soul's own), under
/// the approving account; the account's session then exchanges for a view token of it.
#[test]
fn v13c_a1_a_completed_pairing_records_the_soul_under_the_approving_account() {
    use directoryd::accounts::serve::{App, run};
    use directoryd::accounts::view::{ViewKey, follow_of};
    use directoryd::pairing::Pairing;
    let dir = scratch("v13c-a1");
    let pairing = Pairing::open(&dir.join("pairing.sqlite"), None, "http://127.0.0.1:1").unwrap();
    let app = Arc::new(App {
        store: Store::open(&dir.join("accounts.sqlite")).unwrap(),
        verifier: None,
        test_sign_in: true,
        view_key: Some(ViewKey::new(&VIEW_KEY)),
        origin: None,
        mailbox_key: None,
        pairing: Some(pairing),
        log: Mutex::new(Box::new(std::io::sink())),
        worlds: None,
    });
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let served = app.clone();
    std::thread::spawn(move || run(listener, served));

    // Before: Ada owns nothing, so her session gets no view.
    let ada = json!({"name": "Ada"}).to_string();
    let (s0, _, b0) = request(&addr, "POST", "/v1/account/view-token", None, &ada);
    assert_eq!((s0, b0["refused"].as_str()), (404, Some("nothing-owned")));
    // A daemon asks for a new Soul; Ada approves once on the card.
    let ask =
        json!({"secret_hash": "ab".repeat(32), "device": "laptop", "label": "agent", "new": true});
    let (s1, _, asked) = request(&addr, "POST", "/v1/pair/request", None, &ask.to_string());
    assert_eq!(s1, 200);
    let approve = json!({"test_person": "Ada", "code": asked["code"], "confirm": true});
    let (s2, _, approved) = request(
        &addr,
        "POST",
        "/v1/pair/approve",
        None,
        &approve.to_string(),
    );
    assert_eq!(s2, 200, "{approved}");
    let grant = approved["soul"].as_str().unwrap().to_string();

    let account = app
        .store
        .sign_in(start::TEST_ISSUER, "Ada", 0)
        .unwrap()
        .account;
    let owned = app.store.grants(&account).unwrap();
    println!("v13c a1: Ada owns {owned:?}");
    assert!(follow_of(&grant).is_some());
    assert_eq!(owned, vec![(grant.clone(), follow_of(&grant))]);
    // Bea, who approved nothing, owns nothing.
    let bea = app
        .store
        .sign_in(start::TEST_ISSUER, "Bea", 0)
        .unwrap()
        .account;
    assert!(app.store.grants(&bea).unwrap().is_empty());
    // After: Ada's session exchanges for a view of her paired Soul, following its own body.
    let (s3, _, view) = request(&addr, "POST", "/v1/account/view-token", None, &ada);
    assert_eq!(s3, 200);
    assert!(view["token"].as_str().unwrap().contains(&grant));
    assert_eq!(
        view["owned"],
        json!([{"grant": grant, "follow": follow_of(&grant)}])
    );
}

/// C14 (#3684) A1, A3: a Soul's daemon sets its status line through the gateway (the mailbox key and the socket's own
/// grant); anyone reads it, and nothing else, by grant. A line past 140 characters is refused by name and the line
/// kept; an empty one clears it. Without the gateway's key a set is refused.
#[test]
fn c14_a1_a_soul_sets_its_status_line_through_the_gateway_and_anyone_reads_it() {
    use directoryd::accounts::serve::{App, key_digest, run};
    let dir = scratch("c14-now");
    let app = App {
        store: Store::open(&dir.join("accounts.sqlite")).unwrap(),
        verifier: None,
        test_sign_in: false,
        view_key: None,
        origin: Some(PAGE.to_string()),
        mailbox_key: Some(key_digest("gateway-key")),
        pairing: None,
        log: Mutex::new(Box::new(std::io::sink())),
        worlds: None,
    };
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    std::thread::spawn(move || run(listener, Arc::new(app)));
    let set = |key: &str, grant: &str, text: Value| {
        let body = json!({"now": {"n": 7, "text": text}}).to_string();
        let mut s = TcpStream::connect(&addr).unwrap();
        write!(s, "POST /v1/mailbox/now HTTP/1.1\r\nhost: x\r\nauthorization: Bearer {key}\r\nsouls-soul: {grant}\r\ncontent-length: {}\r\n\r\n{body}", body.len()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        let (head, body) = out.split_once("\r\n\r\n").unwrap();
        (
            head[9..12].parse::<u16>().unwrap(),
            serde_json::from_str::<Value>(body).unwrap(),
        )
    };
    let read = |souls: Value| {
        request(
            &addr,
            "POST",
            "/v1/account/now",
            None,
            &json!({"souls": souls}).to_string(),
        )
    };
    let (a, b) = (soul_grant(1), soul_grant(2));

    let (s1, r1) = set("gateway-key", &a, json!("  Mending the\nnets "));
    assert_eq!(s1, 200);
    assert_eq!(
        (r1["reply"]["n"].as_u64(), r1["reply"]["ok"].as_bool()),
        (Some(7), Some(true))
    );
    assert_eq!(r1["reply"]["now"]["text"], "Mending the nets");
    let (s2, _, got) = read(json!([a, b]));
    assert_eq!(s2, 200);
    assert_eq!(got["now"][&a]["text"], "Mending the nets");
    assert!(
        got["now"].get(&b).is_none(),
        "a Soul with no line is not in the answer"
    );
    assert_eq!(
        got["now"][&a].as_object().unwrap().len(),
        2,
        "text and at only"
    );

    let (_, r3) = set("gateway-key", &a, json!("x".repeat(141)));
    assert_eq!(r3["reply"]["refused"], "now.too-long");
    assert_eq!(read(json!([a])).2["now"][&a]["text"], "Mending the nets");
    let (_, r4) = set("gateway-key", &a, json!(""));
    assert_eq!(
        (r4["reply"]["ok"].as_bool(), &r4["reply"]["now"]),
        (Some(true), &Value::Null)
    );
    assert!(read(json!([a])).2["now"].as_object().unwrap().is_empty());

    // #3784: the world's word on a Soul, through the gateway on each change; read with the lines; `awake` clears it.
    let states = |key: &str, words: Value| {
        let body = json!({ "states": words }).to_string();
        let mut s = TcpStream::connect(&addr).unwrap();
        write!(s, "POST /v1/mailbox/state HTTP/1.1\r\nhost: x\r\nauthorization: Bearer {key}\r\ncontent-length: {}\r\n\r\n{body}", body.len()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out[9..12].parse::<u16>().unwrap()
    };
    assert_eq!(
        states("gateway-key", json!({ &a: "asleep", &b: "zombie" })),
        200
    );
    let got = read(json!([a, b])).2;
    assert_eq!(
        (got["state"][&a].as_str(), got["state"][&b].as_str()),
        (Some("asleep"), Some("zombie"))
    );
    assert_eq!(states("gateway-key", json!({ &b: "awake" })), 200);
    assert!(read(json!([b])).2.get("state").is_none(), "awake: no word");
    assert_eq!(states("not-the-key", json!({ &b: "asleep" })), 401);
    assert!(
        read(json!([b])).2.get("state").is_none(),
        "only the gateway tells"
    );

    let (s5, r5) = set("not-the-key", &a, json!("Hi"));
    assert_eq!((s5, r5["refused"].as_str()), (401, Some("mailbox-key")));
    let (s6, _, r6) = read(json!((0..65).map(soul_grant).collect::<Vec<_>>()));
    assert_eq!((s6, r6["refused"].as_str()), (400, Some("now.too-many")));
    println!(
        "c14 a1: set {s1}; too long {}; cleared; no key {s5}; 65 asked {s6}",
        r3["reply"]["refused"]
    );
}
