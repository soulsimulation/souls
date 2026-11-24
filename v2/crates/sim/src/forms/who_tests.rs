//! Who may at commit (F6, #2771). Each case is a world written as R2's JSON input (the client's copy) and loaded as a
//! T2 tree (the world's): the client's check ([`who_may_parts`]) and the world's ([`super::may`]) answer the same
//! question. The cases are the pinned Soul Actions who-may cases (R2's snapshot) and 10,000 generated ones. No kind is
//! named here: the snapshot's kinds are read from its files, and the generated kind's name is made up.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use replica::audience::{link_type, owners};
use replica::ids::{FIXTURE_SCOPE_A, Id};
use replica::rules::json::{Value, parse};
use replica::tree::Tree;
use replica::who_may::who_may_parts;
use replica::world_model::{
    Audience, Draft, End, FIXTURE_SCOPE_SOULS, Link, Node, parse_kinds, plain, show,
};

use super::may;

const KINDS: &str = include_str!("../../../replica/fixtures/world-model/kinds.diag");
const NAMES: [&str; 8] = ["Ana", "Bo", "Cy", "Di", "Ed", "Flo", "Gus", "Hal"];

fn json_files(dir: &Path, into: &mut Vec<PathBuf>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = read.map(|e| e.expect("an entry").path()).collect();
    paths.sort();
    for p in paths {
        if p.is_dir() {
            json_files(&p, into);
        } else if p.extension().is_some_and(|e| e == "json") {
            into.push(p);
        }
    }
}

fn read(p: &Path) -> Value {
    parse(&std::fs::read_to_string(p).expect("read")).expect("JSON")
}

/// R2's pinned Soul Actions snapshot: its kinds by name, and its who-may cases.
fn snapshot() -> (Value, Vec<Value>) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../replica/cases/form-rules-snapshot");
    let mut files = Vec::new();
    json_files(&root.join("content/kinds"), &mut files);
    json_files(&root.join("packages/form-rules/cases/kinds"), &mut files);
    let kinds = files
        .iter()
        .map(|f| read(f))
        .filter_map(|v| Some((v.get("kind")?.str()?.to_owned(), v)))
        .collect();
    let mut who = Vec::new();
    json_files(&root.join("packages/form-rules/cases/who"), &mut who);
    let cases = who
        .iter()
        .flat_map(|f| {
            read(f)
                .get("cases")
                .and_then(Value::arr)
                .unwrap_or(&[])
                .to_vec()
        })
        .collect();
    (Value::Obj(kinds), cases)
}

/// A case's world as the world holds it.
struct Built {
    tree: Tree,
    audiences: BTreeMap<Id, BTreeSet<Id>>,
    ids: BTreeMap<String, Id>,
    /// Each body's Soul.
    souls: BTreeMap<Id, Id>,
    /// The directory's names, by Soul.
    names: BTreeMap<Id, String>,
}

impl Built {
    fn id(&self, s: &str) -> Id {
        self.ids[s]
    }

    fn name(&self, id: Id) -> Option<String> {
        self.names.get(self.souls.get(&id).unwrap_or(&id)).cloned()
    }
}

fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::arr)
        .unwrap_or(&[])
        .iter()
        .filter_map(|e| e.str().map(str::to_owned))
        .collect()
}

