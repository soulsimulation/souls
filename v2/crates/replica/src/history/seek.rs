//! Seeking (Engine v2 V4, #2713): the public state at a past moment, from the nearest bundle at or before it. A bundle
//! starts with the public snapshot at its window's start; its records up to the moment are applied on top. A window
//! with no public record has no bundle, so the state through it is the last earlier bundle's at its end. Pure: the
//! fetching is the caller's (`v2/tools/archive` for the bench, the page through V2's path), and it runs the same in
//! WASM.

use std::collections::BTreeMap;

use crate::effects::{Effect, LinkState, NodeState, Refusal, State, read_id};
use crate::encode::{Name, Value};
use crate::ids::Id;
use crate::world_model::{Audience, End};

use super::{Bundle, DayIndex};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

fn bad<T>(what: &str) -> R<T> {
    refuse("history-bad", what.to_owned())
}

fn pairs(v: Option<&Value>, what: &str) -> R<Vec<(Id, BTreeMap<u64, Value>)>> {
    let Some(Value::Array(rows)) = v else {
        return bad(what);
    };
    rows.iter()
        .map(|r| match r {
            Value::Array(p) => match p.as_slice() {
                [id, Value::Map(m)] => Ok((read_id(id)?, m.clone())),
                _ => bad(what),
            },
            _ => bad(what),
        })
        .collect()
}

fn name(v: Option<&Value>, what: &str) -> R<Name> {
    match v {
        Some(Value::Text(n)) => Ok(n.clone()),
        _ => bad(what),
    }
}

/// Inserts `[[id, node], ...]` and `[[id, link], ...]` in T6's state layout into `s`, every one public.
fn insert(s: &mut State, nodes: Option<&Value>, links: Option<&Value>) -> R<()> {
    for (id, m) in pairs(nodes, "a snapshot's nodes")? {
        let fields = match m.get(&5) {
            Some(Value::Map(f)) => f.clone(),
            None => BTreeMap::new(),
            _ => return bad("a node's fields"),
        };
        let slot = match m.get(&3) {
            Some(Value::Uint(u)) => Some(*u),
            None => None,
            _ => return bad("a node's slot"),
        };
        s.nodes.insert(
            id,
            NodeState {
                kind: name(m.get(&1), "a node's kind")?,
                parent: m.get(&2).map(read_id).transpose()?,
                slot,
                audience: Audience::Everyone,
                fields,
                place: m.get(&6).cloned(),
                motion: m.get(&7).cloned(),
            },
        );
    }
    for (id, m) in pairs(links, "a snapshot's links")? {
        let Some(Value::Array(ends)) = m.get(&2) else {
            return bad("a link's ends");
        };
        let [a, b] = ends.as_slice() else {
            return bad("a link has two ends");
        };
        s.links.insert(
            id,
            LinkState {
                ty: name(m.get(&1), "a link's type")?,
                ends: [read_id(a)?, read_id(b)?],
                owner: if m.get(&3) == Some(&Value::Uint(1)) {
                    End::Second
                } else {
                    End::First
                },
                audience: Audience::Everyone,
            },
        );
    }
    Ok(())
}

/// The public state a bundle's snapshot holds: its window's start. The root is its node with no parent.
pub fn snapshot_state(snapshot: &Value) -> R<State> {
    let Value::Map(m) = snapshot else {
        return bad("a snapshot is a map");
    };
    let rows = pairs(m.get(&1), "a snapshot's nodes")?;
    let Some((root, n)) = rows.iter().find(|(_, n)| !n.contains_key(&2)) else {
        return bad("a snapshot holds its root");
    };
    let mut s = State::start(*root, name(n.get(&1), "the root's kind")?);
    s.nodes.clear();
    insert(&mut s, m.get(&1), m.get(&2))?;
    Ok(s)
}

/// The public state at world time `at` (µs): the bundle's snapshot with its records at or before `at` applied. The
/// view's records are T6 entries the audience may see, the thinned motion samples left out (R3's `sampled` level),
/// or the subtree an arrival brought (`{0: ...}`), inserted as it stood.
pub fn state_at(bundle: &Bundle, header: &crate::effects::Header, at: i64) -> R<State> {
    let mut s = snapshot_state(&bundle.snapshot)?;
    let Value::Map(view) = &bundle.view else {
        return bad("a view is a map");
    };
    let Some(Value::Array(records)) = view.get(&8) else {
        return bad("a view's records");
    };
    let mut carried = None;
    for r in records {
        if let Value::Map(m) = r
            && let Some(Value::Map(c)) = m.get(&0)
        {
            // It comes just before the arrival it belongs to, and applies with it.
            carried = Some(c);
            continue;
        }
        let e = Effect::read(r.clone())?;
        if e.envelope.at > at {
            break;
        }
        if let Some(c) = carried.take() {
            insert(&mut s, c.get(&2), c.get(&3))?;
        }
        // The view leaves entries out (other audiences, thinned samples): each applies after the last it holds.
        s.next = e.envelope.sequence;
        s.apply_entry(header, &e)?;
    }
    Ok(s)
}

/// The bundle of a day's index that holds `at`: the last that starts at or before it. None when the day has none
/// before `at` (the caller looks at earlier days).
pub fn nearest(ix: &DayIndex, at: i64) -> Option<&(i64, String, [u8; 32])> {
    ix.bundles.iter().rev().find(|(s, _, _)| *s <= at)
}
