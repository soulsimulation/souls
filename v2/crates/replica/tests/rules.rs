//! Form rules (Engine v2 R2, #2685), native build. Each `aN_` test is one acceptance box.
//!
//! The cases are data, read from disk at run time: this crate's `cases/` (its kinds in `cases/kinds/`) and a pinned
//! snapshot of the Soul Actions cases, `cases/form-rules-snapshot/` (`packages/form-rules/cases` with the
//! `content/kinds` they read, at the commit its `SOURCE` names). Adding a case file to either changes no code.
//!
//! The TypeScript rules are the truth this library tracks. So that a Soul Actions change does not fail every v2 run,
//! the required tests read the snapshot; `drift_against_the_live_form_rules_cases` (ignored here, run by
//! `v2/tools/ci.sh` in the daily full run) runs the same comparison on the live `packages/form-rules/cases`, or those
//! under `FORM_RULES_ROOT`, and prints each disagreement without failing. Refresh the snapshot by copying both folders
//! again and naming the commit in `SOURCE`.
//!
//! The 10,000 generated cases are built from this crate's kinds by construction: each need is made met or unmet on
//! purpose, so the expected verdict is known without running the rules. The test writes every case it ran and the
//! native answers under `CARGO_TARGET_TMPDIR/rules/`; `v2/tools/ci.sh` runs the same cases through the WASM build in
//! Node and requires the same answers, byte for byte.

use replica::rules::json::{Value, parse, same};
use replica::rules::{REASONS, decide_parts, rules_run};
use std::fs;
use std::path::{Path, PathBuf};

const GENERATED: usize = 10_000;
const SEED: u64 = 2685;

struct Case {
    file: String,
    case: Value,
}

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The pinned Soul Actions cases, laid out as the repository root is.
fn snapshot_root() -> PathBuf {
    crate_dir().join("cases/form-rules-snapshot")
}

/// The live Soul Actions cases: this checkout's, or another's under `FORM_RULES_ROOT`.
fn live_root() -> PathBuf {
    std::env::var_os("FORM_RULES_ROOT").map_or_else(|| crate_dir().join("../../.."), PathBuf::from)
}

/// The Soul Actions kinds and cases under a root, or `None` when it has none.
/// Kinds by name, and cases.
type SaWorld = (Vec<(String, Value)>, Vec<Case>);

fn sa_world(root: &Path, label: &str) -> Option<SaWorld> {
    let sa = root.join("packages/form-rules/cases");
    if !sa.is_dir() {
        return None;
    }
    let mut kinds = Vec::new();
    load_kinds(&[root.join("content/kinds"), sa.join("kinds")], &mut kinds);
    Some((kinds, load_cases(&sa, label)))
}

fn json_files(dir: &Path, deep: bool) -> Vec<PathBuf> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<PathBuf> = read.map(|e| e.unwrap().path()).collect();
    entries.sort();
    let mut out = Vec::new();
    for p in entries {
        if p.is_dir() && deep {
            out.extend(json_files(&p, deep));
        } else if p.is_file() && p.extension().is_some_and(|e| e == "json") {
            out.push(p);
        }
    }
    out
}

