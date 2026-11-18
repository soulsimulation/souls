//! T2's checks made when the zone's writer commits a change (`v2/docs/world-model.md` rules 5 to 9 and 11), one
//! change at a time: each reads the few nodes the change names, never the whole world. A viewer applying the log runs
//! none of them (T6 rule 5). Also here: loading a T2 world (a `Draft`) into the tree through `commit`, and writing the
//! tree back as one, so that T2's whole-world check can be run over it.

use super::{Life, NONE, R, Tree, refuse, show};
use crate::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Rest, schema_hash,
};
use crate::encode::{Name, Value, encode};
use crate::ids::{Hash, Id, Purpose};
use crate::pose::{Frame, Pose, Quat, Support, Vec3};
use crate::world_model::{Audience, Draft, End, Kind, Link, Node, plain, takes, within};
use std::collections::{BTreeMap, BTreeSet};

/// What a commit is checked against: the kinds by full name (what each admits), the Souls the world knows, and each
/// audience's members as resolved when written (T8).
#[derive(Clone, Debug, Default)]
pub struct Rules {
    pub kinds: BTreeMap<String, Kind>,
    pub souls: BTreeSet<Id>,
    pub audiences: BTreeMap<Id, BTreeSet<Id>>,
}

impl Rules {
    fn kind(&self, node: Id, kind: &str) -> R<&Kind> {
        self.kinds.get(kind).map_or_else(
            || refuse("kind-unknown", format!("{}'s kind {kind}", show(node))),
            Ok,
        )
    }

    fn audience(&self, a: Audience) -> R<()> {
        match a {
            Audience::Of(x) if !self.audiences.contains_key(&x) => refuse(
                "audience-unknown",
                format!("audience {} is not declared", show(x)),
            ),
            _ => Ok(()),
        }
    }

    /// The parent's kind admits the child's, in `slot` or as a child; by plain name or by category (rule 5).
    fn admits(
        &self,
        child: Id,
        kind: &str,
        parent: Id,
        parent_kind: &str,
        slot: Option<u64>,
    ) -> R<()> {
        let own = self.kind(child, kind)?;
        let pk = self.kind(parent, parent_kind)?;
        let list = match slot {
            Some(s) => pk.slots.get(&s),
            None => Some(&pk.children),
        };
        if list.is_some_and(|l| takes(l, plain(kind), &own.owner)) {
            return Ok(());
        }
        let place = slot.map_or(String::new(), |s| format!(" slot {s}"));
        refuse(
            "child-not-admitted",
            format!(
                "{}{place} does not admit {} ({})",
                plain(parent_kind),
                plain(kind),
                show(child)
            ),
        )
    }

    /// A create: its kind is known, its parent admits it, its audience is declared.
    pub(super) fn create(
        &self,
        tree: &Tree,
        node: Id,
        kind: &Name,
        parent: u32,
        slot: Option<u64>,
        audience: Audience,
    ) -> R<()> {
        self.audience(audience)?;
        let p = &tree.nodes[parent as usize];
        self.admits(
            node,
            kind.as_str(),
            p.id,
            tree.names[p.kind as usize].as_str(),
            slot,
        )
    }

    /// A node placed under `parent` in `slot` (a reparent's new slot, an arrive): the parent admits it there.
    pub(super) fn place(&self, tree: &Tree, node: u32, parent: u32, slot: Option<u64>) -> R<()> {
        let (n, p) = (&tree.nodes[node as usize], &tree.nodes[parent as usize]);
        self.admits(
            n.id,
            tree.names[n.kind as usize].as_str(),
            p.id,
            tree.names[p.kind as usize].as_str(),
            slot,
        )
    }

