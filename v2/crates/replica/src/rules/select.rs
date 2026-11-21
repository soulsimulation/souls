//! A thing argument the act leaves out, chosen by its selector as worldd chooses it (`select_thing`, #3914) and as
//! `@souls/form-rules` does (`chosenSlots`, `selectThing`): the same set, order and rank, read from the input alone.

use super::json::Value;
use super::{has, sees_audience, sorted};

/// How far from the anchor a thing `here` may be, mm (worldd `HERE_REACH_MM`).
pub const HERE_REACH_MM: i128 = 20_000;

/// What the choice gives the rules.
pub(super) enum Choice {
    /// Nothing to choose: the act as given.
    Same,
    /// The act with the chosen things added to its arguments.
    Args(Value),
    /// A thing its selector finds none of, by argument name; told only once every need holds.
    None(String),
    /// A choice inside a closed container the asker does not see into: the world's to make.
    Unknown(String),
}

/// The nodes a node holds as the input states them: its children, what rests loose in it and its slots' occupants.
fn held(n: Option<&Value>) -> Vec<String> {
    let Some(n) = n else { return Vec::new() };
    let ids = |v: Option<&Value>| -> Vec<String> {
        v.and_then(Value::arr)
            .unwrap_or(&[])
            .iter()
            .filter_map(|x| x.str().map(str::to_owned))
            .collect()
    };
    let mut out = ids(n.get("children"));
    out.extend(ids(n.get("loose")));
    for (_, l) in n.get("slots").and_then(Value::obj).unwrap_or(&[]) {
        out.extend(ids(Some(l)));
    }
    out
}

fn at(v: Option<&Value>) -> Option<[i128; 3]> {
    let a = v?.arr()?;
    let n = |k: usize| match a.get(k) {
        Some(Value::Int(n)) => Some(*n),
        None => Some(0),
        _ => None,
    };
    Some([n(0)?, n(1)?, n(2)?])
}

/// `selectThing`: the id, `Some(None)` when none qualifies, `None` for a selector this does not read.
fn select_thing(select: &Value, this: &str, state: &Value) -> Option<Option<String>> {
    let nodes = state.get("nodes");
    let actor = state.get("actor").and_then(Value::str).unwrap_or_default();
    if select.get("of").and_then(Value::str) != Some("things") {
        return None;
    }
    let holder = |id: &str| -> Option<String> {
        sorted(nodes)
            .into_iter()
            .find(|k| held(has(nodes, k)).iter().any(|h| h == id))
            .map(str::to_owned)
    };
    let within = select.get("in").and_then(Value::str);
    let set = match within {
        Some("this") => Some(this.to_owned()),
        Some("here") => holder(actor).or_else(|| holder(this)),
        Some("parent") => holder(this),
        _ => return None,
    };
    let anchor = match select.get("anchor").and_then(Value::str) {
        Some("me") => actor,
        Some("this") => this,
        _ => return None,
    };
    let furthest = match select.get("order").and_then(Value::str) {
        Some("nearest") => false,
        Some("furthest") => true,
        _ => return None,
    };
    let rank = match select.get("rank") {
        Some(Value::Int(n)) if *n >= 1 && *n <= (1 << 53) => Some(usize::try_from(*n).ok()?),
        Some(Value::Str(s)) if s == "last" => None,
        _ => return None,
    };
    let set = set?;
    has(nodes, &set)?;
    let here = within == Some("here");
    let kind = select.get("kind").and_then(Value::str);
    let from = at(has(has(nodes, anchor), "at_mm"));
    let mut ids = held(has(nodes, &set));
    if here {
        for (_, h) in has(has(nodes, actor), "hands")
            .and_then(Value::obj)
            .unwrap_or(&[])
        {
            if let Some(h) = h.str() {
                ids.push(h.to_owned());
            }
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    let reach = HERE_REACH_MM * HERE_REACH_MM;
    let mut ranked: Vec<(Option<i128>, String)> = ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .filter(|id| id != this && id != actor)
        .filter_map(|id| {
            let n = has(nodes, &id)?;
            let body = n.get("hands").is_some() || has(n.get("links"), "souls:body-of").is_some();
            if body || kind.is_some_and(|k| n.get("kind").and_then(Value::str) != Some(k)) {
                return None;
            }
            let d = from
                .zip(at(n.get("at_mm")))
                .map(|(a, b)| (0..3).map(|k| (a[k] - b[k]) * (a[k] - b[k])).sum::<i128>());
            Some((d, id))
        })
        .filter(|(d, _)| !here || d.is_none_or(|d| d <= reach))
        .collect();
    ranked.sort_by(|(da, a), (db, b)| {
        let by = match (da, db) {
            (Some(x), Some(y)) if furthest => y.cmp(x),
            (Some(x), Some(y)) => x.cmp(y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        };
        by.then(a.cmp(b))
    });
    let pick = match rank {
        Some(r) => ranked.get(r - 1),
        None => ranked.last(),
    };
    Some(pick.map(|(_, id)| id.clone()))
}

/// `chosenSlots`' thing half: each thing argument the act leaves out that its form describes by a selector.
pub(super) fn chosen(kinds: &Value, act: &Value, state: &Value, sees: Option<&Value>) -> Choice {
    let this = act.get("this").and_then(Value::str).unwrap_or_default();
    let Some(entry) = has(has(state.get("nodes"), this), "kind")
        .and_then(Value::str)
        .and_then(|k| kinds.get(k))
    else {
        return Choice::Same;
    };
    let Some(form) = has(
        entry.get("forms"),
        act.get("form").and_then(Value::str).unwrap_or_default(),
    ) else {
        return Choice::Same;
    };
    let given = act.get("args").filter(|a| !matches!(a, Value::Null));
    let mut args: Vec<(String, Value)> = given
        .and_then(Value::obj)
        .map(<[_]>::to_vec)
        .unwrap_or_default();
    let mut changed = false;
    for key in sorted(form.get("takes")) {
        let Some(t) = has(form.get("takes"), key) else {
            continue;
        };
        let Some(select) = t.get("select") else {
            continue;
        };
        if has(given, key).is_some() || t.get("type").and_then(Value::str) != Some("thing") {
            continue;
        }
        if select.get("in").and_then(Value::str) == Some("this")
            && let Some(closed) = entry.get("closed")
            && !sees_audience(sees, closed.get("audience"))
        {
            return Choice::Unknown(this.to_owned());
        }
        match select_thing(select, this, state) {
            None => {}
            Some(None) => return Choice::None(key.to_owned()),
            Some(Some(id)) => {
                args.push((key.to_owned(), Value::Str(id)));
                changed = true;
            }
        }
    }
    if !changed {
        return Choice::Same;
    }
    let mut a: Vec<(String, Value)> = act.obj().map(<[_]>::to_vec).unwrap_or_default();
    a.retain(|(k, _)| k != "args");
    a.push(("args".to_owned(), Value::Obj(args)));
    Choice::Args(Value::Obj(a))
}
