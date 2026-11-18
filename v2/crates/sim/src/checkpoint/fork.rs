//! Forks (Engine v2 K6, #2670): any checkpoint starts as a new, separate world, for rehearsals, film sets, test
//! fixtures and templates (G9). Contracts T3 (`v2/docs/ids.md` rules 1 and 5) and T8 (`v2/docs/audience.md` rule 10).
//!
//! 1. **A fork is a view of a checkpoint through one principal** ([`fork`]): the parent's newest good checkpoint,
//!    with every node and link of an audience the forker is not in dropped (`Tree::keep_seen`): everyone's, its own
//!    and the audience nodes it is a member of are kept, so one creator's fork never holds another's private state.
//!    Carried nodes keep their ids. Words are held by reference (T8), so the fork names the parent's text store and
//!    redaction list and copies no words: a removal reaches the fork.
//! 2. **A new lineage and minting scope** (T3 rules 1 and 5): the request's fresh 16 bytes, from the operating
//!    system and never from the world's random numbers, which a fork replays. They name the fork's lineage, its
//!    header and its [`Minter`], which starts at 0 and is handed back: nothing the fork makes shares an id with
//!    anything the parent makes. A new random seed comes with the request too.
//! 3. **Its own checkpoint, copied** (the issue's listed alternative): K5 writes one file per checkpoint (one sync,
//!    not one per node), so there are no node files to share by hash. The fork's first checkpoint is the view, in its
//!    own folder, taken before its log's first record: the parent's node records whose hashes still hold are reused
//!    as they are, and only the nodes the view changed are hashed again. The parent's files are only read.
//! 4. **The head of its own log**, one part: the fork's time mapping (T5), anchored at the request's real time and
//!    continuing the parent's line, so world time neither jumps nor stops (a world with no mapping starts at 0); then,
//!    for each body (a node with a `souls:body-of` link: a Soul is in one world, T3 rule 5), each thing it held or
//!    wore (a child in one of its slots) is set down where the body stood, and the body is removed. Setting down is
//!    T1's leave and arrive inside the zone, onto the parent of the first node up from the body that sits in no slot
//!    (the body, or the seat it sits in), at that node's position on the surface that supported it. Removing the
//!    body releases its slot, ends its links and drops its timers (T2 rule 3).
//!
//! Not here: templates and the web flow (G9, W3), travel (X9), merging forks, deleting worlds. Subtrees in flight
//! at the checkpoint stay in flight (their arrive belongs to the parent's lineage).

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, TransferRec,
    schema_hash,
};
use replica::encode::{Value, encode};
use replica::ids::{Id, Minter, Scope, Version};
use replica::pose::{Frame, Pose};
use replica::time::{Line, Mapping, Micros, TimeEffect, TimeRefusal};
use replica::tree::{Handle, Tree};
use replica::world_model::{Audience, plain};

use super::{Checkpoints, R, Root, refuse, restore};
use crate::log::{FileStore, Log};

/// The fork writer's first epoch (T11).
pub const EPOCH: u64 = 1;

/// A fork request: who forks, and the fresh inputs a fork needs (each a recorded input, never read here).
pub struct Request {
    /// The forker: a principal (a creator's or a Soul's id).
    pub through: Id,
    /// The fork's lineage and minting scope: 16 fresh bytes from the operating system (T3 rule 1).
    pub scope: Scope,
    /// The fork's random state, fresh.
    pub seed: Vec<u8>,
    /// The real time of the request, µs (T5 rule 10: real time enters only as a recorded input).
    pub real_us: Micros,
    /// The running build's hash, for the fork's header.
    pub build: Vec<u8>,
    /// The fork's checkpoint interval, bytes of log (K5).
    pub every: u64,
}

/// A fork, running: its tree after the head of its log, its header and minter, its log and checkpoints.
pub struct Forked {
    pub tree: Tree,
    pub header: Header,
    pub minter: Minter,
    pub log: Log<FileStore>,
    pub checkpoints: Checkpoints,
    /// The parent's checkpoint it was made from, and the version of the fork's own first.
    pub parent: Root,
    pub version: Version,
    /// The head of its log, as stored (its record 0).
    pub head: Vec<u8>,
    /// The bodies removed, and each thing set down with the node it now rests on.
    pub bodies: Vec<Id>,
    pub set_down: Vec<(Id, Id)>,
    /// Bytes written: its checkpoint, its header and its log.
    pub bytes: u64,
}

