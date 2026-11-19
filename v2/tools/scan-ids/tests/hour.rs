//! A2 of W1 (#2704): a person signs in through the directory, then acts for an hour of world time under the principal
//! the directory minted; a scan of every byte of the log, of every view and of the directory's own log finds no
//! account id, provider subject or email. The same scan, run on the principal id, finds the acts: it sees ids where
//! they are. The world is T6's base fixture; the acts are a creator's sets, one a second.

use directoryd::accounts::serve::{App, run};
use directoryd::accounts::session::{KeySource, PublicKey, Verifier};
use directoryd::accounts::store::Store;
use directoryd::accounts::{b64url, principal_from_text, random};
use replica::effects::{FIXTURE_HEADER, FIXTURES, Header, Part, State, fixture_bytes};
use replica::encode::to_hex;
use replica::ids::Id;
use replica::views::{Key, ORDER, Redactions, build};
use replica::world_model::Audience;
use ring::rand::SystemRandom;
use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

const ISSUER: &str = "https://clerk.example.test";
const PAGE: &str = "https://world.example.test";
const HOUR_S: u64 = 3600;

struct Keys(BTreeMap<String, PublicKey>);

impl KeySource for Keys {
    fn fetch(&self) -> Result<BTreeMap<String, PublicKey>, String> {
        Ok(self.0.clone())
    }
}

/// A key made for this run, and a session token it signs.
fn key_and_token(claims: &Value) -> (BTreeMap<String, PublicKey>, String) {
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
    let pair = RsaKeyPair::from_der(&out.stdout).expect("an RSA key");
    let c: ring::rsa::PublicKeyComponents<Vec<u8>> = pair.public().into();
    let input = format!(
        "{}.{}",
        b64url(json!({"alg": "RS256", "kid": "k1"}).to_string().as_bytes()),
        b64url(claims.to_string().as_bytes())
    );
    let mut sig = vec![0; pair.public().modulus_len()];
    pair.sign(
        &RSA_PKCS1_SHA256,
        &SystemRandom::new(),
        input.as_bytes(),
        &mut sig,
    )
    .expect("a signature");
    let keys = BTreeMap::from([("k1".to_string(), PublicKey { n: c.n, e: c.e })]);
    (keys, format!("{input}.{}", b64url(&sig)))
}

