//! B19's checks (#3340), on the test world's yard and build site (B17's sizes and places, `v2/tools/testworld`): the
//! rack kinds are B17's entries in `content/kinds/construction/`, read at run time, the 8 ft frames standing on the
//! yard's stand and the 9 ft beams lying beside it, an empty bay 25 m east. Six Souls in three crews of two (B5)
//! seat two frames and two beams and take them out again, and each refusal is returned before anyone moves.
//! `cargo test -p sim seating -- --nocapture` prints each step. With `SEATING_TRACE=<prefix>` the run is also written
//! as bird's-eye traces (V14's `v2/tools/birdseye/view.html`), one a phase (`<prefix>-frames-in.trace`, `-beams-in`,
//! `-beams-out`, `-frames-out`), so each clip is under the proof policy's 90 s: each tick the four parts and the six
//! carriers.
//!
//! The carriers' walk is scripted here (B9's walk is proven on Eden): each tick their positions are handed to B9's
//! `Carry::step`, which writes the crew node's sample.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

use replica::activity::ActivityKind;
use replica::bodies::{Class, Family};
use replica::effects::{
    Actor, Body as EffectBody, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest,
    TransferRec, fixture_bytes, schema_hash,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::kinds::Kinds;
use replica::kinds::entry::entry_to_kind;
use replica::pose::{Frame, Pose, Quat, Support, Track, Vec3};
use replica::time::Micros;
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, Kind, plain};

use super::{Seating, Target};
use crate::activity::carry::{Carry, HEIGHT, yaw_toward};
use crate::activity::{Activities, Ask};
use crate::controller::Controller;
use crate::ground::Piece;
use crate::ground::scene::{F_SLOTS, F_SOLIDS};
use crate::mover::Surface;
use crate::moves::Moves;
use crate::structure::Structure;
use crate::timers::DueList;

const FAMILIES: &str = include_str!("../../../../replica/fixtures/bodies/families.diag");
/// The open ground: N3's ground kind, so a town (N5) can be read from the yard and the site (N19).
const PLACE: &str =
    "eden:ground@12200000000000000000000000000000000000000000000000000000000000000001";
/// A named place on the open ground (N1's area), for N19's walks (`n19_tests.rs`).
const AREA: &str =
    "eden:place@12200000000000000000000000000000000000000000000000000000000000000a19";
const WALKER: &str =
    "test:walker@12200000000000000000000000000000000000000000000000000000000000000002";
/// The crew's activity kind, the one B17's frame entry admits as its child (`content/kinds/construction`).
const CREW_KIND: &str =
    "mars:rack_crew@12200000000000000000000000000000000000000000000000000000000000000b19";
const ROLES: [&str; 2] = ["mars:crew-front", "mars:crew-back"];
/// The test world's yard and site (`v2/tools/testworld`, B17), µm on the ground.
const YARD: Vec3 = Vec3 {
    x: 40_000_000,
    y: 0,
    z: -24_000_000,
};
const SITE: Vec3 = Vec3 {
    x: 65_000_000,
    y: 0,
    z: -24_000_000,
};
/// Beams lie from 2 m east of the stand, 300 mm apart (B17's `BEAM_PITCH`).
const BEAM_X: i64 = 2_000_000;
const BEAM_PITCH: i64 = 300_000;
/// A carrier's centre off the part's centre: past a frame's column (572 mm), past a beam's end (1,372 mm).
const FRAME_HANDS: i64 = 922_000;
const BEAM_HANDS: i64 = 1_722_000;
/// The carry's tick and pace, and the set-in track's start, 1.5 m short of the slot along x.
const TICK: Micros = 500_000;
const STEP: i64 = 700_000;
const SET_IN: i64 = 1_500_000;
const SET_IN_FOR: Micros = 3_000_000;
/// A humanoid's standing reach (`docs/bodies.md`'s reach of a reaching move), µm.
const REACH: i64 = 2_000_000;

fn n(s: &str) -> Name {
    Name::new(s).expect("a name")
}

fn v(x: i64, y: i64, z: i64) -> Vec3 {
    Vec3::new(x, y, z)
}

fn add(a: Vec3, b: Vec3) -> Vec3 {
    v(a.x + b.x, a.y + b.y, a.z + b.z)
}

/// The rack kinds as B17's entries give them, and their texts.
fn kinds() -> (Kinds, Vec<(String, String)>) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds/construction");
    let mut files: Vec<(String, String)> = std::fs::read_dir(&dir)
        .expect("the construction kinds")
        .map(|e| e.expect("an entry").path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| {
            let json = std::fs::read_to_string(&p).expect("read");
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            (name, entry_to_kind(&json).expect("an entry"))
        })
        .collect();
    files.sort();
    let mut kinds = Kinds::default();
    let sources: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    kinds.load(&sources);
    assert!(kinds.refused().is_empty(), "{:?}", kinds.refused());
    (kinds, files)
}