fn read_json(path: &Path) -> Value {
    parse(&fs::read_to_string(path).unwrap()).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn load_kinds(dirs: &[PathBuf], into: &mut Vec<(String, Value)>) {
    for dir in dirs {
        for file in json_files(dir, true) {
            let entry = read_json(&file);
            if entry.get("format").and_then(Value::str) != Some("souls-entry/1") {
                continue;
            }
            let kind = entry.get("kind").and_then(Value::str).unwrap().to_owned();
            assert!(
                into.iter().all(|(k, _)| *k != kind),
                "{}: kind {kind} defined twice",
                file.display()
            );
            into.push((kind, entry));
        }
    }
}

fn load_cases(dir: &Path, label: &str) -> Vec<Case> {
    let mut out = Vec::new();
    for file in json_files(dir, false) {
        let doc = read_json(&file);
        let format = doc.get("format").and_then(Value::str);
        assert_eq!(format, Some("souls-form-cases/1"), "{}", file.display());
        let name = format!("{label}/{}", file.file_name().unwrap().to_string_lossy());
        for c in doc.get("cases").and_then(Value::arr).unwrap() {
            out.push(Case {
                file: name.clone(),
                case: c.clone(),
            });
        }
    }
    out
}

struct World {
    kinds: Value,
    own_kinds: Vec<(String, Value)>,
    hand: Vec<Case>,
    sa_cases: usize,
}

fn world() -> World {
    let own_dir = crate_dir().join("cases");
    let mut own_kinds = Vec::new();
    load_kinds(&[own_dir.join("kinds")], &mut own_kinds);
    let mut all = own_kinds.clone();
    let mut hand = load_cases(&own_dir, "replica/cases");
    let (sa_kinds, cases) = sa_world(&snapshot_root(), "form-rules-snapshot")
        .expect("the pinned snapshot cases/form-rules-snapshot");
    for (k, e) in sa_kinds {
        assert!(all.iter().all(|(x, _)| *x != k), "kind {k} defined twice");
        all.push((k, e));
    }
    let sa_cases = cases.len();
    hand.extend(cases);
    World {
        kinds: Value::Obj(all),
        own_kinds,
        hand,
        sa_cases,
    }
}

fn verdict_of(kinds: &Value, c: &Value) -> Value {
    decide_parts(Some(kinds), c.get("act"), c.get("state"), c.get("asker"))
}

/// The keys of `expect` that the verdict does not match.
fn mismatches(expect: &Value, verdict: &Value) -> Vec<String> {
    expect
        .obj()
        .unwrap()
        .iter()
        .filter(|(k, v)| !verdict.get(k).is_some_and(|w| same(v, w)))
        .map(|(k, _)| k.clone())
        .collect()
}

// ---- Generated cases, built by construction. ----

/// SplitMix64: the same seed gives the same cases everywhere.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn int(&mut self, lo: i128, hi: i128) -> i128 {
        lo + i128::from(self.next() % u64::try_from(hi - lo + 1).unwrap())
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.next() % 100 < pct
    }
    fn pick<'a, T>(&mut self, list: &'a [T]) -> &'a T {
        &list[usize::try_from(self.next() % list.len() as u64).unwrap()]
    }
}

fn s(t: &str) -> Value {
    Value::s(t)
}

fn obj(entries: Vec<(String, Value)>) -> Value {
    Value::Obj(entries)
}

fn set(o: &mut Value, key: &str, v: Value) {
    if let Value::Obj(e) = o {
        match e.iter_mut().find(|(k, _)| k == key) {
            Some(x) => x.1 = v,
            None => e.push((key.to_owned(), v)),
        }
    }
}

fn child<'a>(o: &'a mut Value, key: &str) -> &'a mut Value {
    if o.get(key).is_none() {
        set(o, key, Value::Obj(vec![]));
    }
    match o {
        Value::Obj(e) => &mut e.iter_mut().find(|(k, _)| k == key).unwrap().1,
        _ => unreachable!(),
    }
}

/// Whether an asker seeing `sees` belongs to `audience`, written here from the entry format, apart from the library.
fn seen(sees: &Value, audience: &Value) -> bool {
    if sees.str() == Some("all") {
        return true;
    }
    let list = sees.arr().unwrap();
    let has = |t: String| list.iter().any(|v| v.str() == Some(t.as_str()));
    match audience.get("rule").and_then(Value::str) {
        Some("everyone") => true,
        Some("linked") => has(format!(
            "linked:{}",
            audience.get("link").and_then(Value::str).unwrap()
        )),
        Some(rule) => has(rule.to_owned()),
        None => false,
    }
}

/// A bool written either way the entry format allows.
fn flag_value(r: &mut Rng, b: bool) -> Value {
    if r.chance(50) {
        Value::Bool(b)
    } else {
        Value::Int(i128::from(b))
    }
}

