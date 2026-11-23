//! B18's checks (#3339). The rack kinds are B17's entries in `content/kinds/construction/`, read at run time; a
//! 12 ft and a 19 ft frame are the same entry with its height and hold crew changed, as today's catalog has them
//! (`mars/viewer/engine/world/catalog.ts`: hold crew 2 from 19 ft). `cargo test -p sim structure -- --nocapture`
//! prints the verdict table (A1), the refusals (A2) and the time per check (A3).

use std::collections::BTreeMap;
use std::path::Path;

use replica::activity::{ActivityKind, F_STATE, MEMBER};
use replica::apply::Replica;
use replica::bodies::{Class, Family};
use replica::edit::{Edit, Op, Ref, Spot, World as EditWorld, check as edit_check};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, fixture_bytes,
    schema_hash,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::kinds::Kinds;
use replica::kinds::entry::entry_to_kind;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, End, Kind, show};

use super::Structure;
use crate::activity::{Activities, Ask};
use crate::commit::{Checked, Checks, Outcome, Verdict, commit_guarded, write_guarded};
use crate::controller::Controller;
use crate::edit::plan;
use crate::ground::Piece;
use crate::mover::Surface;
use crate::moves::Moves;
use crate::timers::DueList;

const FAMILIES: &str = include_str!("../../../replica/fixtures/bodies/families.diag");
const PLACE: &str =
    "souls:place@12200000000000000000000000000000000000000000000000000000000000000001";
const WALKER: &str =
    "test:walker@12200000000000000000000000000000000000000000000000000000000000000002";
const HOLD: &str = "test:hold@12200000000000000000000000000000000000000000000000000000000000000003";
/// A field no rule reads: setting it on a part of a bay touches the bay, so the check runs on the bay as it stands.
const F_NOTE: u64 = 99;

fn n(s: &str) -> Name {
    Name::new(s).expect("a name")
}

/// The rack kinds, a frame of `height` mm with hold crew `crew`.
struct Rack {
    kinds: Kinds,
    structure: Structure,
    upright: String,
    beam: String,
    bay: String,
    slots: BTreeMap<String, u64>,
}

fn rack(height: i64, crew: u64) -> Rack {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds/construction");
    let mut files: Vec<(String, String)> = std::fs::read_dir(&dir)
        .expect("the construction kinds")
        .map(|e| e.expect("an entry").path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        // An activity's entry (its `roles`, 0.135 C4's carry) is not a rack kind.
        .filter(|p| {
            let json = std::fs::read_to_string(p).expect("read");
            replica::rules::json::parse(&json)
                .expect("json")
                .get("roles")
                .is_none()
        })
        .map(|p| {
            let mut json = std::fs::read_to_string(&p).expect("read");
            if p.ends_with("rack_upright.json") {
                json = json
                    .replace("[1219, 2438, 76]", &format!("[1219, {height}, 76]"))
                    .replacen("\"default\": 1,", &format!("\"default\": {crew},"), 1);
            }
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            (
                name,
                entry_to_kind(&without_roles(&json)).expect("an entry"),
            )
        })
        .collect();
    files.sort();
    let sources: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    let mut kinds = Kinds::default();
    kinds.load(&sources);
    assert!(kinds.refused().is_empty(), "{:?}", kinds.refused());
    let full = |plain: &str| {
        kinds
            .admits()
            .into_keys()
            .find(|k| k.starts_with(&format!("{plain}@")))
            .expect("loaded")
    };
    let (upright, beam, bay) = (
        full("mars:rack_upright"),
        full("mars:rack_beam"),
        full("mars:rack_bay"),
    );
    let slots = kinds
        .get(&bay)
        .unwrap()
        .slots
        .iter()
        .map(|(k, s)| (s.name.as_ref().unwrap().as_str().to_owned(), *k));
    let slots = slots.collect();
    let structure = Structure::new(&kinds, &sources);
    Rack {
        kinds,
        structure,
        upright,
        beam,
        bay,
        slots,
    }
}

fn header(zone: Id, rack: &Rack) -> Vec<u8> {
    let kinds = [PLACE, WALKER, HOLD, &rack.upright, &rack.beam, &rack.bay]
        .iter()
        .map(|k| Value::Text(n(k)))
        .collect();
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/b18-structure/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(zone.scope().0.to_vec())),
        (4, zone.to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(kinds)),
        (7, Value::Array(Vec::new())),
    ]));
    encode(&v).expect("bytes")
}