fn structure(kinds: &Kinds, files: &[(String, String)]) -> Structure {
    let sources: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    Structure::new(kinds, &sources)
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

/// The crew: a front and a back carrier, each taking its body's hands.
fn crew_kind() -> ActivityKind {
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
        (1, Value::Text(n(CREW_KIND))),
        (2, Value::Uint(1)),
        (3, Value::Array(ROLES.iter().map(|r| role(r)).collect())),
        (4, Value::Uint(600_000_000)),
        (5, Value::Uint(400_000)),
    ])))
    .expect("the crew")
}

fn effect(sequence: u64, node: Id, changes: Vec<Change>) -> Effect {
    Effect {
        envelope: Envelope {
            sequence,
            at: 0,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node,
        },
        body: EffectBody::Changes(
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

fn pose(parent: Id, slot: Option<u64>, at: Vec3) -> Pose {
    Pose {
        frame: Frame { node: parent, slot },
        position: at,
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

/// The yard and the site as the world holds them, the six Souls' bodies, the crews and the writer.
struct W {
    tree: Tree,
    header: Header,
    mint: Minter,
    intents: Minter,
    acts: Activities,
    c: Controller,
    seating: Seating,
    ground: Id,
    stand: Id,
    bay: Id,
    frames: [Id; 2],
    beams: [Id; 2],
    bodies: [Id; 6],
    souls: [Id; 6],
    joint: Name,
    /// The bay's slots by name: number and place in the bay (µm), and the stand's.
    bay_slots: BTreeMap<String, (u64, Vec3)>,
    stand_slots: BTreeMap<String, (u64, Vec3)>,
    t: Micros,
    /// For the trace: each tick, every part's and carrier's place on the ground's plan.
    frames_out: Vec<Vec<Vec3>>,
    /// Where each phase of the run starts in the trace, for one clip a phase.
    phases: Vec<(&'static str, usize)>,
    carriers: BTreeMap<Id, Vec3>,
}

fn slots(kinds: &Kinds, kind: &str) -> BTreeMap<String, (u64, Vec3)> {
    kinds
        .get(kind)
        .expect("loaded")
        .slots
        .iter()
        .map(|(k, s)| {
            let [x, y, z] = s.at_mm.unwrap_or([0, 0, 0]);
            (
                s.name.as_ref().expect("named").as_str().to_owned(),
                (*k, v(x * 1000, y * 1000, z * 1000)),
            )
        })
        .collect()
}

/// A part's box (N1's `solids` row: centre x, z, half x, z, yaw, y0, y1, mm), from B17's bounds (section 7): a frame
/// 1,219 mm wide, 2,438 tall and 76 deep; a beam 51 wide, 102 tall and 2,743 long.
const FRAME_BOX: [i64; 7] = [0, 0, 609, 38, 0, 0, 2_438];
const BEAM_BOX: [i64; 7] = [0, 0, 25, 1_371, 0, 0, 102];

fn int(x: i64) -> Value {
    if x < 0 {
        Value::Nint((-1 - x) as u64)
    } else {
        Value::Uint(x as u64)
    }
}

/// A part's boxes as the tree holds them (`F_SOLIDS`): seated, they are fixed geometry to walkers (N19).
fn solids(b: [i64; 7]) -> BTreeMap<u64, Value> {
    let mut row: Vec<Value> = b.iter().map(|&x| int(x)).collect();
    row.extend([int(5), int(0)]);
    BTreeMap::from([(F_SOLIDS, Value::Array(vec![Value::Array(row)]))])
}

/// A fixture's slot points as the tree holds them (`F_SLOTS`, `[n, x, y, z]` mm), as the import writes them (#3285).
fn slot_points(slots: &BTreeMap<String, (u64, Vec3)>) -> BTreeMap<u64, Value> {
    let rows = slots
        .values()
        .map(|(k, at)| {
            Value::Array(vec![
                Value::Uint(*k),
                int(at.x / 1000),
                int(at.y / 1000),
                int(at.z / 1000),
            ])
        })
        .collect();
    BTreeMap::from([(F_SLOTS, Value::Array(rows))])
}

fn world() -> W {
    let (kinds, files) = kinds();
    let full = |p: &str| {
        kinds
            .admits()
            .into_keys()
            .find(|k| k.starts_with(&format!("{p}@")))
            .expect("loaded")
    };
    let (upright, beam, bay_k, stand_k) = (
        full("mars:rack_upright"),
        full("mars:rack_beam"),
        full("mars:rack_bay"),
        full("mars:frame_stand"),
    );
    let bay_slots = slots(&kinds, &bay_k);
    let stand_slots = slots(&kinds, &stand_k);
    let mut mint = Minter::new(Scope([0x19; 16]));
    let mut id = || mint.mint().expect("an id");
    let ground = id();
    let (stand, bay) = (id(), id());
    let frames = [id(), id()];
    let beams = [id(), id()];
    let bodies = [id(), id(), id(), id(), id(), id()];
    let souls = [id(), id(), id(), id(), id(), id()];
    let names = [
        PLACE, WALKER, CREW_KIND, AREA, &upright, &beam, &bay_k, &stand_k,
    ];
    let hv = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/b19-seating/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(ground.scope().0.to_vec())),
        (4, ground.to_value()),
        (5, Value::Uint(0)),
        (
            6,
            Value::Array(names.iter().map(|k| Value::Text(n(k))).collect()),
        ),
        (7, Value::Array(Vec::new())),
    ]));
    let header = Header::read(&encode(&hv).expect("bytes")).expect("a header");
    // What T2 admits: the rack kinds as loaded (the frame admits its crew, B17's entry), the ground, the bodies and
    // the crew, whose slot takes a part.
    let mut admits = kinds.admits();
    let kind = |owner: &str, children: &[&str], slots: BTreeMap<u64, _>| Kind {
        owner: owner.into(),
        children: children.iter().map(|c| plain(c).to_owned()).collect(),
        slots,
        hands: None,
    };
    admits.insert(
        PLACE.into(),
        kind("place", &["thing", "body", CREW_KIND], BTreeMap::new()),
    );
    admits.insert(WALKER.into(), kind("family", &[], BTreeMap::new()));
    admits.insert(
        CREW_KIND.into(),
        kind(
            "activity",
            &[],
            BTreeMap::from([(super::SLOT, ["thing".to_owned()].into())]),
        ),
    );
    let rules = Rules {
        kinds: admits,
        souls: souls.iter().copied().collect(),
        audiences: BTreeMap::new(),
    };
    let mut tree = Tree::start(ground, n(PLACE));
    let mut cs = vec![
        Change::Create {
            node: stand,
            kind: n(&stand_k),
            pose: pose(ground, None, YARD),
            audience: Audience::Everyone,
            fields: slot_points(&stand_slots),
        },
        Change::Create {
            node: bay,
            kind: n(&bay_k),
            pose: pose(ground, None, SITE),
            audience: Audience::Everyone,
            fields: slot_points(&bay_slots),
        },
    ];
    for (k, f) in frames.iter().enumerate() {
        cs.push(Change::Create {
            node: *f,
            kind: n(&upright),
            pose: pose(
                stand,
                Some(stand_slots[&format!("frame_{}", k + 1)].0),
                Vec3::ZERO,
            ),
            audience: Audience::Everyone,
            fields: solids(FRAME_BOX),
        });
    }
    for (k, b) in beams.iter().enumerate() {
        cs.push(Change::Create {
            node: *b,
            kind: n(&beam),
            pose: pose(ground, None, beam_at(k)),
            audience: Audience::Everyone,
            fields: solids(BEAM_BOX),
        });
    }
    let corners = vec![
        [-100_000, 0, -100_000],
        [100_000, 0, -100_000],
        [100_000, 0, 100_000],
        [-100_000, 0, 100_000],
    ];
    let surface = Surface::new(
        ground,
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
        }],
    );
    let mut c = Controller::new();
    let mut carriers = BTreeMap::new();
    for (k, b) in bodies.iter().enumerate() {
        let at = add(YARD, v(-3_000_000 - k as i64 * 1_000_000, 0, 3_000_000));
        carriers.insert(*b, at);
        cs.push(Change::Create {
            node: *b,
            kind: n(WALKER),
            pose: pose(ground, None, at),
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        });
        let f = Frame {
            node: ground,
            slot: None,
        };
        c.add(
            family(),
            surface.place(*b, f, at, Quat::IDENTITY).expect("placed"),
        )
        .expect("added");
    }
    tree.commit(&header, &part(&header, &[effect(0, ground, cs)]), &rules)
        .expect("the yard and the site");
    let mut acts = Activities::new(
        header.clone(),
        rules.clone(),
        tree.next(),
        vec![crew_kind()],
    );
    acts.structure = structure(&kinds, &files);
    let seating = Seating::new(
        header.clone(),
        rules,
        structure(&kinds, &files),
        ground,
        Audience::Everyone,
    );
    let joint = n(&format!(
        "{}:joint",
        plain(&beam).split(':').next().expect("a namespace")
    ));
    assert!(seating.structure.joint(joint.as_str()));
    W {
        tree,
        header,
        mint,
        intents: Minter::new(Scope([0x20; 16])),
        acts,
        c,
        seating,
        ground,
        stand,
        bay,
        frames,
        beams,
        bodies,
        souls,
        joint,
        bay_slots,
        stand_slots,
        t: 1_000_000,
        frames_out: Vec::new(),
        phases: Vec::new(),
        carriers,
    }
}