fn time(e: TimeRefusal) -> replica::effects::Refusal {
    replica::effects::Refusal {
        name: e.name(),
        detail: "the fork's time mapping (v2/docs/time.md)".into(),
    }
}

fn io(p: &Path, e: std::io::Error) -> replica::effects::Refusal {
    replica::effects::Refusal {
        name: "fork-io",
        detail: format!("{}: {e}", p.display()),
    }
}

/// The fork's header: the build, the schema, the fork's lineage, the zone and its epoch. Its head names no kind.
fn header(build: &[u8], lineage: Scope, zone: Id) -> R<Header> {
    let v = Value::Map(BTreeMap::from([
        (1, Value::Bytes(build.to_vec())),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(lineage.0.to_vec())),
        (4, zone.to_value()),
        (5, Value::Uint(EPOCH)),
        (6, Value::Array(Vec::new())),
        (7, Value::Array(Vec::new())),
    ]));
    Header::read(&encode(&v).or_else(|e| refuse("encoding", e.to_string()))?)
}

fn part(header: &Header, effects: &[Effect]) -> R<Part> {
    let v = Value::Map(BTreeMap::from([
        (1, Value::Bytes(header.hash().to_bytes())),
        (
            2,
            Value::Array(effects.iter().map(Effect::to_value).collect()),
        ),
    ]));
    Part::read(&encode(&v).or_else(|e| refuse("encoding", e.to_string()))?)
}

/// The head's effects, numbered from `seq`, all at world time `at`, by the world.
struct Head {
    seq: u64,
    at: Micros,
    effects: Vec<Effect>,
}

impl Head {
    fn push(&mut self, node: Id, audience: Audience, body: Body) {
        self.effects.push(Effect {
            envelope: Envelope {
                sequence: self.seq,
                at: self.at,
                cause: Cause::World,
                actor: Actor::World,
                audience,
                node,
            },
            body,
            events: None,
            rest: Rest::new(),
        });
        self.seq += 1;
    }
}