    /// A link: two different ends, each a node here or a Soul the world knows, and an audience declared and no
    /// wider than either end's (rules 7 and 9). A self-link means nothing and is refused (rule 11 left it to K2).
    pub(super) fn link(&self, tree: &Tree, link: Id, ends: [Id; 2], audience: Audience) -> R<()> {
        if ends[0] == ends[1] {
            return refuse(
                "link-self",
                format!("link {} joins {} to itself", show(link), show(ends[0])),
            );
        }
        self.audience(audience)?;
        for end in ends {
            let seen_by = if self.souls.contains(&end) {
                Audience::Everyone
            } else if let Ok(s) = tree.live(end) {
                tree.nodes[s as usize].audience
            } else {
                return refuse(
                    "link-end-missing",
                    format!("link {}'s end {} is not here", show(link), show(end)),
                );
            };
            self.audience(seen_by)?;
            if !within(&self.audiences, audience, seen_by) {
                return refuse(
                    "link-audience-wider",
                    format!(
                        "link {} is shown to some who cannot see {}",
                        show(link),
                        show(end)
                    ),
                );
            }
        }
        Ok(())
    }

    /// The amounts moved in a part balance: for each field, the `by` of its sets sum to zero (T6 rule 3.4, SA-F2b).
    /// One pour is two entries, the source's and then the destination's, in one part.
    pub(super) fn balanced(&self, effects: &[Effect]) -> R<()> {
        let mut sums: BTreeMap<u64, i128> = BTreeMap::new();
        for e in effects {
            let Body::Changes(changes) = &e.body else {
                continue;
            };
            for c in changes {
                if let Change::Set {
                    field,
                    by: Some(by),
                    ..
                } = c.change
                {
                    *sums.entry(field).or_default() += i128::from(by);
                }
            }
        }
        match sums.iter().find(|(_, s)| **s != 0) {
            Some((field, sum)) => refuse(
                "by-not-balanced",
                format!("field {field}'s amounts moved sum to {sum}"),
            ),
            None => Ok(()),
        }
    }
}

fn name(text: &str) -> R<Name> {
    Name::new(text).map_or_else(|| refuse("text-not-a-name", text.to_owned()), Ok)
}

/// A header pinning `kinds`, for loading a world into a zone rooted at `zone`.
fn header(zone: Id, kinds: &BTreeMap<String, Kind>) -> R<Header> {
    let build = Hash::of(Purpose::Fixture, b"souls/tree-load/1").to_bytes();
    let v = Value::Map(BTreeMap::from([
        (1, Value::Bytes(build)),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(zone.scope().0.to_vec())),
        (4, zone.to_value()),
        (5, Value::Uint(0)),
        (
            6,
            Value::Array(
                kinds
                    .keys()
                    .map(|k| name(k).map(Value::Text))
                    .collect::<R<_>>()?,
            ),
        ),
        (7, Value::Array(Vec::new())),
    ]));
    let bytes = encode(&v).or_else(|e| refuse("encoding", e.to_string()))?;
    Header::read(&bytes)
}

fn entry(sequence: u64, node: Id, audience: Audience, changes: Vec<Change>) -> Effect {
    Effect {
        envelope: Envelope {
            sequence,
            at: 0,
            cause: Cause::World,
            actor: Actor::World,
            audience,
            node,
        },
        body: Body::Changes(
            changes
                .into_iter()
                .map(|change| ChangeRec {
                    change,
                    rest: Rest::new(),
                })
                .collect(),
        ),
        events: None,
        rest: Rest::new(),
    }
}