/// Where beam `k` lies in the yard, µm on the ground.
fn beam_at(k: usize) -> Vec3 {
    add(YARD, v(BEAM_X + k as i64 * BEAM_PITCH, 0, 0))
}

type Res<T> = Result<T, (String, String)>;

fn named<T>(r: Result<T, replica::effects::Refusal>) -> Res<T> {
    r.map_err(|e| (e.name.to_owned(), e.detail))
}

impl W {
    fn phase(&mut self, name: &'static str) {
        self.phases.push((name, self.frames_out.len()));
    }

    fn ask(&mut self, k: usize) -> Ask {
        self.t += 1_000;
        Ask {
            soul: self.souls[k],
            intent: self.intents.mint().expect("an id"),
            at: self.t,
        }
    }

    fn sync(&mut self) {
        self.acts.next = self.tree.next();
    }

    /// A crew of Souls `ks` on `place`: proposed, joined and started (B5).
    fn crew(&mut self, place: Id, ks: &[usize]) -> Id {
        self.sync();
        let a = self.ask(ks[0]);
        let act = self
            .acts
            .propose(&mut self.tree, &mut self.mint, a, &n(CREW_KIND), place)
            .expect("proposed");
        for (i, k) in ks.iter().enumerate() {
            self.sync();
            let a = self.ask(*k);
            self.acts
                .join(
                    &mut self.tree,
                    &mut self.mint,
                    a,
                    self.bodies[*k],
                    act,
                    &n(ROLES[i]),
                    1,
                )
                .expect("joined");
        }
        if ks.len() == 2 {
            self.sync();
            let a = self.ask(ks[0]);
            self.acts
                .start(&mut self.tree, &mut self.c, a, act)
                .expect("started");
        }
        act
    }