/// What T2 admits: the rack kinds as loaded, the place under a root, and a hold activity on a frame.
fn rules(rack: &Rack, souls: &[Id]) -> Rules {
    let mut kinds = rack.kinds.admits();
    let kind = |owner: &str, children: &[&str]| Kind {
        owner: owner.into(),
        children: children.iter().map(|c| (*c).to_owned()).collect(),
        slots: BTreeMap::new(),
        hands: None,
    };
    kinds.insert(PLACE.into(), kind("place", &["thing", "body"]));
    kinds.insert(WALKER.into(), kind("family", &[]));
    kinds.insert(HOLD.into(), kind("activity", &[]));
    kinds
        .get_mut(&rack.upright)
        .unwrap()
        .children
        .insert("test:hold".into());
    Rules {
        kinds,
        souls: souls.iter().copied().collect(),
        audiences: BTreeMap::new(),
    }
}

fn pose(parent: Id, slot: Option<u64>) -> Pose {
    Pose {
        frame: Frame { node: parent, slot },
        position: Vec3::ZERO,
        orientation: Quat::IDENTITY,
        support: match slot {
            Some(_) => Support::Slot,
            None => Support::Surface {
                surface: parent,
                height: 0,
            },
        },
    }
}

fn effect(sequence: u64, node: Id, actor: Actor, changes: Vec<Change>) -> Effect {
    Effect {
        envelope: Envelope {
            sequence,
            at: 0,
            cause: Cause::World,
            actor,
            audience: Audience::Everyone,
            node,
        },
        body: Body::Changes(
            changes
                .into_iter()
                .map(|change| ChangeRec {
                    change,
                    rest: Rest::new(),
                })
                .collect(),
        ),
        events: None,
        rest: Rest::new(),
    }
}

fn part(header: &Header, effects: &[Effect]) -> Part {
    let v = Value::Map(BTreeMap::from([
        (1, Value::Bytes(header.hash().to_bytes())),
        (
            2,
            Value::Array(effects.iter().map(Effect::to_value).collect()),
        ),
    ]));
    Part::read(&encode(&v).expect("bytes")).expect("a part")
}

