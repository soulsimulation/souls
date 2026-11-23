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