/// A log writer the test reads back.
#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl Write for Sink {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn a2_an_hour_of_acts_under_a_principal_leaves_no_account_identity_in_the_log_or_views() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("scan-ids-hour");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("views")).unwrap();

    // 1. Sign in: a provider token for a subject and an email made up for this run, checked by the directory.
    let tag = to_hex(&random::<4>());
    let (subject, email) = (format!("user_w1{tag}"), format!("ada.{tag}@example.test"));
    let now = directoryd::accounts::serve::now();
    let claims = json!({"iss": ISSUER, "sub": subject, "sid": format!("sess_{tag}"), "azp": PAGE, "email": email,
        "iat": now, "nbf": now, "exp": now + 60});
    let (keys, token) = key_and_token(&claims);
    let log = Sink::default();
    let app = App {
        store: Store::open(&dir.join("accounts.sqlite")).expect("the store"),
        verifier: Some(Verifier::new(
            ISSUER,
            &[PAGE.to_string()],
            Box::new(Keys(keys)),
        )),
        test_sign_in: false,
        pairing: None,
        log: Mutex::new(Box::new(log.clone())),
        worlds: None,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || run(listener, Arc::new(app)));
    let mut s = TcpStream::connect(addr).unwrap();
    write!(s, "POST /v1/account/session HTTP/1.1\r\nauthorization: Bearer {token}\r\ncontent-length: 0\r\n\r\n").unwrap();
    let mut resp = String::new();
    s.read_to_string(&mut resp).unwrap();
    let body: Value = serde_json::from_str(resp.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    let account = body["account"].as_str().expect("signed in").to_string();
    let principal: Id = principal_from_text(body["principal"].as_str().unwrap()).unwrap();

    // 2. An hour of world time: the creator sets a field once a second, every entry acted by its principal.
    let header = Header::read(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap();
    let root = header
        .kinds
        .iter()
        .find(|k| k.as_str().starts_with("souls:place@"))
        .unwrap()
        .clone();
    let start = State::start(header.zone, root);
    let base = Part::read(&fixture_bytes(FIXTURES[0].1).unwrap()).unwrap();
    let (p, world) = (to_hex(&principal.scope().0), "ee".repeat(16));
    let entries: Vec<String> = (1..=HOUR_S)
        .map(|s| {
            format!(
                "{{1: {seq}, 2: {at}, 3: {{1: 1, 2: [h'{p}', {s}]}}, 4: {{1: 2, 2: [h'{p}', {c}]}}, 5: {{1: 1}}, \
                 6: [h'{world}', 7], 7: [{{1: 4, 2: [h'{world}', 7], 3: 1, 4: {v}}}]}}",
                seq = s + 1,
                at = s * 1_000_000,
                c = principal.counter(),
                v = 1000 + s % 500,
            )
        })
        .collect();
    let hour = format!(
        "{{1: h'{}', 2: [{}]}}",
        to_hex(&header.hash().to_bytes()),
        entries.join(",\n")
    );
    let hour = Part::read(&fixture_bytes(&hour).unwrap()).expect("the hour as a part");
    let parts = vec![base, hour];
    let mut end = start.clone();
    for part in &parts {
        end.apply(&header, part).expect("the hour applies");
    }

    // 3. The log as stored, and every view of the root and the set node at every level, public and the principal's.
    let mut log_bytes = header.stored().to_vec();
    for part in &parts {
        log_bytes.extend_from_slice(part.stored());
    }
    std::fs::write(dir.join("world.log"), &log_bytes).unwrap();
    let nodes = [header.zone, Id::new(header.zone.scope(), 7).unwrap()];
    let keys: Vec<Key> = nodes
        .iter()
        .flat_map(|&node| {
            ORDER.into_iter().flat_map(move |level| {
                [Audience::Everyone, Audience::Of(principal)].map(|audience| Key {
                    node,
                    level,
                    audience,
                })
            })
        })
        .collect();
    let views = build(&start, &header, &parts, &keys, &Redactions::default()).expect("the views");
    for (i, v) in views.iter().enumerate() {
        std::fs::write(
            dir.join("views").join(format!("{i:02}.view")),
            v.bytes().unwrap(),
        )
        .unwrap();
    }
    std::fs::write(dir.join("directoryd.log"), log.0.lock().unwrap().as_slice()).unwrap();

    // 4. The scan, as the tool runs it, on everything but the store (which holds the account id by design).
    let scanned = [
        dir.join("world.log"),
        dir.join("views"),
        dir.join("directoryd.log"),
    ];
    std::fs::write(
        dir.join("ids.txt"),
        [account.as_str(), &subject, &email].join("\n"),
    )
    .unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_scan-ids"))
        .arg("--ids")
        .arg(dir.join("ids.txt"))
        .args(&scanned)
        .output()
        .unwrap();
    let said = String::from_utf8_lossy(&out.stdout);
    println!(
        "a2: {} entries over {} s of world time, {} log bytes, {} views; directory log: {}",
        parts.iter().map(|p| p.effects.len()).sum::<usize>(),
        HOUR_S,
        log_bytes.len(),
        views.len(),
        String::from_utf8_lossy(&log.0.lock().unwrap()).trim()
    );
    println!("a2: account, subject, email: {}", said.trim());
    assert_eq!(out.status.code(), Some(0), "{said}");
    assert!(said.contains(": 0 hits"));

    // The control: the principal's scope is in every acted entry, and the same scan finds it there.
    let control = scan_ids::scan(&scanned, &[principal.scope().0.to_vec()]).unwrap();
    let in_log = control
        .hits
        .iter()
        .filter(|h| h.path.ends_with("world.log") && h.form == "as-written")
        .count();
    println!(
        "a2: control: the scan finds the principal's id {in_log} times in the log, {} hits in all",
        control.hits.len()
    );
    assert!(in_log > HOUR_S as usize);
}
