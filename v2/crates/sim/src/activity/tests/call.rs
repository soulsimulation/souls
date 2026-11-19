//! E13's call (#2784, A3): two Souls 39 m apart, beyond a shout, joined in one activity, hear each other when each
//! speaks to its members; a Soul beside one of them that is not a member does not hear the other.
//! `cargo test -p sim a3_a_call -- --nocapture` prints the hearers.

use std::collections::BTreeMap;

use replica::speech::{Radii, Reach, length_of};
use replica::world_model::show;

use super::world;
use crate::controller::Line;
use crate::speech::{Carriers, Hearing, said_by};

#[test]
fn a3_a_call_joins_two_souls_far_apart() {
    let mut w = world(80, 0x13);
    let (a, b, beside_b) = (0, 79, 39);
    let act = w.pair(a, b, 0);
    let members = |activity| {
        w.acts
            .members(activity)
            .map(|m| m.iter().map(|m| m.body).collect())
            .unwrap_or_default()
    };
    let devices = BTreeMap::new();
    let carriers = Carriers {
        radii: Radii::default(),
        members: &members,
        devices: &devices,
    };
    let mut hearing = Hearing::new();
    hearing.update(w.c.near(), w.bodies.iter().copied());
    let line = |reach| Line {
        words: w.bodies[0],
        length: length_of("can you hear me"),
        replace: false,
        reach,
    };
    let near = w.c.near();
    let (pa, pb) = (near.body(w.bodies[a]), near.body(w.bodies[b]));
    let call_a = said_by(
        &hearing,
        near,
        &carriers,
        w.bodies[a],
        &line(Reach::Members(act)),
    );
    let call_b = said_by(
        &hearing,
        near,
        &carriers,
        w.bodies[b],
        &line(Reach::Members(act)),
    );
    let talk_a = said_by(&hearing, near, &carriers, w.bodies[a], &line(Reach::Talk));
    let shout_a = said_by(&hearing, near, &carriers, w.bodies[a], &line(Reach::Loud));
    println!(
        "A3: {} at {:?} and {} at {:?} (µm) in a call {}: {} heard by {} Souls, {} among them; {} heard by {} Souls, \
         {} among them; talk ({} Souls) and a shout ({} Souls) from {} do not reach {}",
        show(w.bodies[a]),
        pa.map(|p| p.1),
        show(w.bodies[b]),
        pb.map(|p| p.1),
        show(act),
        show(w.bodies[a]),
        call_a.hearers.len(),
        show(w.bodies[b]),
        show(w.bodies[b]),
        call_b.hearers.len(),
        show(w.bodies[a]),
        talk_a.hearers.len(),
        shout_a.hearers.len(),
        show(w.bodies[a]),
        show(w.bodies[b]),
    );
    assert!(call_a.hearers.contains(&w.bodies[b]));
    assert!(call_b.hearers.contains(&w.bodies[a]));
    assert!(!call_a.hearers.contains(&w.bodies[beside_b]));
    assert!(!talk_a.hearers.contains(&w.bodies[b]));
    assert!(!shout_a.hearers.contains(&w.bodies[b]));
}