    /// Soul `k` leaves `act` (B5's leave, guarded by B18).
    fn leave(&mut self, act: Id, k: usize) -> Res<()> {
        self.sync();
        let a = self.ask(k);
        let (moves, mut due) = (Moves::new(), DueList::new());
        let before = self.tree.to_state();
        let r = self.acts.leave(
            &mut self.tree,
            &mut self.c,
            &moves,
            &mut due,
            &mut self.mint,
            a,
            self.bodies[k],
            act,
        );
        if r.is_err() {
            assert_eq!(self.tree.to_state(), before, "a refusal changes nothing");
        }
        named(r.map(|_| ()))
    }

    fn parent(&self, id: Id) -> (Option<Id>, Option<u64>) {
        let n = self
            .tree
            .node(self.tree.handle(id).expect("live"))
            .expect("a node");
        (n.parent(), n.slot())
    }

    /// Where part `p` is on the ground's plan, µm: in a slot, its parent's place and the slot's.
    fn place_of(&self, p: Id) -> Vec3 {
        let g = self.tree.handle(self.ground).expect("the ground");
        let (parent, slot) = self.parent(p);
        // The parent's frame, then the slot's point: a crew's carry slot has none in the tree (N19).
        let ph = self.tree.handle(parent.expect("a parent")).expect("live");
        let x = crate::ground::scene::xform_to(&self.tree, ph, g).expect("a frame");
        let own = self
            .tree
            .node(self.tree.handle(p).expect("live"))
            .and_then(|n| n.place())
            .map_or(Vec3::ZERO, |q| q.position);
        let off = match (parent, slot) {
            (Some(b), Some(s)) if b == self.bay => {
                self.bay_slots
                    .values()
                    .find(|(k, _)| *k == s)
                    .expect("a slot")
                    .1
            }
            (Some(b), Some(s)) if b == self.stand => {
                self.stand_slots
                    .values()
                    .find(|(k, _)| *k == s)
                    .expect("a slot")
                    .1
            }
            _ => Vec3::ZERO,
        };
        x.point(add(off, own)).expect("a point")
    }

    /// One row of the trace: each part where it is (or `over`, a part on its set-in track), then each carrier.
    fn snapshot(&mut self, over: Option<(Id, Vec3)>) {
        let mut row = Vec::new();
        for p in self.frames.iter().chain(self.beams.iter()) {
            row.push(match over {
                Some((q, at)) if q == *p => at,
                _ => self.place_of(*p),
            });
        }
        row.extend(self.bodies.iter().map(|b| self.carriers[b]));
        self.frames_out.push(row);
    }

    /// The carriers `ks` walk to `to` (front, back) at the carry's pace, for the trace: the gathering walk is not
    /// this task's, and their bodies are not moved in the tree.
    fn gather(&mut self, ks: [usize; 2], to: [Vec3; 2]) {
        loop {
            let mut done = true;
            for (i, k) in ks.iter().enumerate() {
                let b = self.bodies[*k];
                let c = self.carriers[&b];
                let (dx, dz) = (to[i].x - c.x, to[i].z - c.z);
                let d = ((i128::from(dx).pow(2) + i128::from(dz).pow(2)).isqrt() as i64).max(1);
                let next = if d <= STEP {
                    to[i]
                } else {
                    done = false;
                    v(c.x + dx * STEP / d, 0, c.z + dz * STEP / d)
                };
                self.carriers.insert(b, next);
            }
            self.t += TICK;
            self.snapshot(None);
            if done {
                return;
            }
        }
    }