/// Forks the newest good checkpoint in `parent` into `dir` (new or empty) through `req.through` (rules 1 to 4).
pub fn fork(parent: &Path, dir: &Path, req: Request) -> R<Forked> {
    if fs::read_dir(dir).is_ok_and(|mut d| d.next().is_some()) {
        return refuse("fork-dir-not-empty", dir.display().to_string());
    }
    let Some(restored) = restore(parent)? else {
        return refuse("fork-no-checkpoint", parent.display().to_string());
    };
    let mut tree = restored.tree;
    // Rule 1: everyone's, the forker's own, and each audience node it is a member of (T8 rule 1).
    let mut seen = BTreeSet::from([Audience::Everyone, Audience::Of(req.through)]);
    for e in tree.links_at(req.through) {
        if plain(tree.ty(e).as_str()) == "souls:member" {
            seen.insert(Audience::Of(e.other));
        }
    }
    tree.keep_seen(&|a| seen.contains(&a));

    let zone = tree
        .node(tree.root())
        .map(|n| n.id())
        .unwrap_or_else(|| unreachable!("a root"));
    let header = header(&req.build, req.scope, zone)?;
    let version = Version {
        lineage: req.scope,
        zone,
        epoch: EPOCH,
        sequence: tree.next(),
    };
    fs::create_dir_all(dir).map_err(|e| io(dir, e))?;
    // The parent's records, in memory: unchanged nodes keep their hashes, so their records are reused untouched, and
    // the writer keeps only those the fork's audiences reach.
    let mut checkpoints = Checkpoints::open(&dir.join("ckpt"), req.every, restored.blobs)?;
    checkpoints.take(&mut tree, version, 0, &req.seed)?;

    // Rule 4: the time mapping, continuing the parent's line at the request's real time.
    let last = tree.time().iter().rev().find_map(|t| match t {
        TimeEffect::Mapping(m) => Some(*m),
        _ => None,
    });
    let mapping = match last {
        Some(m) => {
            let world = Line::new(m.real_us, m.world_us, m.rate())
                .y_at(req.real_us)
                .map_err(time)?;
            Mapping::new(
                world,
                req.real_us,
                m.rate().num().into(),
                m.rate().den().into(),
            )
        }
        None => Mapping::new(0, req.real_us, 1, 1),
    }
    .map_err(time)?;
    let mut head = Head {
        seq: tree.next(),
        at: mapping.world_us,
        effects: Vec::new(),
    };
    head.push(
        zone,
        Audience::Everyone,
        Body::Time(vec![TimeEffect::Mapping(mapping)]),
    );

    // Rule 4: each body, in id order; what it held or wore set down where it stood, then the body removed.
    let state = tree.to_state();
    let bodies: BTreeSet<Id> = state
        .links
        .values()
        .filter(|l| plain(l.ty.as_str()) == "souls:body-of")
        .flat_map(|l| l.ends)
        .filter(|e| tree.handle(*e).is_some())
        .collect();
    let mut minter = Minter::new(req.scope);
    let mut set_down = Vec::new();
    for &body in &bodies {
        let h = tree
            .handle(body)
            .unwrap_or_else(|| unreachable!("a node here"));
        let b = tree.node(h).unwrap_or_else(|| unreachable!("live"));
        let audience = b.audience();
        // Where it stood: the first node up from the body that sits in no slot (the body, or its seat).
        let mut stood: Handle = h;
        while let Some(n) = tree.node(stood).filter(|n| n.slot().is_some()) {
            match n.parent().and_then(|p| tree.handle(p)) {
                Some(p) => stood = p,
                None => break,
            }
        }
        let s = tree.node(stood).unwrap_or_else(|| unreachable!("live"));
        let (Some(onto), Some(place)) = (s.parent(), s.place()) else {
            return refuse("fork-body-nowhere", replica::world_model::show(body));
        };
        let held: Vec<(Id, Audience)> = tree
            .children(h)
            .unwrap_or_default()
            .iter()
            .filter_map(|c| tree.node(*c))
            .filter(|n| n.slot().is_some())
            .map(|n| (n.id(), n.audience()))
            .collect();
        for (thing, aud) in held {
            let transfer = minter
                .mint()
                .or_else(|e| refuse("id-counter-exhausted", e.to_string()))?;
            let pose = Pose {
                frame: Frame {
                    node: onto,
                    slot: None,
                },
                position: place.position,
                orientation: place.orientation,
                support: place.support,
            };
            head.push(
                thing,
                aud,
                Body::Transfer(TransferRec::Leave {
                    transfer,
                    node: thing,
                    lineage: req.scope,
                    zone,
                    pose,
                }),
            );
            head.push(
                onto,
                aud,
                Body::Transfer(TransferRec::Arrive {
                    transfer,
                    carried: Vec::new(),
                }),
            );
            set_down.push((thing, onto));
        }
        head.push(
            body,
            audience,
            Body::Changes(vec![ChangeRec {
                change: Change::Remove { node: body },
                rest: Rest::new(),
            }]),
        );
    }
    let head_part = part(&header, &head.effects)?;
    tree.apply(&header, &head_part)?;

    // The fork's header and log, on the disk before the fork runs.
    let hp = dir.join("header");
    let mut f = File::create(&hp).map_err(|e| io(&hp, e))?;
    f.write_all(header.stored()).map_err(|e| io(&hp, e))?;
    f.sync_data().map_err(|e| io(&hp, e))?;
    let lp = dir.join("log");
    let (mut log, _) = Log::open(FileStore::open(&lp)?, EPOCH)?;
    log.append(head_part.stored().to_vec())?;
    log.wait_durable(1)?;
    let written = checkpoints.wait()?;
    let log_bytes = fs::metadata(&lp).map_err(|e| io(&lp, e))?.len();
    Ok(Forked {
        tree,
        header,
        minter,
        log,
        checkpoints,
        parent: restored.root,
        version,
        head: head_part.stored().to_vec(),
        bodies: bodies.into_iter().collect(),
        set_down,
        bytes: written.bytes + header_len(&hp)? + log_bytes,
    })
}

fn header_len(p: &Path) -> R<u64> {
    Ok(fs::metadata(p).map_err(|e| io(p, e))?.len())
}
