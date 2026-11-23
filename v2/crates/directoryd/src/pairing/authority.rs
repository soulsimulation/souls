//! Exact placed-world authority routing. The fixed root-owned registry is private, never a client-supplied path.
use super::{Pairing, is_creator_grant, is_soul_grant};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub(super) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS paired_world_tokens_v1(
    grant_text TEXT NOT NULL, world TEXT NOT NULL, device TEXT NOT NULL, token_hash TEXT NOT NULL,
    PRIMARY KEY(grant_text, world));";

#[derive(Clone)]
pub(super) struct Authority {
    pub world: String,
    pub tokens: PathBuf,
    pub creator: String,
    pub generation: u64,
}

macro_rules! io_error {
    ($stage:literal, $refusal:literal) => {
        |error: std::io::Error| {
            #[cfg(test)]
            eprintln!(
                "directoryd: presence stage={} kind={:?} errno={:?}",
                $stage,
                error.kind(),
                error.raw_os_error()
            );
            #[cfg(not(test))]
            let _ = error;
            $refusal
        }
    };
}

impl Authority {
    pub(super) fn creator_grant(&self) -> String {
        format!("creator-{}", self.creator.replace(':', "-"))
    }

    /// Only an exact trusted world's private gateway can say whether its session is live.
    /// No mutex, worker thread, credential or public address is involved.
    pub(super) fn connected(&self, grant: &str) -> Result<bool, &'static str> {
        use std::io::Write;
        use std::net::Shutdown;
        use std::os::unix::{
            fs::{FileTypeExt, PermissionsExt},
            net::UnixStream,
        };
        use std::time::Duration;
        const WITHIN: u64 = 1_000_000;
        let stamp = || {
            let t = rustix::time::clock_gettime(rustix::time::ClockId::Monotonic);
            u64::try_from(t.tv_sec).unwrap_or(0) * 1_000_000
                + u64::try_from(t.tv_nsec).unwrap_or(0) / 1_000
        };
        let started = stamp();
        let remaining = || {
            let left = WITHIN.saturating_sub(stamp().saturating_sub(started));
            if left == 0 {
                Err("presence-unavailable")
            } else {
                Ok(Duration::from_micros(left))
            }
        };
        let path = self.tokens.with_file_name("ctl.sock");
        regular(path.parent().ok_or("world-authority-invalid")?)?;
        let meta = std::fs::symlink_metadata(&path).map_err(|_| "presence-unavailable")?;
        if !meta.file_type().is_socket() || meta.permissions().mode() & 0o777 != 0o600 {
            return Err("presence-invalid");
        }
        let socket = socket2::Socket::new(socket2::Domain::UNIX, socket2::Type::STREAM, None)
            .map_err(io_error!("socket-create", "presence-unavailable"))?;
        // A trusted absolute authority may be long in an isolated checkout. A shorter path from the current
        // working directory names the same validated socket, without changing process-global cwd.
        let cwd = std::env::current_dir().map_err(|_| "presence-unavailable")?;
        let short = path.strip_prefix(cwd).unwrap_or(&path);
        let address =
            socket2::SockAddr::unix(short).map_err(io_error!("address", "presence-invalid"))?;
        socket
            .connect_timeout(&address, remaining()?)
            .map_err(io_error!("connect", "presence-unavailable"))?;
        let fd: std::os::fd::OwnedFd = socket.into();
        let mut stream: UnixStream = fd.into();
        let request = format!("presence/1 {grant}\n");
        let mut written = 0;
        while written < request.len() {
            let timeout = remaining()?;
            #[cfg(test)]
            eprintln!(
                "directoryd: presence write-timeout-us={}",
                timeout.as_micros()
            );
            stream
                .set_write_timeout(Some(timeout))
                .map_err(io_error!("write-timeout", "presence-unavailable"))?;
            let n = stream
                .write(&request.as_bytes()[written..])
                .map_err(io_error!("write", "presence-unavailable"))?;
            if n == 0 {
                return Err("presence-unavailable");
            }
            written += n;
        }
        stream
            .shutdown(Shutdown::Write)
            .map_err(io_error!("shutdown", "presence-unavailable"))?;
        read_presence(&mut stream, remaining)
    }
}

