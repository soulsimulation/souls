//! Request-only handoff to the installed finite initializer. The directory never launches a world under its limit.
use super::{Start, Starter};
use crate::directory::store::{R, refuse};
use replica::ids::{Hash, Purpose};
use std::path::PathBuf;

pub(super) fn build_pin() -> R<Vec<u8>> {
    let configured = std::env::var_os("DIRECTORYD_PLACEMENT_CONFIG")
        .map(|path| {
            let bytes = std::fs::read(path)
                .or_else(|_| refuse("build-invalid", "placement configuration is unreadable"))?;
            let config: serde_json::Value = serde_json::from_slice(&bytes)
                .or_else(|_| refuse("build-invalid", "placement configuration is malformed"))?;
            config
                .get("build")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
                .ok_or_else(|| replica::effects::Refusal {
                    name: "build-invalid",
                    detail: "placement build is missing".into(),
                })
        })
        .transpose()?;
    match configured.or_else(|| std::env::var("WORLDD_BUILD").ok()) {
        Some(pin) => {
            let bytes = replica::encode::from_hex(&pin)
                .or_else(|_| refuse("build-invalid", "the installed build pin"))?;
            if bytes.len() != 34 || !bytes.starts_with(&[0x12, 0x20]) {
                return refuse("build-invalid", "the installed build pin");
            }
            Ok(bytes)
        }
        None => Ok(Hash::of(Purpose::Fixture, b"souls/worldd/0.0.0").to_bytes()),
    }
}

pub(super) fn starter(root: PathBuf) -> Starter {
    Box::new(move |s: &Start| {
        if s.probe {
            return placed(&root, s);
        }
        let status = root.join("status").join(s.request);
        if let Ok(bytes) = std::fs::read(&status) {
            let value: serde_json::Value = serde_json::from_slice(&bytes)
                .or_else(|_| refuse("start-failed", "invalid placement status"))?;
            if value["request"] != s.request
                || value["name"] != s.name
                || value["lineage"] != replica::encode::to_hex(&s.lineage)
                || value["creator"] != crate::accounts::principal_text(s.creator)
            {
                return refuse(
                    "start-failed",
                    "placement status does not match this request",
                );
            }
            if value["ready"] == true {
                return Ok(());
            }
        }
        let inbox = root.join("requests");
        // The installer owns these directories and their permissions; absence is a configuration refusal.
        let path = inbox.join(s.request);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(file) => {
                file.sync_all()
                    .or_else(|_| refuse("start-failed", "placement request sync"))?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return refuse("start-failed", "placement initializer is unavailable"),
        }
        refuse(
            "world-starting",
            "this owned request is awaiting placement; retry the same click",
        )
    })
}

/// How recently, in seconds, a placement status written but not ready may still be a placement running (the service's
/// own limit is 300 s); such a create is not known yet.
const PLACING_FOR: u64 = 600;

/// A probe (rule 10): Ok when a placement status names this world (name and lineage) ready; `world-starting` when
/// none does and none was written in the last [`PLACING_FOR`] seconds; `start-failed` (not known) otherwise.
fn placed(root: &std::path::Path, s: &Start) -> R<()> {
    let lineage = replica::encode::to_hex(&s.lineage);
    let entries = std::fs::read_dir(root.join("status"))
        .or_else(|_| refuse("start-failed", "placement status is unreadable"))?;
    for e in entries {
        let e = e.or_else(|_| refuse("start-failed", "placement status is unreadable"))?;
        let Ok(bytes) = std::fs::read(e.path()) else {
            return refuse("start-failed", "placement status is unreadable");
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            return refuse("start-failed", "a placement status is unparseable");
        };
        if value["name"] != s.name || value["lineage"] != lineage.as_str() {
            continue;
        }
        if value["ready"] == true {
            return Ok(());
        }
        let written = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        let recent =
            written.is_none_or(|at| crate::accounts::serve::now() < at.saturating_add(PLACING_FOR));
        if recent {
            return refuse(
                "start-failed",
                "a placement of this world may still be running",
            );
        }
    }
    refuse("world-starting", "no placement of this world finished")
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::ids::{Id, Scope};

    #[test]
    fn rule10_a_probe_reads_the_placement_status_by_name_and_lineage() {
        let root = std::env::temp_dir().join(format!(
            "souls-probe-{}",
            replica::encode::to_hex(&crate::accounts::random::<8>())
        ));
        let status = root.join("status");
        std::fs::create_dir_all(&status).unwrap();
        let probe = |name: &str| {
            placed(
                &root,
                &Start {
                    name,
                    template: std::path::Path::new(""),
                    lineage: [0x11; 16],
                    creator: Id::new(Scope([1; 16]), 0).unwrap(),
                    claim: None,
                    request: "",
                    probe: true,
                },
            )
            .map_err(|e| e.name)
        };
        let lineage = replica::encode::to_hex(&[0x11; 16]);
        let write = |file: &str, name: &str, ready: bool, age: u64| {
            let path = status.join(file);
            std::fs::write(
                &path,
                serde_json::json!({"name": name, "lineage": lineage, "ready": ready}).to_string(),
            )
            .unwrap();
            let at = std::time::UNIX_EPOCH
                + std::time::Duration::from_secs(crate::accounts::serve::now() - age);
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(at)
                .unwrap();
        };
        assert_eq!(
            probe("lab"),
            Err("world-starting"),
            "no status: never placed"
        );
        write("a", "lab-2", true, 0);
        assert_eq!(
            probe("lab"),
            Err("world-starting"),
            "another world's status"
        );
        write("b", "lab", false, 60);
        assert_eq!(
            probe("lab"),
            Err("start-failed"),
            "written a minute ago: may still be placing"
        );
        write("b", "lab", false, PLACING_FOR + 60);
        assert_eq!(
            probe("lab"),
            Err("world-starting"),
            "an old, unfinished placement"
        );
        write("c", "lab", true, PLACING_FOR + 60);
        assert_eq!(probe("lab"), Ok(()));
        std::fs::write(status.join("d"), "{not json").unwrap();
        assert_eq!(
            probe("lab-3"),
            Err("start-failed"),
            "an unparseable status is not known"
        );
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(
            probe("lab"),
            Err("start-failed"),
            "an unreadable status folder is not known"
        );
    }
}
