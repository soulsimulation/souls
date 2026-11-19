//! `o20-drill <root> <seed> [--kill-at <s>]`: one run of O20's drill (#2812). Runbook:
//! `v2/docs/runbook/restore-stores.md`.
//!
//! Machine-a (this program again, `o20-drill machine-a <dir> <bucket>`, data in `<root>/a`) keeps the stores the log
//! does not hold, each opened by its owner's code: the account store (W1), pairing and the gateway's tokens file (W2)
//! and a world's text store with its uploads and removal list (K16). Its writer signs people in, pairs agents, says
//! sentences, erases some and uploads files, printing each write once it is acknowledged; its shipper ships the listed
//! stores (`v2/tools/ops/stores.json`) to the bucket, a folder store standing in for the offsite bucket. At a random
//! second from 280 to 560 (after the first full copy at 270 s, up to one whole interval past it) the conductor kills
//! machine-a (SIGKILL) and deletes its data folder. Machine-b, holding only the bucket and the recovery passphrase
//! (kept off machine-a), restores, then checks with the owners' code: each acknowledged account signs in as itself,
//! each paired agent's token is accepted by the gateway's tokens file with no new approval, each sentence reads, each
//! erased one is refused `removed`, each upload's bytes have its hash; and it counts every acknowledged write that did
//! not come back, with the oldest one's age at the loss. Prints the transcript and one table row; fails when a write
//! older than five minutes is lost.

use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use backup::{Key, LOSS_BAR_S, Shipper, checked_in, resolve, restore, unlisted};
use directoryd::accounts::start::TEST_ISSUER;
use directoryd::accounts::store::Store as Accounts;
use directoryd::directory::store::{R, refuse};
use directoryd::pairing::{Ask, INTERVAL, Pairing, Poll};
use gatewayd::token::{Token, Tokens};
use replica::encode::{from_hex, to_hex};
use replica::ids::{Id, Minter, Scope, sha256};
use replica::world_model::Audience;
use sim::text::{Grade, Store as Text};
use supervisor::folder::Folder;

const WORLD: &str = "w";
/// The writer's step: a sentence each step; an account each 4; an erasure each 12; a pairing each 20; an upload each 40.
const STEP_MS: u64 = 250;

#[allow(clippy::disallowed_methods)] // Operations: the drill times a real loss in wall time (K7 allows tools to).
fn unix_us() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as u64)
}

fn io<T>(r: std::io::Result<T>) -> R<T> {
    r.or_else(|e| refuse("io", e.to_string()))
}

fn author() -> Id {
    Id::new(Scope([2; 16]), 0).unwrap_or_else(|| unreachable!("counter 0 is an id"))
}

fn id_text(id: Id) -> String {
    format!("{}-{}", to_hex(&id.scope().0), id.counter())
}

fn id_parse(t: &str) -> Option<Id> {
    let (s, c) = t.split_once('-')?;
    let s: [u8; 16] = from_hex(s).ok()?.try_into().ok()?;
    Id::new(Scope(s), c.parse().ok()?)
}

