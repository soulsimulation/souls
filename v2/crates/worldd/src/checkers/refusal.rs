//! A refusal that repairs the copy (Engine v2 I6, #2691). The agent decides from its own copy; refused because the
//! world moved, it would decide again on the same wrong picture. So a refusal carries what the client needs to make
//! its copy right for the nodes the check read.
//!
//! T10's refusal (`v2/docs/intents.md` rule 8) is `{1: actor, 2: sequence, 3: 2, 4: reason, 5: version now, 6:
//! [node, ...]}`. [`repair`] fills 6 and adds:
//!
//! - **7: the candidate it speaks of**, by its rank in the act's list: the first whose reads changed, else the first;
//! - **8: `[[id, stamp, state], ...]`**, for each node of the read sets that changed since the intent's basis, its
//!   state now as its hash covers it (`replica::hash`), cut to the actor's audience (`v2/docs/audience.md`): a node
//!   the actor may not see is left out of 6 and 8 altogether (the code is named, the state withheld), and of a node
//!   it may see, only the links it may see are carried;
//! - **9: `[[id, stamp, hash], ...]`** in place of 8 when 8 would pass [`STATE_LIMIT`] bytes: ids and hashes only.
//!   The client's fetch of them is R5's.
//! - 10 is left for E16 (a usable reason and the nearest thing that can work). The world names no alternative here:
//!   the agent's own ranked list is the alternative.
//!
//! The client applies 8 with `Replica::apply_states`, in version order with its stream, so a refusal never rewinds a
//! node. A node removed since the basis has no audience left to cut by and is not carried; its fetch is R5's.

use replica::apply::{NodeState, Replica};
use replica::effects::Actor;
use replica::encode::{Value, encode};
use replica::ids::Id;
use replica::intents::Answer;
use replica::read::Read;
use replica::world_model::{Audience, plain};
use sim::commit::Checks;

/// The most bytes field 8 may take; over it, the refusal carries ids and hashes (9) instead.
pub const STATE_LIMIT: usize = 2048;

/// Whether `actor` sees a record of `audience` (`v2/docs/audience.md` rule 1): everyone's, its own, and an audience
/// node's it is a `souls:member` of. The world sees all.
pub fn sees(live: &impl Read, actor: Actor, audience: Audience) -> bool {
    let principal = match actor {
        Actor::World => return true,
        Actor::Soul(p) | Actor::Creator(p) => p,
    };
    match audience {
        Audience::Everyone => true,
        Audience::Of(a) => {
            a == principal
                || live
                    .links(a)
                    .iter()
                    .any(|l| plain(l.ty.as_str()) == "souls:member" && l.ends == [a, principal])
        }
    }
}

/// The nodes of `checks`' read sets that changed since `basis` (a stamp past it), in id order.
pub fn changed(live: &impl Read, checks: &Checks, basis: u64) -> Vec<Id> {
    let mut ids: Vec<Id> = checks
        .candidates
        .iter()
        .flat_map(|c| c.reads.iter().map(|(id, _)| *id))
        .filter(|id| live.stamp(*id) > basis)
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// T10's refusal `answer` (an [`Answer::Refused`]) with what repairs the actor's copy (the module's notes), for an
/// intent decided at `basis` and refused on `live` after `checks`. Any other answer is returned as it is.
pub fn repair(answer: &Answer, live: &Replica, checks: &Checks, basis: u64, limit: usize) -> Value {
    let v = answer.to_value();
    let (Answer::Refused { actor, .. }, Value::Map(mut m)) = (answer, v.clone()) else {
        return v;
    };
    let see = |a: Audience| sees(live, *actor, a);
    let states: Vec<NodeState> = changed(live, checks, basis)
        .into_iter()
        .filter_map(|id| live.node_state(id, &see))
        .collect();
    let rank = checks
        .candidates
        .iter()
        .position(|c| c.reads.iter().any(|(id, s)| live.stamp(*id) != *s))
        .unwrap_or(0);
    m.insert(7, Value::Uint(rank as u64));
    m.remove(&6);
    if !states.is_empty() {
        m.insert(
            6,
            Value::Array(states.iter().map(|s| s.id.to_value()).collect()),
        );
        let full = Value::Array(states.iter().map(NodeState::to_value).collect());
        if encode(&full).map_or(usize::MAX, |b| b.len()) <= limit {
            m.insert(8, full);
        } else {
            let hashes = states
                .iter()
                .map(|s| {
                    Value::Array(vec![
                        s.id.to_value(),
                        Value::Uint(s.stamp),
                        s.hash().map_or(Value::Array(Vec::new()), |h| h.to_value()),
                    ])
                })
                .collect();
            m.insert(9, Value::Array(hashes));
        }
    }
    Value::Map(m)
}

/// The node states a refusal carries (field 8), as the client reads them; none when it carries ids and hashes only.
pub fn states_of(refusal: &Value) -> Vec<NodeState> {
    match refusal {
        Value::Map(m) => match m.get(&8) {
            Some(Value::Array(a)) => a.iter().filter_map(|s| NodeState::read(s).ok()).collect(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests;
