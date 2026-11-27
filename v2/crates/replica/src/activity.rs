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
//! µs, 5: leave within µs, 6?: members at most (two when absent), 7?: 1 when its moves go on the world's beat, 8?: the role that follows}`, a want as in a move (`replica::moves`): `{1: 1 every | 2 one | 3 named, 2: class number
//! or resource name}`.

use std::collections::{BTreeMap, BTreeSet};

use crate::bodies::{Class, SkillShape, Want};
use crate::effects::{Refusal, read_id};
use crate::encode::{Name, Value};
use crate::ids::Id;
use crate::pose::Vec3;
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
    /// The move this role makes at the other member when the activity starts (0.134 T1: a handshake's), if any.
    pub mv: Option<Name>,
    /// Where its members stand, in the activity's own frame, in order (0.135 G3): each a point (µm) and a facing
    /// (millidegrees of yaw); its k-th member takes the k-th. None: its members stay where they are.
    pub stands: Vec<(Vec3, i64)>,
    /// How near the activity's middle a member stands to be walked to its stand, µm (0.135 G3, the entry's
    /// `within_mm`): one farther keeps where it is. None: any distance.
    pub within: Option<i64>,
    /// The link a member of this role holds on the activity's thing while it is a member (B10, #4239): the entry's
    /// link of the role's name, which its forms' `who: {link}` and `linked` needs read. None: no link is written.
    pub link: Option<RoleLink>,
}

