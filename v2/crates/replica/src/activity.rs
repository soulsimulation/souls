//! Joint activities as data (Engine v2 B5, #2724): the one way Souls agree to act on each other's bodies. An activity
//! is a node made from a kind ([`ActivityKind`]); each body that joins it is linked to it ([`MEMBER`]), and the
//! activity's node keeps who holds which role ([`Member`]). The engine runs it in `sim::activity`.
//!
//! - **A kind states** its name and revision; its roles, each a name, a place (a named point of the activity, K3's
//!   named points) and what it claims on the body that takes it (T9's own terms, `v2/docs/bodies.md` rules 2 to 4);
//!   how long a proposal lasts; and the longest a leave may take, `leave_within`, in microseconds, never ticks.
//! - **The node** holds the activity's revision, its state (proposed or started), when the proposal expires and the
//!   members: for each, its role, its body, its Soul, the membership link and the intent that joined it, so a resent
//!   join is answered from the node and makes no second membership.
//! - **Membership is a link** from the body to the activity, owned by the activity's end (T1: the activity is a node
//!   with one owner, `v2/docs/zones.md` rule 4), so the node and its links are in the log and survive a restart.
//!
//! A kind is decoded from `{1: name, 2: revision, 3: [{1: role, 2: place, 3: [want, ...]}, ...], 4: proposal lasts
//! µs, 5: leave within µs}`, a want as in a move (`replica::moves`): `{1: 1 every | 2 one | 3 named, 2: class number
//! or resource name}`.

use std::collections::{BTreeMap, BTreeSet};

use crate::bodies::{Class, SkillShape, Want};
use crate::effects::{Refusal, read_id};
use crate::encode::{Name, Value};
use crate::ids::Id;
use crate::time::Micros;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// The type of the link from a member's body to its activity (T2 rule 7).
pub const MEMBER: &str = "souls:member";

/// The activity node's revision: a join names it, and a join against another is refused.
pub const F_REVISION: u64 = 1;
/// The activity node's state: 1 proposed, 2 started.
pub const F_STATE: u64 = 2;
/// When a proposal that has not started expires, µs of world time.
pub const F_EXPIRES: u64 = 3;
/// The members, `[[role, body, soul, link, intent], ...]`, in the order they joined.
pub const F_MEMBERS: u64 = 4;

/// The longest leave a kind may state, µs: ten seconds. A leave is bounded, so nobody is held.
pub const LEAVE_MOST: Micros = 10_000_000;

/// One role of an activity: its name, where it stands (a named point of the activity) and what it claims.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Role {
    pub name: Name,
    pub place: Name,
    pub claims: Vec<Want>,
}

/// An activity's kind, as data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivityKind {
    /// The kind's full name, `namespace:name@hash`: the activity node's kind.
    pub name: Name,
    pub revision: u64,
    pub roles: Vec<Role>,
    /// µs a proposal lasts before it expires unstarted.
    pub proposal_lasts: Micros,
    /// µs a leave may take at most: a body in a move is let go at the move's next phase end, or at this.
    pub leave_within: Micros,
}

fn uint(v: Option<&Value>, what: &str) -> R<u64> {
    match v {
        Some(Value::Uint(n)) => Ok(*n),
        _ => refuse("not-an-activity", format!("{what} is a whole number")),
    }
}

fn text(v: Option<&Value>, what: &str) -> R<Name> {
    match v {
        Some(Value::Text(t)) => Ok(t.clone()),
        _ => refuse("not-an-activity", format!("{what} is a name")),
    }
}

fn want(v: &Value) -> R<Want> {
    let Value::Map(w) = v else {
        return refuse("not-an-activity", "a want is a map");
    };
    match (w.get(&1), w.get(&2)) {
        (Some(Value::Uint(1)), Some(Value::Uint(c))) => Ok(Want::All(Class::from_number(*c)?)),
        (Some(Value::Uint(2)), Some(Value::Uint(c))) => Ok(Want::One(Class::from_number(*c)?)),
        (Some(Value::Uint(3)), Some(Value::Text(r))) => Ok(Want::Named(r.clone())),
        _ => refuse("not-an-activity", "a want is {1: 1|2|3, 2: class or name}"),
    }
}

