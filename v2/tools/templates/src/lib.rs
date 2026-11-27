//! Templates (Engine v2 G9, #2798): a built world published as a checkpoint that new worlds fork from.
//!
//! 1. **A template is a published checkpoint** ([`publish`]): K6's fork of a world's newest checkpoint through a
//!    publisher who is in no audience, so only what everyone sees is kept, every body is removed and what each held is
//!    set down where it stood. The fork's first checkpoint is taken before the head of its log, so it is taken again
//!    after it: the template's newest checkpoint holds no body. Its folder holds `ckpt/` (what a new world forks),
//!    `header`, `log` and `template`, `{1: name (UTF-8 bytes), 2: lineage, 3: zone, 4: state hash}`.
//! 2. **Ids are never re-minted.** Everything in the source keeps its id in the template, and in each world forked
//!    from it; only what is made afterwards carries the new lineage's scope (`v2/docs/TRUNK.md`, "Settled at
//!    reconciliation").
//! 3. **The scan** ([`scan`]) lists every Soul, body, link to a Soul, held seat, Soul's timer and private record in a
//!    world's state; a template, and a world just made from one, has none. Reservations (F3) do not exist yet.
//!
//! A template from a facts file ([`publish_facts`], `cargo run -p templates --release -- <facts> <out> --name <name>
//! --support <seeded folder>`): N1's import, built with the entries `worldd seed` kept, as `worldd` builds it.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use replica::effects::{Refusal, State};
use replica::encode::{Name, Value, encode};
use replica::hash::state_hash;
use replica::ids::{Id, Scope, Version};
use replica::tree::Tree;
use replica::world_model::{Audience, plain};
use sim::checkpoint::fork::{EPOCH, Request, fork_with_kinds};
use sim::checkpoint::{Blobs, Checkpoints};

pub mod facts;
pub use facts::{PublicSupport, publish_facts, support, support_entries, valid_name};

pub type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// A checkpoint interval for templates: one checkpoint per publish, whatever its size.
const EVERY: u64 = 1 << 30;

/// A published template.
#[derive(Clone, Debug)]
pub struct Template {
    pub name: String,
    pub lineage: Scope,
    pub zone: Id,
    pub hash: Vec<u8>,
    /// The bodies the publish removed.
    pub bodies: Vec<Id>,
    /// The bytes of its folder.
    pub bytes: u64,
}

/// Checkpoints `tree` (a built world, as N1's import leaves it) into `dir` under `lineage`: a world's newest
/// checkpoint, as a running world's would be.
pub fn checkpoint(tree: &mut Tree, lineage: Scope, dir: &Path) -> R<()> {
    let zone = tree
        .node(tree.root())
        .map(|n| n.id())
        .ok_or_else(|| Refusal {
            name: "template-no-root",
            detail: dir.display().to_string(),
        })?;
    let mut c = Checkpoints::open(dir, EVERY, Blobs::default())?;
    let v = Version {
        lineage,
        zone,
        epoch: 1,
        sequence: tree.next(),
    };
    c.take(tree, v, 0, b"")?;
    c.wait()?;
    Ok(())
}

/// Publishes the newest good checkpoint in `source` as the template `name` in `out` (new or empty), under the fresh
/// `scope` (rule 1). `real_us` is the real time of the publish; `seed` the template's random state.
pub fn publish(
    source: &Path,
    out: &Path,
    name: &str,
    scope: Scope,
    seed: Vec<u8>,
    real_us: i64,
    build: Vec<u8>,
) -> R<Template> {
    publish_with_kinds(source, out, name, scope, seed, real_us, build, &[])
}