/// A value of the field `def` that equals `want` (`same = true`) or differs from it.
fn value_vs(r: &mut Rng, def: &Value, want: &Value, equal: bool) -> Value {
    match def.get("type").and_then(Value::str) {
        Some("bool") => {
            let b = matches!(want, Value::Bool(true) | Value::Int(1));
            flag_value(r, if equal { b } else { !b })
        }
        _ => match want {
            Value::Int(n) if equal => Value::Int(*n),
            Value::Int(n) => Value::Int(n + r.int(1, 50) * if r.chance(50) { 1 } else { -1 }),
            v if equal => v.clone(),
            _ => s("something_else"),
        },
    }
}

/// One generated case: the state built so that each need is met or not on purpose, and the verdict that follows.
fn generate(r: &mut Rng, kinds: &[(String, Value)], index: usize) -> Value {
    let pairs: Vec<(&str, &str, &Value)> = kinds
        .iter()
        .flat_map(|(k, e)| {
            e.get("forms")
                .and_then(Value::obj)
                .unwrap()
                .iter()
                .map(move |(f, form)| (k.as_str(), f.as_str(), form))
        })
        // A reach to another thing's point (`of`) is not built here; hand-written cases cover it (reach_of.json).
        .filter(|(_, _, form)| !form.to_json().contains("\"of\":"))
        .collect();
    let (kind, form_name, form) = *r.pick(&pairs);
    let entry = &kinds.iter().find(|(k, _)| k == kind).unwrap().1;
    let needs = form.get("needs").and_then(Value::arr).unwrap();

    let mut this = obj(vec![("kind".into(), s(kind))]);
    let mut actor = obj(vec![]);
    let mut nodes: Vec<(String, Value)> = Vec::new();
    let mut args: Vec<(String, Value)> = Vec::new();
    let mut moves: Vec<(String, Value)> = Vec::new();
    // The asker: everything, or a subset of the audiences the kinds name.
    let sees = if r.chance(30) {
        s("all")
    } else {
        let all = ["owner", "creator", "linked:shared", "linked:plugged"];
        Value::Arr(all.iter().filter(|_| r.chance(50)).map(|a| s(a)).collect())
    };
    let this_index = r.chance(10);
    let into_index = r.chance(15);
    if this_index {
        set(&mut this, "held", s("index"));
    }
    // Each need met (true) or not, chosen first; `hidden` marks a need the asker cannot read.
    let met: Vec<bool> = needs.iter().map(|_| r.chance(70)).collect();
    let mut hidden = vec![false; needs.len()];
    let mut unknown_node = vec![String::new(); needs.len()];

    for (i, n) in needs.iter().enumerate() {
        let ok = met[i];
        match n.get("need").and_then(Value::str).unwrap() {
            "state" => {
                let field = n.get("field").and_then(Value::str).unwrap();
                let def = entry.get("state").and_then(|st| st.get(field)).unwrap();
                hidden[i] = this_index || !seen(&sees, def.get("audience").unwrap());
                unknown_node[i] = "n1".into();
                let v = if let Some(is) = n.get("is") {
                    value_vs(r, def, is, ok)
                } else if let Some(not) = n.get("not") {
                    value_vs(r, def, not, !ok)
                } else {
                    let lo = n.get("at_least").and_then(|v| {
                        if let Value::Int(x) = v {
                            Some(*x)
                        } else {
                            None
                        }
                    });
                    let hi = n.get("at_most").and_then(|v| {
                        if let Value::Int(x) = v {
                            Some(*x)
                        } else {
                            None
                        }
                    });
                    let (a, b) = (lo.unwrap_or(-5000), hi.unwrap_or(5000));
                    if ok {
                        Value::Int(r.int(a, b))
                    } else if lo.is_some() && (hi.is_none() || r.chance(50)) {
                        Value::Int(a - r.int(1, 2000))
                    } else {
                        Value::Int(b + r.int(1, 2000))
                    }
                };
                // Left out, the field reads as its default: do that when the default is the value chosen.
                let default = def.get("default").unwrap();
                let equal_default = same(&v, default)
                    || (matches!(v, Value::Int(x) if x == i128::from(*default == Value::Bool(true)))
                        && def.get("type").and_then(Value::str) == Some("bool"));
                if !(equal_default && r.chance(50)) {
                    set(child(&mut this, "fields"), field, v);
                }
            }
            "slot_free" => {
                let slots = entry.get("slots").and_then(Value::obj).unwrap();
                let name = match n.get("slot").unwrap() {
                    Value::Str(t) => t.clone(),
                    reference => {
                        let arg = reference.get("arg").and_then(Value::str).unwrap();
                        let name = r.pick(slots).0.clone();
                        args.push((arg.into(), s(&name)));
                        name
                    }
                };
                hidden[i] = this_index;
                unknown_node[i] = "n1".into();
                for (slot, def) in slots {
                    let most = match def.get("most") {
                        Some(Value::Int(m)) => *m,
                        _ => unreachable!(),
                    };
                    let count = if *slot == name {
                        if ok {
                            r.int(0, most - 1)
                        } else {
                            most + r.int(0, 1)
                        }
                    } else {
                        r.int(0, most)
                    };
                    let list = (0..count).map(|k| s(&format!("o{k}"))).collect();
                    set(child(&mut this, "slots"), slot, Value::Arr(list));
                }
            }
            "within_reach" => {
                let name = match n.get("point").unwrap() {
                    Value::Str(t) => t.clone(),
                    reference => {
                        let arg = reference.get("arg").and_then(Value::str).unwrap();
                        args.iter()
                            .find(|(a, _)| a == arg)
                            .unwrap()
                            .1
                            .str()
                            .unwrap()
                            .to_owned()
                    }
                };
                let place = entry
                    .get("points")
                    .and_then(|p| p.get(&name))
                    .or_else(|| entry.get("slots").and_then(|p| p.get(&name)))
                    .and_then(|p| p.get("at_mm"))
                    .and_then(Value::arr)
                    .unwrap();
                let at: Vec<i128> = place
                    .iter()
                    .map(|v| if let Value::Int(x) = v { *x } else { 0 })
                    .collect();
                let step = form
                    .get("steps")
                    .and_then(Value::arr)
                    .unwrap()
                    .iter()
                    .find(|st| st.get("step").and_then(Value::str) == Some("move"))
                    .unwrap();
                let mv = step.get("move").and_then(Value::str).unwrap();
                // On the edge now and then: a 3-4-5 triangle at exactly the reach, or one millimetre beyond it.
                let (reach, offset) = if r.chance(20) {
                    let k = r.int(1, 400);
                    (5 * k - i128::from(!ok), [3 * k, 4 * k, 0])
                } else {
                    let reach = r.int(0, 2000);
                    if ok {
                        // Within the L1 ball of the reach, so within its sphere.
                        let x = r.int(-reach, reach);
                        let rest = reach - x.abs();
                        let y = r.int(-rest, rest);
                        let rest = rest - y.abs();
                        (reach, [x, y, r.int(-rest, rest)])
                    } else {
                        let far = (reach + r.int(1, 1500)) * if r.chance(50) { 1 } else { -1 };
                        let mut o = [r.int(-2000, 2000), r.int(-2000, 2000), r.int(-2000, 2000)];
                        o[usize::try_from(r.int(0, 2)).unwrap()] = far;
                        (reach, o)
                    }
                };
                let eff = (0..3).map(|k| Value::Int(at[k] + offset[k])).collect();
                set(&mut actor, "effector_mm", Value::Arr(eff));
                moves.push((mv.into(), obj(vec![("reach_mm".into(), Value::Int(reach))])));
            }
            "hand" | "held_by_actor" => {
                let holds = n.get("holds").and_then(Value::str);
                let free = n.get("free").is_some();
                let mut hands: Vec<Value> = Vec::new();
                let filler = |r: &mut Rng| s(if r.chance(50) { "x1" } else { "x2" });
                for _ in 0..r.int(0, 2) {
                    hands.push(if free {
                        filler(r)
                    } else if r.chance(50) {
                        Value::Null
                    } else {
                        filler(r)
                    });
                }
                if ok {
                    hands.push(if free {
                        Value::Null
                    } else if holds.is_some() {
                        s("c3")
                    } else {
                        s("n1")
                    });
                }
                if let Some(holds) = holds {
                    nodes.push(("c3".into(), obj(vec![("kind".into(), s(holds))])));
                }
                // The other things a hand may hold are of another kind than any a need asks for.
                nodes.push(("x1".into(), obj(vec![("kind".into(), s("other:thing"))])));
                let len = hands.len();
                let rot =
                    usize::try_from(r.int(0, i128::try_from(len).unwrap())).unwrap() % len.max(1);
                hands.rotate_left(rot);
                let names = ["left", "right", "third"];
                let h = hands
                    .into_iter()
                    .enumerate()
                    .map(|(k, v)| (names[k].to_owned(), v))
                    .collect();
                set(&mut actor, "hands", obj(h));
            }
            "linked" | "unlinked" => {
                let link = n.get("link").and_then(Value::str).unwrap();
                let def = entry.get("links").and_then(|l| l.get(link)).unwrap();
                hidden[i] = this_index || !seen(&sees, def.get("audience").unwrap());
                unknown_node[i] = "n1".into();
                let want_linked = n.get("need").and_then(Value::str) == Some("linked");
                let count = if ok == want_linked { r.int(1, 3) } else { 0 };
                let ends = (0..count).map(|k| s(&format!("e{k}"))).collect();
                set(child(&mut this, "links"), link, Value::Arr(ends));
            }
            "room" => {
                let e = form
                    .get("effects")
                    .and_then(Value::arr)
                    .unwrap()
                    .iter()
                    .find(|e| e.get("change").and_then(Value::str) == Some("transfer"))
                    .unwrap();
                let field = e.get("field").and_then(Value::str).unwrap();
                let def = entry.get("state").and_then(|st| st.get(field)).unwrap();
                let max = match def.get("max") {
                    Some(Value::Int(m)) => *m,
                    _ => unreachable!(),
                };
                let into_arg = e
                    .get("into")
                    .and_then(|v| v.get("arg"))
                    .and_then(Value::str)
                    .unwrap();
                let amount_arg = e
                    .get("amount")
                    .and_then(|v| v.get("arg"))
                    .and_then(Value::str)
                    .unwrap();
                // What the target holds, its room, and the amount the transfer moves: within the room or beyond it.
                let held = if ok { r.int(0, max) } else { r.int(1, max) };
                let room = max - held;
                let moved = if ok {
                    r.int(0, room)
                } else {
                    r.int(room + 1, max)
                };
                let (there, grams) = if r.chance(50) {
                    (moved + r.int(0, 300), moved)
                } else {
                    (moved, moved + r.int(0, 300))
                };
                set(child(&mut this, "fields"), field, Value::Int(there));
                let mut target = obj(vec![
                    ("kind".into(), s(kind)),
                    ("fields".into(), obj(vec![(field.into(), Value::Int(held))])),
                ]);
                if into_index {
                    set(&mut target, "held", s("index"));
                }
                nodes.push(("c2".into(), target));
                args.push((into_arg.into(), s("c2")));
                args.push((amount_arg.into(), Value::Int(grams)));
                let audience_hidden = !seen(&sees, def.get("audience").unwrap());
                hidden[i] = audience_hidden || this_index || into_index;
                unknown_node[i] = if audience_hidden || this_index {
                    "n1".into()
                } else {
                    "c2".into()
                };
            }
            other => panic!("the generator does not build the need {other}"),
        }
    }

    nodes.push(("n1".into(), this));
    nodes.push(("b1".into(), actor));
    let mut act = obj(vec![
        ("this".into(), s("n1")),
        ("form".into(), s(form_name)),
    ]);
    if !args.is_empty() {
        set(&mut act, "args", obj(args));
    }
    let state = obj(vec![
        ("actor".into(), s("b1")),
        ("nodes".into(), obj(nodes)),
        ("moves".into(), obj(moves)),
    ]);

    // The verdict by construction: the first need the asker can read that is unmet; else the first it cannot read.
    let reason_of = |n: &Value| match n.get("need").and_then(Value::str).unwrap() {
        "state" => "field_differs",
        "slot_free" => "slot_taken",
        "within_reach" => "out_of_reach",
        "hand" if n.get("free").is_some() => "no_free_hand",
        "hand" => "not_holding_kind",
        "held_by_actor" => "not_held",
        "linked" => "not_linked",
        "unlinked" => "already_linked",
        _ => "no_room",
    };
    let first_no = (0..needs.len()).find(|&i| !hidden[i] && !met[i]);
    let first_hidden = (0..needs.len()).find(|&i| hidden[i]);
    let expect = match (first_no, first_hidden) {
        (Some(i), _) => obj(vec![
            ("verdict".into(), s("no")),
            ("reason".into(), s(reason_of(&needs[i]))),
            ("need".into(), Value::Int(i128::try_from(i).unwrap())),
        ]),
        (None, Some(i)) => obj(vec![
            ("verdict".into(), s("unknown")),
            ("need".into(), Value::Int(i128::try_from(i).unwrap())),
            ("node".into(), s(&unknown_node[i])),
        ]),
        (None, None) => obj(vec![("verdict".into(), s("yes"))]),
    };
    obj(vec![
        (
            "name".into(),
            s(&format!("generated_{index}_{kind}_{form_name}")),
        ),
        ("act".into(), act),
        ("state".into(), state),
        ("asker".into(), obj(vec![("sees".into(), sees)])),
        ("expect".into(), expect),
    ])
}

