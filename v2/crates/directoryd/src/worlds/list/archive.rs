//! One archive transaction on the same conditional row as current creator and handoff authority.
use super::*;

pub const FIELD: &str = "_archive";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Phase {
    pub world: String,
    pub lineage: [u8; 16],
    pub zone: Id,
    pub creator: Id,
    pub creator_generation: u64,
    pub generation: u64,
    pub request: String,
    pub action: String,
    pub state: String,
}

impl Phase {
    pub fn json(&self) -> Json {
        json!({"world":self.world,"lineage":to_hex(&self.lineage),"zone":principal_text(self.zone),
            "creator":principal_text(self.creator),"creator_generation":self.creator_generation,
            "generation":self.generation,"request":self.request,"action":self.action,"state":self.state})
    }
    pub fn instance(&self) -> String {
        format!(
            "{}-{}",
            to_hex(&self.lineage),
            principal_text(self.zone).replace(':', "-")
        )
    }
}

pub(super) fn active(row: &Json) -> R<()> {
    match row.get(FIELD) {
        None => Ok(()),
        Some(value) if value.get("state").and_then(Json::as_str) == Some("active") => Ok(()),
        Some(_) => refuse(
            "world-archived",
            "the world is archived or changing archive state",
        ),
    }
}

fn read<S: Store>(store: &S, row: &Json) -> R<Phase> {
    let owner = handoff::ownership(store, row)?;
    let creator = owner.creator.ok_or_else(|| Refusal {
        name: "archive-handoff-pending",
        detail: "finish the accepted handoff first".into(),
    })?;
    let mut phase = Phase {
        world: row["name"].as_str().unwrap_or_default().to_owned(),
        lineage: owner.lineage,
        zone: owner.zone,
        creator,
        creator_generation: owner.generation,
        generation: 0,
        request: String::new(),
        action: String::new(),
        state: "active".into(),
    };
    if let Some(value) = row.get(FIELD) {
        let text = |key| value.get(key).and_then(Json::as_str).unwrap_or_default();
        let number = |key| value.get(key).and_then(Json::as_u64);
        let state = text("state");
        let action = text("action");
        let request = text("request");
        if !["active", "archiving", "archived", "restoring"].contains(&state)
            || !["archive", "restore"].contains(&action)
            || request.len() != 64
            || from_hex(request).is_err()
            || number("generation").is_none_or(|n| n == 0)
            || number("creator_generation") != Some(owner.generation)
            || text("creator") != principal_text(creator)
        {
            return refuse(
                "archive-state-invalid",
                "archive row differs from current authority",
            );
        }
        phase.generation = number("generation").unwrap();
        phase.request = request.into();
        phase.action = action.into();
        phase.state = state.into();
    }
    Ok(phase)
}

pub fn get<S: Store>(store: &S, world: &str) -> R<Phase> {
    let (_, rows) = read_rows(store)?;
    let row = rows
        .iter()
        .find(|r| r.get("name").and_then(Json::as_str) == Some(world))
        .ok_or_else(|| Refusal {
            name: "world-missing",
            detail: "world not found".into(),
        })?;
    read(store, row)
}

pub fn pending_request<S: Store>(store: &S, request: &str) -> R<Option<Phase>> {
    let (_, rows) = read_rows(store)?;
    for row in rows {
        if row
            .get(FIELD)
            .and_then(|v| v.get("request"))
            .and_then(Json::as_str)
            == Some(request)
        {
            return read(store, &row).map(Some);
        }
    }
    Ok(None)
}

pub fn list<S: Store>(store: &S) -> R<Vec<Phase>> {
    let (_, rows) = read_rows(store)?;
    rows.iter()
        .filter(|r| r.get(FIELD).is_some())
        .map(|row| read(store, row))
        .filter(|p| p.as_ref().map_or(true, |p| p.state != "active"))
        .collect()
}

/// The supervisor uses this only for the matching instance, never another world's failure.
pub fn instance_blocked<S: Store>(store: &S, lineage: &[u8; 16], zone: Id) -> R<bool> {
    let (_, rows) = read_rows(store)?;
    for row in rows {
        if row.get("lineage").and_then(Json::as_str) == Some(to_hex(lineage).as_str())
            && row.get("zone").and_then(Json::as_str) == Some(principal_text(zone).as_str())
        {
            let phase = read(store, &row)?;
            return Ok(matches!(phase.state.as_str(), "archiving" | "archived"));
        }
    }
    Ok(false)
}

