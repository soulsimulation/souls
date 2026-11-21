//! Who may do a form (Engine v2 F6, #2771), beside R2's rules: one closed list, one test, shared by the agent's client
//! (its JSON copy, [`who_may`], natively or in WASM) and the world at commit (`sim::forms::may`, over the tree). It is
//! Soul Actions' `whoMay` (SA-F7a, #2848; `packages/form-rules/src/rules.ts`), case for case.
//!
//! A form's `who` is its own data, so who may is readable on the kind before anyone tries. It is a test on links or on
//! holding, never on a field ([`Who`]):
//!
//! | `who` | passes when | covers |
//! |---|---|---|
//! | `anyone` (the default) | always | owning does not lock |
//! | `holder` | the thing is in one of the actor's hands (holding is a parent, T2) | pouring what you hold |
//! | `world` | never for a Soul's act: only a timer starts it | what happens on its own |
//! | `{"link": <type>}` | the actor, or the actor's Soul, is an end of a link of that type on the thing | its owner, a member, the Soul whose turn it is, a role, a relation its creator set |
//!
//! A public or private mark is not a separate test: a thing that may be either has two forms, one `anyone` with a
//! `state` need on the mark and one `{"link": "owner"}`. No expressions: a need beyond the list goes to the hatch (F8).
//!
//! The answer is yes, no naming the rule and (for a link) its ends, or unknown when the link's audience is not the
//! asker's: a hidden members list is neither read nor named. In words ([`sentence`]), a refusal names the rule, and
//! the ends' names only when the asker may see them. Ends are Soul or body ids, never an account id.

use crate::rules::json::Value;
use crate::rules::{MAX_HANDS, sees_audience};

/// The closed list of `who` tests.
pub const WHO: [&str; 4] = ["anyone", "holder", "world", "link"];

/// A form's `who`, one of the closed list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Who {
    Anyone,
    Holder,
    World,
    /// A link type the thing's kind declares.
    Link(String),
}

impl Who {
    /// A form's `who`: absent (or null) is `anyone`; `None` for anything outside the closed list.
    pub fn read(form: &Value) -> Option<Who> {
        match form.get("who") {
            None | Some(Value::Null) => Some(Who::Anyone),
            Some(Value::Str(s)) => match s.as_str() {
                "anyone" => Some(Who::Anyone),
                "holder" => Some(Who::Holder),
                "world" => Some(Who::World),
                _ => None,
            },
            Some(Value::Obj(o)) if o.len() == 1 && o[0].0 == "link" => {
                o[0].1.str().map(|t| Who::Link(t.to_owned()))
            }
            _ => None,
        }
    }

    /// The rule as the form writes it.
    pub fn to_value(&self) -> Value {
        match self {
            Who::Anyone => Value::s("anyone"),
            Who::Holder => Value::s("holder"),
            Who::World => Value::s("world"),
            Who::Link(t) => Value::object([("link", Value::s(t))]),
        }
    }
}

/// The test's answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    Yes,
    No,
    /// The link's audience is not the asker's.
    Unknown,
}

/// The one test, for both sides. `holds`: the thing is in one of the actor's hands. `ends`: the ends of the rule's
/// links at the thing, or `None` when the asker may not see them. `soul`: the actor's Soul, when the actor is a body
/// linked to one.
pub fn test<T: PartialEq>(
    who: &Who,
    actor: &T,
    soul: Option<&T>,
    holds: bool,
    ends: Option<&[T]>,
) -> Answer {
    let yes = |b: bool| if b { Answer::Yes } else { Answer::No };
    match who {
        Who::Anyone => Answer::Yes,
        Who::World => Answer::No,
        Who::Holder => yes(holds),
        Who::Link(_) => match ends {
            None => Answer::Unknown,
            Some(e) => yes(e.iter().any(|x| x == actor || soul == Some(x))),
        },
    }
}

/// Who may, in words, for a refusal: the rule, and the names of its ends when the asker may see them (`None`: it may
/// not, and the group is named alone).
pub fn sentence(who: &Who, names: Option<&[String]>) -> String {
    match who {
        Who::Anyone => "anyone".to_owned(),
        Who::Holder => "whoever holds it".to_owned(),
        Who::World => "nobody: it happens on its own".to_owned(),
        Who::Link(t) => match names {
            Some([]) => format!("its {t}, and it has none now"),
            Some(n) => format!("its {t}, {}", n.join(" and ")),
            None => format!("its {t}"),
        },
    }
}

// --- The client's check, on its JSON copy (R2's input) -------------------------------------------------------------

fn sorted(o: Option<&Value>) -> Vec<&str> {
    let mut keys: Vec<&str> = o
        .and_then(Value::obj)
        .map(|e| e.iter().map(|(k, _)| k.as_str()).collect())
        .unwrap_or_default();
    keys.sort_unstable();
    keys.dedup();
    keys
}