    /// Crew `act` (Souls `ks`) moves `part` from where it is to `target`: taken with the crew's node at `from` (the
    /// part's centre on the ground) turned `turn`, the part `inside` the slot; carried (B9's samples) to `SET_IN`
    /// short of `target.at` along x; set in on a straight track; put. `across`: the front carrier's offset.
    #[allow(clippy::too_many_arguments)]
    fn move_part(
        &mut self,
        act: Id,
        ks: [usize; 2],
        part: Id,
        from: Vec3,
        across: Vec3,
        inside: Quat,
        target: &Target,
    ) -> Res<usize> {
        let turn = yaw_toward([across.x, across.z]).expect("a turn");
        let lift = v(from.x, HEIGHT, from.z);
        let grips = [
            add(v(from.x, 0, from.z), across),
            add(v(from.x, 0, from.z), v(-across.x, 0, -across.z)),
        ];
        self.gather(ks, grips);
        self.t += TICK;
        let taken = self.seating.parts.len();
        named(self.seating.take(
            &mut self.tree,
            &self.acts,
            &mut self.mint,
            self.t,
            act,
            part,
            (lift, turn),
            inside,
        ))?;
        let end = v(
            target.at.x - SET_IN * (target.at.x - from.x).signum(),
            0,
            target.at.z,
        );
        let mut carry = Carry::new(
            act,
            part,
            self.ground,
            Audience::Everyone,
            self.header.clone(),
            self.seating.rules.clone(),
        );
        let mut c = v(from.x, 0, from.z);
        loop {
            let (dx, dz) = (end.x - c.x, end.z - c.z);
            let d = ((i128::from(dx).pow(2) + i128::from(dz).pow(2)).isqrt() as i64).max(1);
            if d <= STEP {
                c = end;
            } else {
                c = v(c.x + dx * STEP / d, 0, c.z + dz * STEP / d);
            }
            self.t += TICK;
            let (f, b) = (add(c, across), add(c, v(-across.x, 0, -across.z)));
            named(carry.step(&mut self.tree, self.t, f, b))?;
            self.carriers.insert(self.bodies[ks[0]], f);
            self.carriers.insert(self.bodies[ks[1]], b);
            self.snapshot(None);
            if c == end {
                break;
            }
        }
        let t0 = self.t;
        named(self.seating.set_in(
            &mut self.tree,
            &self.acts,
            act,
            t0,
            v(end.x, HEIGHT, end.z),
            turn,
            target.at,
            t0 + SET_IN_FOR,
        ))?;
        // The trace: the part on the track, each tick, as T4's formula gives it.
        let start = v(end.x, HEIGHT, end.z);
        let dt = i128::from(SET_IN_FOR);
        let velocity = |a: i64, b: i64| (i128::from(b - a) * 1_000_000 / dt) as i64;
        let track = Track::Straight {
            t0,
            velocity: v(
                velocity(start.x, target.at.x),
                velocity(start.y, target.at.y),
                velocity(start.z, target.at.z),
            ),
        };
        while self.t < t0 + SET_IN_FOR {
            self.t += TICK;
            let (at, _) = track.at(start, self.t).expect("on the track");
            self.snapshot(Some((part, at)));
        }
        self.t = t0 + SET_IN_FOR;
        named(self.seating.put(
            &mut self.tree,
            &self.acts,
            &mut self.mint,
            self.t,
            act,
            part,
            target,
        ))?;
        self.snapshot(None);
        Ok(taken)
    }

    fn in_bay(&self, slot: &str, joins: Vec<Id>, hold: bool) -> Target {
        let (k, at) = self.bay_slots[slot];
        Target {
            to: Frame {
                node: self.bay,
                slot: Some(k),
            },
            place: Vec3::ZERO,
            turn: Quat::IDENTITY,
            at: add(SITE, at),
            joins: joins.into_iter().map(|f| (self.joint.clone(), f)).collect(),
            hold,
        }
    }

    fn onto_stand(&self, slot: &str) -> Target {
        let (k, at) = self.stand_slots[slot];
        Target {
            to: Frame {
                node: self.stand,
                slot: Some(k),
            },
            place: Vec3::ZERO,
            turn: Quat::IDENTITY,
            at: add(YARD, at),
            joins: Vec::new(),
            hold: false,
        }
    }

    fn onto_ground(&self, at: Vec3) -> Target {
        Target {
            to: Frame {
                node: self.ground,
                slot: None,
            },
            place: at,
            turn: Quat::IDENTITY,
            at,
            joins: Vec::new(),
            hold: false,
        }
    }