/// A role's link on the activity's thing (B10, #4239). The activity's thing is the node its offer or proposal was
/// made under when that node is of kind `on` (an entry's own thing, whose roles made the activity's kind); on any
/// other place (the open ground) no link is written. The link is of tree type `ty`, from the member's body (or its
/// Soul when `soul`) to the thing, owned by the thing, as a form's `link` effect writes it (`sim::forms::links`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoleLink {
    pub ty: Name,
    pub soul: bool,
    /// The plain kind of the thing the link is written on.
    pub on: String,
    /// How many may hold it on one thing at once (the entry link's `most`): one more is refused `role-taken`.
    pub most: Option<u64>,
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
    /// How many members it takes at most (0.134 T3): two for a pair; a dance's offer, to several, takes up to eight.
    pub most: usize,
    /// Its roles' moves go on the world's beat (0.134 T3, `v2/docs/time.md` rule 7): each member's move begins on one
    /// beat, aimed at its own body, and begins again on the next beat after it ends, until the member leaves.
    pub beat: bool,
    /// The role whose member follows the other's (0.135 G2), if any: while the activity runs, the follower's own
    /// `souls:follow` order on the leader (`v2/docs/intents.md` rule 5) walks it along the leader's trail.
    pub follows: Option<Name>,
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
        if let Some(k) = m.keys().find(|k| **k == 0 || **k > 8) {
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
                    "a role is {1: name, 2: place, 3: [want, ...], 4?: move, 5?: [[x, y, z, yaw], ...], 6?: within}",
                );
            };
            if r.keys().any(|k| *k == 0 || *k > 6) {
                return refuse("not-an-activity", "a role has fields 1 to 6");
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
            let mv = match r.get(&4) {
                None => None,
                v => Some(text(v, "a role's move")?),
            };
            let int = |v: &Value| match v {
                Value::Uint(n) => i64::try_from(*n).ok(),
                Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
                _ => None,
            };
            let stands = match r.get(&5) {
                None => Vec::new(),
                Some(Value::Array(ss)) => ss
                    .iter()
                    .map(|s| match s {
                        Value::Array(p) => {
                            match p.iter().map(int).collect::<Option<Vec<_>>>().as_deref() {
                                Some([x, y, z, yaw]) => Ok((Vec3::new(*x, *y, *z), *yaw)),
                                _ => refuse("not-an-activity", "a stand is [x, y, z, yaw]"),
                            }
                        }
                        _ => refuse("not-an-activity", "a stand is [x, y, z, yaw]"),
                    })
                    .collect::<R<Vec<_>>>()?,
                Some(_) => return refuse("not-an-activity", "a role's stands are a list"),
            };
            let within = match r.get(&6) {
                None => None,
                Some(v) => Some(int(v).filter(|n| *n >= 0).map_or_else(
                    || refuse("not-an-activity", "a role's within is µm, zero or more"),
                    Ok,
                )?),
            };
            roles.push(Role {
                name: rname,
                place,
                claims,
                mv,
                stands,
                within,
                link: None,
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
        let most = match m.get(&6) {
            None => roles.len(),
            v => usize::try_from(uint(v, "the members at most")?).unwrap_or(usize::MAX),
        };
        if most < roles.len() {
            return refuse(
                "not-an-activity",
                format!(
                    "{}: {most} members for {} roles",
                    name.as_str(),
                    roles.len()
                ),
            );
        }
        let beat = match m.get(&7) {
            None => false,
            v => uint(v, "on the beat")? == 1,
        };
        let follows = match m.get(&8) {
            None => None,
            v => Some(text(v, "the role that follows")?),
        };
        if let Some(f) = &follows
            && !roles.iter().any(|r| r.name == *f)
        {
            return refuse(
                "not-an-activity",
                format!("{} follows as no role of its", f.as_str()),
            );
        }
        Ok(ActivityKind {
            name,
            revision,
            roles,
            proposal_lasts,
            leave_within,
            most,
            beat,
            follows,
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
/// effect however many it asks; 6 names the thing a give hands over, and a group's offer to several says how long
/// each accept keeps it open (7, µs) and the latest it stays open (8, µs). The bodies asked are resolved when it is
/// written (T8): one who comes in later was not.
pub const OFFER: &str = "souls:offer";
/// An answer of no: `souls:offer-declined {1: offer, 2: the asker's body, 3: [the body that declined]}`.
pub const OFFER_DECLINED: &str = "souls:offer-declined";
/// No answer in time: `souls:offer-lapsed {1: offer, 2: the asker's body, 3: [body, ...]}`, the bodies that did not
/// answer the offer, or those whose accepted pair waited past its own expiry (then 4 is that pair's activity).
pub const OFFER_LAPSED: &str = "souls:offer-lapsed";

/// The bodies an offer's event is addressed to, for the queue of events addressed to a Soul (R4): an offer goes to
/// each body asked, a refusal to the asker, and a lapse to the asker and to the bodies it names (those that did not
/// answer, or those whose accepted pair never started), so no one is left waiting on an offer that is gone.
/// `None` for any other event.
pub fn addressed(name: &str, fields: &BTreeMap<u64, Value>) -> Option<BTreeSet<Id>> {
    let listed = |v: Option<&Value>| -> BTreeSet<Id> {
        match v {
            Some(Value::Array(a)) => a.iter().filter_map(|x| read_id(x).ok()).collect(),
            _ => BTreeSet::new(),
        }
    };
    match (name, fields.get(&3), fields.get(&2)) {
        (OFFER, Some(Value::Array(_)), _) => Some(listed(fields.get(&3))),
        (OFFER_DECLINED, _, Some(asker)) => Some(read_id(asker).into_iter().collect()),
        (OFFER_LAPSED, asked, Some(asker)) => {
            let mut to = listed(asked);
            to.extend(read_id(asker));
            Some(to)
        }
        (OFFER | OFFER_DECLINED | OFFER_LAPSED, _, _) => Some(BTreeSet::new()),
        _ => None,
    }
}

/// The events of an activity its members are told wherever they stand (0.135): a join (an offer's answer of yes), its
/// start, a leave, its end (`souls:activity-ended`, at a member's body), its expiry and a carry's set-down, each with
/// the activity in field 1 or as the node it is written at. The view tier addresses each to the bodies that were
/// members as it was written and those it made members (`worldd`'s hub keeps the membership links).
pub const TO_MEMBERS: [&str; 6] = [
    "souls:activity-joined",
    "souls:activity-started",
    "souls:activity-left",
    "souls:activity-ended",
    "souls:activity-expired",
    "souls:carry-set-down",
];

/// Whether an event named `name` is one an activity's members are told ([`TO_MEMBERS`]).
pub fn to_members(name: &str) -> bool {
    TO_MEMBERS.contains(&name)
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
    fn an_offer_goes_to_those_asked_its_decline_to_the_asker_and_its_lapse_to_both() {
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
            Some(BTreeSet::from([asker, a])),
            "a lapse reaches the asker and the body that did not answer"
        );
        let declined =
            BTreeMap::from([(2, asker.to_value()), (3, Value::Array(vec![b.to_value()]))]);
        assert_eq!(
            addressed(OFFER_DECLINED, &declined),
            Some(BTreeSet::from([asker])),
            "a decline reaches the asker alone"
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