// Reading remains bounded by the original overall deadline. A closed peer can leave a complete
// buffered response while some platforms reject further receive socket options, so use nonblocking
// reads instead of changing SO_RCVTIMEO. EOF, not the first newline, validates the complete reply.
fn read_presence(
    stream: &mut std::os::unix::net::UnixStream,
    remaining: impl Fn() -> Result<std::time::Duration, &'static str>,
) -> Result<bool, &'static str> {
    use std::io::{ErrorKind, Read};
    use std::time::Duration;
    stream
        .set_nonblocking(true)
        .map_err(io_error!("nonblocking", "presence-unavailable"))?;
    let mut bytes = Vec::new();
    loop {
        remaining()?;
        let mut part = [0; 16];
        let n = match stream.read(&mut part) {
            Ok(0) => break,
            Ok(n) => n,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(remaining()?.min(Duration::from_millis(1)));
                continue;
            }
            Err(error) => return Err(io_error!("read", "presence-unavailable")(error)),
        };
        bytes.extend_from_slice(&part[..n]);
        if bytes.len() > 16 {
            return Err("presence-invalid");
        }
    }
    remaining()?;
    match bytes.as_slice() {
        b"connected\n" => Ok(true),
        b"disconnected\n" => Ok(false),
        b"unavailable\n" => Err("presence-unavailable"),
        _ => Err("presence-invalid"),
    }
}

fn regular(path: &Path) -> Result<(), &'static str> {
    let mut at = PathBuf::new();
    for part in path.components() {
        at.push(part);
        let meta = std::fs::symlink_metadata(&at).map_err(|_| "world-authority-unavailable")?;
        if meta.file_type().is_symlink() {
            return Err("world-authority-invalid");
        }
    }
    Ok(())
}