/// Loads a case's `state` as a T2 tree: a public root place; each node with hands a body of the fixtures' family,
/// under the root, linked to its Soul by `souls:body-of`; each other node a thing of its kind, in the hand that
/// holds it or under the root; each link `t` of a thing's kind `ns:k` a link `ns:t` (`souls:owns` for its `owner`)
/// from its end to the thing, public when the kind's link is, else in an audience whose members are its ends, each
/// body counted as its Soul.
fn build(kinds: &Value, state: &Value) -> Built {
    let nodes = state.get("nodes").and_then(Value::obj).unwrap_or(&[]);
    let thing_kinds: BTreeSet<&str> = nodes
        .iter()
        .filter(|(_, n)| n.get("hands").is_none())
        .filter_map(|(_, n)| n.get("kind")?.str())
        .collect();
    let mut text = KINDS.to_owned();
    for k in &thing_kinds {
        text.push_str(&format!("\n{{1: \"{k}\", 2: \"thing\"}}"));
    }
    let kind_defs = parse_kinds(&text).expect("kinds");
    let full = |p: &str| -> String {
        kind_defs
            .keys()
            .find(|k| plain(k) == p)
            .unwrap_or_else(|| panic!("{p} is a kind"))
            .clone()
    };
    let mut ids = BTreeMap::new();
    let mut counter = 1_u64;
    let mut next = |scope| {
        counter += 1;
        Id::new(scope, counter).expect("an id")
    };
    let root = Id::new(FIXTURE_SCOPE_A, 1).expect("an id");
    for (k, _) in nodes {
        ids.insert(k.clone(), next(FIXTURE_SCOPE_A));
    }
    // Every other id the case names is a Soul's.
    let mut souls_named = Vec::new();
    for (_, n) in nodes {
        for (_, ends) in n.get("links").and_then(Value::obj).unwrap_or(&[]) {
            souls_named.extend(strs(Some(ends)));
        }
    }
    let mut draft = Draft {
        kinds: kind_defs.clone(),
        ..Draft::default()
    };
    let mut names = BTreeMap::new();
    for s in souls_named {
        if let std::collections::btree_map::Entry::Vacant(e) = ids.entry(s) {
            let id = next(FIXTURE_SCOPE_SOULS);
            e.insert(id);
            draft.souls.insert(id);
            names.insert(id, NAMES[names.len() % NAMES.len()].to_owned());
        }
    }
    draft.nodes.push(Node {
        id: root,
        kind: full("souls:place"),
        parent: None,
        slot: None,
        audience: Audience::Everyone,
        fields: BTreeMap::new(),
    });
    let mut souls = BTreeMap::new();
    let mut holder: BTreeMap<String, (Id, u64)> = BTreeMap::new();
    for (k, n) in nodes {
        let Some(hands) = n.get("hands") else {
            continue;
        };
        let body = ids[k];
        let mut hand_names: Vec<&String> =
            hands.obj().unwrap_or(&[]).iter().map(|(h, _)| h).collect();
        hand_names.sort();
        for (slot, h) in (1..).zip(hand_names) {
            if let Some(t) = hands.get(h).and_then(Value::str) {
                holder.insert(t.to_owned(), (body, slot));
            }
        }
        if let [s] = strs(n.get("links").and_then(|l| l.get("soul"))).as_slice() {
            souls.insert(body, ids[s]);
            draft.links.push(Link {
                id: next(FIXTURE_SCOPE_A),
                ty: "souls:body-of".into(),
                ends: [body, ids[s]],
                owner: End::First,
                audience: Audience::Everyone,
            });
        }
    }
    for (k, n) in nodes {
        let body = n.get("hands").is_some();
        let (parent, slot) = match holder.get(k) {
            Some((b, s)) if !body => (*b, Some(*s)),
            _ => (root, None),
        };
        let kind = match body {
            true => full("souls:body"),
            false => full(n.get("kind").and_then(Value::str).expect("a kind")),
        };
        draft.nodes.push(Node {
            id: ids[k],
            kind,
            parent: Some(parent),
            slot,
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        });
        if body {
            continue;
        }
        let kind = n.get("kind").and_then(Value::str).expect("a kind");
        for (t, ends) in n.get("links").and_then(Value::obj).unwrap_or(&[]) {
            let public = kinds
                .get(kind)
                .and_then(|e| e.get("links"))
                .and_then(|l| l.get(t))
                .and_then(|d| d.get("audience"))
                .and_then(|a| a.get("rule"))
                .and_then(Value::str)
                == Some("everyone");
            let ends: Vec<Id> = strs(Some(ends)).iter().map(|e| ids[e]).collect();
            let audience = if public {
                Audience::Everyone
            } else {
                let a = next(FIXTURE_SCOPE_A);
                let members = ends.iter().map(|e| *souls.get(e).unwrap_or(e)).collect();
                draft.audiences.insert(a, members);
                Audience::Of(a)
            };
            for e in ends {
                draft.links.push(Link {
                    id: next(FIXTURE_SCOPE_A),
                    ty: link_type(kind, t),
                    ends: [e, ids[k]],
                    owner: End::Second,
                    audience,
                });
            }
        }
    }
    let (tree, rules) = Tree::load(&draft).unwrap_or_else(|e| panic!("loads: {e}: {draft:?}"));
    Built {
        tree,
        audiences: rules.audiences,
        ids,
        souls,
        names,
    }
}