fn micros(v: Option<&Value>, what: &str) -> R<Micros> {
    let n = uint(v, what)?;
    Micros::try_from(n).or_else(|_| refuse("not-an-activity", format!("{what}: {n}")))
}

impl ActivityKind {
    /// Reads a kind, refusing by name: `not-an-activity` (unknown fields included), `class-unknown`,
    /// `activity-roles-too-few` (fewer than two: one Soul needs no agreement), `role-duplicate`, `role-claims-none`,
    /// `activity-leave-out-of-range` (none, or above [`LEAVE_MOST`]) and `activity-proposal-empty`.
    pub fn from_value(v: &Value) -> R<ActivityKind> {
        let Value::Map(m) = v else {
            return refuse("not-an-activity", "an activity kind is a map");
        };
        if let Some(k) = m.keys().find(|k| **k == 0 || **k > 5) {
            return refuse("not-an-activity", format!("field {k}"));
        }
        let name = text(m.get(&1), "the name")?;
        let revision = uint(m.get(&2), "the revision")?;
        let Some(Value::Array(rs)) = m.get(&3) else {
            return refuse("not-an-activity", "roles are a list");
        };
        let mut roles: Vec<Role> = Vec::new();
        for r in rs {
            let Value::Map(r) = r else {
                return refuse(
                    "not-an-activity",
                    "a role is {1: name, 2: place, 3: [want, ...]}",
                );
            };
            if r.keys().any(|k| *k == 0 || *k > 3) {
                return refuse("not-an-activity", "a role has fields 1 to 3");
            }
            let rname = text(r.get(&1), "a role's name")?;
            let place = text(r.get(&2), "a role's place")?;
            let Some(Value::Array(ws)) = r.get(&3) else {
                return refuse("not-an-activity", "a role's claims are a list");
            };
            let claims = ws.iter().map(want).collect::<R<Vec<_>>>()?;
            if claims.is_empty() {
                return refuse("role-claims-none", rname.as_str());
            }
            if roles.iter().any(|x| x.name == rname) {
                return refuse("role-duplicate", rname.as_str());
            }
            roles.push(Role {
                name: rname,
                place,
                claims,
            });
        }
        if roles.len() < 2 {
            return refuse(
                "activity-roles-too-few",
                format!("{}: two roles at least", name.as_str()),
            );
        }
        let proposal_lasts = micros(m.get(&4), "how long a proposal lasts")?;
        if proposal_lasts == 0 {
            return refuse("activity-proposal-empty", name.as_str());
        }
        let leave_within = micros(m.get(&5), "the leave's bound")?;
        if leave_within == 0 || leave_within > LEAVE_MOST {
            return refuse(
                "activity-leave-out-of-range",
                format!("{}: {leave_within} µs; 1 to {LEAVE_MOST}", name.as_str()),
            );
        }
        Ok(ActivityKind {
            name,
            revision,
            roles,
            proposal_lasts,
            leave_within,
        })
    }

    pub fn role(&self, name: &Name) -> Option<&Role> {
        self.roles.iter().find(|r| r.name == *name)
    }

    /// The claim role `role` makes on its body, as a skill's shape (T9 rule 3): it blocks and gives way to nothing.
    pub fn shape(&self, role: &Role) -> SkillShape {
        SkillShape {
            name: Name::new(&format!("{}/{}", self.name.as_str(), role.name.as_str()))
                .unwrap_or_else(|| self.name.clone()),
            claims: role.claims.clone(),
            blocks: Vec::new(),
            cancelled_by: Vec::new(),
        }
    }
}