fn read_pair(address: String, v: Value) -> Value {
    Value::Arr(vec![Value::Str(address), v])
}

/// Whether the actor may do `act` at all, before its needs, on R2's input (`{kinds, act, state, asker}`): `yes`;
/// `no` with `reason` `not_permitted` (and, for a link, `detail: {link, ends}`) or `bad_input`; or `unknown`, naming
/// the node and link the asker cannot see. Every answer carries `who` and `read`. Never panics.
pub fn who_may(input: &Value) -> Value {
    who_may_parts(
        input.get("kinds"),
        input.get("act"),
        input.get("state"),
        input.get("asker"),
    )
}

/// [`who_may`] with its four parts given apart.
pub fn who_may_parts(
    kinds: Option<&Value>,
    act: Option<&Value>,
    state: Option<&Value>,
    asker: Option<&Value>,
) -> Value {
    let mut read: Vec<Value> = Vec::new();
    let bad = |what: &str, extra: Vec<(String, Value)>, read: Vec<Value>| {
        let mut detail = vec![("what".to_owned(), Value::s(what))];
        detail.extend(extra);
        Value::object([
            ("verdict", Value::s("no")),
            ("reason", Value::s("bad_input")),
            ("who", Value::Null),
            ("detail", Value::Obj(detail)),
            ("read", Value::Arr(read)),
        ])
    };
    let (Some(act), Some(state), Some(kinds), Some(_)) = (
        act.filter(|a| a.truthy()),
        state.filter(|s| s.truthy()),
        kinds.filter(|k| k.truthy()),
        asker.filter(|a| a.truthy()),
    ) else {
        return bad("malformed", vec![], read);
    };
    let nodes = state.get("nodes");
    let this = act.get("this").and_then(Value::str);
    let node = |id: Option<&str>| id.and_then(|i| nodes.and_then(|n| n.get(i)));
    let Some(thing) = node(this) else {
        let at = act.get("this").cloned().unwrap_or(Value::Null);
        return bad("no_such_node", vec![("node".into(), at)], read);
    };
    let this = this.unwrap_or_default();
    let entry = thing
        .get("kind")
        .and_then(Value::str)
        .and_then(|k| kinds.get(k));
    let Some(entry) = entry else {
        let k = thing.get("kind").cloned().unwrap_or(Value::Null);
        return bad("no_such_kind", vec![("kind".into(), k)], read);
    };
    let form = act
        .get("form")
        .and_then(Value::str)
        .and_then(|f| entry.get("forms").and_then(|fs| fs.get(f)));
    let Some(form) = form else {
        let f = act.get("form").cloned().unwrap_or(Value::Null);
        return bad("no_such_form", vec![("form".into(), f)], read);
    };
    let actor_id = state.get("actor").and_then(Value::str);
    let Some(actor) = node(actor_id) else {
        let a = state.get("actor").cloned().unwrap_or(Value::Null);
        return bad("no_such_node", vec![("node".into(), a)], read);
    };
    let actor_id = actor_id.unwrap_or_default();
    let written = form.get("who").cloned().unwrap_or(Value::s("anyone"));
    let Some(who) = Who::read(form) else {
        return bad("unknown_who", vec![("who".into(), written)], read);
    };
    let answer = |verdict: &str, extra: Vec<(&str, Value)>, read: Vec<Value>| {
        let mut o = vec![
            ("verdict".to_owned(), Value::s(verdict)),
            ("who".to_owned(), written.clone()),
        ];
        o.extend(extra.into_iter().map(|(k, v)| (k.to_owned(), v)));
        o.push(("read".to_owned(), Value::Arr(read)));
        Value::Obj(o)
    };
    let refuse = |detail: Vec<(String, Value)>, read: Vec<Value>| {
        answer(
            "no",
            vec![
                ("reason", Value::s("not_permitted")),
                ("detail", Value::Obj(detail)),
            ],
            read,
        )
    };
    let (holds, ends, soul) = match &who {
        Who::Anyone | Who::World => (false, None, None),
        Who::Holder => {
            let h = actor.get("hands");
            let names = sorted(h);
            if h.is_some_and(|h| h.obj().is_none()) || names.len() > MAX_HANDS {
                return bad("too_many_hands", vec![], read);
            }
            for n in &names {
                let v = h.and_then(|h| h.get(n)).cloned().unwrap_or(Value::Null);
                read.push(read_pair(format!("{actor_id}/hand/{n}"), v));
            }
            let holds = names
                .iter()
                .any(|n| h.and_then(|h| h.get(n)).and_then(Value::str) == Some(this));
            (holds, None, None)
        }
        Who::Link(t) => {
            let Some(def) = entry.get("links").and_then(|l| l.get(t)) else {
                return bad("no_such_link", vec![("link".into(), Value::s(t))], read);
            };
            if !sees_audience(asker.and_then(|a| a.get("sees")), def.get("audience")) {
                return answer(
                    "unknown",
                    vec![("node", Value::s(this)), ("link", Value::s(t))],
                    read,
                );
            }
            let list = thing
                .get("links")
                .and_then(|l| l.get(t))
                .and_then(Value::arr)
                .unwrap_or(&[]);
            let most = match def.get("most") {
                Some(Value::Int(n)) if (0..=(1 << 53) - 1).contains(n) => Some(*n),
                _ => None,
            };
            if most.is_none_or(|m| i128::try_from(list.len()).unwrap_or(i128::MAX) > m) {
                return bad("link_over_most", vec![("link".into(), Value::s(t))], read);
            }
            let souls = actor
                .get("links")
                .and_then(|l| l.get("soul"))
                .and_then(Value::arr);
            let soul = match souls {
                Some([Value::Str(s)]) => Some(s.as_str()),
                _ => None,
            };
            read.push(read_pair(
                format!("{actor_id}/soul"),
                soul.map_or(Value::Null, Value::s),
            ));
            let n = def.get("n").map_or("undefined".to_owned(), Value::to_json);
            read.push(read_pair(
                format!("{this}/link/{n}/ends"),
                Value::Arr(list.to_vec()),
            ));
            let ends: Vec<Option<&str>> = list.iter().map(Value::str).collect();
            (false, Some(ends), soul)
        }
    };
    let actor_ref = Some(actor_id);
    match test(
        &who,
        &actor_ref,
        soul.map(Some).as_ref(),
        holds,
        ends.as_deref(),
    ) {
        Answer::Yes => answer("yes", vec![], read),
        Answer::Unknown => unreachable!("an unseen link answered above"),
        Answer::No => match (&who, ends) {
            (Who::Link(t), Some(_)) => {
                let list = thing
                    .get("links")
                    .and_then(|l| l.get(t))
                    .cloned()
                    .filter(|v| v.arr().is_some())
                    .unwrap_or(Value::Arr(vec![]));
                refuse(
                    vec![("link".into(), Value::s(t)), ("ends".into(), list)],
                    read,
                )
            }
            _ => refuse(vec![], read),
        },
    }
}