/// The world's answer for a case: `Ok` or the refusal's detail.
fn server(kinds: &Value, c: &Value) -> (Result<(), String>, Built) {
    let state = c.get("state").expect("state");
    let b = build(kinds, state);
    let act = c.get("act").expect("act");
    let this = act.get("this").and_then(Value::str).expect("this");
    let form = act.get("form").and_then(Value::str).expect("form");
    let actor = state.get("actor").and_then(Value::str).expect("actor");
    let kind = state
        .get("nodes")
        .and_then(|n| n.get(this))
        .and_then(|n| n.get("kind"))
        .and_then(Value::str)
        .expect("a kind");
    let entry = kinds.get(kind).expect("an entry");
    let r = may(
        &b.tree,
        &b.audiences,
        &|id| b.name(id),
        b.id(actor),
        b.id(this),
        entry,
        form,
    )
    .map_err(|r| {
        assert_eq!(r.name, "not-permitted", "{}", r.detail);
        r.detail
    });
    (r, b)
}

fn verdict(v: &Value) -> &str {
    v.get("verdict").and_then(Value::str).unwrap_or_default()
}

/// A3: a refusal names no account id (none is ever handed to the check: the directory gives names) and, when the
/// asker may not see the link, no end of it.
fn leaks(detail: &str, hidden: &[Id], b: &Built) -> Vec<String> {
    let mut out: Vec<String> = hidden
        .iter()
        .flat_map(|e| [b.name(*e), Some(show(*e))])
        .flatten()
        .filter(|w| detail.contains(w.as_str()))
        .collect();
    if detail.contains("account") {
        out.push("account".into());
    }
    out
}

/// The ends of `t`'s links at `this`.
fn ends_of(c: &Value, this: &str, t: &str, b: &Built) -> Vec<Id> {
    strs(
        c.get("state")
            .and_then(|s| s.get("nodes"))
            .and_then(|n| n.get(this))
            .and_then(|n| n.get("links"))
            .and_then(|l| l.get(t)),
    )
    .iter()
    .map(|e| b.id(e))
    .collect()
}

#[test]
fn f6_a1_a3_each_who_test_with_data_accepts_the_permitted_and_refuses_another_naming_who_may() {
    let (kinds, cases) = snapshot();
    let mut by_rule: BTreeMap<String, (u32, u32)> = BTreeMap::new();
    println!("| case | who | asker | client | world |\n|---|---|---|---|---|");
    for c in &cases {
        let name = c.get("name").and_then(Value::str).unwrap_or_default();
        let client = who_may_parts(Some(&kinds), c.get("act"), c.get("state"), c.get("asker"));
        let (world, b) = server(&kinds, c);
        let who = client.get("who").map_or(String::new(), Value::to_json);
        let actor = c
            .get("state")
            .and_then(|s| s.get("actor"))
            .and_then(Value::str)
            .expect("actor");
        let asker = b
            .name(b.id(actor))
            .unwrap_or_else(|| format!("body {actor}, no Soul"));
        println!(
            "| {name} | `{who}` | {asker} | {} | {} |",
            verdict(&client),
            world
                .as_ref()
                .map_or_else(|d| format!("refused: {d}"), |()| "accepted".into())
        );
        // The client agrees with the world wherever it can see; where it cannot, the world still decides.
        match verdict(&client) {
            "yes" => assert!(world.is_ok(), "{name}: {world:?}"),
            "no" => assert!(world.is_err(), "{name}"),
            "unknown" => {}
            v => panic!("{name}: {v}"),
        }
        let e = by_rule.entry(who).or_default();
        match &world {
            Ok(()) => e.0 += 1,
            Err(detail) => {
                e.1 += 1;
                assert!(detail.starts_with("who may: "), "{detail}");
                let this = c
                    .get("act")
                    .and_then(|a| a.get("this"))
                    .and_then(Value::str)
                    .expect("this");
                let link = c
                    .get("expect")
                    .and_then(|x| x.get("link"))
                    .and_then(Value::str);
                let hidden = link.map(|t| ends_of(c, this, t, &b)).unwrap_or_default();
                assert!(leaks(detail, &hidden, &b).is_empty(), "{name}: {detail}");
                // A link refusal the asker may see names the link and its ends.
                if let Some(t) = c
                    .get("expect")
                    .and_then(|x| x.get("detail"))
                    .and_then(|d| d.get("link"))
                {
                    let t = t.str().expect("a link");
                    assert!(detail.contains(&format!("its {t}")), "{detail}");
                    for e in ends_of(c, this, t, &b) {
                        let n = b.name(e).unwrap_or_else(|| show(e));
                        assert!(detail.contains(&n), "{name}: {detail} names {n}");
                    }
                }
            }
        }
    }
    println!("f6 a1: by rule (accepted, refused): {by_rule:?}");
    for (who, (yes, no)) in &by_rule {
        // `world` is never a Soul's to do; every other test accepts one Soul and refuses another.
        if who.contains("world") {
            assert!(*yes == 0 && *no > 0, "{who}");
        } else if !who.contains("anyone") {
            assert!(*yes > 0 && *no > 0, "{who}: {yes} accepted, {no} refused");
        }
    }
}

