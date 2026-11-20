//! Private, per-world live-session lookup. Never mounted on the public HTTP router.
use crate::{Gateway, token::Grant};
use replica::effects::Actor;
use std::fs::{File, OpenOptions};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

pub const NAME: &str = "ctl.sock";
const WITHIN: Duration = Duration::from_secs(1);
const MOST: u64 = 129;

pub struct Control {
    listener: UnixListener,
    // The persistent regular lock inode is never removed: simultaneous startups lock the same file.
    _lock: File,
}

fn lock(path: &Path) -> Result<File, &'static str> {
    let path = path.with_extension("lock");
    let file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let before = std::fs::symlink_metadata(&path).map_err(|_| "control-path-occupied")?;
            if !before.file_type().is_file() || before.permissions().mode() & 0o777 != 0o600 {
                return Err("control-path-occupied");
            }
            let file = File::open(&path).map_err(|_| "control-path-occupied")?;
            let opened = file.metadata().map_err(|_| "control-path-occupied")?;
            let after = std::fs::symlink_metadata(&path).map_err(|_| "control-path-occupied")?;
            if !after.file_type().is_file()
                || before.dev() != opened.dev()
                || before.ino() != opened.ino()
                || after.dev() != opened.dev()
                || after.ino() != opened.ino()
                || before.uid() != opened.uid()
            {
                return Err("control-path-occupied");
            }
            file
        }
        Err(_) => return Err("control-unavailable"),
    };
    file.try_lock().map_err(|_| "control-listener-active")?;
    Ok(file)
}

struct Bound(PathBuf, u64, u64);
impl Drop for Bound {
    fn drop(&mut self) {
        if std::fs::symlink_metadata(&self.0)
            .is_ok_and(|m| m.file_type().is_socket() && m.dev() == self.1 && m.ino() == self.2)
        {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}

/// Only a dead socket can be replaced. An active listener, regular file or symlink is never unlinked.
pub async fn bind(path: &Path) -> Result<Control, &'static str> {
    let lock = lock(path)?;
    match std::fs::symlink_metadata(path) {
        Ok(m) if !m.file_type().is_socket() => return Err("control-path-occupied"),
        Ok(before) => match tokio::time::timeout(WITHIN, UnixStream::connect(path)).await {
            Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                let same = std::fs::symlink_metadata(path).is_ok_and(|m| {
                    m.file_type().is_socket()
                        && m.dev() == before.dev()
                        && m.ino() == before.ino()
                        && m.uid() == before.uid()
                });
                if !same {
                    return Err("control-path-occupied");
                }
                std::fs::remove_file(path).map_err(|_| "control-path-occupied")?;
            }
            _ => return Err("control-listener-active"),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("control-unavailable"),
    }
    let listener = UnixListener::bind(path).map_err(|_| "control-unavailable")?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|_| "control-unavailable")?;
    Ok(Control {
        listener,
        _lock: lock,
    })
}

async fn answer(mut stream: UnixStream, gw: Arc<Gateway>, uid: u32) {
    if !stream.peer_cred().is_ok_and(|p| p.uid() == uid) {
        return;
    }
    let mut bytes = Vec::new();
    // The caller half-closes its write side. Both bytes and the complete exchange are bounded.
    if (&mut stream)
        .take(MOST)
        .read_to_end(&mut bytes)
        .await
        .is_err()
    {
        return;
    }
    let grant = (bytes.len() < MOST as usize)
        .then(|| std::str::from_utf8(&bytes).ok())
        .flatten()
        .and_then(|s| s.strip_suffix('\n'))
        .and_then(|s| s.strip_prefix("presence/1 "))
        .and_then(Grant::parse)
        .filter(|g| matches!(g, Grant::Actor(Actor::Soul(_))));
    let state = match grant.and_then(|g| gw.connected(g)) {
        Some(true) => "connected\n",
        Some(false) => "disconnected\n",
        None => "unavailable\n",
    };
    let _ = stream.write_all(state.as_bytes()).await;
}

