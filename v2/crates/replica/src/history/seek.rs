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
    if let Some(observation) = &bundle.observation {
        return observed_state(bundle, header, observation, at);
    }
    walk_legacy(bundle, header, at, |_, _, _, _| Ok(()))
}

/// Read-only replay hook; application and carried context retain the existing seek semantics.
pub(crate) fn walk_legacy(
    bundle: &Bundle,
    header: &crate::effects::Header,
    at: i64,
    mut visit: impl FnMut(&State, &Effect, Option<&BTreeMap<u64, Value>>, bool) -> R<()>,
) -> R<State> {
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
        visit(&s, &e, carried, false)?;
        if let Some(c) = carried.take() {
            insert(&mut s, c.get(&2), c.get(&3))?;
        }
        // A snapshot holds no timers (they are not public state), so a timer set before the window and cleared in
        // it would be refused (`timer-missing`, 24 Nov: Eden's past on soul.game). Timers change no node or link.
        if matches!(e.body, crate::effects::Body::Timers(_)) {
            visit(&s, &e, None, true)?;
            continue;
        }
        // The view leaves entries out (other audiences, thinned samples): each applies after the last it holds.
        s.next = e.envelope.sequence;
        s.apply_entry(header, &e)?;
        visit(&s, &e, None, true)?;
    }
    Ok(s)
}

/// The bundle of a day's index that holds `at`: the last that starts at or before it. None when the day has none
/// before `at` (the caller looks at earlier days).
pub fn nearest(ix: &DayIndex, at: i64) -> Option<&(i64, String, [u8; 32])> {
    ix.bundles.iter().rev().find(|(s, _, _)| *s <= at)
}

/// The complete public carry context remains in `projection`; the existing history API returns live state only.
fn observed_state(
    bundle: &Bundle,
    header: &crate::effects::Header,
    observation: &Value,
    at: i64,
) -> R<State> {
    if at < bundle.start {
        return bad("observation predates its genuine start");
    }
    let mut selected = None;
    walk_observation(bundle, header, observation, |time, projection, _| {
        if time <= at {
            selected = Some(projection.clone());
        }
        Ok(())
    })?;
    live_observation(
        header,
        &selected.ok_or_else(|| Refusal {
            name: "history-bad",
            detail: "missing baseline".into(),
        })?,
    )
}

/// Validate the existing authorized chain once while exposing each accepted exact-time projection delta.
pub(crate) fn walk_observation(
    bundle: &Bundle,
    header: &crate::effects::Header,
    observation: &Value,
    mut visit: impl FnMut(i64, &Value, Option<&Value>) -> R<()>,
) -> R<(usize, usize)> {
    use crate::stream::public::ProjectionReader;
    let Value::Map(m) = observation else {
        return bad("observation is a map");
    };
    if bundle.header != header.hash().to_bytes()
        || m.get(&1) != Some(&Value::Uint(1))
        || m.get(&2) != Some(&Value::Bytes(header.hash().to_bytes()))
    {
        return bad("observation format or header");
    }

    let projection = m.get(&3).cloned().ok_or_else(|| Refusal {
        name: "history-bad",
        detail: "missing public baseline".into(),
    })?;
    let mut reader = ProjectionReader::new(header, projection)?;
    let Some(Value::Array(cursor)) = m.get(&4) else {
        return bad("observation baseline cursor");
    };
    let [Value::Uint(record), Value::Uint(offset)] = cursor.as_slice() else {
        return bad("observation baseline cursor shape");
    };
    let (mut record, mut offset) = (*record, *offset);
    let Some(Value::Array(rows)) = m.get(&5) else {
        return bad("observation rows");
    };
    if !matches!(m.get(&8),Some(Value::Bytes(hash)) if hash.len()==32) {
        return bad("original archive base digest");
    }
    visit(bundle.start, reader.state(), None)?;
    let mut previous_at = bundle.start;
    for row in rows {
        let Value::Array(row) = row else {
            return bad("observation row");
        };
        let [
            Value::Uint(r),
            Value::Uint(o),
            Value::Uint(sequence),
            time,
            Value::Bytes(before),
            Value::Bytes(after),
            delta,
        ] = row.as_slice()
        else {
            return bad("observation row fields");
        };
        let time = match time {
            Value::Uint(n) => i64::try_from(*n).map_err(|_| Refusal {
                name: "history-bad",
                detail: "observation time overflow".into(),
            })?,
            Value::Nint(n) => {
                -1 - i64::try_from(*n).map_err(|_| Refusal {
                    name: "history-bad",
                    detail: "observation time overflow".into(),
                })?
            }
            _ => return bad("observation time"),
        };
        if (*r, *o) <= (record, offset)
            || time < previous_at
            || time
                >= bundle
                    .start
                    .checked_add(bundle.length)
                    .ok_or_else(|| Refusal {
                        name: "history-bad",
                        detail: "window overflow".into(),
                    })?
            || before.as_slice() != reader.digest()
        {
            return bad("observation order or prior digest");
        }
        reader.apply(delta, before, after, *sequence)?;
        (record, offset, previous_at) = (*r, *o, time);
        visit(time, reader.state(), Some(delta))?;
    }
    if m.get(&6) != Some(&Value::Bytes(reader.digest().to_vec()))
        || m.get(&7)
            != Some(&Value::Array(vec![
                Value::Uint(record),
                Value::Uint(offset),
            ]))
    {
        return bad("observation terminal differs");
    }
    Ok((reader.fast_rows, reader.whole_rows))
}

/// Existing history callers consume the live authorized nodes/links, while the reader retains carry context.
pub fn live_observation(header: &crate::effects::Header, projection: &Value) -> R<State> {
    crate::stream::public::validate_projection(header, projection)?;
    let Value::Map(public) = projection else {
        unreachable!("validated public projection");
    };
    let nodes = pairs(public.get(&2), "public live nodes")?
        .into_iter()
        .map(|(id, node)| Ok((id, NodeState::read(&Value::Map(node))?)))
        .collect::<R<BTreeMap<_, _>>>()?;
    let kind = nodes
        .get(&header.zone)
        .ok_or_else(|| Refusal {
            name: "history-root-missing",
            detail: "public root missing".into(),
        })?
        .kind
        .clone();
    let mut state = State::start(header.zone, kind);
    state.nodes = nodes;
    state.links.clear();
    if let Some(Value::Uint(next)) = public.get(&1) {
        state.next = *next;
    }
    for (id, link) in pairs(public.get(&3), "public live links")? {
        state.links.insert(id, LinkState::read(&Value::Map(link))?);
    }
    Ok(state)
}
