//! `gateway-upgrade`: put a new gateway build on a machine running O1's units and restart each world's gateway onto
//! it, one at a time (Engine v2 O16, #2809). Runbook: `v2/docs/runbook/gateway-upgrade.md`.
//!
//! ```text
//! gateway-upgrade <new gatewayd> <world> [<world> ...] [--lib /usr/local/lib/souls]
//! ```
//!
//! 1. It refuses, `gateway-upgrade.world-deploying`, while any world on the machine deploys (`step.rs`), and holds
//!    the machine's step until it ends, so no deploy starts meanwhile: never in the same step as a world's deploy.
//! 2. The build goes in beside the old one and is renamed over it (`<lib>/gatewayd`), so a gateway that restarts on
//!    its own meanwhile starts a whole build, old or new.
//! 3. Each world's `souls-gateway@<world>` is restarted: SIGTERM, the old process closes every socket with 1012 and
//!    exits, systemd starts the new one; then it must be active within 10 s, or the upgrade stops there. Agents
//!    reconnect within 2 s, resume by cursor and send their unanswered intents again (`gatewayd`'s docs).
//!
//! Prints the timeline (ms from its start); exits 0 when every gateway named is active on the new build.
// Operations, not the engine: its timeline is wall-clock time (the wall-clock rule, K7).
#![allow(clippy::disallowed_methods)]

mod step;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// How long a restarted gateway has to be active.
const ACTIVE_WITHIN: Duration = Duration::from_secs(10);

/// The machine's service manager: `systemctl <args>`, true when it exits 0.
type Systemctl<'a> = &'a mut dyn FnMut(&[&str]) -> bool;

/// The upgrade, its timeline lines as it goes to `say`.
fn upgrade(
    root: &Path,
    lib: &Path,
    build: &Path,
    worlds: &[String],
    systemctl: Systemctl,
    say: &mut dyn FnMut(String),
) -> Result<(), String> {
    let _step = step::upgrading(root)?;
    say(format!(
        "the machine's step is held: no world deploys until the upgrade ends ({})",
        step::LOCK
    ));
    let bytes = std::fs::read(build).map_err(|e| format!("the build: {e}"))?;
    let (to, tmp) = (lib.join("gatewayd"), lib.join("gatewayd.new"));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &to).map_err(|e| format!("{}: {e}", to.display()))?;
    say(format!(
        "the new build is {} ({} bytes)",
        to.display(),
        bytes.len()
    ));
    for w in worlds {
        let unit = format!("souls-gateway@{w}.service");
        if !systemctl(&["restart", &unit]) {
            return Err(format!("gateway-upgrade.restart-failed: {unit}"));
        }
        say(format!("{unit} restarted: its sockets closed with 1012"));
        let t = Instant::now();
        while !systemctl(&["is-active", "--quiet", &unit]) {
            if t.elapsed() > ACTIVE_WITHIN {
                return Err(format!("gateway-upgrade.not-active: {unit}"));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        say(format!("{unit} active on the new build"));
    }
    Ok(())
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let mut lib = PathBuf::from("/usr/local/lib/souls");
    let mut rest = Vec::new();
    let mut it = a.into_iter();
    while let Some(x) = it.next() {
        if x == "--lib" {
            lib = it.next().map_or(lib, PathBuf::from);
        } else {
            rest.push(x);
        }
    }
    let [build, worlds @ ..] = rest.as_slice() else {
        eprintln!("usage: gateway-upgrade <new gatewayd> <world> [<world> ...] [--lib <dir>]");
        std::process::exit(2);
    };
    if worlds.is_empty() {
        eprintln!("gateway-upgrade: name at least one world");
        std::process::exit(2);
    }
    let root = std::env::var_os("WORLDS_ROOT")
        .map_or_else(|| PathBuf::from("/var/lib/souls/worlds"), PathBuf::from);
    let t0 = Instant::now();
    let mut systemctl = |args: &[&str]| {
        Command::new("systemctl")
            .args(args)
            .status()
            .is_ok_and(|s| s.success())
    };
    let r = upgrade(
        &root,
        &lib,
        Path::new(build),
        worlds,
        &mut systemctl,
        &mut |line| println!("{:>7} ms  {line}", t0.elapsed().as_millis()),
    );
    match r {
        Ok(()) => println!("upgraded"),
        Err(e) => {
            println!("refused: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("o16-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("lib")).unwrap();
        std::fs::write(d.join("build"), b"new gateway").unwrap();
        d
    }

    #[test]
    fn a4_the_upgrade_refuses_while_a_world_deploys_and_touches_nothing() {
        let d = scratch("refuse");
        let deploy = step::deploying(&d).expect("a deploy holds the step");
        let mut called = Vec::new();
        let r = upgrade(
            &d,
            &d.join("lib"),
            &d.join("build"),
            &["w".into()],
            &mut |a: &[&str]| {
                called.push(a.join(" "));
                true
            },
            &mut |_| {},
        );
        assert_eq!(r, Err(step::WORLD_DEPLOYING.to_owned()));
        assert!(called.is_empty(), "no gateway was restarted");
        assert!(
            !d.join("lib/gatewayd").exists(),
            "the build was not installed"
        );
        drop(deploy);
        let mut called = Vec::new();
        let r = upgrade(
            &d,
            &d.join("lib"),
            &d.join("build"),
            &["w".into()],
            &mut |a: &[&str]| {
                called.push(a.join(" "));
                true
            },
            &mut |_| {},
        );
        assert_eq!(r, Ok(()));
        assert_eq!(
            called,
            [
                "restart souls-gateway@w.service",
                "is-active --quiet souls-gateway@w.service"
            ]
        );
        assert_eq!(
            std::fs::read(d.join("lib/gatewayd")).unwrap(),
            b"new gateway"
        );
    }

    #[test]
    fn a4_a_deploy_refuses_while_the_gateway_is_upgraded() {
        let d = scratch("deploy");
        let up = step::upgrading(&d).expect("the upgrade holds the step");
        assert_eq!(
            step::deploying(&d).err(),
            Some(step::GATEWAY_UPGRADING.to_owned())
        );
        drop(up);
        let a = step::deploying(&d).expect("one deploy");
        let b = step::deploying(&d).expect("two worlds deploy at once");
        drop((a, b));
    }
}