fn generated(w: &World) -> Vec<Case> {
    let mut r = Rng(SEED);
    (0..GENERATED)
        .map(|i| Case {
            file: "generated".into(),
            case: generate(&mut r, &w.own_kinds, i),
        })
        .collect()
}

/// The same input as the server sees it: every audience, and every node held in full.
fn as_server(c: &Value) -> Value {
    let mut c = c.clone();
    set(child(&mut c, "asker"), "sees", s("all"));
    if let Some(Value::Obj(nodes)) = c.get("state").and_then(|st| st.get("nodes")).cloned() {
        let full = nodes
            .into_iter()
            .map(|(k, v)| match v {
                Value::Obj(e) => (
                    k,
                    Value::Obj(e.into_iter().filter(|(f, _)| f != "held").collect()),
                ),
                v => (k, v),
            })
            .collect();
        set(child(&mut c, "state"), "nodes", Value::Obj(full));
    }
    c
}

fn kind_of<'a>(kinds: &'a Value, c: &Value, node: &str) -> Option<&'a Value> {
    let k = c
        .get("state")?
        .get("nodes")?
        .get(node)?
        .get("kind")?
        .str()?;
    kinds.get(k)
}

#[test]
fn a1_a3_a4_every_case_gives_its_expected_verdict_and_carries_its_read_set() {
    let w = world();
    let mut cases = generated(&w);
    let hand = w.hand.len();
    cases.extend(w.hand);
    let mut wrong = Vec::new();
    let mut tally = std::collections::BTreeMap::new();
    let mut lines = String::new();
    for Case { file, case } in &cases {
        let v = verdict_of(&w.kinds, case);
        // A3: every verdict carries its read set, and a refusal names a reason in the closed list.
        assert!(
            v.get("read").and_then(Value::arr).is_some(),
            "{file}: no read set: {}",
            v.to_json()
        );
        if let Some(reason) = v.get("reason").and_then(Value::str) {
            assert!(REASONS.contains(&reason), "{reason}");
        }
        let miss = mismatches(case.get("expect").unwrap(), &v);
        if !miss.is_empty() {
            wrong.push(format!(
                "{file} {}: {miss:?} expected {} got {}",
                case.get("name").unwrap().to_json(),
                case.get("expect").unwrap().to_json(),
                v.to_json()
            ));
        }
        let key = format!(
            "{} {}",
            v.get("verdict").and_then(Value::str).unwrap(),
            v.get("reason").and_then(Value::str).unwrap_or("")
        );
        *tally.entry(key).or_insert(0) += 1;
        lines.push_str(&format!(
            "{file}:{}\t{}\n",
            case.get("name").and_then(Value::str).unwrap(),
            v.to_json()
        ));
    }
    println!(
        "a1: {} cases: {GENERATED} generated (seed {SEED}), {hand} from files ({} Soul Actions)",
        cases.len(),
        w.sa_cases
    );
    println!("a1: verdicts {tally:?}");
    assert!(
        wrong.is_empty(),
        "{} of {} cases disagree:\n{}",
        wrong.len(),
        cases.len(),
        wrong.join("\n")
    );
    assert!(cases.len() >= 10_000 && w.sa_cases > 0);

    // The run the WASM build repeats in Node (v2/tools/ci.sh): every case under its file's name, and the answers.
    let doc_cases = cases
        .iter()
        .map(|Case { file, case }| {
            let mut c = case.clone();
            set(
                &mut c,
                "name",
                s(&format!(
                    "{file}:{}",
                    case.get("name").and_then(Value::str).unwrap()
                )),
            );
            c
        })
        .collect();
    let doc = obj(vec![
        ("kinds".into(), w.kinds.clone()),
        ("cases".into(), Value::Arr(doc_cases)),
    ])
    .to_json();
    let native = rules_run(&doc);
    assert_eq!(native, lines, "rules_run answers each case as decide does");
    let out = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("rules");
    fs::create_dir_all(&out).unwrap();
    fs::write(out.join("run.json"), &doc).unwrap();
    fs::write(out.join("native.txt"), &native).unwrap();
    println!(
        "a1: wrote target/tmp/rules/run.json ({} bytes) and native.txt for the WASM build",
        doc.len()
    );
}