/// [`who_may`] on JSON text, answering JSON text: what the client calls from the WASM build.
#[cfg_attr(
    all(target_arch = "wasm32", not(feature = "checker")),
    wasm_bindgen::prelude::wasm_bindgen
)]
pub fn who_may_decide(input: &str) -> String {
    match crate::rules::json::parse(input) {
        Ok(v) => who_may(&v).to_json(),
        Err(_) => who_may(&Value::Null).to_json(),
    }
}

// --- Ownership marks (0.131 parity, #3700) ---------------------------------------------------------------------
//
// Today's `own` and `access`: a thing or a place may carry an owner (a Soul, a group, the world's god) and an access
// mark, set by the creator's edits as two generic fields. A thing without either takes its nearest marked ancestor's,
// so a private house makes everything in it private. A private thing refuses every Soul but its owner (`object.private`,
// [`private_to`]), before its form's own `who`; groups have no members in this world (relationships are off, as they
// are today without LAYERS), so a group's private thing refuses everyone. No marks anywhere: nothing changes.

/// A node's owner: an id (a Soul's), `group:<name>`, `owner:god`, or 0 for none.
pub const F_OWNER: u64 = 97;
/// A node's access: 0 none (its ancestors' holds), 1 public, 2 private.
pub const F_ACCESS: u64 = 98;

/// Who owns a marked thing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Owner {
    Soul(crate::ids::Id),
    Group(String),
    God,
}

impl Owner {
    fn read(v: &crate::encode::Value) -> Result<Option<Owner>, String> {
        use crate::encode::Value as V;
        match v {
            V::Uint(0) => Ok(None),
            V::Text(t) if t.as_str() == "owner:god" => Ok(Some(Owner::God)),
            V::Text(t) if t.as_str().starts_with("group:") && t.as_str().len() > 6 => {
                Ok(Some(Owner::Group(t.as_str()[6..].to_owned())))
            }
            V::Array(_) => crate::effects::read_id(v)
                .map(|id| Some(Owner::Soul(id)))
                .map_err(|_| "an owner id is [scope, counter]".to_owned()),
            _ => Err("an owner is a Soul's id, group:<name>, owner:god or 0 for none".to_owned()),
        }
    }

    /// The owner in a refusal's words.
    pub fn words(&self) -> String {
        match self {
            Owner::Soul(id) => format!("Soul {}'s", crate::world_model::show(*id)),
            Owner::Group(g) => format!("the {g} group's"),
            Owner::God => "the world's".to_owned(),
        }
    }
}