/// A bay as built: holders on each frame (none, or a started hold of that many bodies), and the beams by slot, each
/// joined to frame a, frame b or both.
#[derive(Clone)]
struct Build {
    holders: [usize; 2],
    beams: Vec<(&'static str, [bool; 2])>,
}

/// The ids a built bay has.
struct Bay {
    root: Id,
    bay: Id,
    frames: [Id; 2],
    beams: Vec<Id>,
    /// Each beam's joints: (link, frame).
    joints: Vec<Vec<(Id, Id)>>,
    /// Each frame's hold: (activity, membership links).
    holds: [Option<(Id, Vec<Id>)>; 2],
}

/// A replica holding `build`, loaded as a world's log would load it (the viewer's apply: no check).
fn built(rack: &Rack, build: &Build) -> (Replica, Header, Bay, Minter) {
    let mut mint = Minter::new(Scope([0x18; 16]));
    let mut id = || mint.mint().expect("an id");
    let root = id();
    let bytes = header(root, rack);
    let h = Header::read(&bytes).expect("a header");
    let mut live = Replica::start(&bytes).expect("a replica");
    let (bay, frames) = (id(), [id(), id()]);
    let mut changes = vec![Change::Create {
        node: bay,
        kind: n(&rack.bay),
        pose: pose(root, None),
        audience: Audience::Everyone,
        fields: BTreeMap::new(),
    }];
    for (k, (f, slot)) in frames.iter().zip(["upright_a", "upright_b"]).enumerate() {
        if build.holders[k] == LYING {
            continue;
        }
        changes.push(Change::Create {
            node: *f,
            kind: n(&rack.upright),
            pose: pose(bay, Some(rack.slots[slot])),
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        });
    }
    let mut holds = [None, None];
    for (k, f) in frames.iter().enumerate() {
        if build.holders[k] == 0 || build.holders[k] == LYING {
            continue;
        }
        let act = id();
        changes.push(Change::Create {
            node: act,
            kind: n(HOLD),
            pose: pose(*f, None),
            audience: Audience::Everyone,
            fields: BTreeMap::from([(F_STATE, Value::Uint(2))]),
        });
        let mut links = Vec::new();
        for _ in 0..build.holders[k] {
            let (body, link) = (id(), id());
            changes.push(Change::Link {
                link,
                ty: n(MEMBER),
                ends: [body, act],
                owner: End::Second,
                audience: Audience::Everyone,
            });
            links.push(link);
        }
        holds[k] = Some((act, links));
    }
    let (mut beams, mut joints) = (Vec::new(), Vec::new());
    for (slot, to) in &build.beams {
        let b = id();
        changes.push(Change::Create {
            node: b,
            kind: n(&rack.beam),
            pose: pose(bay, Some(rack.slots[*slot])),
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        });
        let mut js = Vec::new();
        for (k, f) in frames.iter().enumerate() {
            if to[k] {
                let link = id();
                changes.push(Change::Link {
                    link,
                    ty: n("mars:joint"),
                    ends: [b, *f],
                    owner: End::First,
                    audience: Audience::Everyone,
                });
                js.push((link, *f));
            }
        }
        beams.push(b);
        joints.push(js);
    }
    live.apply(&part(&h, &[effect(0, root, Actor::World, changes)]))
        .expect("built");
    let b = Bay {
        root,
        bay,
        frames,
        beams,
        joints,
        holds,
    };
    (live, h, b, mint)
}

const BOTH: [bool; 2] = [true, true];
/// A frame not raised yet: lying in the yard, outside the bay.
const LYING: usize = usize::MAX;

/// The four beams of the bay at both heights, or the two low ones.
fn beams(high: bool) -> Vec<(&'static str, [bool; 2])> {
    let mut v = vec![("beam_low_l", BOTH), ("beam_low_r", BOTH)];
    if high {
        v.extend([("beam_high_l", BOTH), ("beam_high_r", BOTH)]);
    }
    v
}

/// A change to the bay, as the case writes it.
enum Do {
    /// Touch frame a: the bay as it stands.
    Stand,
    /// Every holder of frame `k` leaves (the hold ends).
    Release(usize),
    /// One holder of frame `k` leaves.
    LeaveOne(usize),
    /// Beam `i`'s joint to frame a is taken off.
    Unjoin(usize),
    /// Frame `k` is removed, with whatever is on it.
    RemoveFrame(usize),
    /// Every beam is removed, then the frames in `frames`.
    Strip(Vec<usize>),
    /// A beam is put in slot `beam_high_l`, joined to nothing.
    PlaceLoose,
}

fn effects(rack: &Rack, b: &Bay, live: &Replica, mint: &mut Minter, d: &Do) -> Vec<Effect> {
    let seq = live.version();
    let world = Actor::World;
    match d {
        Do::Stand => vec![effect(
            seq,
            b.frames[0],
            world,
            vec![Change::Set {
                node: b.frames[0],
                field: F_NOTE,
                to: Value::Uint(1),
                by: None,
            }],
        )],
        Do::Release(k) => {
            let (act, _) = b.holds[*k].clone().expect("held");
            vec![effect(seq, act, world, vec![Change::Remove { node: act }])]
        }
        Do::LeaveOne(k) => {
            let (act, links) = b.holds[*k].clone().expect("held");
            vec![effect(
                seq,
                act,
                world,
                vec![Change::Unlink { link: links[0] }],
            )]
        }
        Do::Unjoin(i) => vec![effect(
            seq,
            b.beams[*i],
            world,
            vec![Change::Unlink {
                link: b.joints[*i][0].0,
            }],
        )],
        Do::RemoveFrame(k) => vec![effect(
            seq,
            b.frames[*k],
            world,
            vec![Change::Remove { node: b.frames[*k] }],
        )],
        Do::Strip(frames) => {
            let mut out: Vec<Effect> = Vec::new();
            for x in b.beams.iter().chain(frames.iter().map(|k| &b.frames[*k])) {
                let s = seq + out.len() as u64;
                out.push(effect(s, *x, world, vec![Change::Remove { node: *x }]));
            }
            out
        }
        Do::PlaceLoose => {
            let beam = mint.mint().expect("an id");
            vec![effect(
                seq,
                b.bay,
                world,
                vec![Change::Create {
                    node: beam,
                    kind: n(&rack.beam),
                    pose: pose(b.bay, Some(rack.slots["beam_high_l"])),
                    audience: Audience::Everyone,
                    fields: BTreeMap::new(),
                }],
            )]
        }
    }
}

/// The new rule's verdict on a case: accepted, or the refusal's name and detail. A refusal changes nothing.
fn verdict(rack: &Rack, build: &Build, d: &Do) -> Result<(), (String, String)> {
    let (mut live, _, b, mut mint) = built(rack, build);
    let es = effects(rack, &b, &live, &mut mint, d);
    let before = (live.version(), live.tree().to_state());
    match write_guarded(&mut live, &es, &rack.structure) {
        Ok(_) => Ok(()),
        Err(r) => {
            assert_eq!(
                (live.version(), live.tree().to_state()),
                before,
                "a refusal changes nothing"
            );
            Err((r.name.to_owned(), r.detail))
        }
    }
}

/// A case of the table: its source, what it is, the frames, the bay as built, the change, and today's verdict (none:
/// accepted; else today's code).
type Case<'a> = (&'a str, &'a str, &'a Rack, Build, Do, Option<&'a str>);

#[test]
fn a1_the_new_rule_gives_todays_verdict_on_every_case_the_bay_can_express() {
    let ft8 = rack(2_438, 1);
    let ft12 = rack(3_658, 1);
    let ft19 = rack(5_791, 2);
    let held = |a, b, beams| Build {
        holders: [a, b],
        beams,
    };
    // (source, case, rack, build, change, today's verdict: None accepted, Some(today's code))
    let cases: Vec<Case> = vec![
        (
            "construction.test.ts: supported bay",
            "12 ft frame A raised and held by two (hold crew 1)",
            &ft12,
            held(2, LYING, vec![]),
            Do::Stand,
            None,
        ),
        (
            "construction.test.ts: supported bay",
            "premature release of A, not joined by beams",
            &ft12,
            held(2, LYING, vec![]),
            Do::Release(0),
            Some("support.release-premature"),
        ),
        (
            "construction.test.ts: supported bay",
            "release of A with beams at one height on both columns (12 ft needs 2)",
            &ft12,
            held(2, 2, beams(false)),
            Do::Release(0),
            Some("support.release-premature"),
        ),
        (
            "construction.test.ts: supported bay",
            "release of A with beams at two heights on both columns",
            &ft12,
            held(2, 2, beams(true)),
            Do::Release(0),
            None,
        ),
        (
            "construction.test.ts: supported bay",
            "then release of B",
            &ft12,
            held(0, 2, beams(true)),
            Do::Release(1),
            None,
        ),
        (
            "construction.test.ts: 19 ft bay",
            "19 ft frame held by three (hold crew 2)",
            &ft19,
            held(3, LYING, vec![]),
            Do::Stand,
            None,
        ),
        (
            "construction.test.ts: 19 ft bay",
            "premature release, not joined",
            &ft19,
            held(3, LYING, vec![]),
            Do::Release(0),
            Some("support.release-premature"),
        ),
        (
            "construction.test.ts: 19 ft bay",
            "premature release, beams at one height",
            &ft19,
            held(3, 3, beams(false)),
            Do::Release(0),
            Some("support.release-premature"),
        ),
        (
            "construction.test.ts: 19 ft bay",
            "release of A, beams at two heights",
            &ft19,
            held(3, 3, beams(true)),
            Do::Release(0),
            None,
        ),
        (
            "construction.test.ts: 19 ft bay",
            "then release of B",
            &ft19,
            held(0, 3, beams(true)),
            Do::Release(1),
            None,
        ),
        (
            "rules.ts isSupported",
            "19 ft frame held by one of the two it needs, unjoined",
            &ft19,
            held(2, LYING, vec![]),
            Do::LeaveOne(0),
            Some("isSupported false"),
        ),
        (
            "rules.ts requiredLevels",
            "8 ft frames, beams at one height on both columns: released",
            &ft8,
            held(1, 0, beams(false)),
            Do::Release(0),
            None,
        ),
        (
            "rules.ts groupStability",
            "8 ft frames, a beam on one column only: released",
            &ft8,
            held(1, 1, vec![("beam_low_l", BOTH)]),
            Do::Release(0),
            Some("needs beams on its right column"),
        ),
        (
            "invariants.ts uprightsSupported",
            "a standing frame neither held nor braced",
            &ft8,
            held(0, LYING, vec![]),
            Do::Stand,
            Some("support.upright-unsupported"),
        ),
        (
            "joints.test.ts A2a",
            "a beam disconnected at one end",
            &ft12,
            held(0, 0, beams(true)),
            Do::Unjoin(0),
            Some("support.none"),
        ),
        (
            "joints.test.ts A2a",
            "the frame under four beams removed",
            &ft12,
            held(0, 0, beams(true)),
            Do::RemoveFrame(0),
            Some("support.none"),
        ),
        (
            "joints.test.ts A2a",
            "a bearing part placed in the air, unjoined",
            &ft12,
            held(0, 0, beams(true)),
            Do::PlaceLoose,
            Some("support.none"),
        ),
        (
            "joints.test.ts A2b",
            "safe release order: the beams, then both frames",
            &ft12,
            held(0, 0, beams(true)),
            Do::Strip(vec![0, 1]),
            None,
        ),
        (
            "joints.test.ts A2b (rules.ts)",
            "the beams, then frame A; B left standing alone, unheld",
            &ft12,
            held(0, 0, beams(true)),
            Do::Strip(vec![0]),
            Some("support.upright-unsupported"),
        ),
    ];
    println!("| source | case | today | B18 | agree |");
    println!("|---|---|---|---|---|");
    let mut disagree = Vec::new();
    for (src, what, rack, build, d, today) in &cases {
        let got = verdict(rack, build, d);
        let agree = got.is_ok() == today.is_none();
        let new = match &got {
            Ok(()) => "accepted".to_owned(),
            Err((name, detail)) => format!("{name}: {detail}"),
        };
        println!(
            "| {src} | {what} | {} | {new} | {} |",
            today.map_or("accepted".to_owned(), |c| format!("refused ({c})")),
            if agree { "yes" } else { "NO" }
        );
        if !agree {
            disagree.push(*what);
        }
    }
    assert!(disagree.is_empty(), "{disagree:?}");
}

#[test]
fn a2a_a_souls_act_that_unjoins_a_beam_is_refused_naming_it_before_anything_moves() {
    let rack = rack(2_438, 1);
    let (mut live, _, b, _) = built(
        &rack,
        &Build {
            holders: [0, 0],
            beams: beams(false),
        },
    );
    let soul = Id::new(Scope([0x50; 16]), 1).expect("an id");
    let checks = Checks {
        act: 1,
        cause: Cause::Intent(Id::new(Scope([0x51; 16]), 1).expect("an id")),
        actor: Actor::Soul(soul),
        version: live.version(),
        rechecked: false,
        candidates: vec![Checked {
            verdict: Verdict::Yes,
            node: b.beams[0],
            changes: vec![Change::Unlink {
                link: b.joints[0][0].0,
            }],
            reads: vec![],
        }],
    };
    let before = (live.version(), live.tree().to_state());
    let out = commit_guarded(&mut live, &checks, 1_000, &rack.structure);
    println!("the act: {out:?}");
    assert!(matches!(&out, Outcome::Refused { reason } if reason == "support.none"));
    assert_eq!((live.version(), live.tree().to_state()), before);
    // The same write, read for its detail: the beam, and the one joint it would hang by.
    let es = effects(
        &rack,
        &b,
        &live,
        &mut Minter::new(Scope([1; 16])),
        &Do::Unjoin(0),
    );
    let r = write_guarded(&mut live, &es, &rack.structure).expect_err("refused");
    println!("{}: {}", r.name, r.detail);
    assert_eq!(r.name, "support.none");
    assert!(r.detail.starts_with(&show(b.beams[0])), "{}", r.detail);
    assert!(
        r.detail
            .contains(&format!("its joint to {}", show(b.frames[1]))),
        "{}",
        r.detail
    );
    assert_eq!((live.version(), live.tree().to_state()), before);
}

#[test]
fn a2b_a_creators_edit_that_removes_the_frame_under_four_beams_is_refused_naming_a_beam() {
    let rack = rack(2_438, 1);
    let (mut live, _, b, mut mint) = built(
        &rack,
        &Build {
            holders: [0, 0],
            beams: beams(true),
        },
    );
    let creator = Id::new(Scope([0xc0; 16]), 1).expect("an id");
    let world = EditWorld {
        creator,
        kinds: rules(&rack, &[]).kinds,
    };
    let planned = live.version();
    let edit = |ops| Edit {
        claim: None,
        intent: Id::new(Scope([0x11; 16]), 1).expect("an id"),
        actor: Actor::Creator(creator),
        planned,
        ops,
    };
    let before = (live.version(), live.tree().to_state());
    let checked = edit_check(
        edit(vec![Op::Remove {
            node: Ref::Node(b.frames[0]),
        }]),
        &live.frozen(),
        &world,
    )
    .expect("the edit's own checks pass");
    let planned = plan(checked, &live.frozen(), None).expect("planned");
    let r =
        crate::edit::commit_guarded(&mut live, &mut mint, &planned, &[], 1_000, &rack.structure)
            .expect_err("refused");
    println!("remove frame a: {} {}", r.name, r.detail);
    assert_eq!(r.name, "support.none");
    assert!(
        b.beams.iter().any(|x| r.detail.starts_with(&show(*x))),
        "{}",
        r.detail
    );
    assert_eq!((live.version(), live.tree().to_state()), before);

    // A beam placed in a slot of the bay, joined to nothing.
    let checked = edit_check(
        edit(vec![Op::Place {
            name: 1,
            kind: n(&rack.beam),
            parent: Ref::Node(b.bay),
            at: Spot {
                slot: Some(rack.slots["beam_high_l"]),
                position: Vec3::ZERO,
                orientation: Quat::IDENTITY,
                support: Support::Slot,
            },
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        }]),
        &live.frozen(),
        &world,
    )
    .expect("the edit's own checks pass");
    let planned = plan(checked, &live.frozen(), None).expect("planned");
    let r =
        crate::edit::commit_guarded(&mut live, &mut mint, &planned, &[], 2_000, &rack.structure)
            .expect_err("refused");
    println!("a loose beam: {} {}", r.name, r.detail);
    assert_eq!(r.name, "support.none");
    assert!(r.detail.contains("would hang by nothing"), "{}", r.detail);
    assert_eq!((live.version(), live.tree().to_state()), before);

    // Taken down in a safe order, the beams and then both frames: accepted.
    let ops = b
        .beams
        .iter()
        .chain(&b.frames)
        .map(|x| Op::Remove {
            node: Ref::Node(*x),
        })
        .collect();
    let checked = edit_check(edit(ops), &live.frozen(), &world).expect("checks");
    let planned = plan(checked, &live.frozen(), None).expect("planned");
    crate::edit::commit_guarded(&mut live, &mut mint, &planned, &[], 3_000, &rack.structure)
        .expect("a safe order is accepted");
    let _ = b.root;
}

fn family() -> Family {
    let Value::Array(fs) = decode(&fixture_bytes(FAMILIES).expect("bytes"))
        .expect("decodes")
        .value
    else {
        panic!("a list")
    };
    fs.iter()
        .map(|f| Family::from_value(f).expect("a family"))
        .find(|f| f.resources.iter().any(|r| r.class == Class::Manipulator))
        .expect("a family with hands")
}

/// A hold: two roles, each taking its body's hands.
fn hold() -> ActivityKind {
    let role = |r: &str| {
        Value::Map(BTreeMap::from([
            (1, Value::Text(n(r))),
            (2, Value::Text(n(&format!("{r}-place")))),
            (
                3,
                Value::Array(vec![Value::Map(BTreeMap::from([
                    (1, Value::Uint(1)),
                    (2, Value::Uint(2)),
                ]))]),
            ),
        ]))
    };
    ActivityKind::from_value(&Value::Map(BTreeMap::from([
        (1, Value::Text(n(HOLD))),
        (2, Value::Uint(1)),
        (
            3,
            Value::Array(vec![role("test:footer"), role("test:lifter")]),
        ),
        (4, Value::Uint(60_000_000)),
        (5, Value::Uint(400_000)),
    ])))
    .expect("the hold")
}

/// A frame of the bay held by two Souls through B5's activity, the hold started; then one of them leaves.
fn leave_one(crew: u64) -> Result<(), (String, String, Id)> {
    let rack = rack(5_791, crew);
    let mut mint = Minter::new(Scope([0x19; 16]));
    let mut id = || mint.mint().expect("an id");
    let root = id();
    let (bay, frame) = (id(), id());
    let bodies = [id(), id()];
    let souls = [id(), id()];
    let bytes = header(root, &rack);
    let h = Header::read(&bytes).expect("a header");
    let rules = rules(&rack, &souls);
    let mut tree = Tree::start(root, n(PLACE));
    let mut changes = vec![
        Change::Create {
            node: bay,
            kind: n(&rack.bay),
            pose: pose(root, None),
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        },
        Change::Create {
            node: frame,
            kind: n(&rack.upright),
            pose: pose(bay, Some(rack.slots["upright_a"])),
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        },
    ];
    for (i, b) in bodies.iter().enumerate() {
        let mut p = pose(root, None);
        p.position = Vec3::new(i as i64 * 1_000_000, 0, 0);
        changes.push(Change::Create {
            node: *b,
            kind: n(WALKER),
            pose: p,
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        });
    }
    tree.commit(
        &h,
        &part(&h, &[effect(0, root, Actor::World, changes)]),
        &rules,
    )
    .expect("the frame and the bodies");
    let corners = vec![
        [-50_000, 0, -50_000],
        [50_000, 0, -50_000],
        [50_000, 0, 50_000],
        [-50_000, 0, 50_000],
    ];
    let ground = Surface::new(
        root,
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
            ground: crate::gaits::Ground::Dry,
        }],
    );
    let mut c = Controller::new();
    for (i, b) in bodies.iter().enumerate() {
        let at = Vec3::new(i as i64 * 1_000_000, 0, 0);
        let f = Frame {
            node: root,
            slot: None,
        };
        c.add(
            family(),
            ground.place(*b, f, at, Quat::IDENTITY).expect("placed"),
        )
        .expect("added");
    }
    let next = tree.to_state().next;
    let mut acts = Activities::new(h, rules, next, vec![hold()]);
    let mut intents = Minter::new(Scope([0x20; 16]));
    let mut ask = |k: usize, at| Ask {
        soul: souls[k],
        intent: intents.mint().expect("an id"),
        at,
    };
    // The world as loaded: the hold proposed, joined and started on the frame, then the rule in force.
    let act = acts
        .propose(&mut tree, &mut mint, ask(0, 1_000), &n(HOLD), frame)
        .expect("proposed");
    for (k, role) in ["test:footer", "test:lifter"].iter().enumerate() {
        acts.join(
            &mut tree,
            &mut mint,
            ask(k, 2_000),
            bodies[k],
            act,
            &n(role),
            1,
        )
        .expect("joined");
    }
    acts.start(&mut tree, &mut c, ask(0, 3_000), act)
        .expect("started");
    acts.structure = rack.structure;
    let (mut moves, mut due) = (Moves::new(), DueList::new());
    let before = tree.to_state();
    let r = acts.leave(
        &mut tree,
        &mut c,
        &mut moves,
        &mut due,
        &mut mint,
        ask(1, 4_000),
        bodies[1],
        act,
    );
    match r {
        Ok(_) => Ok(()),
        Err(r) => {
            assert_eq!(tree.to_state(), before, "a refusal changes nothing");
            assert_eq!(acts.members(act).map(<[_]>::len), Some(2), "still both");
            Err((r.name.to_owned(), r.detail, frame))
        }
    }
}