#[test]
fn a2_unknown_only_for_a_field_outside_the_audience_or_a_node_held_at_an_index_level() {
    let w = world();
    let mut cases = generated(&w);
    cases.extend(w.hand);
    let (mut unknown, mut by_audience, mut by_index, mut no_pose) = (0, 0, 0, 0);
    for Case { file, case } in &cases {
        let client = verdict_of(&w.kinds, case);
        let server = verdict_of(&w.kinds, &as_server(case));
        let (cv, sv) = (
            client.get("verdict").unwrap(),
            server.get("verdict").unwrap(),
        );
        let name = case.get("name").unwrap().to_json();
        // An input with no pose for the thing a reach measures to is unknown to everyone, the server too: no copy is
        // involved, so it is not A2's case (SA #3012). It must name that pose and the pose must be missing.
        if sv == &s("unknown") && server.get("field") == Some(&s("at_mm")) {
            let node = server.get("node").and_then(Value::str).unwrap();
            let nodes = case.get("state").and_then(|st| st.get("nodes"));
            assert!(
                nodes
                    .and_then(|n| n.get(node))
                    .and_then(|n| n.get("at_mm"))
                    .is_none(),
                "{file} {name}"
            );
            no_pose += 1;
            continue;
        }
        assert_ne!(
            sv,
            &s("unknown"),
            "{file} {name}: the server is always definite"
        );
        if cv != &s("unknown") {
            assert_eq!(
                cv, sv,
                "{file} {name}: a definite client verdict is the server's"
            );
            continue;
        }
        unknown += 1;
        // Exactly the two causes, checked against the data, not against the verdict's own say-so.
        let node = client.get("node").and_then(Value::str).unwrap();
        let held = case
            .get("state")
            .and_then(|st| st.get("nodes"))
            .and_then(|n| n.get(node))
            .and_then(|n| n.get("held"));
        let kind = kind_of(&w.kinds, case, node).unwrap();
        let sees = case.get("asker").unwrap().get("sees").unwrap();
        let audience = if let Some(field) = client.get("field").and_then(Value::str) {
            let closed = kind.get("closed").filter(|c| {
                c.get("fields")
                    .and_then(Value::arr)
                    .is_some_and(|f| f.contains(&s(field)))
            });
            closed.map_or_else(
                || {
                    kind.get("state")
                        .and_then(|st| st.get(field))
                        .and_then(|d| d.get("audience"))
                },
                |c| c.get("audience"),
            )
        } else if let Some(link) = client.get("link").and_then(Value::str) {
            kind.get("links")
                .and_then(|l| l.get(link))
                .and_then(|d| d.get("audience"))
        } else {
            None
        };
        let outside = audience.is_some_and(|a| !seen(sees, a));
        // An index-held node includes the pose of a thing whose point `within_reach` measures (`field: at_mm`).
        let index = held == Some(&s("index"));
        assert!(
            outside || index,
            "{file} {name}: unknown with neither cause: {}",
            client.to_json()
        );
        assert_eq!(
            client.get("held").is_some(),
            !outside && index,
            "{file} {name}: `held` names the index cause"
        );
        if outside {
            by_audience += 1;
        } else {
            by_index += 1;
        }
    }
    println!(
        "a2: {} cases; {unknown} unknown to the client and definite to the server: {by_audience} outside the audience, {by_index} held at an index level; {no_pose} with no pose in the input, unknown to both",
        cases.len()
    );
    assert!(by_audience > 0 && by_index > 0);
}

