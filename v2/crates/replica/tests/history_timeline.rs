//! Exact-time public history output, differential against the existing seek API.
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, FIXTURE_HEADER, Header, Rest, State,
    TransferRec, fixture_bytes,
};
use replica::encode::{Value, encode};
use replica::history::{Bundle, public_snapshot, seek::state_at, timeline::Timeline};
use replica::ids::Id;
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::stream::public::{digest, observation_delta, project};
use replica::views::Redactions;
use replica::world_model::Audience;
use std::collections::BTreeMap;
use std::time::Instant;
fn header() -> Header {
    Header::read(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap()
}
fn id(h: &Header, n: u64) -> Id {
    Id::new(h.zone.scope(), n + 100).unwrap()
}
fn pose(parent: Id, x: i64) -> Pose {
    Pose {
        frame: Frame {
            node: parent,
            slot: None,
        },
        position: Vec3::new(x, 0, 0),
        orientation: Quat::IDENTITY,
        support: Support::Surface {
            surface: parent,
            height: 0,
        },
    }
}
fn create(h: &Header, node: Id, parent: Id) -> Change {
    Change::Create {
        node,
        kind: h.kinds[0].clone(),
        pose: pose(parent, 0),
        audience: Audience::Everyone,
        fields: BTreeMap::new(),
    }
}
fn effect(seq: u64, at: i64, node: Id, changes: Vec<Change>) -> Effect {
    Effect {
        envelope: Envelope {
            sequence: seq,
            at,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
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
fn set(node: Id, n: u64) -> Change {
    Change::Set {
        node,
        field: 42,
        to: Value::Uint(n),
        by: None,
    }
}
fn bundle(h: &Header, state: &State, es: &[Effect], observed: bool) -> Bundle {
    let snapshot = public_snapshot(state, &Redactions::default());
    let view = Value::Map(BTreeMap::from([(
        8,
        Value::Array(es.iter().map(Effect::to_value).collect()),
    )]));
    if !observed {
        return Bundle::new(h.hash().to_bytes(), 0, 60_000_000, snapshot, view).unwrap();
    }
    let mut s = state.clone();
    let base = project(h, &s).unwrap();
    let mut prior = base.clone();
    let mut rows = vec![];
    for (i, e) in es.iter().enumerate() {
        s.next = e.envelope.sequence;
        s.apply_entry(h, e).unwrap();
        let next = project(h, &s).unwrap();
        let delta = observation_delta(h, &prior, &next).unwrap();
        rows.push(Value::Array(vec![
            Value::Uint(i as u64 + 1),
            Value::Uint(0),
            Value::Uint(e.envelope.sequence),
            Value::Uint(e.envelope.at as u64),
            Value::Bytes(digest(&prior).unwrap()),
            Value::Bytes(digest(&next).unwrap()),
            delta,
        ]));
        prior = next;
    }
    let obs = Value::Map(BTreeMap::from([
        (1, Value::Uint(1)),
        (2, Value::Bytes(h.hash().to_bytes())),
        (3, base),
        (4, Value::Array(vec![Value::Uint(0), Value::Uint(0)])),
        (5, Value::Array(rows)),
        (6, Value::Bytes(digest(&prior).unwrap())),
        (
            7,
            Value::Array(vec![Value::Uint(es.len() as u64), Value::Uint(0)]),
        ),
        (8, Value::Bytes(vec![0; 32])),
    ]));
    Bundle::new_based(h.hash().to_bytes(), 0, 60_000_000, snapshot, view, obs).unwrap()
}
fn read(h: &Header, b: &Bundle, from: i64) -> Timeline {
    Timeline::read(h.stored(), b.bytes(), &b.hash(), from, 60_000_000).unwrap()
}
fn parity(h: &Header, b: &Bundle, from: i64, times: &[i64]) {
    let t = read(h, b, from);
    let mut nodes = t.initial.clone();
    let mut i = 0;
    for at in times {
        while i < t.transitions.len() && t.transitions[i].at <= *at {
            for id in &t.transitions[i].removed {
                nodes.remove(id);
            }
            nodes.extend(t.transitions[i].nodes.clone());
            i += 1;
        }
        assert_eq!(nodes, state_at(b, h, *at).unwrap().nodes, "at {at}");
    }
}
#[test]
fn birth_updates_equal_time_pose_removal_and_after_birth_control() {
    let h = header();
    let a = id(&h, 1);
    let b = id(&h, 2);
    let s = State::start(h.zone, h.kinds[0].clone());
    let es = vec![
        effect(
            0,
            3_250_001,
            h.zone,
            vec![create(&h, a, h.zone), create(&h, b, a)],
        ),
        effect(1, 4_000_000, a, vec![set(a, 1)]),
        effect(
            2,
            4_000_000,
            a,
            vec![Change::Reparent {
                node: a,
                from: pose(h.zone, 0).frame,
                pose: pose(h.zone, 9),
            }],
        ),
        effect(3, 5_000_000, a, vec![Change::Remove { node: a }]),
    ];
    for observed in [false, true] {
        let b = bundle(&h, &s, &es, observed);
        parity(
            &h,
            &b,
            0,
            &[0, 3_250_000, 3_250_001, 4_000_000, 5_000_000, 59_000_000],
        );
        parity(&h, &b, 3_500_000, &[3_500_000, 4_000_000, 5_000_000]);
        let t = read(&h, &b, 0);
        assert!(!t.initial.contains_key(&a));
        assert_eq!(t.transitions[0].at, 3_250_001);
        assert!(t.transitions[0].nodes.contains_key(&a));
        assert_eq!(t.transitions.last().unwrap().removed.len(), 2);
    }
}
#[test]
fn cross_parent_reparent_is_refused_not_an_omitted_descendant() {
    let h = header();
    let a = id(&h, 1);
    let b = id(&h, 2);
    let c = id(&h, 3);
    let mut s = State::start(h.zone, h.kinds[0].clone());
    s.apply_entry(
        &h,
        &effect(
            0,
            0,
            h.zone,
            vec![
                create(&h, a, h.zone),
                create(&h, b, h.zone),
                create(&h, c, a),
            ],
        ),
    )
    .unwrap();
    let e = effect(
        1,
        1,
        a,
        vec![
            Change::Reparent {
                node: a,
                from: pose(h.zone, 0).frame,
                pose: pose(b, 0),
            },
            Change::Remove { node: b },
        ],
    );
    assert_eq!(s.apply_entry(&h, &e).unwrap_err().name, "crosses-nodes");
}
#[test]
fn arrival_context_and_return_match_existing_seek() {
    let h = header();
    let a = id(&h, 1);
    let t = id(&h, 9);
    let mut s = State::start(h.zone, h.kinds[0].clone());
    s.apply_entry(&h, &effect(0, 0, h.zone, vec![create(&h, a, h.zone)]))
        .unwrap();
    let mut leave = effect(1, 1_000_000, a, vec![]);
    leave.body = Body::Transfer(TransferRec::Leave {
        transfer: t,
        node: a,
        lineage: h.zone.scope(),
        zone: h.zone,
        pose: pose(h.zone, 0),
    });
    let mut arrive = effect(2, 2_000_000, h.zone, vec![]);
    arrive.body = Body::Transfer(TransferRec::Arrive {
        transfer: t,
        carried: vec![],
    });
    for observed in [false, true] {
        // Legacy snapshots have no flights, so leave and arrival must both occur in this bundle.
        let b = bundle(&h, &s, &[leave.clone(), arrive.clone()], observed);
        parity(&h, &b, 0, &[0, 1_000_000, 2_000_000]);
    }
    // Observation baselines preserve an already-carried subtree arriving inside the requested window.
    s.apply_entry(&h, &leave).unwrap();
    let b = bundle(&h, &s, &[arrive], true);
    parity(&h, &b, 0, &[0, 2_000_000]);
    assert!(!read(&h, &b, 0).initial.contains_key(&a));
}
#[test]
fn rejects_corruption_and_malformed_input() {
    let h = header();
    let s = State::start(h.zone, h.kinds[0].clone());
    let b = bundle(&h, &s, &[], false);
    assert!(Timeline::read(h.stored(), b.bytes(), &[9; 32], 0, 1).is_err());
    assert!(Timeline::read(h.stored(), &[0xff], &replica::ids::sha256(&[0xff]), 0, 1).is_err());
    assert!(Timeline::read(h.stored(), b.bytes(), &b.hash(), -1, 1).is_err());
    for observed in [false, true] {
        let b = bundle(
            &h,
            &s,
            &[
                effect(0, 2, h.zone, vec![set(h.zone, 1)]),
                effect(1, 1, h.zone, vec![set(h.zone, 2)]),
            ],
            observed,
        );
        assert!(Timeline::read(h.stored(), b.bytes(), &b.hash(), 0, 3).is_err());
    }
}
#[test]
// This test measures a read-only API; the engine itself receives no clock.
#[allow(clippy::disallowed_methods)]
fn output_work_and_batch_bytes_grow_with_changes_not_nodes_times_changes() {
    let h = header();
    for (nodes, events) in [(8, 32), (64, 256), (256, 1024), (1024, 256)] {
        let mut s = State::start(h.zone, h.kinds[0].clone());
        let births = (0..nodes).map(|i| create(&h, id(&h, i), h.zone)).collect();
        s.apply_entry(&h, &effect(0, 0, h.zone, births)).unwrap();
        let es: Vec<_> = (0..events)
            .map(|i| {
                effect(
                    i + 1,
                    (i + 1) as i64,
                    id(&h, i % nodes),
                    vec![set(id(&h, i % nodes), i)],
                )
            })
            .collect();
        for observed in [false, true] {
            let b = bundle(&h, &s, &es, observed);
            let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/history-timeline-fixture");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(format!("cost-{observed}-{nodes}.cbor")), b.bytes()).unwrap();
            for repeat in 0..2 {
                let now = Instant::now();
                let t = read(&h, &b, 0);
                let elapsed = now.elapsed();
                let validation_start = Instant::now();
                state_at(&b, &h, 0).unwrap();
                let inherited_us = validation_start.elapsed().as_micros();
                let encoded = encode(&t.to_value()).unwrap();
                assert_eq!(t.stats.records, events as usize);
                assert_eq!(t.stats.inspected_nodes, events as usize);
                assert_eq!(t.stats.emitted_nodes, (nodes + 1 + events) as usize);
                println!(
                    "cost observed={observed} nodes={nodes} events={events} repeat={repeat} elapsed_us={} inherited_seek_us={inherited_us} input_bytes={} output_bytes={} inspected={} emitted={} fast={} whole={}",
                    elapsed.as_micros(),
                    b.bytes().len(),
                    encoded.len(),
                    t.stats.inspected_nodes,
                    t.stats.emitted_nodes,
                    t.stats.fast_rows,
                    t.stats.whole_rows
                );
            }
        }
    }
}

#[test]
fn carried_prefix_supplies_public_arrival_context_and_motion() {
    let h = header();
    let root = State::start(h.zone, h.kinds[0].clone());
    let parent = id(&h, 1);
    let body = id(&h, 2);
    let mut context = root.clone();
    context
        .apply_entry(&h, &effect(0, 0, h.zone, vec![create(&h, parent, h.zone)]))
        .unwrap();
    let Value::Map(snapshot) = public_snapshot(&context, &Redactions::default()) else {
        unreachable!()
    };
    let Value::Array(rows) = &snapshot[&1] else {
        unreachable!()
    };
    let row = rows
        .iter()
        .find(|row| matches!(row,Value::Array(r) if r[0]==parent.to_value()))
        .unwrap()
        .clone();
    let prefix = Value::Map(BTreeMap::from([(
        0,
        Value::Map(BTreeMap::from([
            (2, Value::Array(vec![row])),
            (3, Value::Array(vec![])),
        ])),
    )]));
    let mut arrival = effect(0, 1_250_001, parent, vec![]);
    arrival.body = Body::Transfer(TransferRec::Arrive {
        transfer: id(&h, 9),
        carried: vec![ChangeRec {
            change: create(&h, body, parent),
            rest: Rest::new(),
        }],
    });
    let movement = effect(
        1,
        2_000_000,
        body,
        vec![Change::Motion(HandOff {
            node: body,
            at: 2_000_000,
            from: Owner::Mover,
            to: Owner::Mover,
            pose: pose(parent, 15),
            linear: Vec3::ZERO,
            angular: Vec3::ZERO,
        })],
    );
    let b = Bundle::new(
        h.hash().to_bytes(),
        0,
        60_000_000,
        public_snapshot(&root, &Redactions::default()),
        Value::Map(BTreeMap::from([(
            8,
            Value::Array(vec![prefix, arrival.to_value(), movement.to_value()]),
        )])),
    )
    .unwrap();
    parity(&h, &b, 0, &[0, 1_250_000, 1_250_001, 2_000_000]);
    assert_eq!(read(&h, &b, 0).transitions[0].nodes.len(), 2);
}
#[test]
fn observation_tampering_private_effect_and_header_mismatch_are_refused() {
    let h = header();
    let state = State::start(h.zone, h.kinds[0].clone());
    let mut b = bundle(
        &h,
        &state,
        &[effect(0, 1, h.zone, vec![set(h.zone, 1)])],
        true,
    );
    let Value::Map(obs) = b.observation.as_mut().unwrap() else {
        unreachable!()
    };
    obs.insert(6, Value::Bytes(vec![9; 32]));
    let corrupt = Bundle::new_based(
        b.header.clone(),
        b.start,
        b.length,
        b.snapshot,
        b.view,
        b.observation.unwrap(),
    )
    .unwrap();
    assert!(Timeline::read(h.stored(), corrupt.bytes(), &corrupt.hash(), 0, 10).is_err());
    let mut e = effect(0, 1, h.zone, vec![set(h.zone, 1)]);
    e.envelope.audience = Audience::Of(id(&h, 9));
    let b = bundle(&h, &state, &[e], false);
    assert!(Timeline::read(h.stored(), b.bytes(), &b.hash(), 0, 10).is_err());
    let b = Bundle::new(
        vec![9; 32],
        0,
        60_000_000,
        public_snapshot(&state, &Redactions::default()),
        Value::Map(BTreeMap::from([(8, Value::Array(vec![]))])),
    )
    .unwrap();
    assert!(Timeline::read(h.stored(), b.bytes(), &b.hash(), 0, 10).is_err());
}
#[test]
fn writes_owned_binding_fixture() {
    let h = header();
    let state = State::start(h.zone, h.kinds[0].clone());
    let a = id(&h, 1);
    let es = [effect(0, 1_250_001, h.zone, vec![create(&h, a, h.zone)])];
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/history-timeline-fixture");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("header.cbor"), h.stored()).unwrap();
    for observed in [false, true] {
        let b = bundle(&h, &state, &es, observed);
        let name = if observed { "observation" } else { "legacy" };
        std::fs::write(dir.join(format!("{name}.cbor")), b.bytes()).unwrap();
        std::fs::write(
            dir.join(format!("{name}.out.cbor")),
            encode(&read(&h, &b, 0).to_value()).unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn projection_reader_matches_whole_checks_and_rolls_back_refusals() {
    use replica::stream::public::{ProjectionReader, apply_observation};
    let h = header();
    let a = id(&h, 1);
    let transfer = id(&h, 9);
    let mut s = State::start(h.zone, h.kinds[0].clone());
    let mut leave = effect(3, 4, a, vec![]);
    leave.body = Body::Transfer(TransferRec::Leave {
        transfer,
        node: a,
        lineage: h.zone.scope(),
        zone: h.zone,
        pose: pose(h.zone, 0),
    });
    let mut arrive = effect(4, 5, h.zone, vec![]);
    arrive.body = Body::Transfer(TransferRec::Arrive {
        transfer,
        carried: vec![],
    });
    let effects = vec![
        effect(0, 1, h.zone, vec![create(&h, a, h.zone)]),
        effect(1, 2, a, vec![set(a, 1)]),
        effect(
            2,
            3,
            a,
            vec![Change::Reparent {
                node: a,
                from: pose(h.zone, 0).frame,
                pose: pose(h.zone, 4),
            }],
        ),
        leave,
        arrive,
        effect(5, 6, a, vec![set(a, 2)]),
        effect(6, 7, a, vec![Change::Remove { node: a }]),
    ];
    let mut prior = project(&h, &s).unwrap();
    let mut reader = ProjectionReader::new(&h, prior.clone()).unwrap();
    let mut paths = vec![];
    for e in effects {
        s.next = e.envelope.sequence;
        s.apply_entry(&h, &e).unwrap();
        let next = project(&h, &s).unwrap();
        let delta = observation_delta(&h, &prior, &next).unwrap();
        let before = digest(&prior).unwrap();
        let after = digest(&next).unwrap();
        assert_eq!(apply_observation(&h, &prior, &delta).unwrap(), next);
        for (b, a, seq) in [
            (&[9; 32][..], after.as_slice(), e.envelope.sequence),
            (before.as_slice(), &[9; 32][..], e.envelope.sequence),
            (before.as_slice(), after.as_slice(), u64::MAX),
        ] {
            assert!(reader.apply(&delta, b, a, seq).is_err());
            assert_eq!(reader.state(), &prior);
            assert_eq!(reader.digest(), before);
        }
        paths.push(
            reader
                .apply(&delta, &before, &after, e.envelope.sequence)
                .unwrap(),
        );
        assert_eq!(reader.state(), &next);
        assert_eq!(reader.digest(), after);
        prior = next;
    }
    assert_eq!(paths, vec![true, true, true, false, false, true, true]);
    assert_eq!(reader.fast_rows, 5);
    assert_eq!(reader.whole_rows, 2);
    // A private replacement and a duplicate row must be refused by both independent validation paths.
    let mut s = State::start(h.zone, h.kinds[0].clone());
    s.apply_entry(&h, &effect(0, 0, h.zone, vec![create(&h, a, h.zone)]))
        .unwrap();
    let prior = project(&h, &s).unwrap();
    s.apply_entry(&h, &effect(1, 1, a, vec![set(a, 1)]))
        .unwrap();
    let next = project(&h, &s).unwrap();
    let delta = observation_delta(&h, &prior, &next).unwrap();
    for private in [false, true] {
        let Value::Map(mut d) = delta.clone() else {
            unreachable!()
        };
        let Value::Array(rows) = d.get_mut(&2).unwrap() else {
            unreachable!()
        };
        if private {
            let Value::Array(r) = &mut rows[0] else {
                unreachable!()
            };
            let Value::Map(n) = &mut r[1] else {
                unreachable!()
            };
            n.insert(
                4,
                Value::Map(BTreeMap::from([
                    (1, Value::Uint(2)),
                    (2, id(&h, 99).to_value()),
                ])),
            );
        } else {
            rows.push(rows[0].clone());
        }
        let malformed = Value::Map(d);
        assert!(apply_observation(&h, &prior, &malformed).is_err());
        let mut reader = ProjectionReader::new(&h, prior.clone()).unwrap();
        assert!(
            reader
                .apply(
                    &malformed,
                    &digest(&prior).unwrap(),
                    &digest(&next).unwrap(),
                    1
                )
                .is_err()
        );
        assert_eq!(reader.state(), &prior);
    }
}

#[test]
fn earlier_touch_cannot_hide_descendant_removals() {
    let h = header();
    let a = id(&h, 1);
    let b = id(&h, 2);
    let mut state = State::start(h.zone, h.kinds[0].clone());
    state
        .apply_entry(
            &h,
            &effect(0, 0, h.zone, vec![create(&h, a, h.zone), create(&h, b, a)]),
        )
        .unwrap();
    let changes = vec![
        set(a, 9),
        Change::Reparent {
            node: a,
            from: pose(h.zone, 0).frame,
            pose: pose(h.zone, 4),
        },
        Change::Motion(HandOff {
            node: a,
            at: 1,
            from: Owner::Mover,
            to: Owner::Mover,
            pose: pose(h.zone, 4),
            linear: Vec3::ZERO,
            angular: Vec3::ZERO,
        }),
    ];
    for first in changes {
        for observed in [false, true] {
            let bdl = bundle(
                &h,
                &state,
                &[effect(
                    1,
                    1,
                    a,
                    vec![first.clone(), Change::Remove { node: a }],
                )],
                observed,
            );
            let t = read(&h, &bdl, 0);
            assert_eq!(t.initial.len(), 3);
            assert_eq!(t.transitions.len(), 1);
            assert_eq!(t.transitions[0].removed, vec![a, b]);
            assert!(t.transitions[0].nodes.is_empty());
            let mut expected = t.initial;
            for id in &t.transitions[0].removed {
                expected.remove(id);
            }
            assert_eq!(expected.keys().copied().collect::<Vec<_>>(), vec![h.zone]);
        }
    }
}

#[test]
fn legacy_explicit_private_snapshot_and_carried_rows_are_refused() {
    let h = header();
    let state = State::start(h.zone, h.kinds[0].clone());
    let private = Value::Map(BTreeMap::from([
        (1, Value::Uint(2)),
        (2, id(&h, 99).to_value()),
    ]));
    let Value::Map(mut snapshot) = public_snapshot(&state, &Redactions::default()) else {
        unreachable!()
    };
    let Value::Array(rows) = snapshot.get_mut(&1).unwrap() else {
        unreachable!()
    };
    let Value::Array(row) = &mut rows[0] else {
        unreachable!()
    };
    let Value::Map(node) = &mut row[1] else {
        unreachable!()
    };
    node.insert(4, private.clone());
    let b = Bundle::new(
        h.hash().to_bytes(),
        0,
        60_000_000,
        Value::Map(snapshot.clone()),
        Value::Map(BTreeMap::from([(8, Value::Array(vec![]))])),
    )
    .unwrap();
    assert!(Timeline::read(h.stored(), b.bytes(), &b.hash(), 0, 2).is_err());
    let Value::Array(rows) = snapshot.get_mut(&1).unwrap() else {
        unreachable!()
    };
    let Value::Array(row) = &mut rows[0] else {
        unreachable!()
    };
    let Value::Map(node) = &mut row[1] else {
        unreachable!()
    };
    node.remove(&4);
    let b = Bundle::new(
        h.hash().to_bytes(),
        0,
        60_000_000,
        Value::Map(snapshot),
        Value::Map(BTreeMap::from([(8, Value::Array(vec![]))])),
    )
    .unwrap();
    assert_eq!(read(&h, &b, 0).initial.len(), 1);
    for link in [false, true] {
        let mut context = BTreeMap::from([(2, Value::Array(vec![])), (3, Value::Array(vec![]))]);
        let row = Value::Array(vec![
            id(&h, 1).to_value(),
            Value::Map(BTreeMap::from([
                (1, Value::Text(h.kinds[0].clone())),
                (4, private.clone()),
            ])),
        ]);
        context.insert(if link { 3 } else { 2 }, Value::Array(vec![row]));
        let b = Bundle::new(
            h.hash().to_bytes(),
            0,
            60_000_000,
            public_snapshot(&state, &Redactions::default()),
            Value::Map(BTreeMap::from([(
                8,
                Value::Array(vec![
                    Value::Map(BTreeMap::from([(0, Value::Map(context))])),
                    effect(0, 1, h.zone, vec![set(h.zone, 1)]).to_value(),
                ]),
            )])),
        )
        .unwrap();
        assert_eq!(
            Timeline::read(h.stored(), b.bytes(), &b.hash(), 0, 2)
                .unwrap_err()
                .detail,
            "nonpublic legacy row"
        );
    }
}
#[test]
fn actual_transfer_return_restores_exact_subtree() {
    let h = header();
    let a = id(&h, 1);
    let child = id(&h, 2);
    let transfer = id(&h, 9);
    let mut s = State::start(h.zone, h.kinds[0].clone());
    s.apply_entry(
        &h,
        &effect(
            0,
            0,
            h.zone,
            vec![create(&h, a, h.zone), create(&h, child, a)],
        ),
    )
    .unwrap();
    let original = s.nodes.clone();
    let mut leave = effect(1, 1, a, vec![]);
    leave.body = Body::Transfer(TransferRec::Leave {
        transfer,
        node: a,
        lineage: h.zone.scope(),
        zone: h.zone,
        pose: pose(h.zone, 0),
    });
    let mut returned = effect(2, 2, h.zone, vec![]);
    returned.body = Body::Transfer(TransferRec::Return {
        transfer,
        reason: h.kinds[0].clone(),
    });
    for observed in [false, true] {
        let b = bundle(&h, &s, &[leave.clone(), returned.clone()], observed);
        let t = read(&h, &b, 0);
        assert_eq!(t.transitions[0].removed, vec![a, child]);
        assert_eq!(t.transitions[1].nodes.len(), 2);
        let mut actual = t.initial;
        for transition in t.transitions {
            for id in transition.removed {
                actual.remove(&id);
            }
            actual.extend(transition.nodes);
        }
        assert_eq!(actual, original);
    }
}

#[test]
// Measure pure reader work only; no runtime clock enters replay.
#[allow(clippy::disallowed_methods)]
fn fallback_cost_and_return_to_cached_rows() {
    use replica::stream::public::{ProjectionReader, apply_observation};
    let h = header();
    let a = id(&h, 1);
    let transfer = id(&h, 9000);
    let mut state = State::start(h.zone, h.kinds[0].clone());
    state
        .apply_entry(
            &h,
            &effect(
                0,
                0,
                h.zone,
                (1..=256).map(|i| create(&h, id(&h, i), h.zone)).collect(),
            ),
        )
        .unwrap();
    let mut leave = effect(2, 2, a, vec![]);
    leave.body = Body::Transfer(TransferRec::Leave {
        transfer,
        node: a,
        lineage: h.zone.scope(),
        zone: h.zone,
        pose: pose(h.zone, 0),
    });
    let mut arrive = effect(3, 3, h.zone, vec![]);
    arrive.body = Body::Transfer(TransferRec::Arrive {
        transfer,
        carried: vec![],
    });
    let baseline = project(&h, &state).unwrap();
    let mut prior = baseline.clone();
    let mut rows = vec![];
    for e in [
        effect(1, 1, a, vec![set(a, 1)]),
        leave,
        arrive,
        effect(4, 4, a, vec![set(a, 2)]),
        effect(5, 5, a, vec![set(a, 3)]),
    ] {
        state.apply_entry(&h, &e).unwrap();
        let next = project(&h, &state).unwrap();
        rows.push((
            e.envelope.sequence,
            observation_delta(&h, &prior, &next).unwrap(),
            digest(&prior).unwrap(),
            digest(&next).unwrap(),
        ));
        prior = next;
    }
    for repeat in 0..2 {
        let mut reader = ProjectionReader::new(&h, baseline.clone()).unwrap();
        let mut old = baseline.clone();
        for (seq, delta, before, after) in &rows {
            let started = Instant::now();
            let fast = reader.apply(delta, before, after, *seq).unwrap();
            let candidate_us = started.elapsed().as_micros();
            let started = Instant::now();
            assert_eq!(digest(&old).unwrap(), *before);
            old = apply_observation(&h, &old, delta).unwrap();
            assert_eq!(digest(&old).unwrap(), *after);
            let whole_us = started.elapsed().as_micros();
            assert_eq!(reader.state(), &old);
            println!(
                "fallback repeat={repeat} sequence={seq} fast={fast} candidate_us={candidate_us} whole_us={whole_us}"
            );
        }
        assert_eq!((reader.fast_rows, reader.whole_rows), (3, 2));
    }
}

#[test]
fn validated_unsorted_baseline_uses_whole_then_cached_path() {
    use replica::stream::public::{ProjectionReader, apply_observation};
    let h = header();
    let a = id(&h, 1);
    let b = id(&h, 2);
    let mut state = State::start(h.zone, h.kinds[0].clone());
    state
        .apply_entry(
            &h,
            &effect(
                0,
                0,
                h.zone,
                vec![create(&h, a, h.zone), create(&h, b, h.zone)],
            ),
        )
        .unwrap();
    let mut prior = project(&h, &state).unwrap();
    let Value::Map(m) = &mut prior else {
        unreachable!()
    };
    let Value::Array(rows) = m.get_mut(&2).unwrap() else {
        unreachable!()
    };
    rows.reverse();
    let mut reader = ProjectionReader::new(&h, prior.clone()).unwrap();
    for seq in [1, 2] {
        state
            .apply_entry(&h, &effect(seq, seq as i64, a, vec![set(a, seq)]))
            .unwrap();
        let next = project(&h, &state).unwrap();
        let delta = observation_delta(&h, &prior, &next).unwrap();
        assert_eq!(apply_observation(&h, &prior, &delta).unwrap(), next);
        assert_eq!(
            reader
                .apply(
                    &delta,
                    &digest(&prior).unwrap(),
                    &digest(&next).unwrap(),
                    seq
                )
                .unwrap(),
            seq == 2
        );
        assert_eq!(reader.state(), &next);
        prior = next;
    }
}