/// One member: its role, its body, the Soul that joined, the membership link and the intent that joined it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    pub role: Name,
    pub body: Id,
    pub soul: Id,
    pub link: Id,
    pub intent: Id,
}

/// Where an activity is: proposed (reserving nothing) or started (holding every member's role claims).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Proposed,
    Started,
}

/// What an activity node holds, read from and written to its fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Node {
    pub revision: u64,
    pub state: State,
    pub expires: Micros,
    pub members: Vec<Member>,
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

impl Node {
    /// The members' field value.
    pub fn members_value(&self) -> Value {
        Value::Array(
            self.members
                .iter()
                .map(|m| {
                    Value::Array(vec![
                        Value::Text(m.role.clone()),
                        m.body.to_value(),
                        m.soul.to_value(),
                        m.link.to_value(),
                        m.intent.to_value(),
                    ])
                })
                .collect(),
        )
    }

    /// Every field the node holds.
    pub fn fields(&self) -> BTreeMap<u64, Value> {
        BTreeMap::from([
            (F_REVISION, Value::Uint(self.revision)),
            (
                F_STATE,
                Value::Uint(match self.state {
                    State::Proposed => 1,
                    State::Started => 2,
                }),
            ),
            (F_EXPIRES, int(self.expires)),
            (F_MEMBERS, self.members_value()),
        ])
    }

    /// Reads the node back from its fields (`not-an-activity` when one is missing or malformed).
    pub fn from_fields(f: &BTreeMap<u64, Value>) -> R<Node> {
        let revision = uint(f.get(&F_REVISION), "the revision")?;
        let state = match f.get(&F_STATE) {
            Some(Value::Uint(1)) => State::Proposed,
            Some(Value::Uint(2)) => State::Started,
            _ => return refuse("not-an-activity", "the state is 1 or 2"),
        };
        let expires = match f.get(&F_EXPIRES) {
            Some(Value::Uint(n)) => Micros::try_from(*n).unwrap_or(Micros::MAX),
            Some(Value::Nint(n)) => -1 - Micros::try_from(*n).unwrap_or(Micros::MAX - 1),
            _ => return refuse("not-an-activity", "the expiry"),
        };
        let Some(Value::Array(ms)) = f.get(&F_MEMBERS) else {
            return refuse("not-an-activity", "the members are a list");
        };
        let mut members = Vec::new();
        for m in ms {
            let Value::Array(m) = m else {
                return refuse("not-an-activity", "a member is a list");
            };
            let [Value::Text(role), body, soul, link, intent] = m.as_slice() else {
                return refuse(
                    "not-an-activity",
                    "a member is [role, body, soul, link, intent]",
                );
            };
            members.push(Member {
                role: role.clone(),
                body: read_id(body)?,
                soul: read_id(soul)?,
                link: read_id(link)?,
                intent: read_id(intent)?,
            });
        }
        Ok(Node {
            revision,
            state,
            expires,
            members,
        })
    }
}

// --- Offers (Engine v2 E8, #2779) ------------------------------------------------------------------------------------

/// An offer: a proposal of a two-role kind with the asker already in its role, asked of other bodies until it
/// expires. `souls:offer {1: activity, 2: kind, 3: [body asked, ...], 4: expires µs, 5: the asker's body}`, one
/// effect however many it asks. The bodies asked are resolved when it is written (T8): one who comes in later was not.
pub const OFFER: &str = "souls:offer";
/// An answer of no: `souls:offer-declined {1: offer, 2: the asker's body, 3: [the body that declined]}`.
pub const OFFER_DECLINED: &str = "souls:offer-declined";
/// No answer in time: `souls:offer-lapsed {1: offer, 2: the asker's body, 3: [body, ...]}`, the bodies that did not
/// answer the offer, or the one whose accepted pair waited past its own expiry (then 4 is that pair's activity).
pub const OFFER_LAPSED: &str = "souls:offer-lapsed";