/// Publishes the same filtered template with previously validated public boot pins, before its header is sealed.
#[allow(clippy::too_many_arguments)]
pub fn publish_with_kinds(
    source: &Path,
    out: &Path,
    name: &str,
    scope: Scope,
    seed: Vec<u8>,
    real_us: i64,
    build: Vec<u8>,
    boot_pins: &[Name],
) -> R<Template> {
    // In no audience: the highest counter of the template's own scope, which nothing it mints reaches.
    let Some(nobody) = Id::new(scope, (1 << 53) - 1) else {
        return refuse("template-publisher", "no id");
    };
    let mut f = fork_with_kinds(
        source,
        out,
        Request {
            through: nobody,
            scope,
            seed: seed.clone(),
            real_us,
            build,
            every: EVERY,
        },
        boot_pins,
    )?;
    let zone = f.version.zone;
    // Taken again after the head of the log, so the newest checkpoint holds no body.
    let sequence = f.tree.next();
    f.checkpoints.take(
        &mut f.tree,
        Version {
            lineage: scope,
            zone,
            epoch: EPOCH,
            sequence,
        },
        1,
        &seed,
    )?;
    f.checkpoints.wait()?;
    let hash = state_hash(&f.tree)?.to_bytes();
    let manifest = encode(&Value::Map(BTreeMap::from([
        (1, Value::Bytes(name.as_bytes().to_vec())),
        (2, Value::Bytes(scope.0.to_vec())),
        (3, zone.to_value()),
        (4, Value::Bytes(hash.clone())),
    ])))
    .or_else(|e| refuse("encoding", e.to_string()))?;
    let mp = out.join("template");
    fs::write(&mp, &manifest)
        .or_else(|e| refuse("template-io", format!("{}: {e}", mp.display())))?;
    let found = scan(&f.tree.to_state(), &BTreeSet::new());
    if !found.is_empty() {
        return refuse("template-not-clean", found.join("; "));
    }
    Ok(Template {
        name: name.to_owned(),
        lineage: scope,
        zone,
        hash,
        bodies: f.bodies.clone(),
        bytes: folder_bytes(out),
    })
}

fn folder_bytes(d: &Path) -> u64 {
    let mut n = 0;
    let mut stack = vec![d.to_path_buf()];
    while let Some(p) = stack.pop() {
        for e in fs::read_dir(&p).into_iter().flatten().flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                n += e.metadata().map_or(0, |m| m.len());
            }
        }
    }
    n
}

/// The bodies and Souls a world's state names: both ends of each `souls:body-of` link.
pub fn souls(state: &State) -> BTreeSet<Id> {
    state
        .links
        .values()
        .filter(|l| plain(l.ty.as_str()) == "souls:body-of")
        .flat_map(|l| l.ends)
        .collect()
}

/// Everything in `state` a template or a new world may not hold (rule 3): a node, link, timer or flight naming one of
/// `gone` (a source's bodies and Souls), a `souls:body-of` link, a body (a node of kind `souls:body`), a seat held by a
/// body, a timer of a node that is not there, and any node or link not everyone's.
pub fn scan(state: &State, gone: &BTreeSet<Id>) -> Vec<String> {
    let mut out = Vec::new();
    let name = |id: &Id| replica::world_model::show(*id);
    for (id, n) in &state.nodes {
        if gone.contains(id) {
            out.push(format!("node {} was a body or a Soul", name(id)));
        }
        if plain(n.kind.as_str()) == "souls:body" {
            out.push(format!("body {}", name(id)));
            if n.slot.is_some() {
                out.push(format!("a seat held by body {}", name(id)));
            }
        }
        if n.audience != Audience::Everyone {
            out.push(format!("private node {}", name(id)));
        }
    }
    for (id, l) in &state.links {
        if plain(l.ty.as_str()) == "souls:body-of" {
            out.push(format!("link to a Soul {}", name(id)));
        }
        if l.ends.iter().any(|e| gone.contains(e)) {
            out.push(format!("link {} names a body or a Soul", name(id)));
        }
        if l.audience != Audience::Everyone {
            out.push(format!("private link {}", name(id)));
        }
    }
    for (id, t) in &state.timers {
        if gone.contains(&t.node) || !state.nodes.contains_key(&t.node) {
            out.push(format!("timer {} of an absent node", name(id)));
        }
    }
    for (id, f) in &state.in_flight {
        if gone.contains(&f.root) {
            out.push(format!("flight {} carries a body", name(id)));
        }
    }
    out
}