impl Tree {
    /// Loads a T2 world into a new tree through [`Tree::commit`]'s checks: one root (public, with no slot), then
    /// every node as a create by its parent's entry, parents first, then every link as its owning end's entry. A
    /// node that no parent chain reaches from the root is refused, as `tree-cycle` when its chain comes back to
    /// itself (walked up at most 33 steps). Positions are the frame's origin: T2's worlds carry none.
    pub fn load(draft: &Draft) -> R<(Tree, Rules)> {
        let rules = Rules {
            kinds: draft.kinds.clone(),
            souls: draft.souls.clone(),
            audiences: draft.audiences.clone(),
        };
        let mut roots = draft.nodes.iter().filter(|n| n.parent.is_none());
        let (Some(root), None) = (roots.next(), roots.next()) else {
            return refuse("world-source", "a zone has one root");
        };
        if root.slot.is_some() {
            return refuse(
                "root-slot",
                format!("the root {} sits in no slot", show(root.id)),
            );
        }
        if root.audience != Audience::Everyone {
            return refuse("audience-mismatch", "the zone's root is public");
        }
        let header = header(root.id, &draft.kinds)?;
        let mut tree = Tree::start(root.id, name(&root.kind)?);
        let mut entries = Vec::new();
        if !root.fields.is_empty() {
            let sets = root
                .fields
                .iter()
                .map(|(f, v)| Change::Set {
                    node: root.id,
                    field: *f,
                    to: v.clone(),
                    by: None,
                })
                .collect();
            entries.push(entry(0, root.id, Audience::Everyone, sets));
        }
        let mut below: BTreeMap<Id, Vec<&Node>> = BTreeMap::new();
        for n in &draft.nodes {
            if let Some(p) = n.parent {
                below.entry(p).or_default().push(n);
            }
        }
        let mut order = vec![root.id];
        let mut i = 0;
        while i < order.len() {
            for n in below.get(&order[i]).into_iter().flatten() {
                let support = match n.slot {
                    Some(_) => Support::Slot,
                    None => Support::Surface {
                        surface: order[i],
                        height: 0,
                    },
                };
                let pose = Pose {
                    frame: Frame {
                        node: order[i],
                        slot: n.slot,
                    },
                    position: Vec3::ZERO,
                    orientation: Quat::IDENTITY,
                    support,
                };
                let create = Change::Create {
                    node: n.id,
                    kind: name(&n.kind)?,
                    pose,
                    audience: n.audience,
                    fields: n.fields.clone(),
                };
                entries.push(entry(
                    entries.len() as u64,
                    order[i],
                    n.audience,
                    vec![create],
                ));
                order.push(n.id);
            }
            i += 1;
        }
        let reached: BTreeSet<Id> = order.iter().copied().collect();
        if let Some(n) = draft.nodes.iter().find(|n| !reached.contains(&n.id)) {
            // Not under the root: its parent chain ends at a missing node, or comes back on itself.
            let by_id: BTreeMap<Id, &Node> = draft.nodes.iter().map(|n| (n.id, n)).collect();
            let (mut at, mut seen) = (n, BTreeSet::new());
            while let Some(p) = at.parent.and_then(|p| by_id.get(&p)) {
                if !seen.insert(p.id) {
                    return refuse("tree-cycle", show(p.id));
                }
                at = p;
            }
            return refuse(
                "parent-missing",
                format!("{} is not under the root", show(n.id)),
            );
        }
        for l in &draft.links {
            let link = Change::Link {
                link: l.id,
                ty: name(&l.ty)?,
                ends: l.ends,
                owner: l.owner,
                audience: l.audience,
            };
            let owning = l.ends[usize::from(l.owner == End::Second)];
            entries.push(entry(entries.len() as u64, owning, l.audience, vec![link]));
        }
        tree.run(&header, &entries, Some(&rules))?;
        Ok((tree, rules))
    }

    /// The tree as a T2 world, nodes and links in id order, for T2's whole-world check (`world_model::check`).
    pub fn to_draft(&self, rules: &Rules) -> Draft {
        let mut nodes: Vec<Node> = self
            .nodes
            .iter()
            .filter(|r| r.life == Life::Live)
            .map(|r| Node {
                id: r.id,
                kind: self.names[r.kind as usize].as_str().to_owned(),
                parent: (r.parent != NONE).then(|| self.nodes[r.parent as usize].id),
                slot: r.slot,
                audience: r.audience,
                fields: r.fields.clone(),
            })
            .collect();
        nodes.sort_by_key(|n| n.id);
        let mut links: Vec<Link> = self
            .links
            .iter()
            .map(|(id, l)| Link {
                id: *id,
                ty: self.names[l.ty as usize].as_str().to_owned(),
                ends: l.ends,
                owner: l.owner,
                audience: l.audience,
            })
            .collect();
        links.sort_by_key(|l| l.id);
        Draft {
            kinds: rules.kinds.clone(),
            souls: rules.souls.clone(),
            audiences: rules.audiences.clone(),
            nodes,
            links,
        }
    }
}