pub fn begin<S: Store>(
    store: &S,
    world: &str,
    who: Option<Id>,
    confirmation: &str,
    restore: bool,
) -> R<Phase> {
    let (etag, rows) = read_rows(store)?;
    let (_, phase) = write_rows(store, etag, rows, |rows| {
        let row = rows
            .iter_mut()
            .find(|r| r.get("name").and_then(Json::as_str) == Some(world))
            .ok_or_else(|| Refusal {
                name: "world-missing",
                detail: "world not found".into(),
            })?;
        let mut phase = read(store, row)?;
        if !restore {
            if row.get("ready") == Some(&Json::Bool(false)) {
                return refuse("archive-world-starting", "world creation must finish first");
            }
            if who != Some(phase.creator) {
                return refuse("not-the-creator", "only the current creator");
            }
            if confirmation != world {
                return refuse("archive-confirmation", "type the exact world name");
            }
            if row.get("_handoff_offer").is_some() {
                return refuse(
                    "archive-handoff-pending",
                    "cancel the offered handoff first",
                );
            }
            if matches!(phase.state.as_str(), "archiving" | "archived") {
                return Ok(phase);
            }
            if phase.state != "active" {
                return refuse("archive-pending", "restore is pending");
            }
        } else {
            if phase.action == "restore" && matches!(phase.state.as_str(), "restoring" | "active") {
                return Ok(phase);
            }
            if phase.state != "archived" {
                return refuse("archive-not-archived", "archive must finish first");
            }
        }
        phase.generation = phase.generation.checked_add(1).ok_or_else(|| Refusal {
            name: "archive-generation",
            detail: "archive generation exhausted".into(),
        })?;
        phase.action = if restore { "restore" } else { "archive" }.into();
        phase.state = if restore { "restoring" } else { "archiving" }.into();
        phase.request = to_hex(&sha256(
            format!(
                "{}:{}:{}:{}",
                world, phase.action, phase.generation, phase.creator_generation
            )
            .as_bytes(),
        ));
        row[FIELD] = phase.json();
        Ok(phase)
    })?;
    Ok(phase)
}

/// An operation's acknowledgement cannot commit over a changed owner, request or generation.
pub fn finish<S: Store>(store: &S, expected: &Phase) -> R<Phase> {
    let (etag, rows) = read_rows(store)?;
    let (_, phase) = write_rows(store, etag, rows, |rows| {
        let row = rows
            .iter_mut()
            .find(|r| r.get("name").and_then(Json::as_str) == Some(expected.world.as_str()))
            .ok_or_else(|| Refusal {
                name: "world-missing",
                detail: "world not found".into(),
            })?;
        let mut current = read(store, row)?;
        let target = if expected.action == "archive" {
            "archived"
        } else {
            "active"
        };
        if current.request != expected.request
            || current.generation != expected.generation
            || current.creator != expected.creator
            || current.creator_generation != expected.creator_generation
        {
            return refuse("archive-stale", "archive operation changed");
        }
        if current.state == target {
            return Ok(current);
        }
        if current != *expected {
            return refuse("archive-stale", "archive phase changed");
        }
        current.state = target.into();
        row[FIELD] = current.json();
        Ok(current)
    })?;
    Ok(phase)
}

/// After an uncertain final acknowledgement, physical containment may have completed. Keep the same restore
/// request pending rather than reporting an active row whose exact protected fence is still installed.
pub fn retry_restore<S: Store>(store: &S, world: &str, request: &str) -> R<Phase> {
    let (etag, rows) = read_rows(store)?;
    let (_, phase) = write_rows(store, etag, rows, |rows| {
        let row = rows
            .iter_mut()
            .find(|r| r.get("name").and_then(Json::as_str) == Some(world))
            .ok_or_else(|| Refusal {
                name: "world-missing",
                detail: "world not found".into(),
            })?;
        let mut phase = read(store, row)?;
        if phase.action != "restore"
            || phase.request != request
            || !["active", "restoring"].contains(&phase.state.as_str())
        {
            return refuse("archive-stale", "restore request changed");
        }
        phase.state = "restoring".into();
        row[FIELD] = phase.json();
        Ok(phase)
    })?;
    Ok(phase)
}

/// Root-owned local fence bytes are private materialization, not mutable ownership authority.
pub fn check_fence(bytes: &[u8], instance: &str) -> R<()> {
    let v: Json = serde_json::from_slice(bytes)
        .or_else(|_| refuse("archive-fence-invalid", "malformed local archive fence"))?;
    if v.get("format").and_then(Json::as_str) != Some("souls/archive-fence/1")
        || v.get("instance").and_then(Json::as_str) != Some(instance)
        || !v
            .get("request")
            .and_then(Json::as_str)
            .is_some_and(|r| r.len() == 64 && from_hex(r).is_ok())
    {
        return refuse(
            "archive-fence-invalid",
            "local archive fence identity differs",
        );
    }
    refuse("world-archived", "the local archive fence is installed")
}

/// Whether an archive of `world` would get past [`begin`]'s own refusals of its row (a world still being made, an
/// offered handoff, a pending acceptance, an archive or restore under way): only such an archive is held for the
/// Souls living there (#5006), so every other one is refused by its own name, as before.
pub(super) fn would_begin<S: Store>(store: &S, world: &str) -> bool {
    let Ok((_, rows)) = read_rows(store) else {
        return false;
    };
    let Some(row) = rows
        .iter()
        .find(|r| r.get("name").and_then(Json::as_str) == Some(world))
    else {
        return false;
    };
    row.get("ready") != Some(&Json::Bool(false))
        && row.get("_handoff_offer").is_none()
        && read(store, row).is_ok_and(|p| p.state == "active")
}

/// Whether this directory has an archive initializer to finish an archive (#5006).
pub(super) fn configured() -> bool {
    std::env::var_os("DIRECTORYD_PLACEMENT").is_some()
}

pub(super) fn enqueue(request: &str) -> R<()> {
    let root = std::env::var_os("DIRECTORYD_PLACEMENT")
        .map(PathBuf::from)
        .ok_or_else(|| Refusal {
            name: "archive-unavailable",
            detail: "archive initializer is not configured".into(),
        })?;
    let path = root.join("requests").join(request);
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => file
            .sync_all()
            .or_else(|_| refuse("archive-unavailable", "request sync")),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(_) => refuse("archive-unavailable", "archive initializer is unavailable"),
    }
}