// --- Generated cases ----------------------------------------------------------------------------------------------

/// SplitMix64.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const GENERATED: usize = 10_000;

/// A made-up kind with every test of the closed list: a public link `a`, a members-only link `b` (its audience is its
/// own ends) and a form for each `who`.
fn generated_kind() -> (String, Value) {
    let name = format!("f{}:k", 6);
    let entry = parse(&format!(
        r#"{{"format":"souls-entry/1","kind":"{name}","owner":"thing",
        "links":{{"a":{{"n":1,"from":"soul","most":4,"audience":{{"rule":"everyone"}}}},
                  "b":{{"n":2,"from":"soul","most":4,"audience":{{"rule":"linked","link":"b"}}}}}},
        "forms":{{"f0":{{"who":"anyone"}},"f1":{{"who":"holder"}},"f2":{{"who":"world"}},
                  "f3":{{"who":{{"link":"a"}}}},"f4":{{"who":{{"link":"b"}}}}}}}}"#
    ))
    .expect("JSON");
    (name, entry)
}

/// One case: one to four bodies (most linked to a Soul of their own), the thing maybe in a hand, each link's ends
/// drawn from the Souls and bodies, and an actor. The asker sees `b` exactly when it is a member of `b`'s audience.
fn generate(r: &mut Rng, kind: &str) -> Value {
    let bodies = 1 + r.below(4) as usize;
    let mut nodes = Vec::new();
    let mut candidates = Vec::new();
    let mut soul_of = BTreeMap::new();
    let held_by = (r.below(3) == 0).then(|| r.below(bodies as u64) as usize);
    let mut links_of_thing = Vec::new();
    for i in 0..bodies {
        let b = format!("b{i}");
        candidates.push(b.clone());
        let mut links = Vec::new();
        if r.below(5) > 0 {
            let s = format!("s{i}");
            candidates.push(s.clone());
            soul_of.insert(b.clone(), s.clone());
            links.push(("soul".to_owned(), Value::Arr(vec![Value::s(&s)])));
        }
        let right = if held_by == Some(i) {
            Value::s("t")
        } else {
            Value::Null
        };
        nodes.push((
            b,
            Value::object([
                (
                    "hands",
                    Value::object([("left", Value::Null), ("right", right)]),
                ),
                ("links", Value::Obj(links)),
            ]),
        ));
    }
    let mut ends_b = Vec::new();
    for t in ["a", "b"] {
        let mut ends: Vec<String> = Vec::new();
        for _ in 0..r.below(4) {
            let e = candidates[r.below(candidates.len() as u64) as usize].clone();
            if !ends.contains(&e) {
                ends.push(e);
            }
        }
        if !ends.is_empty() {
            links_of_thing.push((
                t.to_owned(),
                Value::Arr(ends.iter().map(|e| Value::s(e)).collect()),
            ));
        }
        if t == "b" {
            ends_b = ends;
        }
    }
    nodes.push((
        "t".to_owned(),
        Value::object([
            ("kind", Value::s(kind)),
            ("links", Value::Obj(links_of_thing)),
        ]),
    ));
    let actor = format!("b{}", r.below(bodies as u64));
    let asker = soul_of.get(&actor).unwrap_or(&actor);
    let member = ends_b.iter().any(|e| soul_of.get(e).unwrap_or(e) == asker);
    let mut sees = vec![Value::s("public")];
    if member {
        sees.push(Value::s("linked:b"));
    }
    Value::object([
        ("name", Value::s(&format!("generated {}", r.0))),
        (
            "act",
            Value::object([
                ("this", Value::s("t")),
                ("form", Value::s(&format!("f{}", r.below(5)))),
            ]),
        ),
        (
            "state",
            Value::object([("actor", Value::s(&actor)), ("nodes", Value::Obj(nodes))]),
        ),
        ("asker", Value::object([("sees", Value::Arr(sees))])),
    ])
}

