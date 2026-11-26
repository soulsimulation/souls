//! A timber shade (the carpentry kinds, `content/kinds/carpentry/`): two bents stand in a marked site, a rail on each
//! side joins their tops, and a shade cloth rests on both rails. The rule reads the cloth as a part that rests on
//! bearing parts (it declares its joining link to the rail, which itself bears), so its build order and refusals come
//! from the kinds alone: a rail needs both bents standing, the cloth needs both rails, and nothing under the cloth
//! leaves while it is on. The rack kinds read as before. `cargo test -p sim shade -- --nocapture` prints each step.

use std::collections::BTreeMap;
use std::path::Path;

use replica::activity::{F_STATE, MEMBER};
use replica::apply::Replica;
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, schema_hash,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::kinds::Kinds;
use replica::kinds::entry::entry_to_kind;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::world_model::{Audience, End};

use super::Structure;
use crate::commit::write_guarded;

const PLACE: &str =
    "souls:place@12200000000000000000000000000000000000000000000000000000000000000001";
const HOLD: &str = "test:hold@12200000000000000000000000000000000000000000000000000000000000000003";
const JOINT: &str = "mars:joint";

fn n(s: &str) -> Name {
    Name::new(s).expect("a name")
}

fn without_roles(json: &str) -> String {
    let mut e = replica::rules::json::parse(json).expect("an entry");
    if let replica::rules::json::Value::Obj(o) = &mut e {
        o.retain(|(k, _)| k != "roles");
    }
    e.to_json()
}

/// The construction and carpentry entries, loaded as a world with both would load them.
struct Shade {
    structure: Structure,
    full: BTreeMap<&'static str, String>,
    slots: BTreeMap<String, u64>,
}

fn shade() -> Shade {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let mut files: Vec<(String, String)> = Vec::new();
    for family in ["construction", "carpentry"] {
        for e in std::fs::read_dir(root.join(family)).expect("the kinds") {
            let p = e.expect("an entry").path();
            if p.extension().is_none_or(|x| x != "json") {
                continue;
            }
            let json = std::fs::read_to_string(&p).expect("read");
            let name = format!("{family}/{}", p.file_name().unwrap().to_string_lossy());
            files.push((
                name,
                entry_to_kind(&without_roles(&json)).expect("an entry"),
            ));
        }
    }
    files.sort();
    let sources: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    let mut kinds = Kinds::default();
    kinds.load(&sources);
    assert!(kinds.refused().is_empty(), "{:?}", kinds.refused());
    let full_of = |plain: &str| {
        kinds
            .admits()
            .into_keys()
            .find(|k| k.starts_with(&format!("{plain}@")))
            .unwrap_or_else(|| panic!("{plain} loaded"))
    };
    let full: BTreeMap<&'static str, String> = [
        "mars:shade_site",
        "mars:timber_bent",
        "mars:timber_rail",
        "mars:shade_cloth",
        "mars:rack_upright",
        "mars:rack_beam",
    ]
    .into_iter()
    .map(|k| (k, full_of(k)))
    .collect();
    let slots = kinds
        .get(&full["mars:shade_site"])
        .unwrap()
        .slots
        .iter()
        .map(|(k, s)| (s.name.as_ref().unwrap().as_str().to_owned(), *k))
        .collect();
    Shade {
        structure: Structure::new(&kinds, &sources),
        full,
        slots,
    }
}