#[test]
fn never_panics_and_refuses_what_it_cannot_read() {
    let w = world();
    for junk in [
        "null",
        "{}",
        "[]",
        "{\"act\":{},\"state\":{},\"kinds\":{},\"asker\":{}}",
        "{\"kinds\":{\"a\":1},\"act\":{\"this\":\"x\",\"form\":\"y\"},\"state\":{\"actor\":\"b\",\"nodes\":{\"x\":{\"kind\":\"a\"}}},\"asker\":{\"sees\":[]}}",
    ] {
        let v = replica::rules::rules_decide(junk);
        assert!(v.contains("\"reason\":\"bad_input\""), "{junk}: {v}");
    }
    // Too many hands is refused by name: the one list an asker states.
    let hands: Vec<(String, Value)> = (0..9).map(|k| (format!("h{k}"), Value::Null)).collect();
    let cup = obj(vec![("kind".into(), s("r2:cup"))]);
    let body = obj(vec![("hands".into(), obj(hands))]);
    let c = obj(vec![
        (
            "act".into(),
            obj(vec![("this".into(), s("n1")), ("form".into(), s("take"))]),
        ),
        (
            "state".into(),
            obj(vec![
                ("actor".into(), s("b1")),
                (
                    "nodes".into(),
                    obj(vec![("n1".into(), cup), ("b1".into(), body)]),
                ),
            ]),
        ),
        (
            "asker".into(),
            obj(vec![("sees".into(), Value::Arr(vec![]))]),
        ),
    ]);
    let v = verdict_of(&w.kinds, &c);
    assert_eq!(
        v.get("detail").and_then(|d| d.get("what")),
        Some(&s("too_many_hands")),
        "{}",
        v.to_json()
    );
    // Nested deeper than the parser reads is refused, not a stack overflow.
    let deep = "[".repeat(100_000);
    assert!(replica::rules::rules_decide(&deep).contains("bad_input"));
}

