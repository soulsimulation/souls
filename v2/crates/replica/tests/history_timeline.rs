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
fn output_work_and_batch_bytes_grow_with_changes_not_nodes_times_changes() {
    let h = header();
    for (nodes, events) in [(8, 32), (64, 256), (256, 1024)] {
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
                    "cost observed={observed} nodes={nodes} events={events} repeat={repeat} elapsed_us={} inherited_seek_us={inherited_us} input_bytes={} output_bytes={} inspected={} emitted={}",
                    elapsed.as_micros(),
                    b.bytes().len(),
                    encoded.len(),
                    t.stats.inspected_nodes,
                    t.stats.emitted_nodes
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