    /// A beam's turn in the crew's slot: carried level with a carrier at each end, its length along the crew's +x.
    fn beam_inside() -> Quat {
        let turn = yaw_toward([0, 1]).expect("a turn");
        let m = [0, 90_000, 180_000, 270_000]
            .into_iter()
            .find(|m| Quat::from_yaw_mdeg(*m).expect("a yaw") == turn)
            .expect("a quarter turn");
        Quat::from_yaw_mdeg((360_000 - m) % 360_000).expect("a yaw")
    }
}

/// The nodes the commit at `i` moves (its transfers' leaves, in order) and the links it unlinks.
fn commit_at(w: &W, i: usize) -> (Vec<Id>, usize) {
    let mut moved = Vec::new();
    let mut unlinks = 0;
    for e in &w.seating.parts[i] {
        match &e.body {
            EffectBody::Transfer(TransferRec::Leave { node, .. }) => moved.push(*node),
            EffectBody::Changes(cs) => {
                unlinks += cs
                    .iter()
                    .filter(|c| matches!(c.change, Change::Unlink { .. }))
                    .count();
            }
            _ => {}
        }
    }
    (moved, unlinks)
}

/// The parts the last committed part moves and the joints it makes.
fn last_commit(w: &W) -> (Vec<Id>, usize) {
    let last = w.seating.parts.last().expect("a commit");
    let mut moved = Vec::new();
    let mut joints = 0;
    for e in last {
        match &e.body {
            EffectBody::Transfer(TransferRec::Leave { node, .. }) => moved.push(*node),
            EffectBody::Changes(cs) => {
                joints += cs
                    .iter()
                    .filter(|c| matches!(&c.change, Change::Link { ty, .. } if *ty == w.joint))
                    .count();
            }
            _ => {}
        }
    }
    (moved, joints)
}