#[test]
fn f6_a2_a3_the_clients_check_and_the_worlds_agree_on_10000_cases_and_no_refusal_leaks() {
    let (name, entry) = generated_kind();
    let kinds = Value::Obj(vec![(name.clone(), entry)]);
    let mut r = Rng(2771);
    let mut tally: BTreeMap<String, u32> = BTreeMap::new();
    let mut agree = 0;
    let mut checked_hidden = 0;
    for _ in 0..GENERATED {
        let c = generate(&mut r, &name);
        let client = who_may_parts(Some(&kinds), c.get("act"), c.get("state"), c.get("asker"));
        // The same input as the world sees it: every audience.
        let mut all = c.clone();
        if let Value::Obj(o) = &mut all {
            o.retain(|(k, _)| k != "asker");
            o.push(("asker".into(), Value::object([("sees", Value::s("all"))])));
        }
        let whole = who_may_parts(
            Some(&kinds),
            all.get("act"),
            all.get("state"),
            all.get("asker"),
        );
        let (world, b) = server(&kinds, &c);
        let v = verdict(&client);
        let ok = match v {
            "yes" => world.is_ok(),
            "no" => world.is_err(),
            "unknown" => world.is_err(),
            _ => false,
        } && (verdict(&whole) == "yes") == world.is_ok();
        assert!(
            ok,
            "{}: client {} world {world:?}",
            c.to_json(),
            client.to_json()
        );
        agree += 1;
        *tally
            .entry(format!(
                "{} {v}",
                client.get("who").map_or(String::new(), Value::to_json)
            ))
            .or_default() += 1;
        if let Err(detail) = &world {
            let hidden = match v {
                "unknown" => {
                    checked_hidden += 1;
                    ends_of(&c, "t", "b", &b)
                }
                _ => Vec::new(),
            };
            let leaked = leaks(detail, &hidden, &b);
            assert!(
                leaked.is_empty(),
                "{}: {detail} leaks {leaked:?}",
                c.to_json()
            );
        }
    }
    println!(
        "f6 a2: {agree} of {GENERATED} cases agree (seed 2771); by who and client verdict: {tally:?}"
    );
    println!(
        "f6 a3: {checked_hidden} refusals of a hidden members list name none of its members; no refusal names an account"
    );
    assert_eq!(agree, GENERATED);
    assert!(checked_hidden > 100);
}

// --- One owner (#3265) --------------------------------------------------------------------------------------------

const OWNED: usize = 1_000;

/// One generated thing of a made-up kind with an `owner` link (its audience the `owner` rule) and another link `a`:
/// one to four bodies, each with a Soul of its own; each link's ends drawn from the Souls and their bodies; the thing
/// maybe in a hand.
fn owned(r: &mut Rng, kind: &str) -> Value {
    let bodies = 1 + r.below(4) as usize;
    let held_by = (r.below(3) == 0).then(|| r.below(bodies as u64) as usize);
    let mut candidates = Vec::new();
    let mut nodes = Vec::new();
    for i in 0..bodies {
        let (b, s) = (format!("b{i}"), format!("s{i}"));
        candidates.extend([b.clone(), s.clone()]);
        let right = match held_by == Some(i) {
            true => Value::s("t"),
            false => Value::Null,
        };
        nodes.push((
            b,
            Value::object([
                (
                    "hands",
                    Value::object([("left", Value::Null), ("right", right)]),
                ),
                (
                    "links",
                    Value::Obj(vec![("soul".into(), Value::Arr(vec![Value::s(&s)]))]),
                ),
            ]),
        ));
    }
    let mut links = Vec::new();
    for t in ["owner", "a"] {
        let mut ends: Vec<String> = Vec::new();
        for _ in 0..r.below(4) {
            let e = candidates[r.below(candidates.len() as u64) as usize].clone();
            if !ends.contains(&e) {
                ends.push(e);
            }
        }
        if !ends.is_empty() {
            links.push((
                t.to_owned(),
                Value::Arr(ends.iter().map(|e| Value::s(e)).collect()),
            ));
        }
    }
    nodes.push((
        "t".to_owned(),
        Value::object([("kind", Value::s(kind)), ("links", Value::Obj(links))]),
    ));
    Value::object([("nodes", Value::Obj(nodes))])
}