/// The bodies an offer's event is addressed to, for the queue of events addressed to a Soul (R4): an offer goes to
/// each body asked, and a refusal or a lapse to the asker. `None` for any other event.
pub fn addressed(name: &str, fields: &BTreeMap<u64, Value>) -> Option<BTreeSet<Id>> {
    match (name, fields.get(&3), fields.get(&2)) {
        (OFFER, Some(Value::Array(a)), _) => {
            Some(a.iter().filter_map(|x| read_id(x).ok()).collect())
        }
        (OFFER_DECLINED | OFFER_LAPSED, _, Some(asker)) => {
            Some(read_id(asker).into_iter().collect())
        }
        (OFFER | OFFER_DECLINED | OFFER_LAPSED, _, _) => Some(BTreeSet::new()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{Minter, Scope};

    fn n(s: &str) -> Name {
        Name::new(s).expect("a name")
    }

    fn kind(roles: &[&str], leave: u64) -> Value {
        let rs = roles
            .iter()
            .map(|r| {
                Value::Map(BTreeMap::from([
                    (1, Value::Text(n(r))),
                    (2, Value::Text(n("p"))),
                    (
                        3,
                        Value::Array(vec![Value::Map(BTreeMap::from([
                            (1, Value::Uint(2)),
                            (2, Value::Uint(3)),
                        ]))]),
                    ),
                ]))
            })
            .collect();
        Value::Map(BTreeMap::from([
            (1, Value::Text(n("test:pair@1"))),
            (2, Value::Uint(1)),
            (3, Value::Array(rs)),
            (4, Value::Uint(60_000_000)),
            (5, Value::Uint(leave)),
        ]))
    }

    #[test]
    fn a_kind_reads_and_a_bad_one_is_refused_by_name() {
        let k = ActivityKind::from_value(&kind(&["a", "b"], 500_000)).expect("a kind");
        assert_eq!(k.roles.len(), 2);
        assert_eq!(k.shape(&k.roles[0]).claims, vec![Want::One(Class::Gaze)]);
        let name = |v| ActivityKind::from_value(&v).expect_err("refused").name;
        assert_eq!(name(kind(&["a"], 1)), "activity-roles-too-few");
        assert_eq!(name(kind(&["a", "a"], 1)), "role-duplicate");
        assert_eq!(name(kind(&["a", "b"], 0)), "activity-leave-out-of-range");
        assert_eq!(
            name(kind(&["a", "b"], 10_000_001)),
            "activity-leave-out-of-range"
        );
    }

    #[test]
    fn an_offer_goes_to_those_asked_and_its_outcome_to_the_asker() {
        let mut mint = Minter::new(Scope([0xe8; 16]));
        let mut id = || mint.mint().expect("an id");
        let (asker, a, b) = (id(), id(), id());
        let offer = BTreeMap::from([
            (1, id().to_value()),
            (3, Value::Array(vec![a.to_value(), b.to_value()])),
            (5, asker.to_value()),
        ]);
        assert_eq!(addressed(OFFER, &offer), Some(BTreeSet::from([a, b])));
        let lapsed = BTreeMap::from([(2, asker.to_value()), (3, Value::Array(vec![a.to_value()]))]);
        assert_eq!(
            addressed(OFFER_LAPSED, &lapsed),
            Some(BTreeSet::from([asker]))
        );
        assert_eq!(addressed("souls:said", &lapsed), None);
    }

    #[test]
    fn a_node_round_trips_through_its_fields() {
        let mut mint = Minter::new(Scope([0xb5; 16]));
        let mut id = || mint.mint().expect("an id");
        let node = Node {
            revision: 3,
            state: State::Started,
            expires: 1_000,
            members: vec![Member {
                role: n("a"),
                body: id(),
                soul: id(),
                link: id(),
                intent: id(),
            }],
        };
        assert_eq!(Node::from_fields(&node.fields()).expect("reads"), node);
    }
}