fn header(zone: Id, s: &Shade) -> Vec<u8> {
    let mut kinds: Vec<Value> = vec![Value::Text(n(PLACE)), Value::Text(n(HOLD))];
    kinds.extend(s.full.values().map(|k| Value::Text(n(k))));
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/shade-structure/1").to_bytes()),
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

/// A world with the site in it, and the ids its steps use.
struct World {
    s: Shade,
    live: Replica,
    mint: Minter,
    site: Id,
    bents: [Id; 2],
    rails: [Id; 2],
    cloth: Id,
    /// Each part's joints, (link, other end), as committed.
    joints: BTreeMap<Id, Vec<(Id, Id)>>,
    /// Each bent's hold: its activity and its members' links.
    holds: [Option<(Id, Vec<Id>)>; 2],
}

impl World {
    fn new() -> World {
        let s = shade();
        let mut mint = Minter::new(Scope([0x5a; 16]));
        let mut id = || mint.mint().expect("an id");
        let root = id();
        let bytes = header(root, &s);
        let h = Header::read(&bytes).expect("a header");
        let mut live = Replica::start(&bytes).expect("a replica");
        let site = id();
        let (bents, rails, cloth) = ([id(), id()], [id(), id()], id());
        live.apply(&part(
            &h,
            &[effect(
                0,
                root,
                vec![Change::Create {
                    node: site,
                    kind: n(&s.full["mars:shade_site"]),
                    pose: pose(root, None),
                    audience: Audience::Everyone,
                    fields: BTreeMap::new(),
                }],
            )],
        ))
        .expect("the site");
        World {
            s,
            live,
            mint,
            site,
            bents,
            rails,
            cloth,
            joints: BTreeMap::new(),
            holds: [None, None],
        }
    }

    fn id(&mut self) -> Id {
        self.mint.mint().expect("an id")
    }

    /// Commits `changes` through the rule (`write_guarded`); a refusal changes nothing.
    fn write(&mut self, node: Id, changes: Vec<Change>) -> Result<(), (String, String)> {
        let before = (self.live.version(), self.live.tree().to_state());
        let es = vec![effect(self.live.version(), node, changes)];
        match write_guarded(&mut self.live, &es, &self.s.structure) {
            Ok(_) => Ok(()),
            Err(r) => {
                assert_eq!(
                    (self.live.version(), self.live.tree().to_state()),
                    before,
                    "a refusal changes nothing"
                );
                Err((r.name.to_owned(), r.detail))
            }
        }
    }

    /// `part` of `kind` put in the site's `slot`, joined to `to`.
    fn put(&mut self, part: Id, kind: &str, slot: &str, to: &[Id]) -> Result<(), (String, String)> {
        let mut changes = vec![Change::Create {
            node: part,
            kind: n(&self.s.full[kind]),
            pose: pose(self.site, Some(self.s.slots[slot])),
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        }];
        let mut js = Vec::new();
        for other in to {
            let link = self.id();
            changes.push(Change::Link {
                link,
                ty: n(JOINT),
                ends: [part, *other],
                owner: End::First,
                audience: Audience::Everyone,
            });
            js.push((link, *other));
        }
        self.write(self.site, changes)?;
        self.joints.insert(part, js);
        Ok(())
    }

    /// A bent raised into `slot` and held by `crew` (a started hold under it, its members linked).
    fn raise(&mut self, k: usize, slot: &str, crew: usize) -> Result<(), (String, String)> {
        let bent = self.bents[k];
        let mut changes = vec![Change::Create {
            node: bent,
            kind: n(&self.s.full["mars:timber_bent"]),
            pose: pose(self.site, Some(self.s.slots[slot])),
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        }];
        let act = self.id();
        changes.extend(self.hold_changes(bent, act, crew));
        self.write(self.site, changes)?;
        Ok(())
    }

    fn hold_changes(&mut self, bent: Id, act: Id, crew: usize) -> Vec<Change> {
        let mut changes = vec![Change::Create {
            node: act,
            kind: n(HOLD),
            pose: pose(bent, None),
            audience: Audience::Everyone,
            fields: BTreeMap::from([(F_STATE, Value::Uint(2))]),
        }];
        let mut links = Vec::new();
        for _ in 0..crew {
            let (body, link) = (self.id(), self.id());
            changes.push(Change::Link {
                link,
                ty: n(MEMBER),
                ends: [body, act],
                owner: End::Second,
                audience: Audience::Everyone,
            });
            links.push(link);
        }
        let k = usize::from(self.bents[1] == bent);
        self.holds[k] = Some((act, links));
        changes
    }

    /// A hold taken up again on a standing bent.
    fn hold(&mut self, k: usize) -> Result<(), (String, String)> {
        let (bent, act) = (self.bents[k], self.id());
        let changes = self.hold_changes(bent, act, 1);
        self.write(bent, changes)
    }

    /// Every holder of bent `k` lets go: its hold ends.
    fn release(&mut self, k: usize) -> Result<(), (String, String)> {
        let (act, _) = self.holds[k].clone().expect("held");
        self.write(act, vec![Change::Remove { node: act }])?;
        self.holds[k] = None;
        Ok(())
    }

    /// `part` taken out of the site: its joints undone (each by the part that owns it, the cloth's to a rail
    /// included) and the part removed, in one change.
    fn take_out(&mut self, part: Id) -> Result<(), (String, String)> {
        let mut changes: Vec<Change> = Vec::new();
        for (owner, js) in &self.joints {
            for (link, other) in js {
                if *owner == part || *other == part {
                    changes.push(Change::Unlink { link: *link });
                }
            }
        }
        // A bent goes with its holders' hold: they carry it out.
        for (k, bent) in self.bents.iter().enumerate() {
            if *bent == part
                && let Some((act, _)) = &self.holds[k]
            {
                changes.push(Change::Remove { node: *act });
            }
        }
        changes.push(Change::Remove { node: part });
        self.write(part, changes)?;
        for k in 0..2 {
            if self.bents[k] == part {
                self.holds[k] = None;
            }
        }
        self.joints.remove(&part);
        for js in self.joints.values_mut() {
            js.retain(|(_, other)| *other != part);
        }
        Ok(())
    }
}

fn refused(r: Result<(), (String, String)>, name: &str, says: &str, step: &str) {
    match r {
        Err((got, detail)) => {
            println!("{step}: refused {got}: {detail}");
            assert_eq!(got, name, "{step}: {detail}");
            assert!(detail.contains(says), "{step}: {detail} names {says}");
        }
        Ok(()) => panic!("{step}: accepted, want {name}"),
    }
}

fn accepted(r: Result<(), (String, String)>, step: &str) {
    println!("{step}: accepted");
    if let Err((name, detail)) = r {
        panic!("{step}: refused {name}: {detail}");
    }
}

#[test]
fn shade_kinds_read_as_a_bay_two_standing_two_bearing_and_one_resting_the_rack_as_before() {
    let s = shade();
    let (bays, standing, bearing) = s.structure.kinds();
    println!("bays {bays:?}\nstanding {standing:?}\nbearing or resting {bearing:?}");
    assert!(s.structure.is_bay("mars:shade_site"));
    assert!(s.structure.is_bay("mars:rack_bay"));
    assert!(s.structure.stands("mars:timber_bent"));
    assert!(s.structure.bears("mars:timber_rail"));
    assert!(
        !s.structure.stands("mars:timber_rail"),
        "the cloth rests on a rail; the rail still bears"
    );
    assert!(s.structure.rests("mars:shade_cloth"));
    assert!(s.structure.is_crew("mars:carry_activity"));
    // the rack's reading is unchanged
    assert!(s.structure.stands("mars:rack_upright"));
    assert!(s.structure.bears("mars:rack_beam"));
    assert!(!s.structure.rests("mars:rack_beam"));
    // connectors: a rail mates a bent, the cloth a rail, the cloth never a bent
    assert!(
        s.structure
            .mates("mars:timber_rail", "mars:timber_bent")
            .is_ok()
    );
    assert!(
        s.structure
            .mates("mars:shade_cloth", "mars:timber_rail")
            .is_ok()
    );
    assert!(
        s.structure
            .mates("mars:shade_cloth", "mars:timber_bent")
            .is_err()
    );
    assert!(
        s.structure
            .mates("mars:timber_rail", "mars:rack_upright")
            .is_err()
    );
}

#[test]
fn shade_builds_in_order_and_refuses_each_step_out_of_it_then_comes_down_in_reverse() {
    let mut w = World::new();
    let [a, b] = w.bents;
    let [rl, rr] = w.rails;
    let cloth = w.cloth;
    // Build.
    refused(
        w.put(rl, "mars:timber_rail", "rail_l", &[]),
        "support.none",
        "would hang by nothing",
        "1. a rail before any bent stands",
    );
    accepted(w.raise(0, "bent_a", 1), "2. bent a raised, one holding it");
    refused(
        w.put(rl, "mars:timber_rail", "rail_l", &[a]),
        "support.none",
        "it needs 2 joined to parts that stand",
        "3. a rail with one bent standing",
    );
    accepted(w.raise(1, "bent_b", 1), "4. bent b raised, one holding it");
    refused(
        w.put(cloth, "mars:shade_cloth", "cloth", &[]),
        "support.none",
        "would rest on nothing",
        "5. the cloth before any rail",
    );
    refused(
        w.release(0),
        "support.none",
        "held by nobody",
        "6. bent a let go before the rails brace it",
    );
    accepted(
        w.put(rl, "mars:timber_rail", "rail_l", &[a, b]),
        "7. the left rail across both bents",
    );
    refused(
        w.put(cloth, "mars:shade_cloth", "cloth", &[rl]),
        "support.none",
        "it needs 2 joined to parts that are held up",
        "8. the cloth on one rail",
    );
    accepted(
        w.put(rr, "mars:timber_rail", "rail_r", &[a, b]),
        "9. the right rail across both bents",
    );
    accepted(w.release(0), "10. bent a let go: braced by both rails");
    accepted(w.release(1), "11. bent b let go: the frame stands unheld");
    accepted(
        w.put(cloth, "mars:shade_cloth", "cloth", &[rl, rr]),
        "12. the cloth on both rails",
    );
    // Take-down.
    refused(
        w.take_out(rl),
        "support.none",
        "would rest on",
        "13. a rail out from under the cloth",
    );
    accepted(w.take_out(cloth), "14. the cloth off first");
    refused(
        w.take_out(rl),
        "support.none",
        "held by nobody",
        "15. a rail out while nobody holds the bents",
    );
    accepted(w.hold(0), "16. a holder on bent a");
    accepted(w.hold(1), "17. a holder on bent b");
    accepted(w.take_out(rl), "18. the left rail out");
    accepted(w.take_out(rr), "19. the right rail out");
    accepted(w.take_out(a), "20. bent a carried out by its holder's crew");
    accepted(w.take_out(b), "21. bent b carried out");
}