pub async fn run(gw: Arc<Gateway>, path: PathBuf, control: Control) {
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
        return;
    };
    let _bound = Bound(path, meta.dev(), meta.ino());
    let uid = meta.uid();
    let mut closing = gw.closing.subscribe();
    let slots = Arc::new(tokio::sync::Semaphore::new(16));
    loop {
        if *closing.borrow() {
            break;
        }
        tokio::select! {
            _ = closing.changed() => break,
            accepted = control.listener.accept() => {
                let Ok((stream, _)) = accepted else { break; };
                let Ok(slot) = slots.clone().try_acquire_owned() else { drop(stream); continue; };
                let gw = gw.clone();
                tokio::spawn(async move {
                    let _slot = slot;
                    let _ = tokio::time::timeout(WITHIN, answer(stream, gw, uid)).await;
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{receipts::Who, token::Tokens};
    fn folder() -> PathBuf {
        let mut bytes = [0; 4];
        getrandom::fill(&mut bytes).unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.local")
            .join(format!("c{}", replica::encode::to_hex(&bytes)));
        std::fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }
    async fn query(path: &Path, request: &str) -> String {
        let mut socket = UnixStream::connect(path).await.unwrap();
        socket.write_all(request.as_bytes()).await.unwrap();
        socket.shutdown().await.unwrap();
        let mut out = String::new();
        socket.read_to_string(&mut out).await.unwrap();
        out
    }
    #[tokio::test]
    async fn control_reports_real_sessions_and_guarded_replacement_and_fails_closed() {
        let root = folder();
        let path = root.join(NAME);
        assert!(path.as_os_str().len() < 104);
        let gw = Gateway::new(Tokens::default(), vec![], Arc::new(|_| {}));
        let listener = bind(&path).await.unwrap();
        let job = tokio::spawn(run(gw.clone(), path.clone(), listener));
        let grant = Grant::parse(&format!("soul-{}-0", "01".repeat(16))).unwrap();
        let line = format!("presence/1 {}\n", grant.to_text());
        assert_eq!(query(&path, &line).await, "disconnected\n");
        let old = gw.attach(grant, None, 1, Arc::new(Who::default()));
        assert_eq!(query(&path, &line).await, "connected\n");
        let next = gw.attach(grant, None, 1, Arc::new(Who::default()));
        gw.detach(grant, old.session);
        assert_eq!(query(&path, &line).await, "connected\n");
        gw.detach(grant, next.session);
        assert_eq!(query(&path, &line).await, "disconnected\n");
        assert_eq!(query(&path, "presence/2 invalid\n").await, "unavailable\n");
        let other = Grant::parse(&format!("soul-{}-0", "02".repeat(16))).unwrap();
        let _held = gw.attach(grant, None, 1, Arc::new(Who::default()));
        assert_eq!(
            query(&path, &format!("presence/1 {}\n", other.to_text())).await,
            "disconnected\n"
        );
        assert!(bind(&path).await.is_err());
        gw.closing.send(true).unwrap();
        assert_eq!(gw.connected(grant), None);
        job.await.unwrap();
        assert!(!path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn startup_lock_serializes_concurrent_dead_socket_replacement_and_preserves_substitutions()
     {
        let root = folder();
        let path = root.join(NAME);
        assert!(path.as_os_str().len() < 104);
        drop(UnixListener::bind(&path).unwrap());
        let (one, two) = tokio::join!(bind(&path), bind(&path));
        assert_ne!(one.is_ok(), two.is_ok());
        drop(one);
        drop(two);
        // A dead listener is recoverable after its lifetime lock is released.
        let live = bind(&path).await.unwrap();
        assert!(bind(&path).await.is_err());
        drop(live);
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, "keep").unwrap();
        assert!(bind(&path).await.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "keep");
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(root.join("target"), &path).unwrap();
        assert!(bind(&path).await.is_err());
        assert!(
            std::fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