#[test]
fn a2c_a_holder_leaving_a_frame_that_needs_them_is_refused_by_b5s_leave() {
    let (name, detail, frame) = leave_one(2).expect_err("refused");
    println!("crew 2, one of two leaves: {name}: {detail}");
    assert_eq!(name, "support.holders");
    assert!(detail.starts_with(&show(frame)), "{detail}");
    assert!(detail.contains("held by 1 of the 2"), "{detail}");
    // With a hold crew of one, the other holder is enough: the leave is accepted.
    leave_one(1).expect("one holder is enough");
}

/// One check on a full bay (two frames held, four beams joined), `runs` times: the rack, the live copy, the bay and
/// each check's real time in ns, sorted. Printed with p50, p99 and max; asserted only by the speed bar below.
#[allow(clippy::disallowed_methods)] // measures the check's real time (A3); the rule itself reads no clock
fn full_bay_checks(runs: usize) -> (Rack, Replica, Header, Bay, Vec<u64>) {
    let rack = rack(3_658, 1);
    let (live, h, b, _) = built(
        &rack,
        &Build {
            holders: [2, 2],
            beams: beams(true),
        },
    );
    let touch = [effect(
        live.version(),
        b.beams[0],
        Actor::World,
        vec![Change::Set {
            node: b.beams[0],
            field: F_NOTE,
            to: Value::Uint(1),
            by: None,
        }],
    )];
    let mut ns = Vec::with_capacity(runs);
    for _ in 0..runs {
        let t = std::time::Instant::now();
        rack.structure.check(live.tree(), &touch).expect("stands");
        ns.push(t.elapsed().as_nanos() as u64);
    }
    ns.sort_unstable();
    println!(
        "one check on a full bay, {runs} runs: p50 {} ns, p99 {} ns, max {} ns",
        pct(&ns, 50),
        pct(&ns, 99),
        ns[runs - 1]
    );
    (rack, live, h, b, ns)
}

