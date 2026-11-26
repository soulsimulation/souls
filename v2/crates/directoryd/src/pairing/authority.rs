//! Exact placed-world authority routing. The fixed root-owned registry is private, never a client-supplied path.
use super::{Pairing, is_creator_grant, is_soul_grant};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long a request waits for a world's owner record from the world store before it uses the owner last read
/// (after a restart, the one the world's tokens file was last written with). A store stall (5 to 60 s on production,
/// 24 Nov) never holds a request longer, and only one read per world is in flight at a time.
pub const OWNER_WITHIN: Duration = Duration::from_secs(2);

/// Each world's owner as last read, by instance (`creator`, `generation`), and the instances being read now.
#[derive(Default)]
pub(super) struct Owners {
    known: BTreeMap<String, (String, u64)>,
    reading: BTreeSet<String>,
}

impl Owners {
    /// Keeps `owner` as this world's last read unless the one kept is newer ([`newer`]): a late or stale answer
    /// never takes a world back from the owner a handoff gave it.
    fn remember(&mut self, instance: &str, owner: (String, u64)) {
        if self
            .known
            .get(instance)
            .is_none_or(|kept| !newer(kept, &owner))
        {
            self.known.insert(instance.to_owned(), owner);
        }
    }
}

/// Whether owner `a` (`creator`, `generation`) comes after `b`: a later generation, or at the same one a named
/// creator after none (a handoff is pending at its next generation with no creator, then names the recipient).
/// Generations only go up, so an older owner is never the current one.
fn newer(a: &(String, u64), b: &(String, u64)) -> bool {
    (a.1, !a.0.is_empty()) > (b.1, !b.0.is_empty())
}

/// The owner a world's tokens file was last written with (`# souls-creator/1 <gen> <creator>`), if it names one.
fn header(tokens: &Path) -> Option<(String, u64)> {
    let text = std::fs::read_to_string(tokens).ok()?;
    let line = text
        .lines()
        .take(4)
        .find_map(|l| l.strip_prefix("# souls-creator/1 "))?;
    let (generation, creator) = line.split_once(' ')?;
    let creator = match creator {
        "none" => String::new(),
        c if crate::accounts::principal_from_text(c).is_some() => c.to_owned(),
        _ => return None,
    };
    Some((creator, generation.parse().ok()?))
}

/// The waits before each further try of a removal's file write: a short-lived failure (a full disk freed, a
/// temporary file in the way) costs at most 150 ms under the pairing store's lock.
const REMOVAL_RETRIES: [Duration; 2] = [Duration::from_millis(25), Duration::from_millis(125)];

/// `write`, tried again after each of [`REMOVAL_RETRIES`] while it fails; its last error.
pub(super) fn retried(mut write: impl FnMut() -> std::io::Result<()>) -> std::io::Result<()> {
    let mut result = write();
    for wait in REMOVAL_RETRIES {
        if result.is_ok() {
            break;
        }
        std::thread::sleep(wait);
        result = write();
    }
    result
}

/// The world files owed: every world's (`full`, as at start-up) or these worlds'.
#[derive(Default)]
pub(super) struct Owed {
    full: bool,
    worlds: BTreeSet<String>,
}

pub(super) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS paired_world_tokens_v1(
    grant_text TEXT NOT NULL, world TEXT NOT NULL, device TEXT NOT NULL, token_hash TEXT NOT NULL,
    PRIMARY KEY(grant_text, world));";

#[derive(Clone)]
pub(super) struct Authority {
    pub world: String,
    pub tokens: PathBuf,
    pub creator: String,
    pub generation: u64,
    /// The registry's instance and founding creator, checked against the world's current owner record.
    instance: String,
    founder: String,
    /// The owner was read from the world store just now, not taken from the last read.
    pub fresh: bool,
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

/// The current creator and generation of the world a registry row names, if `current` is that world's owner record.
fn current_owner(
    authority: &Authority,
    current: &crate::worlds::list::handoff::Ownership,
) -> Result<(String, u64), &'static str> {
    let expected = format!(
        "{}-{}",
        replica::encode::to_hex(&current.lineage),
        crate::accounts::principal_text(current.zone).replace(':', "-")
    );
    if expected != authority.instance
        || crate::accounts::principal_text(current.founder) != authority.founder
    {
        return Err("world-authority-mismatch");
    }
    Ok((
        current
            .creator
            .map(crate::accounts::principal_text)
            .unwrap_or_default(),
        current.generation,
    ))
}