/// #3265 A2: for 1,000 generated things, the Souls the `owner` audience rule names (who may see as owner) are exactly
/// the Souls whose bodies may do a form whose `who` is `{"link": "owner"}` (who may use as owner).
#[test]
fn one_owner_who_may_see_and_who_may_use_as_owner_name_the_same_soul() {
    let name = "f7:o".to_owned();
    let entry = parse(&format!(
        r#"{{"format":"souls-entry/1","kind":"{name}","owner":"thing",
        "links":{{"owner":{{"n":1,"from":"soul","most":4,"audience":{{"rule":"owner"}}}},
                  "a":{{"n":2,"from":"soul","most":4,"audience":{{"rule":"everyone"}}}}}},
        "forms":{{"use":{{"who":{{"link":"owner"}}}}}}}}"#
    ))
    .expect("JSON");
    let kinds = Value::Obj(vec![(name.clone(), entry.clone())]);
    let mut r = Rng(3265);
    let mut with_owner = 0;
    for _ in 0..OWNED {
        let state = owned(&mut r, &name);
        let b = build(&kinds, &state);
        let thing = b.id("t");
        let see = owners(thing, &b.tree.to_state());
        let used: BTreeSet<Id> = b
            .souls
            .iter()
            .filter(|(body, _)| {
                may(
                    &b.tree,
                    &b.audiences,
                    &|id| b.name(id),
                    **body,
                    thing,
                    &entry,
                    "use",
                )
                .is_ok()
            })
            .map(|(_, soul)| *soul)
            .collect();
        assert_eq!(see, used, "{}", state.to_json());
        with_owner += usize::from(!see.is_empty());
    }
    println!(
        "one owner: {OWNED} things (seed 3265), {with_owner} with an owner; who may see as owner is who may use as owner in every one"
    );
    assert!(with_owner > OWNED / 2);
}

/// E10: a vehicle's `who: holder` form (its `steer`) is the drive seat's. A body seated in the slot the kind's
/// `vehicle.drive` names may do it; a body in its other body slot (a passenger) and a body standing beside it are
/// refused `not-permitted`, naming who may. The drive seat is the made-up kind's second slot, so the slot is found by
/// its name, not by being first.
#[test]
fn e10_a_seated_rider_steers_and_a_passenger_or_a_bystander_is_refused() {
    let name = "f6:v";
    let entry = parse(&format!(
        r#"{{"format":"souls-entry/1","kind":"{name}","owner":"thing",
        "slots":{{"front":{{"admits":"body","posture":"sit","most":1}},
                  "back":{{"admits":"body","posture":"sit","most":1}}}},
        "vehicle":{{"drive":"back","steer":"steer","speed_mm_s":1500,"ground":"deep_water"}},
        "forms":{{"steer":{{"who":"holder"}}}}}}"#
    ))
    .expect("JSON");
    let text =
        format!("{KINDS}\n{{1: \"{name}\", 2: \"thing\", 6: {{1: [\"body\"], 2: [\"body\"]}}}}");
    let kinds = parse_kinds(&text).expect("kinds");
    let full = |p: &str| {
        kinds
            .keys()
            .find(|k| plain(k) == p)
            .expect("a kind")
            .clone()
    };
    let id = |n| Id::new(FIXTURE_SCOPE_A, n).expect("an id");
    let (root, boat, rider, passenger, beside) = (id(1), id(2), id(3), id(4), id(5));
    let node = |id, kind: &str, parent, slot| Node {
        id,
        kind: full(kind),
        parent,
        slot,
        audience: Audience::Everyone,
        fields: BTreeMap::new(),
    };
    let draft = Draft {
        kinds: kinds.clone(),
        nodes: vec![
            node(root, "souls:place", None, None),
            node(boat, name, Some(root), None),
            node(rider, "souls:body", Some(boat), Some(2)),
            node(passenger, "souls:body", Some(boat), Some(1)),
            node(beside, "souls:body", Some(root), None),
        ],
        ..Draft::default()
    };
    let (tree, rules) = Tree::load(&draft).unwrap_or_else(|e| panic!("loads: {e}"));
    let steer = |body| {
        may(
            &tree,
            &rules.audiences,
            &|_| None,
            body,
            boat,
            &entry,
            "steer",
        )
    };
    assert!(steer(rider).is_ok(), "the rider in the drive slot steers");
    for (who, body) in [("a passenger", passenger), ("someone beside it", beside)] {
        let r = steer(body).expect_err(who);
        assert_eq!(r.name, "not-permitted", "{who}: {}", r.detail);
        assert_eq!(r.detail, "who may: whoever holds it", "{who}");
    }
}
