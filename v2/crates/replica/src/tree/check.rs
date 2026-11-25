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
use std::borrow::Cow;
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
    /// A kind by full name: the world's boot kinds, else one a creator defined in `tree` (#3697), by the one loader.
    fn kind(&self, tree: &Tree, node: Id, kind: &str) -> R<Cow<'_, Kind>> {
        if let Some(k) = self.kinds.get(kind) {
            return Ok(Cow::Borrowed(k));
        }
        crate::kinds::defined::kind_named(tree, kind).map_or_else(
            || refuse("kind-unknown", format!("{}'s kind {kind}", show(node))),
            |k| Ok(Cow::Owned(k)),
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
        tree: &Tree,
        child: Id,
        kind: &str,
        parent: Id,
        parent_kind: &str,
        slot: Option<u64>,
    ) -> R<()> {
        // A creator's definition sits at the zone's root, and only there (#3697).
        if crate::kinds::defined::is_definition(kind) {
            let root = tree.nodes[tree.root as usize].id;
            if parent == root && slot.is_none() {
                return Ok(());
            }
            return refuse(
                "child-not-admitted",
                format!("a definition sits at the root, not under {}", show(parent)),
            );
        }
        let own = self.kind(tree, child, kind)?;
        let pk = self.kind(tree, parent, parent_kind)?;
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
            tree,
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
            tree,
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
    /// One pour is two entries, the source's and then the destination's, in one part. A field is known by its name on
    /// the kind of the node set (its section 3), so a transfer between two kinds that number it differently balances
    /// (E5b). When a set's node or field has no name the tree can read, the part balances by number, as before.
    pub(super) fn balanced(&self, tree: &Tree, effects: &[Effect]) -> R<()> {
        let mut sets: Vec<(Id, u64, i64)> = Vec::new();
        for e in effects {
            let Body::Changes(changes) = &e.body else {
                continue;
            };
            for c in changes {
                if let Change::Set {
                    node,
                    field,
                    by: Some(by),
                    ..
                } = c.change
                {
                    sets.push((node, field, by));
                }
            }
        }
        let named = |node: Id, field: u64| {
            let kind = tree.kind_any(node)?;
            self.kind(tree, node, kind.as_str())
                .ok()?
                .fields
                .get(&field)
                .cloned()
        };
        let names: Option<Vec<String>> = sets.iter().map(|(n, f, _)| named(*n, *f)).collect();
        let mut sums: BTreeMap<String, i128> = BTreeMap::new();
        for (i, (_, field, by)) in sets.iter().enumerate() {
            let key = match &names {
                Some(names) => names[i].clone(),
                None => format!("field {field}"),
            };
            *sums.entry(key).or_default() += i128::from(*by);
        }
        match sums.iter().find(|(_, s)| **s != 0) {
            Some((field, sum)) => refuse(
                "by-not-balanced",
                format!("{field}'s amounts moved sum to {sum}"),
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

/// T6 rule 3.4's balance by name (E5b): each set's field is named on the kind of the node set, and falls back to its
/// number when any set's name is unknown.
#[cfg(test)]
mod balance_tests {
    use super::*;
    use crate::effects::Part;
    use crate::world_model::{parse_kinds, parse_world};

    /// Linen numbers soap 2, the board 1 and the tub 2; `odd` numbers dirt 1, as the board numbers soap; `plain_a` and
    /// `plain_b` have no section 3. Each kind has one thing: 100 linen, 101 board, 102 tub, 103 odd, 104 plain_a,
    /// 105 plain_b, on a ground that admits things.
    const KINDS: &str = "{1: \"t:ground\", 2: \"place\", 11: [\"thing\"]}\n\
        {1: \"t:linen\", 2: \"thing\", 3: {1: {1: \"dirt\"}, 2: {1: \"soap\"}}}\n\
        {1: \"t:board\", 2: \"thing\", 3: {1: {1: \"soap\"}, 2: {1: \"dirt\"}}}\n\
        {1: \"t:tub\", 2: \"thing\", 3: {1: {1: \"water\"}, 2: {1: \"soap\"}}}\n\
        {1: \"t:odd\", 2: \"thing\", 3: {1: {1: \"dirt\"}}}\n\
        {1: \"t:plain_a\", 2: \"thing\"}\n\
        {1: \"t:plain_b\", 2: \"thing\"}";
    const WORLD: &str = "{1: [], 2: {}, 3: [{1: 1, 2: \"t:ground\"}, {1: 100, 2: \"t:linen\", 3: 1}, \
        {1: 101, 2: \"t:board\", 3: 1}, {1: 102, 2: \"t:tub\", 3: 1}, {1: 103, 2: \"t:odd\", 3: 1}, \
        {1: 104, 2: \"t:plain_a\", 3: 1}, {1: 105, 2: \"t:plain_b\", 3: 1}], 4: []}";

    fn id(n: u64) -> Id {
        Id::new(crate::ids::FIXTURE_SCOPE_A, n).expect("an id")
    }

    fn world() -> (Tree, Rules, Header) {
        let kinds = parse_kinds(KINDS).expect("kinds");
        let (tree, rules) =
            Tree::load(&parse_world(&kinds, WORLD).expect("a world")).expect("loads");
        let header = header(id(1), &rules.kinds).expect("a header");
        (tree, rules, header)
    }

    fn set(node: u64, field: u64, by: i64) -> Change {
        Change::Set {
            node: id(node),
            field,
            to: Value::Uint(u64::try_from(20 + by).expect("whole")),
            by: Some(by),
        }
    }

    /// Commits `changes`, one entry each (written by the node changed, or a create's parent), as one part.
    fn commit(tree: &mut Tree, rules: &Rules, header: &Header, changes: Vec<Change>) -> R<()> {
        let next = tree.to_state().next;
        let entries: Vec<Effect> = changes
            .into_iter()
            .zip(next..)
            .map(|(c, s)| {
                let node = match &c {
                    Change::Set { node, .. } | Change::Remove { node } => *node,
                    Change::Create { pose, .. } => pose.frame.node,
                    _ => unreachable!("sets, creates and removes"),
                };
                entry(s, node, Audience::Everyone, vec![c])
            })
            .collect();
        let v = Value::Map(BTreeMap::from([
            (1, Value::Bytes(header.hash().to_bytes())),
            (
                2,
                Value::Array(entries.iter().map(Effect::to_value).collect()),
            ),
        ]));
        let part = Part::read(&encode(&v).expect("bytes")).expect("a part");
        tree.commit(header, &part, rules)
    }

    fn refused(r: R<()>) -> Option<&'static str> {
        r.err().map(|e| e.name)
    }

    #[test]
    fn a_transfer_between_kinds_that_number_the_field_differently_balances_by_name() {
        let (mut tree, rules, header) = world();
        assert_eq!(
            commit(
                &mut tree,
                &rules,
                &header,
                vec![set(100, 2, -10), set(101, 1, 10)]
            ),
            Ok(())
        );
        // The tub numbers soap as linen does: by number or by name, the same.
        assert_eq!(
            commit(
                &mut tree,
                &rules,
                &header,
                vec![set(100, 2, -10), set(102, 2, 10)]
            ),
            Ok(())
        );
        // Half a transfer is still refused.
        assert_eq!(
            refused(commit(&mut tree, &rules, &header, vec![set(100, 2, -10)])),
            Some("by-not-balanced")
        );
    }

    #[test]
    fn the_same_number_with_different_names_is_refused() {
        // The old wrong-field write: linen's soap (2) out, the board's dirt (2) in.
        let (mut tree, rules, header) = world();
        assert_eq!(
            refused(commit(
                &mut tree,
                &rules,
                &header,
                vec![set(100, 2, -10), set(101, 2, 10)]
            )),
            Some("by-not-balanced")
        );
        // The board's soap (1) into `odd`'s dirt (1): one number, two names.
        assert_eq!(
            refused(commit(
                &mut tree,
                &rules,
                &header,
                vec![set(101, 1, -10), set(103, 1, 10)]
            )),
            Some("by-not-balanced")
        );
    }

    #[test]
    fn with_a_kind_that_has_no_section_3_the_part_balances_by_number() {
        let (mut tree, rules, header) = world();
        assert_eq!(
            commit(
                &mut tree,
                &rules,
                &header,
                vec![set(104, 1, -10), set(105, 1, 10)]
            ),
            Ok(())
        );
        assert_eq!(
            refused(commit(
                &mut tree,
                &rules,
                &header,
                vec![set(104, 1, -10), set(105, 2, 10)]
            )),
            Some("by-not-balanced")
        );
        // One end named and one not: the whole part by number, so soap 2 and field 2 balance.
        assert_eq!(
            commit(
                &mut tree,
                &rules,
                &header,
                vec![set(100, 2, -10), set(104, 2, 10)]
            ),
            Ok(())
        );
    }

    #[test]
    fn a_node_made_or_removed_in_the_same_part_is_named_by_its_kind() {
        let (mut tree, rules, header) = world();
        let board = rules
            .kinds
            .keys()
            .find(|k| plain(k) == "t:board")
            .expect("pinned")
            .clone();
        let made = Change::Create {
            node: id(200),
            kind: Name::new(&board).expect("a name"),
            pose: Pose {
                frame: Frame {
                    node: id(1),
                    slot: None,
                },
                position: Vec3::ZERO,
                orientation: Quat::IDENTITY,
                support: Support::Surface {
                    surface: id(1),
                    height: 0,
                },
            },
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        };
        // A board made in the part takes linen's soap: its soap is field 1, by its kind.
        assert_eq!(
            commit(
                &mut tree,
                &rules,
                &header,
                vec![made, set(100, 2, -10), set(200, 1, 10)]
            ),
            Ok(())
        );
        // The board takes soap and is removed in the same part: still named by its kind.
        assert_eq!(
            commit(
                &mut tree,
                &rules,
                &header,
                vec![
                    set(100, 2, -10),
                    set(101, 1, 10),
                    Change::Remove { node: id(101) }
                ]
            ),
            Ok(())
        );
    }
}
