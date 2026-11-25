//! An argument the act leaves out, chosen as worldd chooses it and as today's form rules do (`chosenSlots`,
//! `selectThing`), read from the input alone: a body slot from this thing's free ones (worldd `Acts`, #3802), and a
//! thing by its selector (`select_thing`, #3914), the same set, order and rank.

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
    /// A body slot left out with none of this thing's free, by argument name: refused `slot_taken` before any need.
    NoSlot(String),
}

/// `selectsBodySlot`: argument `key` is a slot chosen from this thing's free ones, which the form seats the actor in
/// (a sit or lie step's slot, or a reparent of the actor into it).
fn selects_body_slot(form: &Value, key: &str) -> bool {
    let t = has(form.get("takes"), key);
    let select = t.and_then(|t| t.get("select"));
    if t.and_then(|t| t.get("type")).and_then(Value::str) != Some("slot")
        || has(select, "of").and_then(Value::str) != Some("free_slots")
        // A seat of another thing (`in`: `parent` or `here`, E14b) is the world's to choose (worldd `other_seat`).
        || matches!(has(select, "in").and_then(Value::str), Some("parent" | "here"))
    {
        return false;
    }
    let is_arg = |r: Option<&Value>| has(r, "arg").and_then(Value::str) == Some(key);
    let list = |k: &str| form.get(k).and_then(Value::arr).unwrap_or(&[]);
    list("steps").iter().any(|s| {
        matches!(s.get("step").and_then(Value::str), Some("sit" | "lie")) && is_arg(s.get("slot"))
    }) || list("effects").iter().any(|e| {
        e.get("change").and_then(Value::str) == Some("reparent")
            && e.get("what").and_then(Value::str) == Some("actor")
            && is_arg(e.get("into"))
    })
}

/// `chosenSlots`' body half: each body slot argument left out, the free one nearest the actor (from the slot's stand
/// point, else the slot) when the input places both the actor and this thing, else the first free in the entry's
/// order. `Err` names an argument with no slot free.
fn chosen_slots(
    entry: &Value,
    form: &Value,
    this: &Value,
    actor: Option<&Value>,
    args: &mut Vec<(String, Value)>,
) -> Result<bool, String> {
    let mut changed = false;
    for key in sorted(form.get("takes")) {
        if args.iter().any(|(k, _)| k == key) || !selects_body_slot(form, key) {
            continue;
        }
        let slots = entry.get("slots");
        let free: Vec<&str> = slots
            .and_then(Value::obj)
            .unwrap_or(&[])
            .iter()
            .filter(|(name, d)| {
                let taken = has(this.get("slots"), name)
                    .and_then(Value::arr)
                    .map_or(0, |l| l.len() as i128);
                d.get("admits").and_then(Value::str) == Some("body")
                    && matches!(d.get("most"), Some(Value::Int(m)) if taken < *m)
            })
            .map(|(name, _)| name.as_str())
            .collect();
        let Some(first) = free.first() else {
            return Err(key.to_owned());
        };
        let (origin, me) = (
            at(this.get("at_mm")),
            at(actor.and_then(|a| a.get("at_mm"))),
        );
        let far = |name: &str| -> Option<i128> {
            let d = has(slots, name)?;
            let stand = d
                .get("stand")
                .and_then(Value::str)
                .and_then(|p| has(entry.get("points"), p));
            let p = at(stand.map_or(d.get("at_mm"), |s| s.get("at_mm")))?;
            let (o, m) = (origin?, me?);
            Some((0..3).map(|k| (m[k] - (o[k] + p[k])).pow(2)).sum())
        };
        let mut best = *first;
        for name in &free {
            if let (Some(a), Some(b)) = (far(name), far(best))
                && a < b
            {
                best = name;
            }
        }
        args.push((key.to_owned(), Value::s(best)));
        changed = true;
    }
    Ok(changed)
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

/// `chosenSlots`: each body slot argument the act leaves out (its body half), then each thing argument the act leaves
/// out that its form describes by a selector.
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
    let nodes = state.get("nodes");
    let actor = has(
        nodes,
        state.get("actor").and_then(Value::str).unwrap_or_default(),
    );
    let mut changed = match has(nodes, this).map(|n| chosen_slots(entry, form, n, actor, &mut args))
    {
        Some(Ok(c)) => c,
        Some(Err(key)) => return Choice::NoSlot(key),
        None => false,
    };
    for key in sorted(form.get("takes")) {
        let Some(t) = has(form.get("takes"), key) else {
            continue;
        };
        let Some(select) = t.get("select") else {
            continue;
        };
        if args.iter().any(|(k, _)| k == key) || t.get("type").and_then(Value::str) != Some("thing")
        {
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