/// A seeded xorshift: the kill second and which sentence is erased.
struct Rng(u64);
impl Rng {
    fn next(&mut self, below: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % below.max(1)
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let r = match args.first().map(String::as_str) {
        Some("machine-a") => machine_a(&args[1..]),
        Some(_) => conduct(&args),
        None => refuse(
            "usage",
            "o20-drill <root> <seed> [--kill-at <s>] | o20-drill machine-a <dir> <bucket>",
        ),
    };
    if let Err(e) = r {
        eprintln!("o20-drill: {e}");
        std::process::exit(1);
    }
}

// --- Machine-a ----------------------------------------------------------------------------------------------------

fn machine_a(args: &[String]) -> R<()> {
    let [dir, bucket] = args else {
        return refuse("usage", "o20-drill machine-a <dir> <bucket>");
    };
    let dir = PathBuf::from(dir);
    let d = dir.join("directory");
    io(std::fs::create_dir_all(&d))?;
    let accounts = Arc::new(
        Accounts::open(&d.join("accounts.sqlite"))
            .or_else(|e| refuse("accounts", e.to_string()))?,
    );
    let pairing = Pairing::open(
        &d.join("pairing.sqlite"),
        Some(d.join("gateway-tokens")),
        "http://127.0.0.1:1",
    )
    .or_else(|e| refuse("pairing", e.to_string()))?;
    let world = dir.join("worlds").join(WORLD);
    io(std::fs::create_dir_all(&world))?;
    let text = Text::open_dir(&world.join("log.text"), Minter::new(Scope([1; 16])))?;
    let Some(key) = Key::from_env() else {
        return refuse("backup-key", "SOULS_BACKUP_KEY_FILE is not set");
    };
    let mut shipper = Shipper::new(
        Folder::new(PathBuf::from(bucket)),
        key?,
        dir.clone(),
        resolve(&checked_in()?, &[WORLD]),
        dir.with_extension("staging"),
    );
    let a = Arc::clone(&accounts);
    shipper.hooks.insert(
        "accounts".into(),
        Box::new(move |to: &Path| a.backup(to).map_err(|e| e.to_string())),
    );
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let say = {
        let out = Arc::clone(&out);
        move |line: String| {
            let mut o = out.lock().unwrap_or_else(|p| p.into_inner());
            let _ = writeln!(o, "{line}");
            let _ = o.flush();
        }
    };
    // The shipper: each second, every store whose time has come and that changed.
    let ship_say = say.clone();
    std::thread::spawn(move || {
        loop {
            let at = unix_us();
            match shipper.due(at) {
                Ok(s) => {
                    for s in s {
                        ship_say(format!("shipped {at} {} {} {}", s.name, s.key, s.bytes));
                    }
                }
                Err(e) => ship_say(format!("ship-failed {at} {e}")),
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
    let mut said: Vec<Id> = Vec::new();
    let mut last_account: Option<String> = None;
    let mut rng = Rng(0x2812_2812);
    for step in 0u64.. {
        let n = step;
        let r = text.write(
            format!("sentence {n}").as_bytes(),
            Audience::Everyone,
            author(),
        )?;
        say(format!("ack {} said {} {n}", unix_us(), id_text(r)));
        said.push(r);
        if step % 4 == 0 {
            let who = format!("person-{}", step / 4);
            let acct = accounts
                .sign_in(TEST_ISSUER, &who, unix_us() / 1_000_000)
                .or_else(|e| refuse("accounts", e.to_string()))?;
            say(format!("ack {} account {who} {}", unix_us(), acct.account));
            last_account = Some(acct.account);
        }
        if step % 12 == 11 {
            let r = said.remove(rng.next(said.len() as u64) as usize);
            text.remove(r, author(), unix_us(), Grade::Erased)?;
            say(format!("ack {} erased {}", unix_us(), id_text(r)));
        }
        if let (0, Some(account)) = (step % 20, &last_account) {
            let secret = to_hex(&sha256(format!("secret {step}").as_bytes()));
            let now = unix_us() / 1_000_000;
            let asked = pairing
                .ask(
                    &Ask {
                        secret_hash: sha256(secret.as_bytes()),
                        device: format!("agent {step}"),
                        label: "drill agent".into(),
                        soul: None,
                        scope: "soul".into(),
                        force: false,
                    },
                    now,
                )
                .or_else(|e| refuse("pairing", e))?;
            pairing
                .approve(account, &asked.code, now)
                .or_else(|(e, _)| refuse("pairing", e))?;
            match pairing.poll(&secret, now + INTERVAL) {
                Poll::Token { token, grant } => {
                    say(format!("ack {} paired {grant} {token}", unix_us()))
                }
                p => return refuse("pairing", format!("{p:?}")),
            }
        }
        if step % 40 == 39 {
            let bytes = format!("upload {n} ").repeat(400).into_bytes();
            let r = text.upload(&bytes, Audience::Everyone, author())?;
            say(format!(
                "ack {} upload {} {}",
                unix_us(),
                id_text(r),
                to_hex(&sha256(&bytes))
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(STEP_MS));
    }
    Ok(())
}

// --- The conductor and machine-b ----------------------------------------------------------------------------------

/// One acknowledged write and whether it came back.
struct Acked {
    at: u64,
    kind: &'static str,
    back: bool,
}

fn conduct(args: &[String]) -> R<()> {
    let root = PathBuf::from(&args[0]);
    let Some(seed) = args.get(1).and_then(|s| s.parse::<u64>().ok()) else {
        return refuse("usage", "o20-drill <root> <seed> [--kill-at <s>]");
    };
    let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
    let kill_at = args
        .iter()
        .position(|a| a == "--kill-at")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| 280 + rng.next(281));
    let _ = std::fs::remove_dir_all(&root);
    let (a, b, bucket) = (root.join("a"), root.join("b"), root.join("bucket"));
    for d in [&a, &b, &bucket] {
        io(std::fs::create_dir_all(d))?;
    }
    // The recovery passphrase: kept off machine-a (the repository secret in a fleet); machine-b is handed it.
    let pass = root.join("recovery.key");
    let mut p = [0u8; 32];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut p)
        .or_else(|_| refuse("backup-key", "no random passphrase"))?;
    io(std::fs::write(&pass, to_hex(&p)))?;
    println!(
        "o20 drill: seed {seed}, kill at {kill_at} s; machine-a {}, bucket a folder store",
        a.display()
    );
    let t0 = unix_us();
    let mut child = io(Command::new(io(std::env::current_exe())?)
        .args(["machine-a"])
        .arg(&a)
        .arg(&bucket)
        .env("SOULS_BACKUP_KEY_FILE", &pass)
        .stdout(Stdio::piped())
        .stderr(Stdio::from(io(std::fs::File::create(
            root.join("machine-a.err"),
        ))?))
        .spawn())?;
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    if let Some(out) = child.stdout.take() {
        let lines = Arc::clone(&lines);
        std::thread::spawn(move || {
            for l in std::io::BufReader::new(out).lines().map_while(Result::ok) {
                lines.lock().unwrap_or_else(|p| p.into_inner()).push(l);
            }
        });
    }
    while unix_us() < t0 + kill_at * 1_000_000 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if let Ok(Some(st)) = child.try_wait() {
            return refuse("machine-a", format!("exited early: {st}"));
        }
    }
    io(child.kill())?; // SIGKILL
    let _ = child.wait();
    let loss = unix_us();
    io(std::fs::remove_dir_all(&a))?;
    std::thread::sleep(std::time::Duration::from_millis(200));
    let lines = std::mem::take(&mut *lines.lock().unwrap_or_else(|p| p.into_inner()));
    println!(
        "loss at {:.2} s: machine-a killed (SIGKILL), its data folder deleted",
        (loss - t0) as f64 / 1e6
    );
    let mut ships: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    for l in lines.iter().filter(|l| l.starts_with("shipped ")) {
        let f: Vec<&str> = l.split(' ').collect();
        let e = ships.entry(f[2].to_owned()).or_default();
        *e = (e.0 + 1, f[1].parse().unwrap_or(0));
    }
    for (name, (n, at)) in &ships {
        println!(
            "  {name}: shipped {n} times, last copy taken {:.2} s before the loss",
            (loss.saturating_sub(*at)) as f64 / 1e6
        );
    }

    // Machine-b: the bucket and the passphrase only.
    let started = unix_us();
    let key = Key::from_passphrase(io(std::fs::read_to_string(&pass))?.trim().as_bytes())?;
    let stores = resolve(&checked_in()?, &[WORLD]);
    let restored = restore(&Folder::new(bucket.clone()), Some(&key), &stores, &b, "")?;
    let took = unix_us() - started;
    let fetched: u64 = restored.iter().map(|r| r.bytes).sum();
    println!(
        "restore on machine-b from the bucket alone: {:.0} ms",
        took as f64 / 1e3
    );
    for r in &restored {
        println!("  {}: {} files, {} bytes", r.name, r.files, r.bytes);
    }
    let left = unlisted(&b, &checked_in()?);
    println!(
        "  files no line covers: {}",
        if left.is_empty() {
            "none".to_owned()
        } else {
            left.join(", ")
        }
    );

    let d = b.join("directory");
    let accounts = Accounts::open(&d.join("accounts.sqlite"))
        .or_else(|e| refuse("accounts", e.to_string()))?;
    let tokens = Tokens::read(&io(std::fs::read_to_string(d.join("gateway-tokens")))?)
        .or_else(|e| refuse("tokens", e))?;
    let text = Text::open_dir(
        &b.join("worlds").join(WORLD).join("log.text"),
        Minter::new(Scope([1; 16])),
    )?;
    let mut w: Vec<Acked> = Vec::new();
    let mut erased_read = 0;
    let mut said = BTreeMap::new();
    for l in lines.iter().filter(|l| l.starts_with("ack ")) {
        let f: Vec<&str> = l.split(' ').collect();
        let at: u64 = f[1].parse().unwrap_or(0);
        let (kind, back) = match f[2] {
            "said" => {
                let r = id_parse(f[3]);
                said.insert(f[3].to_owned(), w.len());
                let want = format!("sentence {}", f[4]);
                (
                    "said",
                    r.is_some_and(|r| text.read(r, &[]).is_ok_and(|b| b == want.as_bytes())),
                )
            }
            "erased" => {
                // The erased sentence is no longer "said": its words must not come back.
                if let Some(i) = said.get(f[3]) {
                    w[*i].kind = "said, then erased";
                    w[*i].back = true;
                }
                let r = id_parse(f[3]);
                let refused =
                    r.is_some_and(|r| text.read(r, &[]).is_err_and(|e| e.name == "removed"));
                let unknown =
                    r.is_some_and(|r| text.read(r, &[]).is_err_and(|e| e.name == "text-unknown"));
                if !refused && !unknown {
                    erased_read += 1;
                }
                ("erased", refused || unknown)
            }
            "account" => {
                let got = accounts
                    .sign_in(TEST_ISSUER, f[3], unix_us() / 1_000_000)
                    .map(|a| a.account)
                    .unwrap_or_default();
                ("account", got == f[4])
            }
            "paired" => {
                let back = Token::parse(f[4]).and_then(|t| tokens.check(&t)).is_some();
                ("paired", back)
            }
            "upload" => {
                let r = id_parse(f[3]);
                let got = r.and_then(|r| text.read(r, &[]).ok());
                ("upload", got.is_some_and(|b| to_hex(&sha256(&b)) == f[4]))
            }
            _ => continue,
        };
        w.push(Acked { at, kind, back });
    }
    let mut by: BTreeMap<&str, (u64, u64)> = BTreeMap::new();
    for x in &w {
        let e = by.entry(x.kind).or_default();
        e.0 += 1;
        e.1 += u64::from(x.back);
    }
    println!("checked on machine-b with the owners' code:");
    for (k, (n, back)) in &by {
        let how = match *k {
            "account" => "signed in as the same account",
            "paired" => "agent's token accepted by the gateway's tokens file, no new approval",
            "said" => "sentence reads",
            "said, then erased" => "sentence later erased (counted under erased)",
            "erased" => "refused `removed` (or never came back)",
            _ => "bytes served with the hash acknowledged",
        };
        println!("  {k}: {back} of {n} acknowledged: {how}");
    }
    let lost: Vec<&Acked> = w.iter().filter(|x| !x.back).collect();
    let oldest = lost.iter().map(|x| x.at).min();
    let window = oldest.map_or(0.0, |o| loss.saturating_sub(o) as f64 / 1e6);
    let met = window <= LOSS_BAR_S as f64 && erased_read == 0;
    let (acc, pair, sent, er, up) = (
        by.get("account").copied().unwrap_or_default(),
        by.get("paired").copied().unwrap_or_default(),
        by.get("said").copied().unwrap_or_default(),
        by.get("erased").copied().unwrap_or_default(),
        by.get("upload").copied().unwrap_or_default(),
    );
    println!(
        "| seed | kill at (s) | restore (ms) | bytes restored | accounts sign in | agents reconnect | sentences read | erased stay erased | uploads by hash | writes acked | writes lost | lost window (s) | bar |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    println!(
        "| {seed} | {kill_at} | {:.0} | {fetched} | {}/{} | {}/{} | {}/{} | {}/{} | {}/{} | {} | {} | {window:.2} | {} |",
        took as f64 / 1e3,
        acc.1,
        acc.0,
        pair.1,
        pair.0,
        sent.1,
        sent.0,
        er.1,
        er.0,
        up.1,
        up.0,
        w.len(),
        lost.len(),
        if met { "MET" } else { "MISSED" }
    );
    text.close();
    if met {
        Ok(())
    } else {
        refuse(
            "bar",
            format!("lost window {window:.2} s, erased words read {erased_read}"),
        )
    }
}
