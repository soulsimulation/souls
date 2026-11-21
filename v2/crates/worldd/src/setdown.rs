//! An agent puts its held thing down (Engine v2 E4's caller, #3604): the intent `hands:set-down`, checked off the
//! clock thread by the edit checker's thread ([`crate::answers`]) and committed at a tick with lookups only.
//!
//! - **The intent.** Verb [`VERB`], its target the thing held. Parameter 1 the word (`replica::kinds::place::Word`,
//!   by its placements name under [`NS`], `place:next_to`; `here` when absent), 2 the anchor (an id, for the words
//!   that need one), 3 the facing: a node's id (toward it) or `place:to_wall`; absent, as it was.
//! - **Off the clock** ([`check`]): on the newest frozen copy at or after the intent's arrival, with the acting body
//!   stood where the controller has it (Souls' bodies are not written to the tree as they walk), E4's
//!   `sim::setdown::plan` chooses the place on the checker's own town's ground, `sim::setdown::part` makes its one
//!   part, and G2's rule judges it on the town (`sim::edit::safety::check_on`, the call `sim::setdown::judge_on`
//!   makes, its guard kept for the commit). Refused by name: E4's (`not-held`, `setdown.no-room`, ...) and G2's.
//! - **At the tick** ([`still_held`] and the guard's judge): the thing is still in the same hand of the same body
//!   and its new parent still stands; the bodies as they stand now are judged by the kept guard (lookups only).
//!   Then the entries are written as one part under the intent: one receipt.
//!
//! Not here: walking to the spot (a move's), making a thing at a spot (F4's make), a thing's lifetime (F10).

use replica::apply::Replica;
use replica::effects::{Actor, Body, Cause, Change, ChangeRec, Refusal, Rest};
use replica::encode::{Name, Value};
use replica::ids::{Id, Minter};
use replica::intents::{Intent, Target};
use replica::kinds::place::{Facing, Word};
use replica::pose::{Frame, Pose, Vec3};
use replica::time::Micros;
use replica::tree::{Rules, Tree};
use replica::world_model::show;
use sim::edit::safety::{self, Guard, Known, Who};
use sim::ground::scene::xform_to;
use sim::setdown::{self as e4, What};
use sim::slots::hands::Entry;
use sim::walk::town::Town;

type R<T> = Result<T, Refusal>;

/// The verb of a set-down.
pub const VERB: &str = "hands:set-down";
/// The namespace of a placement word or a facing in the intent: a text in a part is a namespaced name
/// (`v2/docs/effects.md`), so `here` is sent as `place:here`.
pub const NS: &str = "place:";

fn refusal(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

/// A set-down as the clock thread takes it, for the checker.
#[derive(Clone, Debug)]
pub struct Ask {
    pub id: Id,
    pub soul: Id,
    pub body: Id,
    pub thing: Id,
    pub word: Word,
    pub anchor: Option<Id>,
    pub facing: Facing,
    /// The replica's version at its arrival: it is planned on a copy at least this new.
    pub planned: u64,
    pub at: Micros,
}

/// A set-down checked off the clock: the hand it is taken from, its entries, the parent it goes to, whether it asks
/// for G3's rebuild, G2's guard, and the Souls' bodies on the copy (those the controller holds are judged where it
/// has them at the commit).
pub struct Checked {
    pub thing: Id,
    pub body: Id,
    pub hand: u64,
    pub parent: Id,
    pub entries: Vec<Entry>,
    pub walk: bool,
    pub guard: Guard,
    pub souls: Vec<Who>,
}

/// The ask of intent `id` driving `body`: its thing, words and facing, or the reason it is not one.
pub fn read(
    intent: &Intent,
    id: Id,
    body: Id,
    planned: u64,
    at: Micros,
) -> Result<Ask, &'static str> {
    let Some(Target::Node(thing)) = intent.target else {
        return Err("setdown.no-thing");
    };
    let p = &intent.parameters;
    let word = match p.get(&1) {
        None => Word::Here,
        Some(Value::Text(t)) => t
            .as_str()
            .strip_prefix(NS)
            .and_then(Word::from_name)
            .ok_or("setdown.unknown-word")?,
        Some(_) => return Err("setdown.unknown-word"),
    };
    let id_at = |k| match p.get(&k) {
        None => Ok(None),
        Some(v) => replica::effects::read_id(v)
            .map(Some)
            .map_err(|_| "arg-malformed"),
    };
    let anchor = id_at(2)?;
    let facing = match p.get(&3) {
        None => Facing::AsItWas,
        Some(Value::Text(t)) if t.as_str().strip_prefix(NS) == Some("to_wall") => Facing::ToWall,
        Some(Value::Text(t)) if t.as_str().strip_prefix(NS) == Some("as_it_was") => Facing::AsItWas,
        Some(_) => Facing::Toward(id_at(3)?.ok_or("arg-malformed")?),
    };
    Ok(Ask {
        id,
        soul: match intent.actor {
            Actor::Soul(s) => s,
            _ => body,
        },
        body,
        thing,
        word,
        anchor,
        facing,
        planned,
        at,
    })
}