#[test]
fn a1_to_a4_two_frames_and_two_beams_seated_held_released_and_taken_back_to_the_yard() {
    let mut w = world();
    let (fa, fb) = (w.frames[0], w.frames[1]);
    let (b1, b2) = (w.beams[0], w.beams[1]);
    let frame_across = v(FRAME_HANDS, 0, 0);
    let beam_across = v(0, 0, BEAM_HANDS);
    let ground = w.ground;

    w.phase("frames-in");
    // A1: two Souls take frame A off the stand, carry it 25 m, seat it in the bay and hold it; two more frame B.
    for (k, (f, slot, ks)) in [(fa, "upright_a", [0, 1]), (fb, "upright_b", [2, 3])]
        .into_iter()
        .enumerate()
    {
        let act = w.crew(ground, &ks);
        let from = w.place_of(f);
        let target = w.in_bay(slot, vec![], true);
        let mut m = w.mint.clone();
        named(
            w.seating
                .check(&w.tree, &w.acts, &mut m, act, f, &target, REACH),
        )
        .expect("nothing refuses");
        w.move_part(act, ks, f, from, frame_across, Quat::IDENTITY, &target)
            .expect("seated");
        assert_eq!(w.parent(f), (Some(w.bay), target.to.slot), "in its slot");
        assert_eq!(w.parent(act).0, Some(f), "the crew's node is on the frame");
        let holders = w.acts.members(act).expect("live").len();
        println!(
            "A1: frame {} ({}) taken from the stand at ({}, {}) mm, carried and seated in {slot} at ({}, {}, {}) mm; crew {} holds it, {holders} holders",
            k + 1,
            f.counter(),
            from.x / 1000,
            from.z / 1000,
            target.at.x / 1000,
            target.at.y / 1000,
            target.at.z / 1000,
            act.counter()
        );
    }
    let holds: Vec<Id> = [fa, fb]
        .iter()
        .map(|f| {
            let h = w.tree.handle(*f).expect("live");
            w.tree.children(h).expect("live")[0]
        })
        .map(|h| w.tree.node(h).expect("a node").id())
        .collect();

    // A3, early: a frame held by two (hold crew 1) may lose one holder; the last is refused, the frame not braced.
    w.leave(holds[0], 1)
        .expect("one of two may go; the frame is still held");
    let early = w.leave(holds[0], 0).expect_err("refused");
    println!(
        "A3: frame A's last holder leaves before the beams: {}: {}",
        early.0, early.1
    );
    assert_eq!(early.0, "support.none");

    w.phase("beams-in");
    // A2: two Souls seat each beam; its two joints and its hand-off to the slot are one commit.
    for (beam, slot) in [(b1, "beam_low_l"), (b2, "beam_low_r")] {
        let act = w.crew(ground, &[4, 5]);
        let from = w.place_of(beam);
        let target = w.in_bay(slot, vec![fa, fb], false);
        w.move_part(
            act,
            [4, 5],
            beam,
            from,
            beam_across,
            W::beam_inside(),
            &target,
        )
        .expect("seated");
        let (moved, joints) = last_commit(&w);
        println!(
            "A2: beam {} seated in {slot}: one commit moves {:?} and makes {joints} joints",
            beam.counter(),
            moved.iter().map(|m| m.counter()).collect::<Vec<_>>()
        );
        assert_eq!((moved, joints), (vec![beam], 2));
        assert_eq!(w.parent(beam), (Some(w.bay), target.to.slot));
        w.leave(act, 4).expect("a beam's crew go");
        w.leave(act, 5).expect("a beam's crew go");
    }

    // A3: braced on both columns, the frames stand; the holders let go and the holds end.
    w.leave(holds[0], 0).expect("frame A stands");
    w.leave(holds[1], 2).expect("frame B stands");
    w.leave(holds[1], 3).expect("frame B stands");
    assert!(w.tree.handle(holds[0]).is_none() && w.tree.handle(holds[1]).is_none());
    println!("A3: with both beams joined to both frames, every holder let go; the holds ended");

    // A4: the reverse. The frames are held again, the beams come out first, then each frame back to the stand.
    w.phase("beams-out");
    let ha = w.crew(fa, &[0, 1]);
    let hb = w.crew(fb, &[2, 3]);
    for (k, beam) in [b2, b1].into_iter().enumerate() {
        let act = w.crew(ground, &[4, 5]);
        let from = w.place_of(beam);
        let home = beam_at(1 - k);
        let taken = w
            .move_part(
                act,
                [4, 5],
                beam,
                from,
                beam_across,
                W::beam_inside(),
                &w.onto_ground(home),
            )
            .expect("taken out");
        let (moved, unjoined) = commit_at(&w, taken);
        println!(
            "A4: beam {} taken out of the bay: one commit undoes {unjoined} joints and moves {:?} into crew {}; set down in the yard at ({}, {}) mm",
            beam.counter(),
            moved.iter().map(|m| m.counter()).collect::<Vec<_>>(),
            act.counter(),
            home.x / 1000,
            home.z / 1000
        );
        assert_eq!((moved, unjoined), (vec![beam], 2));
        assert_eq!(w.parent(beam), (Some(ground), None));
        w.leave(act, 4).expect("go");
        w.leave(act, 5).expect("go");
    }
    w.phase("frames-out");
    for (f, act, slot, ks) in [(fa, ha, "frame_1", [0, 1]), (fb, hb, "frame_2", [2, 3])] {
        let from = w.place_of(f);
        let target = w.onto_stand(slot);
        let taken = w
            .move_part(act, ks, f, from, frame_across, Quat::IDENTITY, &target)
            .expect("taken out");
        let (moved, unjoined) = commit_at(&w, taken);
        println!(
            "A4: frame {} taken out: one commit moves {:?} (its holders' node off it, then it into their slot), {unjoined} joints left to undo",
            f.counter(),
            moved.iter().map(|m| m.counter()).collect::<Vec<_>>()
        );
        assert_eq!((moved, unjoined), (vec![act, f], 0));
        assert_eq!(w.parent(f), (Some(w.stand), target.to.slot));
        w.leave(act, ks[0]).expect("go");
        w.leave(act, ks[1]).expect("go");
    }
    let bay_h = w.tree.handle(w.bay).expect("the bay");
    assert!(
        w.tree.children(bay_h).expect("live").is_empty(),
        "the bay is empty"
    );
    for (p, what) in [
        (fa, "frame A"),
        (fb, "frame B"),
        (b1, "beam 1"),
        (b2, "beam 2"),
    ] {
        let (parent, slot) = w.parent(p);
        let at = w.place_of(p);
        println!(
            "A4: {what}, id {}, back in the yard: parent {}, slot {slot:?}, at ({}, {}) mm",
            p.counter(),
            parent.expect("a parent").counter(),
            at.x / 1000,
            at.z / 1000
        );
    }
    println!(
        "commits: {} guarded writes by the crew, {} activity steps (B5)",
        w.seating.parts.len(),
        w.acts.stream.len()
    );
    if let Ok(out) = std::env::var("SEATING_TRACE") {
        let mut ends: Vec<usize> = w.phases.iter().skip(1).map(|p| p.1).collect();
        ends.push(w.frames_out.len());
        for ((name, from), to) in w.phases.iter().zip(ends) {
            let file = format!("{out}-{name}.trace");
            trace(&file, &w.frames_out[*from..to]);
            println!("trace written: {file}, {} ticks", to - from);
        }
    }
}