impl Pairing {
    pub(super) fn authorities(&self) -> Result<Option<BTreeMap<String, Authority>>, &'static str> {
        let Some(path) = &self.authority_file else {
            return Ok(None);
        };
        regular(path)?;
        let bytes = std::fs::read(path).map_err(|_| "world-authority-unavailable")?;
        if bytes.len() > 1 << 20 {
            return Err("world-authority-invalid");
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "world-authority-invalid")?;
        if value["format"] != "souls/world-authority/1" {
            return Err("world-authority-invalid");
        }
        let root = PathBuf::from(
            value["worldsRoot"]
                .as_str()
                .ok_or("world-authority-invalid")?,
        );
        if !root.is_absolute() {
            return Err("world-authority-invalid");
        }
        regular(&root)?;
        let mut out = BTreeMap::new();
        for (world, row) in value["worlds"]
            .as_object()
            .ok_or("world-authority-invalid")?
        {
            let instance = row["instance"].as_str().ok_or("world-authority-invalid")?;
            let parts: Vec<_> = instance.split('-').collect();
            if !super::souls::is_world(world)
                || parts.len() != 3
                || parts[..2]
                    .iter()
                    .any(|p| p.len() != 32 || replica::encode::from_hex(p).is_err())
                || parts[2].parse::<u64>().is_err()
            {
                return Err("world-authority-invalid");
            }
            let creator = row["creator"].as_str().ok_or("world-authority-invalid")?;
            if crate::accounts::principal_from_text(creator).is_none() {
                return Err("world-authority-invalid");
            }
            let (creator, generation) = if let Some(read) = self.owner_reader.get() {
                let current = read(world).map_err(|_| "world-authority-unavailable")?;
                let expected = format!(
                    "{}-{}",
                    replica::encode::to_hex(&current.lineage),
                    crate::accounts::principal_text(current.zone).replace(':', "-")
                );
                if expected != instance
                    || crate::accounts::principal_text(current.founder) != creator
                {
                    return Err("world-authority-mismatch");
                }
                (
                    current
                        .creator
                        .map(crate::accounts::principal_text)
                        .unwrap_or_default(),
                    current.generation,
                )
            } else {
                (creator.to_owned(), 0)
            };
            let tokens = root.join("worlds").join(instance).join("tokens");
            regular(&tokens)?;
            let authority = Authority {
                world: world.clone(),
                tokens,
                creator,
                generation,
            };
            if out.insert(world.clone(), authority.clone()).is_some()
                || out.insert(instance.to_owned(), authority).is_some()
            {
                return Err("world-authority-invalid");
            }
        }
        // Imported aliases must be explicit operator bindings, never a guessed public-name fallback.
        if let Some(aliases) = value.get("aliases") {
            for (alias, target) in aliases.as_object().ok_or("world-authority-invalid")? {
                if !super::souls::is_world(alias) {
                    return Err("world-authority-invalid");
                }
                let target = out
                    .get(target.as_str().ok_or("world-authority-invalid")?)
                    .cloned()
                    .ok_or("world-authority-invalid")?;
                if out.insert(alias.clone(), target).is_some() {
                    return Err("world-authority-invalid");
                }
            }
        }
        Ok(Some(out))
    }

    pub(super) fn authority(&self, world: Option<&str>) -> Result<Option<Authority>, &'static str> {
        match self.authorities()? {
            None => Ok(None),
            Some(rows) => rows
                .get(world.ok_or("world-required")?)
                .cloned()
                .map(Some)
                .ok_or("world-unplaced"),
        }
    }

    pub(super) fn request_world(
        db: &Connection,
        code: &str,
    ) -> Result<Option<String>, &'static str> {
        db.query_row(
            "SELECT world FROM pair_request_worlds_v1 WHERE code=?1",
            params![code],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "store")
    }

    pub(super) fn soul_for_request(
        &self,
        grant: &str,
        code: &str,
    ) -> Result<Option<(String, Option<String>)>, &'static str> {
        let Some((account, legacy_device)) = self.soul_of(grant)? else {
            return Ok(None);
        };
        let db = self.db.lock().expect("the store");
        let world = Self::request_world(&db, code)?;
        let device = match self.authority(world.as_deref())? {
            None => legacy_device,
            Some(authority) => db
                .query_row(
                    "SELECT device FROM paired_world_tokens_v1 WHERE grant_text=?1 AND world=?2",
                    params![grant, authority.world],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|_| "store")?,
        };
        Ok(Some((account, device)))
    }

    pub(super) fn check_world(&self, code: &str, grant: &str) -> Result<(), &'static str> {
        let db = self.db.lock().expect("the store");
        let world = Self::request_world(&db, code)?;
        let Some(authority) = self.authority(world.as_deref())? else {
            return Ok(());
        };
        if is_creator_grant(grant) && grant != authority.creator_grant() {
            return Err("not-the-creator");
        }
        if is_soul_grant(grant) {
            let previous: Option<String> = db
                .query_row(
                    "SELECT world FROM soul_profiles_v1 WHERE grant_text=?1",
                    params![grant],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|_| "store")?
                .flatten();
            if let Some(previous) = previous
                && self
                    .authority(Some(&previous))?
                    .is_none_or(|a| a.world != authority.world)
            {
                return Err("soul-in-another-world");
            }
        }
        Ok(())
    }

    pub(super) fn write_world_tokens(&self, db: &Connection) -> std::io::Result<bool> {
        self.write_handoff_tokens(db, None)
    }

    fn write_handoff_tokens(
        &self,
        db: &Connection,
        target: Option<&crate::worlds::list::handoff::Pending>,
    ) -> std::io::Result<bool> {
        let Some(rows) = self.authorities().map_err(std::io::Error::other)? else {
            return Ok(false);
        };
        Self::backfill_world_tokens(db, &rows).map_err(std::io::Error::other)?;
        for (key, mut authority) in rows {
            if key != authority.world {
                continue;
            }
            if let Some(target) = target
                && target.world == authority.world
            {
                if !authority.creator.is_empty() || authority.generation != target.generation {
                    return Err(std::io::Error::other("handoff-stale"));
                }
                authority.creator = crate::accounts::principal_text(target.creator);
            }
            let mut query = db.prepare("SELECT grant_text, token_hash FROM paired_world_tokens_v1 WHERE world=?1 ORDER BY 1").map_err(std::io::Error::other)?;
            let values = query
                .query_map(params![authority.world], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(std::io::Error::other)?;
            let mut text = format!(
                "# World-bound pairing authority\n# souls-creator/1 {} {}\n",
                authority.generation,
                if authority.creator.is_empty() {
                    "none"
                } else {
                    &authority.creator
                }
            );
            for value in values {
                let (grant, hash) = value.map_err(std::io::Error::other)?;
                if !is_creator_grant(&grant) || grant == authority.creator_grant() {
                    text.push_str(&format!("{grant} {hash}\n"));
                }
            }
            let temporary = authority.tokens.with_extension("tmp");
            std::fs::write(&temporary, text)?;
            std::fs::rename(temporary, authority.tokens)?;
        }
        Ok(true)
    }

    // A registry upgrade must preserve an already-delivered legacy token, never assign it to every world.
    // Validate the complete migration before changing SQL or any file; an existing scoped row wins.
    fn backfill_world_tokens(
        db: &Connection,
        rows: &BTreeMap<String, Authority>,
    ) -> Result<(), String> {
        let mut query = db
            .prepare(
                "SELECT s.grant_text,s.device,s.token_hash,p.world FROM paired_souls_v1 s
            LEFT JOIN soul_profiles_v1 p ON p.grant_text=s.grant_text
            WHERE s.token_hash IS NOT NULL AND COALESCE(p.retired_at,0)=0
            AND NOT EXISTS(SELECT 1 FROM paired_world_tokens_v1 w WHERE w.grant_text=s.grant_text)
            ORDER BY s.grant_text",
            )
            .map_err(|_| "store")?;
        let legacy = query
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|_| "store")?;
        let mut pending = Vec::new();
        for item in legacy {
            let (grant, device, hash, world) = item.map_err(|_| "store")?;
            let device = device.ok_or("world-authority-upgrade-unbound")?;
            let contains = |a: &Authority| -> Result<bool, String> {
                let text = std::fs::read_to_string(&a.tokens)
                    .map_err(|_| "world-authority-unavailable")?;
                Ok(text.lines().any(|line| {
                    let fields: Vec<_> = line.split_whitespace().collect();
                    fields.len() == 2 && fields[0] == grant && fields[1] == hash
                }))
            };
            let authority = if is_soul_grant(&grant) {
                let authority = world
                    .as_ref()
                    .and_then(|world| rows.get(world))
                    .ok_or("world-authority-upgrade-unbound")?;
                if !contains(authority)? {
                    return Err("world-authority-upgrade-mismatch".into());
                }
                authority
            } else if is_creator_grant(&grant) {
                let mut matches = Vec::new();
                for (key, authority) in rows {
                    if key == &authority.world
                        && grant == authority.creator_grant()
                        && contains(authority)?
                    {
                        matches.push(authority);
                    }
                }
                if matches.len() != 1 {
                    return Err("world-authority-upgrade-ambiguous".into());
                }
                matches[0]
            } else {
                return Err("world-authority-upgrade-unbound".into());
            };
            pending.push((grant, authority.world.clone(), device, hash));
        }
        db.execute_batch("SAVEPOINT world_authority_upgrade")
            .map_err(|_| "store")?;
        let changed = (|| {
            for (grant, world, device, hash) in pending {
                db.execute("INSERT INTO paired_world_tokens_v1(grant_text,world,device,token_hash) VALUES(?1,?2,?3,?4)",params![grant,world,device,hash]).map_err(|_| "store")?;
            }
            db.execute_batch("RELEASE world_authority_upgrade")
                .map_err(|_| "store")
        })();
        if changed.is_err() {
            let _ = db.execute_batch(
                "ROLLBACK TO world_authority_upgrade; RELEASE world_authority_upgrade",
            );
        }
        changed.map_err(str::to_owned)
    }
}

