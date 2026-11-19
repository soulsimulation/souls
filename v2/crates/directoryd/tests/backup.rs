//! Engine v2 O20b (#3523): directoryd runs O20's shipper for its own stores. With a folder standing in for the offsite
//! bucket it ships the account store (its copy handed over by the program, which holds the file exclusively), pairing
//! and the gateway's tokens file, and the copies read back: a person signed in before the copy signs in again as the
//! same account from the restored file (A2). With no bucket set it starts as before and says so once (A3).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use directoryd::accounts::start::TEST_ISSUER;
use directoryd::accounts::store::Store as Accounts;
use directoryd::backup::{Key, URL_ENV, unpack};
use directoryd::directory::folder::Folder;
use directoryd::directory::store::Store;

fn scratch(name: &str) -> PathBuf {
    let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("backup-{name}"));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("a scratch dir");
    d
}

/// directoryd on loopback with the test sign-in, its stores in `dir/directory/`; `env` set for it. Its address.
fn start(dir: &Path, env: &[(&str, &Path)]) -> (Child, String) {
    let d = dir.join("directory");
    std::fs::create_dir_all(&d).unwrap();
    let mut c = Command::new(env!("CARGO_BIN_EXE_directoryd"));
    c.args(["--listen", "127.0.0.1:0", "--public-url", "http://127.0.0.1:8080", "--test-sign-in"])
        .arg("--store")
        .arg(d.join("accounts.sqlite"))
        .arg("--pairing")
        .arg(d.join("pairing.sqlite"))
        .arg("--gateway-tokens")
        .arg(d.join("gateway-tokens"))
        .env_remove(URL_ENV)
        .env_remove("SOULS_BACKUP_KEY_FILE")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        c.env(k, v);
    }
    let mut child = c.spawn().expect("starts");
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let addr = line.trim().strip_prefix("listening on ").expect("listening").to_owned();
    (child, addr)
}

fn stop(mut child: Child) -> String {
    child.kill().unwrap();
    child.wait().unwrap();
    let mut log = String::new();
    child.stderr.take().unwrap().read_to_string(&mut log).unwrap();
    log
}

fn sign_in(addr: &str, name: &str) -> serde_json::Value {
    let body = format!(r#"{{"name":"{name}"}}"#);
    let mut s = TcpStream::connect(addr).expect("connects");
    write!(
        s,
        "POST /v1/account/test-sign-in HTTP/1.1\r\nhost: {addr}\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    assert_eq!(&out[9..12], "200", "{out}");
    serde_json::from_str(out.split("\r\n\r\n").nth(1).unwrap()).unwrap()
}

#[test]
fn a3_no_bucket_starts_as_before_and_says_so_once() {
    let dir = scratch("a3");
    let (child, addr) = start(&dir, &[]);
    let a = sign_in(&addr, "Ada");
    let log = stop(child);
    println!("A3: directoryd's log:\n{log}");
    assert!(a["account"].as_str().unwrap().starts_with("acct_"), "it signs in as before");
    assert_eq!(log.matches("backup: no bucket").count(), 1, "{log}");
    assert!(!log.contains("backup: not shipped"), "{log}");
}

// A real process on the real clock: the wait for its copy is real time.
#[allow(clippy::disallowed_methods)]
#[test]
fn a2_directoryd_ships_its_stores_and_the_copies_read_back() {
    let dir = scratch("a2");
    let bucket = dir.join("bucket");
    let pass = dir.join("recovery.key");
    std::fs::write(&pass, "a recovery passphrase for the test\n").unwrap();
    let url = PathBuf::from(format!("folder:{}", bucket.display()));
    let (child, addr) = start(
        &dir,
        &[
            (URL_ENV, &url),
            ("SOULS_BACKUP_KEY_FILE", &pass),
            ("SOULS_BACKUP_SHIP_S", Path::new("1")),
        ],
    );
    let ada = sign_in(&addr, "Ada");
    let account = ada["account"].as_str().unwrap().to_owned();
    // The copy taken after Ada's sign-in: the newest copy of the account store names her.
    let folder = Folder::new(bucket.clone());
    let key = Key::from_passphrase(b"a recovery passphrase for the test").unwrap();
    let restored = dir.join("restored.sqlite");
    let end = Instant::now() + Duration::from_secs(30);
    let found = loop {
        if let Some(o) = folder.get("store/accounts").unwrap() {
            let files = unpack(&key.open("store/accounts", &o.bytes).unwrap()).unwrap();
            let _ = std::fs::remove_file(&restored);
            std::fs::write(&restored, &files[0].1).unwrap();
            let s = Accounts::open(&restored).expect("the copy opens");
            let a = s.sign_in(TEST_ISSUER, "Ada", 0).expect("signs in");
            if a.account == account {
                break true;
            }
        }
        if Instant::now() > end {
            break false;
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    let log = stop(child);
    println!("A2: directoryd's log:\n{log}\nA2: keys {:?}", folder.keys("store/"));
    assert!(found, "Ada signs in as {account} from the restored copy");
    assert_eq!(log.matches("backup: shipping").count(), 1, "{log}");
    assert!(!log.contains("backup: not shipped"), "{log}");
    // The gateway's tokens file is written at the first pairing, so it has nothing to ship yet.
    for k in ["store/accounts", "store/pairing"] {
        assert!(folder.keys(k).contains(&k.to_owned()), "{k} shipped");
    }
}