#[test]
fn a5_each_refusal_is_returned_before_anyone_moves() {
    let mut w = world();
    let ground = w.ground;
    let (fa, fb, b1) = (w.frames[0], w.frames[1], w.beams[0]);
    let check = |w: &mut W, act, part, target: &Target, reach| {
        let before = (w.tree.to_state(), w.seating.parts.len());
        let mut m = w.mint.clone();
        let r = named(
            w.seating
                .check(&w.tree, &w.acts, &mut m, act, part, target, reach),
        );
        assert_eq!(
            (w.tree.to_state(), w.seating.parts.len()),
            before,
            "nothing moved"
        );
        r
    };
    // crew.size: one Soul alone.
    let alone = w.crew(ground, &[0]);
    let t = w.in_bay("upright_a", vec![], true);
    let r = check(&mut w, alone, fa, &t, REACH).expect_err("refused");
    println!("A5: one Soul for a frame: {}: {}", r.0, r.1);
    assert_eq!(r.0, "crew.size");
    // B18: a beam into the empty bay would hang by nothing.
    let act = w.crew(ground, &[2, 3]);
    let t = w.in_bay("beam_low_l", vec![], false);
    let r = check(&mut w, act, b1, &t, REACH).expect_err("refused");
    println!("A5: a beam into the empty bay: {}: {}", r.0, r.1);
    assert_eq!(r.0, "support.none");
    // reach.too-high: the high beam slot above a short crew's reach.
    let t = w.in_bay("beam_high_l", vec![fa, fb], false);
    let r = check(&mut w, act, b1, &t, 800_000).expect_err("refused");
    println!(
        "A5: the high beam for a crew that reaches 800 mm: {}: {}",
        r.0, r.1
    );
    assert_eq!(r.0, "reach.too-high");
    // B18: a frame into the bay with no one to hold it.
    let t = w.in_bay("upright_a", vec![], false);
    let r = check(&mut w, act, fa, &t, REACH).expect_err("refused");
    println!("A5: a frame set in and let go: {}: {}", r.0, r.1);
    assert_eq!(r.0, "support.none");
    // slot.occupied: frame A seated in upright_a, then frame B asked into the same slot.
    let t = w.in_bay("upright_a", vec![], true);
    let from = w.place_of(fa);
    w.move_part(
        act,
        [2, 3],
        fa,
        from,
        v(FRAME_HANDS, 0, 0),
        Quat::IDENTITY,
        &t,
    )
    .expect("seated");
    let other = w.crew(ground, &[4, 5]);
    let r = check(&mut w, other, fb, &t, REACH).expect_err("refused");
    println!("A5: frame B into frame A's slot: {}: {}", r.0, r.1);
    assert_eq!(r.0, "slot.occupied");
}

/// The run as V14's trace (`v2/tools/birdseye/src/main.rs`): a `u32` header length, the header, zero bytes to a
/// multiple of four, then per tick `x[n]` and `z[n]` as `i16` centimetres about the yard and site's middle, and
/// `node[n]` as `u8`. Bodies 0 and 1 are the frames, 2 and 3 the beams, then the six carriers.
fn trace(out: &str, rows: &[Vec<Vec3>]) {
    let o = v((YARD.x + SITE.x) / 2, 0, YARD.z);
    let cm = |p: Vec3| [((p.x - o.x) / 10_000) as i16, ((p.z - o.z) / 10_000) as i16];
    let rect = |c: Vec3, hx: i64, hz: i64| {
        let pts: Vec<String> = [(-hx, -hz), (hx, -hz), (hx, hz), (-hx, hz)]
            .iter()
            .map(|(x, z)| {
                let p = cm(v(c.x + x, 0, c.z + z));
                format!("[{},{}]", p[0], p[1])
            })
            .collect();
        format!(
            "{{\"floor\":0,\"kind\":\"place\",\"pts\":[{}]}}",
            pts.join(",")
        )
    };
    let n = 10;
    let head = format!(
        "{{\"format\":\"birdseye/0\",\"note\":\"B19: frames 0-1, beams 2-3, carriers 4-9; the stand (west) and the bay (east)\",\"tick_us\":{TICK},\"ticks\":{},\"bodies\":{n},\"unit\":\"cm\",\"step_cm\":{},\"floors\":[0],\"nodes\":[{{\"name\":\"yard and site\",\"floor\":0}}],\"outlines\":[{},{}]}}",
        rows.len(),
        STEP / 10_000,
        rect(YARD, 710_000, 300_000),
        rect(SITE, 610_000, 1_486_000)
    );
    let mut file = std::io::BufWriter::new(std::fs::File::create(out).expect("the trace file"));
    file.write_all(&(head.len() as u32).to_le_bytes()).unwrap();
    file.write_all(head.as_bytes()).unwrap();
    file.write_all(&vec![0u8; (4 - (4 + head.len()) % 4) % 4])
        .unwrap();
    for row in rows {
        let mut bytes = vec![0u8; 5 * n];
        for (k, p) in row.iter().enumerate() {
            let p = cm(*p);
            bytes[2 * k..2 * k + 2].copy_from_slice(&p[0].to_le_bytes());
            bytes[2 * n + 2 * k..2 * n + 2 * k + 2].copy_from_slice(&p[1].to_le_bytes());
        }
        file.write_all(&bytes).unwrap();
    }
    file.flush().unwrap();
}

#[path = "n19_tests.rs"]
mod n19;