impl Pairing {
    /// Install the trusted existing Worlds reader before the listener accepts requests.
    pub fn current_owner_reader(&self, read: super::OwnerReader) -> Result<(), String> {
        self.owner_reader
            .set(read)
            .map_err(|_| "world-authority-already-configured".to_owned())
    }

    pub fn requires_world_authority(&self) -> bool {
        self.authority_file.is_some()
    }

    pub fn reconcile_current_authority(&self) -> Result<(), String> {
        let db = self.db.lock().map_err(|_| "store")?;
        self.write_tokens(&db)
            .and_then(|()| self.write_souls(&db))
            .map_err(|_| "world-authority-publication".to_owned())
    }

    /// Materialize only this already-fenced world's creator; ordinary Souls and other worlds are untouched.
    pub fn materialize_handoff(
        &self,
        pending: &crate::worlds::list::handoff::Pending,
    ) -> Result<(), String> {
        let authority = self
            .authority(Some(&pending.world))
            .map_err(str::to_owned)?
            .ok_or("world-authority-required")?;
        if !authority.creator.is_empty() || authority.generation != pending.generation {
            return Err("handoff-stale".into());
        }
        let mut db = self.db.lock().map_err(|_| "store")?;
        let tx = db.transaction().map_err(|_| "store")?;
        let grant = format!(
            "creator-{}",
            crate::accounts::principal_text(pending.creator).replace(':', "-")
        );
        let prior: Option<String> = tx
            .query_row(
                "SELECT account FROM paired_souls_v1 WHERE grant_text=?1",
                params![grant],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| "store")?;
        if prior.is_some_and(|a| a != pending.account) {
            return Err("handoff-account-mismatch".into());
        }
        let mut q = tx.prepare("SELECT grant_text FROM paired_world_tokens_v1 WHERE world=?1 AND grant_text LIKE 'creator-%'").map_err(|_| "store")?;
        let old = q
            .query_map(params![authority.world], |r| r.get::<_, String>(0))
            .map_err(|_| "store")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "store")?;
        drop(q);
        tx.execute(
            "DELETE FROM paired_world_tokens_v1 WHERE world=?1 AND grant_text LIKE 'creator-%'",
            params![authority.world],
        )
        .map_err(|_| "store")?;
        for grant in old {
            tx.execute("UPDATE paired_souls_v1 SET device=NULL,token_hash=NULL WHERE grant_text=?1 AND NOT EXISTS(SELECT 1 FROM paired_world_tokens_v1 WHERE grant_text=?1)",params![grant]).map_err(|_| "store")?;
        }
        let grant = format!(
            "creator-{}",
            crate::accounts::principal_text(pending.creator).replace(':', "-")
        );
        tx.execute(
            "INSERT OR IGNORE INTO paired_souls_v1(grant_text,account) VALUES(?1,?2)",
            params![grant, pending.account],
        )
        .map_err(|_| "store")?;
        // An approved old request cannot mint a replacement credential after the handoff.
        let mut q=tx.prepare("SELECT r.code,w.world FROM pair_requests_v1 r JOIN pair_request_worlds_v1 w ON w.code=r.code WHERE r.scope='creator' AND r.state IN ('pending','approved')").map_err(|_|"store")?;
        let requests = q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|_| "store")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "store")?;
        drop(q);
        for (code, world) in requests {
            if self
                .authority(Some(&world))
                .map_err(str::to_owned)?
                .is_some_and(|a| a.world == authority.world)
            {
                tx.execute("UPDATE pair_requests_v1 SET state='refused',refusal='not-the-creator' WHERE code=?1",params![code]).map_err(|_|"store")?;
            }
        }
        tx.commit().map_err(|_| "store")?;
        // The next marker is installed before final CAS. World admission still sees pending until that CAS.
        self.write_handoff_tokens(&db, Some(pending))
            .map_err(|_| "world-authority-publication".to_owned())?;
        Ok(())
    }
}