/// The drift report: the snapshot's comparison, run on the live Soul Actions cases. It prints every disagreement and
/// never fails, so a Soul Actions change shows up in the daily full run (`v2/tools/ci.sh`) without failing v2.
#[test]
#[ignore = "a report, not a check: v2/tools/ci.sh runs it in the daily full run"]
fn drift_against_the_live_form_rules_cases() {
    let Some((mut kinds, cases)) = sa_world(&live_root(), "live form-rules/cases") else {
        println!("drift: packages/form-rules/cases is not in this tree; nothing to compare");
        return;
    };
    load_kinds(&[crate_dir().join("cases/kinds")], &mut kinds);
    let kinds = Value::Obj(kinds);
    let mut drift = 0;
    for Case { file, case } in &cases {
        let v = verdict_of(&kinds, case);
        let miss = mismatches(case.get("expect").unwrap(), &v);
        if !miss.is_empty() {
            drift += 1;
            println!(
                "drift: {file} {}: {miss:?} expected {} got {}",
                case.get("name").unwrap().to_json(),
                case.get("expect").unwrap().to_json(),
                v.to_json()
            );
        }
    }
    println!(
        "drift: {drift} of {} live Soul Actions cases disagree with this library (the snapshot's commit is in cases/form-rules-snapshot/SOURCE)",
        cases.len()
    );
}