impl Pairing {
    /// The registry as the root-owned file names it, without asking the world store: enough to know a world is
    /// placed. Its creators are the founding ones until [`Pairing::verified`] reads the current owner.
    fn registry(&self) -> Result<Option<BTreeMap<String, Authority>>, &'static str> {
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
            let tokens = root.join("worlds").join(instance).join("tokens");
            regular(&tokens)?;
            let authority = Authority {
                world: world.clone(),
                tokens,
                creator: creator.to_owned(),
                generation: 0,
                instance: instance.to_owned(),
                founder: creator.to_owned(),
                fresh: false,
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

    /// One registry row checked against its world's current owner record, with that owner's creator and generation.
    /// Only this world's record is read, so a slow or failing read of another world never refuses this one. A read
    /// unanswered after [`OWNER_WITHIN`] (or one already in flight) gives way to the owner last read; a mismatch is
    /// never covered by it.
    fn verified(&self, mut authority: Authority) -> Result<Authority, &'static str> {
        let Some(read) = self.owner_reader.get() else {
            return Ok(authority);
        };
        let (creator, generation) = match self.read_owner(read, &authority) {
            Some(found) => {
                authority.fresh = true;
                found?
            }
            None => {
                let last = self.last_owner(&authority);
                eprintln!(
                    "directoryd: degraded: world-owner-unavailable {}: {}",
                    authority.world,
                    if last.is_some() {
                        "the store is slow; the owner last read stands"
                    } else {
                        "the store is slow and no owner was read before"
                    }
                );
                last.ok_or("world-authority-unavailable")?
            }
        };
        authority.creator = creator;
        authority.generation = generation;
        Ok(authority)
    }