fn pct(ns: &[u64], q: usize) -> u64 {
    ns[(ns.len() * q / 100).min(ns.len() - 1)]
}

/// A3's work: each check on a bay is counted once, and a stream of changes that touch no bay runs none. The check's
/// time is printed, not asserted: the bar is `speed_bar_a3_one_check_under_a_millisecond_at_p99`'s.
#[test]
fn a3_each_check_counts_once_and_none_runs_when_no_bay_changes() {
    let runs = 10_000;
    let (rack, live, h, b, _) = full_bay_checks(runs);
    assert_eq!(rack.structure.checks(), runs as u64);

    // Changes beside the bay: a thing placed on the ground and set again and again. None runs a check.
    let mut live = live;
    let thing = Id::new(Scope([0x77; 16]), 1).expect("an id");
    let place = effect(
        live.version(),
        b.root,
        Actor::World,
        vec![Change::Create {
            node: thing,
            kind: n(WALKER),
            pose: pose(b.root, None),
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        }],
    );
    write_guarded(&mut live, &[place], &rack.structure).expect("placed");
    for k in 0..1_000u64 {
        let set = effect(
            live.version(),
            thing,
            Actor::World,
            vec![Change::Set {
                node: thing,
                field: F_NOTE,
                to: Value::Uint(k),
                by: None,
            }],
        );
        write_guarded(&mut live, &[set], &rack.structure).expect("set");
    }
    println!(
        "1,001 commits beside the bay: {} checks run",
        rack.structure.checks() - runs as u64
    );
    assert_eq!(rack.structure.checks(), runs as u64);
    let _ = h;
}

/// A3's speed bar: one check on a full bay under 1 ms at p99. Wall time, so not in `cargo test`: a loaded runner's
/// debug build misses it with no fault in the rule. Run it in release on a quiet machine:
/// `cargo test -p sim --release --lib structure -- --ignored speed_bar --nocapture`.
#[test]
#[ignore = "speed bar (wall time): cargo test -p sim --release --lib structure -- --ignored speed_bar"]
fn speed_bar_a3_one_check_under_a_millisecond_at_p99() {
    let (.., ns) = full_bay_checks(10_000);
    assert!(pct(&ns, 99) < 1_000_000, "p99 {} ns", pct(&ns, 99));
}

/// An entry without its `roles`: they make the crew's activity kind (`worldd::serve::activity_kinds`), not the kind's
/// meaning, so K3's reader is given the rest (0.135 A2).
fn without_roles(json: &str) -> String {
    let mut e = replica::rules::json::parse(json).expect("an entry");
    if let replica::rules::json::Value::Obj(o) = &mut e {
        o.retain(|(k, _)| k != "roles");
    }
    e.to_json()
}