/// Checks a value written to [`F_OWNER`] or [`F_ACCESS`]; other fields pass. The edit check refuses a bad one
/// `edit.owner-malformed`.
pub fn check_mark(field: u64, v: &crate::encode::Value) -> Result<(), String> {
    match field {
        F_OWNER => Owner::read(v).map(|_| ()),
        F_ACCESS => match v {
            crate::encode::Value::Uint(0..=2) => Ok(()),
            _ => Err("access is 0 (none), 1 (public) or 2 (private)".to_owned()),
        },
        _ => Ok(()),
    }
}

/// A node's ownership as it holds: its own marks, else its nearest marked ancestor's: the owner, whether it is
/// private, and the node that carries the mark. `None` when nothing above it is marked.
pub fn ownership(
    tree: &crate::tree::Tree,
    node: crate::ids::Id,
) -> Option<(Option<Owner>, bool, crate::ids::Id)> {
    let mut at = tree.handle(node).and_then(|h| tree.node(h));
    while let Some(n) = at {
        let f = n.fields();
        let owner = f.get(&F_OWNER).and_then(|v| Owner::read(v).ok()).flatten();
        let access = match f.get(&F_ACCESS) {
            Some(crate::encode::Value::Uint(a)) => *a,
            _ => 0,
        };
        if owner.is_some() || access != 0 {
            return Some((owner, access == 2, n.id()));
        }
        at = n
            .parent()
            .and_then(|p| tree.handle(p))
            .and_then(|h| tree.node(h));
    }
    None
}

/// Whether `node` is private to someone other than `soul` (the asker's Soul, or its body with none): the refusal's
/// words when it is (`object.private`), `None` when the asker may use it.
pub fn private_to(
    tree: &crate::tree::Tree,
    node: crate::ids::Id,
    soul: crate::ids::Id,
) -> Option<String> {
    let (owner, private, _) = ownership(tree, node)?;
    if !private || owner == Some(Owner::Soul(soul)) {
        return None;
    }
    Some(match owner {
        Some(o) => format!("it is {} and private", o.words()),
        None => "it is private".to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::json::{parse, same};
    use std::path::{Path, PathBuf};

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

    /// The pinned Soul Actions snapshot's kinds and who-may cases (R2's `cases/form-rules-snapshot`).
    fn snapshot() -> (Value, Vec<Value>) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("cases/form-rules-snapshot");
        let mut files = Vec::new();
        json_files(&root.join("content/kinds"), &mut files);
        json_files(&root.join("packages/form-rules/cases/kinds"), &mut files);
        let kinds = files
            .iter()
            .map(|f| read(f))
            .filter_map(|v| Some((v.get("kind")?.str()?.to_owned(), v)))
            .collect();
        let mut cases = Vec::new();
        let mut who = Vec::new();
        json_files(&root.join("packages/form-rules/cases/who"), &mut who);
        for f in who {
            cases.extend(
                read(&f)
                    .get("cases")
                    .and_then(Value::arr)
                    .unwrap_or(&[])
                    .to_vec(),
            );
        }
        (Value::Obj(kinds), cases)
    }

    #[test]
    fn every_soul_actions_who_case_gives_its_expected_answer() {
        let (kinds, cases) = snapshot();
        assert!(cases.len() >= 20, "{} who cases", cases.len());
        for c in &cases {
            let got = who_may_parts(Some(&kinds), c.get("act"), c.get("state"), c.get("asker"));
            let expect = c.get("expect").expect("expect");
            for (k, v) in expect.obj().expect("an object") {
                assert!(
                    got.get(k).is_some_and(|w| same(v, w)),
                    "{}: {k}: expected {} got {}",
                    c.get("name").map_or(String::new(), Value::to_json),
                    expect.to_json(),
                    got.to_json()
                );
            }
        }
        println!(
            "who_may: {} Soul Actions who cases, each as expected",
            cases.len()
        );
    }

    #[test]
    fn never_panics_and_refuses_what_it_cannot_read() {
        for text in [
            "null",
            "1",
            "{}",
            "[]",
            r#"{"act":{},"state":{},"kinds":{},"asker":{}}"#,
        ] {
            let v = parse(&who_may_decide(text)).expect("JSON");
            assert_eq!(v.get("verdict").and_then(Value::str), Some("no"), "{text}");
        }
    }

    #[test]
    fn the_sentence_names_ends_only_when_seen() {
        let who = Who::Link("owner".into());
        assert_eq!(sentence(&who, Some(&["Ana".to_owned()])), "its owner, Ana");
        assert_eq!(sentence(&who, None), "its owner");
    }
}