    /// This world's owner from the store, if it answers within [`OWNER_WITHIN`]; a late answer still becomes the
    /// owner last read. `None`: the store did not answer in time, is out of reach, or is being read for this world
    /// already. Any other answer of the store (the world is missing, or its record differs from the registry's or is
    /// invalid) is a refusal the owner last read never covers, and that owner is forgotten.
    fn read_owner(
        &self,
        read: &super::OwnerReader,
        authority: &Authority,
    ) -> Option<Result<(String, u64), &'static str>> {
        if !self
            .owners
            .lock()
            .ok()?
            .reading
            .insert(authority.instance.clone())
        {
            return None;
        }
        let (send, answer) = std::sync::mpsc::channel();
        let (read, owners, row) = (read.clone(), self.owners.clone(), authority.clone());
        std::thread::spawn(move || {
            let found = read(&row.world)
                .map_err(|e| match e.as_str() {
                    // Only a store out of reach (a transport error or a timeout) may pass to the owner last read.
                    "store-unreachable" | "world-authority-unavailable" => {
                        "world-authority-unavailable"
                    }
                    _ => {
                        eprintln!("directoryd: world-owner {}: {e}", row.world);
                        match e.as_str() {
                            "world-missing" => "world-authority-missing",
                            "handoff-authority-mismatch" => "world-authority-mismatch",
                            _ => "world-authority-invalid",
                        }
                    }
                })
                .and_then(|current| current_owner(&row, &current));
            if let Ok(mut owners) = owners.lock() {
                owners.reading.remove(&row.instance);
                match &found {
                    Ok(owner) => owners.remember(&row.instance, owner.clone()),
                    Err("world-authority-unavailable") => {}
                    Err(_) => {
                        owners.known.remove(&row.instance);
                    }
                }
            }
            let _ = send.send(found);
        });
        match answer.recv_timeout(OWNER_WITHIN) {
            Ok(Err("world-authority-unavailable")) | Err(_) => None,
            Ok(found) => Some(found),
        }
    }

    /// The newer ([`newer`]) of the owner last read for this world and the one its tokens file was last written with
    /// (all there is after a restart): what the world's gateway holds already.
    fn last_owner(&self, authority: &Authority) -> Option<(String, u64)> {
        let known = self
            .owners
            .lock()
            .ok()
            .and_then(|o| o.known.get(&authority.instance).cloned());
        match (known, header(&authority.tokens)) {
            (Some(k), Some(f)) => Some(if newer(&f, &k) { f } else { k }),
            (k, f) => k.or(f),
        }
    }

    /// Every placed world, each checked against its current owner record (for the files written for all worlds).
    pub(super) fn authorities(&self) -> Result<Option<BTreeMap<String, Authority>>, &'static str> {
        let Some(rows) = self.registry()? else {
            return Ok(None);
        };
        let mut checked: BTreeMap<String, Authority> = BTreeMap::new();
        let mut out = BTreeMap::new();
        for (key, row) in rows {
            let authority = match checked.get(&row.world) {
                Some(a) => a.clone(),
                None => {
                    let a = self.verified(row)?;
                    checked.insert(a.world.clone(), a.clone());
                    a
                }
            };
            out.insert(key, authority);
        }
        Ok(Some(out))
    }

    /// The placed world `world` names (by name, instance or alias), checked against its own owner record only.
    pub(super) fn authority(&self, world: Option<&str>) -> Result<Option<Authority>, &'static str> {
        match self.registry()? {
            None => Ok(None),
            Some(mut rows) => {
                let row = rows
                    .remove(world.ok_or("world-required")?)
                    .ok_or("world-unplaced")?;
                self.verified(row).map(Some)
            }
        }
    }

    /// Whether `world` is placed, from the registry alone: a pairing request is kept without reading the world
    /// store, and its world's owner is checked when the request is approved.
    pub(super) fn placed(&self, world: &str) -> Result<(), &'static str> {
        match self.registry()? {
            None => Ok(()),
            Some(rows) if rows.contains_key(world) => Ok(()),
            Some(_) => Err("world-unplaced"),
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
        let Some(rows) = self.authorities().map_err(std::io::Error::other)? else {
            return Ok(false);
        };
        self.all_world_tokens(db, &rows)?;
        Ok(true)
    }

    /// Every world's tokens file, after the legacy upgrade.
    fn all_world_tokens(
        &self,
        db: &Connection,
        rows: &BTreeMap<String, Authority>,
    ) -> std::io::Result<()> {
        Self::backfill_world_tokens(db, rows).map_err(std::io::Error::other)?;
        for (key, authority) in rows {
            if key == &authority.world {
                self.world_tokens(db, authority)?;
            }
        }
        Ok(())
    }

    /// One world's tokens file, from the store: written whole, then renamed into place. Every writer holds the
    /// pairing store's lock, and under it the owner written is never older than the one the file names, so an owner
    /// read before a handoff never takes the world back ([`newer`]). Only an owner read just now may put a pending
    /// handoff's `none` over its named recipient (a handoff whose final step never came is undone); the world is then
    /// owed, so the recipient is named again from the next read once the handoff is finished.
    fn world_tokens(&self, db: &Connection, authority: &Authority) -> std::io::Result<()> {
        let ours = (authority.creator.clone(), authority.generation);
        let authority = &match header(&authority.tokens) {
            Some(file) if file.1 > ours.1 || (newer(&file, &ours) && !authority.fresh) => {
                Authority {
                    creator: file.0,
                    generation: file.1,
                    ..authority.clone()
                }
            }
            Some(file) if newer(&file, &ours) => {
                self.owe(Some(&authority.world));
                authority.clone()
            }
            _ => authority.clone(),
        };
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
        crate::durable::replace(&authority.tokens, &temporary, text.as_bytes())
    }

    /// Whether a token from before the registry is still to be bound to its world (then every world is written).
    fn needs_backfill(db: &Connection) -> std::io::Result<bool> {
        db.query_row(
            "SELECT EXISTS(SELECT 1 FROM paired_souls_v1 s LEFT JOIN soul_profiles_v1 p ON p.grant_text=s.grant_text
             WHERE s.token_hash IS NOT NULL AND COALESCE(p.retired_at,0)=0
             AND NOT EXISTS(SELECT 1 FROM paired_world_tokens_v1 w WHERE w.grant_text=s.grant_text))",
            [],
            |r| r.get(0),
        )
        .map_err(std::io::Error::other)
    }

    /// The two files of one world, its gateway's tokens and its Souls notices, from the store: what a pairing,
    /// revoke, retire or profile change of a Soul there needs, and nothing of another world.
    pub(super) fn publish_world(
        &self,
        db: &Connection,
        authority: &Authority,
    ) -> std::io::Result<()> {
        if Self::needs_backfill(db)? {
            if !self.write_world_tokens(db)? {
                return Ok(());
            }
        } else {
            self.world_tokens(db, authority)?;
        }
        let rows = self.registry().map_err(std::io::Error::other)?;
        Self::world_souls(db, &rows.unwrap_or_default(), authority)
    }

    /// The Souls of `grant`'s worlds: those its tokens are bound to and the one its profile names.
    pub(super) fn worlds_of(
        db: &Connection,
        grant: &str,
    ) -> Result<BTreeSet<String>, &'static str> {
        let mut q = db
            .prepare(
                "SELECT world FROM paired_world_tokens_v1 WHERE grant_text=?1
                 UNION SELECT world FROM soul_profiles_v1 WHERE grant_text=?1 AND world IS NOT NULL",
            )
            .map_err(|_| "store")?;
        let rows = q
            .query_map(params![grant], |r| r.get::<_, String>(0))
            .map_err(|_| "store")?;
        rows.collect::<Result<_, _>>().map_err(|_| "store")
    }

    /// After a change to the Souls of `worlds`, already kept in the store: under a registry, each world's files are
    /// written now when its owner can be had, and owed to the copier ([`Pairing::copy_owed`]) when not, so a slow
    /// world store never refuses the change nor loses it. Without a registry, `legacy` writes the gateway's one file.
    pub(super) fn publish(
        &self,
        db: &Connection,
        worlds: &BTreeSet<String>,
        legacy: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<(), &'static str> {
        if self.authority_file.is_none() {
            return legacy();
        }
        for world in worlds {
            let _ = self.publish_one(db, world);
        }
        Ok(())
    }

    /// One world's files, as [`Pairing::publish`] writes them: `Err` (with the reason) when they could not be
    /// written. Unless they were written from an owner read just now, the world is owed to the copier.
    fn publish_one(&self, db: &Connection, world: &str) -> Result<(), String> {
        let written = match self.authority(Some(world)) {
            Ok(Some(a)) => self
                .publish_world(db, &a)
                .map(|()| a.fresh)
                .map_err(|e| e.to_string()),
            Ok(None) | Err("world-unplaced") => Ok(true),
            Err(e) => Err(e.to_owned()),
        };
        match written {
            Ok(true) => Ok(()),
            Ok(false) => {
                self.owe(Some(world));
                Ok(())
            }
            Err(e) => {
                eprintln!("directoryd: degraded: world-files {world}: {e}; owed to the copier");
                self.owe(Some(world));
                Err(e)
            }
        }
    }

    /// After a revoke or a retire (`retire`) of Souls in `worlds`, already kept in the store: lines only leave the
    /// files, so each world's files are rewritten at once with the owner its tokens file already names, and no owner
    /// is read. A write that fails is tried again ([`REMOVAL_RETRIES`]); one that still fails is owed to the copier,
    /// which rewrites the world from the store. A revoke is then refused by name (`tokens-file`, `souls-file`), since
    /// the gateway must stop accepting its token before it answers; a retire stands, as the store already holds it,
    /// and its other worlds are still written. A world whose file names no owner yet, or with a token from before the
    /// registry still to bind, is written as [`Pairing::publish`] writes it.
    pub(super) fn publish_removal(
        &self,
        db: &Connection,
        worlds: &BTreeSet<String>,
        retire: bool,
        legacy: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<(), &'static str> {
        if self.authority_file.is_none() {
            return legacy();
        }
        let owe = |world: Option<&str>, refusal: &'static str| {
            let name = world.unwrap_or("every world");
            eprintln!("directoryd: degraded: world-files {name}: {refusal}; owed to the copier");
            self.owe(world);
            if retire { Ok(()) } else { Err(refusal) }
        };
        let Ok(rows) = self.registry() else {
            return owe(None, "tokens-file");
        };
        let rows = rows.unwrap_or_default();
        let backfill = Self::needs_backfill(db).map_err(|_| "store")?;
        for world in worlds {
            let Some(row) = rows.get(world) else {
                continue;
            };
            let Some((creator, generation)) = header(&row.tokens).filter(|_| !backfill) else {
                if self.publish_one(db, world).is_err() && !retire {
                    return Err("tokens-file");
                }
                continue;
            };
            let authority = Authority {
                creator,
                generation,
                ..row.clone()
            };
            if retried(|| self.world_tokens(db, &authority)).is_err() {
                owe(Some(world), "tokens-file")?;
                continue;
            }
            if retire && retried(|| Self::world_souls(db, &rows, &authority)).is_err() {
                owe(Some(world), "souls-file")?;
            }
        }
        Ok(())
    }

    /// Owes the copier every world's files, as a start whose world store did not answer does.
    pub fn owe_all(&self) {
        self.owe(None);
    }

    /// Owes the copier every world's files (`None`) or one world's.
    pub(super) fn owe(&self, world: Option<&str>) {
        let mut owed = self.owed.lock().unwrap_or_else(|e| e.into_inner());
        match world {
            None => owed.full = true,
            Some(w) => {
                owed.worlds.insert(w.to_owned());
            }
        }
    }

    /// One pass of the copier: writes the world files a slow store kept back, each from its owner read fresh; a file
    /// written from the owner last read is owed again until the store answers. True while some are still owed (the
    /// caller waits longer before each next pass, as R17's retries do).
    pub fn copy_owed(&self) -> bool {
        let owed = std::mem::take(&mut *self.owed.lock().unwrap_or_else(|e| e.into_inner()));
        if owed.full
            && let Err(e) = self.reconcile_current_authority()
        {
            eprintln!("directoryd: degraded: {e}: the world files already written stand; retrying");
            self.owe(None);
        }
        for world in &owed.worlds {
            let written = match self.authority(Some(world)) {
                Ok(Some(a)) => {
                    let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
                    self.publish_world(&db, &a).is_ok() && a.fresh
                }
                Ok(None) | Err("world-unplaced") => true,
                Err(_) => false,
            };
            if !written {
                self.owe(Some(world));
            }
        }
        let owed = self.owed.lock().unwrap_or_else(|e| e.into_inner());
        owed.full || !owed.worlds.is_empty()
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

    /// Whether a handoff of `world` can be published here: the registry names it by its own name (#5006), not an
    /// alias or instance, as the world's row is named. Read from the registry file alone, before an acceptance writes
    /// anything, so a directory that could never publish one refuses at once, by the registry's own reason.
    /// Every key the world-authority map names `world` by (its own name, its instance and its aliases), and the name
    /// itself; the name alone with no map. A Soul's profile names its world by whichever its request used (#5006).
    pub fn world_keys(&self, world: &str) -> Result<Vec<String>, &'static str> {
        let mut keys: Vec<String> = match self.registry()? {
            None => Vec::new(),
            Some(rows) => rows
                .into_iter()
                .filter(|(_, a)| a.world == world)
                .map(|(k, _)| k)
                .collect(),
        };
        if !keys.iter().any(|k| k == world) {
            keys.push(world.to_owned());
        }
        Ok(keys)
    }

    pub fn can_hand_on(&self, world: &str) -> Result<(), &'static str> {
        match self.registry()? {
            None => Err("world-authority-required"),
            Some(rows) if rows.get(world).is_some_and(|a| a.world == world) => Ok(()),
            Some(_) => Err("world-unplaced"),
        }
    }

    /// Every world's files, from each world's owner (read before the pairing store is locked, so a slow world store
    /// holds no request). A world whose owner came from the last read is owed to the copier until the store answers.
    /// Refused by name: `world-authority-unavailable` (no owner to be had), `world-authority-mismatch`, or
    /// `world-authority-publication` (a file or the store).
    pub fn reconcile_current_authority(&self) -> Result<(), String> {
        let rows = self.authorities().map_err(str::to_owned)?;
        let db = self.db.lock().map_err(|_| "store")?;
        let Some(rows) = rows else {
            return self
                .write_tokens(&db)
                .and_then(|()| self.write_souls(&db))
                .map_err(|_| "world-authority-publication".to_owned());
        };
        self.all_world_tokens(&db, &rows)
            .and_then(|()| Self::all_world_souls(&db, &rows))
            .map_err(|_| "world-authority-publication".to_owned())?;
        for (key, authority) in &rows {
            if key == &authority.world && !authority.fresh {
                self.owe(Some(key));
            }
        }
        Ok(())
    }

    /// Materialize only this already-fenced world's creator; ordinary Souls and other worlds are untouched. Only an
    /// owner read from the store just now may hand a world over.
    pub fn materialize_handoff(
        &self,
        pending: &crate::worlds::list::handoff::Pending,
    ) -> Result<(), String> {
        let authority = self
            .authority(Some(&pending.world))
            .map_err(str::to_owned)?
            .ok_or("world-authority-required")?;
        if !authority.fresh {
            return Err("world-authority-unavailable".into());
        }
        if !authority.creator.is_empty() || authority.generation != pending.generation {
            return Err("handoff-stale".into());
        }
        let rows = self
            .registry()
            .map_err(str::to_owned)?
            .ok_or("world-authority-required")?;
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
            if rows.get(&world).is_some_and(|a| a.world == authority.world) {
                tx.execute("UPDATE pair_requests_v1 SET state='refused',refusal='not-the-creator' WHERE code=?1",params![code]).map_err(|_|"store")?;
            }
        }
        tx.commit().map_err(|_| "store")?;
        // The next marker is installed before final CAS. World admission still sees pending until that CAS.
        let mut next = authority;
        next.creator = crate::accounts::principal_text(pending.creator);
        Self::needs_backfill(&db)
            .and_then(|legacy| {
                if legacy {
                    self.write_world_tokens(&db)?;
                }
                self.world_tokens(&db, &next)
            })
            .map_err(|_| "world-authority-publication".to_owned())?;
        // The recipient is the owner last read from now on: a store that stalls before the finished handoff is read
        // never writes the pending `none` back over it.
        if let Ok(mut owners) = self.owners.lock() {
            owners.remember(&next.instance, (next.creator.clone(), next.generation));
        }
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