/// The copy's tree with `body` stood at `pose`, where the controller has it.
fn standing(copy: &Replica, body: Id, pose: Option<Pose>, at: Micros) -> R<Tree> {
    let mut tree = copy.tree().frozen();
    let Some(pose) = pose else { return Ok(tree) };
    let n = tree
        .handle(body)
        .and_then(|h| tree.node(h))
        .ok_or_else(|| refusal("intent.no-body", show(body)))?;
    let Some(parent) = n.parent() else {
        return Ok(tree);
    };
    let from = Frame {
        node: parent,
        slot: n.slot(),
    };
    let entry: Entry = (
        body,
        n.audience(),
        Body::Changes(vec![ChangeRec {
            change: Change::Reparent {
                node: body,
                from,
                pose,
            },
            rest: Rest::new(),
        }]),
    );
    let p = e4::part(
        copy.header(),
        tree.next(),
        at,
        body,
        Cause::World,
        vec![entry],
    )?;
    tree.apply(copy.header(), &p)?;
    Ok(tree)
}

/// Checks `a` off the clock thread on `copy` and the checker's `town` (its open ground's), with `bodies` the Souls'
/// bodies as G2 judges them (the controller's where it holds them) and `souls` the copy's.
pub fn check(
    a: &Ask,
    copy: &Replica,
    town: Option<&mut Town>,
    rules: &Rules,
    mint: &mut Minter,
    bodies: &[Who],
    souls: Vec<Who>,
) -> R<Checked> {
    let town = town.ok_or_else(|| refusal("setdown.no-ground", "the zone has no open ground"))?;
    let tree = standing(
        copy,
        a.body,
        bodies.iter().find(|w| w.body == a.body).map(|w| w.pose),
        a.at,
    )?;
    let hand = tree
        .handle(a.thing)
        .and_then(|h| tree.node(h))
        .filter(|n| n.parent() == Some(a.body))
        .and_then(|n| n.slot())
        .ok_or_else(|| {
            refusal(
                "not-held",
                format!("{} holds no {}", show(a.body), show(a.thing)),
            )
        })?;
    // Every Soul's body where it stands, in the root's frame: no place is chosen under one.
    let root = tree.root();
    let standing: Vec<Vec3> = bodies
        .iter()
        .filter_map(|w| {
            let h = tree.handle(w.pose.frame.node)?;
            xform_to(&tree, h, root).ok()?.point(w.pose.position).ok()
        })
        .collect();
    let ask = e4::Ask {
        soul: a.soul,
        body: a.body,
        what: What::Held(a.thing),
        word: a.word,
        anchor: a.anchor,
        facing: a.facing,
        bodies: &standing,
    };
    let header = copy.header();
    let none = |_: &Name| None;
    let planned = town.with_ground(|_, ground| {
        let mut w = e4::World {
            tree: &tree,
            rules,
            ground,
            outlines: &none,
            header,
            mint,
        };
        e4::plan(&mut w, &ask, a.at)
    })?;
    // Judged as the body's: G2's bodies name their Soul by its body (`crate::buildsafe`), so the holder's own thing is
    // not counted in use by it.
    let part = e4::part(
        header,
        tree.next(),
        a.at,
        a.body,
        Cause::Intent(a.id),
        planned.entries.clone(),
    )?;
    // G2's rule as `sim::setdown::judge_on` calls it, its guard kept for the commit's lookups.
    let (guard, v) = safety::check_on(&tree, header, &part, bodies, &Known::of(town))
        .map_err(|e| refusal("setdown.unsafe-check", e))?;
    verdict(&v)?;
    Ok(Checked {
        thing: a.thing,
        body: a.body,
        hand,
        parent: planned.chosen.parent,
        entries: planned.entries,
        walk: planned.walk,
        guard,
        souls,
    })
}

/// The first unsafe body's refusal, by the rule's name, naming the Soul.
pub fn verdict(v: &[replica::edit::Unsafe]) -> R<()> {
    match v.first() {
        Some(u) => Err(refusal(
            u.name,
            format!("{} at {}", show(u.soul), show(u.node)),
        )),
        None => Ok(()),
    }
}

/// The commit's lookups: the thing is still in the same hand of the same body, and its new parent still stands.
pub fn still_held(tree: &Tree, c: &Checked) -> R<()> {
    let held = tree
        .handle(c.thing)
        .and_then(|h| tree.node(h))
        .is_some_and(|n| n.parent() == Some(c.body) && n.slot() == Some(c.hand));
    if !held {
        return Err(refusal(
            "not-held",
            format!("{} no longer holds {}", show(c.body), show(c.thing)),
        ));
    }
    if tree.handle(c.parent).is_none() {
        return Err(refusal("setdown.gone", show(c.parent)));
    }
    Ok(())
}