#[cfg(test)]
mod presence_tests {
    use super::read_presence;
    use std::io::Write;
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    fn stamp() -> u64 {
        let t = rustix::time::clock_gettime(rustix::time::ClockId::Monotonic);
        u64::try_from(t.tv_sec).unwrap() * 1_000_000 + u64::try_from(t.tv_nsec).unwrap() / 1_000
    }

    fn reply(
        parts: Vec<&'static [u8]>,
        hold: bool,
        preclosed: bool,
    ) -> (Result<bool, &'static str>, u64) {
        let (mut client, mut peer) = UnixStream::pair().unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let worker = std::thread::spawn(move || {
            for (index, part) in parts.into_iter().enumerate() {
                if index != 0 {
                    std::thread::sleep(Duration::from_millis(2));
                }
                peer.write_all(part).unwrap();
            }
            if hold {
                std::thread::sleep(Duration::from_millis(2_000));
            }
        });
        // Immediate close is joined before reading to deterministically cover the shutdown/buffered case.
        let worker = if preclosed {
            worker.join().unwrap();
            None
        } else {
            Some(worker)
        };
        let started = stamp();
        let result = read_presence(&mut client, || {
            let left = 1_000_000u64.saturating_sub(stamp().saturating_sub(started));
            if left == 0 {
                Err("presence-unavailable")
            } else {
                Ok(Duration::from_micros(left))
            }
        });
        let elapsed = stamp().saturating_sub(started);
        if let Some(worker) = worker {
            worker.join().unwrap();
        }
        (result, elapsed)
    }

    #[test]
    fn closed_peer_buffered_reply_and_strict_eof() {
        assert_eq!(reply(vec![b"disconnected\n"], false, true).0, Ok(false));
        assert_eq!(reply(vec![b"connected\n"], false, true).0, Ok(true));
        assert_eq!(
            reply(vec![b"unavailable\n"], false, true).0,
            Err("presence-unavailable")
        );
        assert_eq!(
            reply(vec![b"disconnected\nx"], false, true).0,
            Err("presence-invalid")
        );
        assert_eq!(
            reply(vec![b"disconnected"], false, true).0,
            Err("presence-invalid")
        );
        assert_eq!(
            reply(vec![b"01234567890123456"], false, true).0,
            Err("presence-invalid")
        );
    }

    #[test]
    fn fragmented_reply_is_accepted_only_at_eof() {
        assert_eq!(
            reply(vec![b"dis", b"connected\n"], false, false).0,
            Ok(false)
        );
    }

    #[test]
    fn peer_held_past_total_deadline_is_unavailable() {
        // Keep the peer open so fragments are consumed separately, and reject even a complete line without EOF.
        let (result, elapsed) = reply(vec![b"dis", b"connected\n"], true, false);
        assert_eq!(result, Err("presence-unavailable"));
        assert!(elapsed >= 1_000_000);
        assert!(elapsed < 1_500_000, "bounded reader outlives peer hold");
    }
}
