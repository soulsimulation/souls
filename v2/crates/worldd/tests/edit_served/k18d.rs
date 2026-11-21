//! Committed creator geometry must reach the already-running planner before the next ordinary move.
use super::*;

fn row(values: &[i64]) -> Value {
    Value::Array(values.iter().copied().map(int).collect())
}

fn polygon(x0: i64, x1: i64, z0: i64, z1: i64) -> Value {
    Value::Array(vec![
        row(&[x0, z0]),
        row(&[x1, z0]),
        row(&[x1, z1]),
        row(&[x0, z1]),
    ])
}

async fn terminal(ws: &mut Ws) -> Got {
    loop {
        let got = read_answer(&next(ws).await);
        if got.kind != 3 {
            return got;
        }
    }
}

fn soul_intent(
    w: &Seeded,
    soul: Id,
    sequence: u64,
    verb: &str,
    target: Option<Id>,
    parameters: BTreeMap<u64, Value>,
) -> Vec<u8> {
    encode(
        &Intent {
            actor: Actor::Soul(soul),
            verb: Name::new(verb).unwrap(),
            target: target.map(Target::Node),
            parameters,
            sequence,
            basis: basis(w.root.scope(), 0),
            expiry: answers::now() + 120_000_000,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
            reflex: false,
        }
        .to_value(),
    )
    .unwrap()
}

fn place(
    name: u64,
    kind: Name,
    parent: Ref,
    position: Vec3,
    support: Support,
    fields: BTreeMap<u64, Value>,
) -> Op {
    Op::Place {
        name,
        kind,
        parent,
        at: Spot {
            slot: None,
            position,
            orientation: Quat::IDENTITY,
            support,
        },
        audience: Audience::Everyone,
        fields,
    }
}

/// The new building's walls: the closed partition at x 0 and three outer walls (µm rows of the building's frame).
fn host_solids() -> Vec<Value> {
    vec![
        row(&[0, 0, 100, 2000, 0, 0, 2500, 1, 0]),
        row(&[4000, 0, 100, 2000, 0, 0, 2500, 1, 0]),
        row(&[2000, -2000, 2000, 100, 0, 0, 2500, 1, 0]),
        row(&[2000, 2000, 2000, 100, 0, 0, 2500, 1, 0]),
    ]
}

fn room_batch(w: &Seeded, im: &import_eden::Import, building: &Name, x: i64, z: i64) -> Vec<Op> {
    let pinned = |plain: &str| {
        Name::new(
            im.rules
                .kinds
                .keys()
                .find(|kind| replica::world_model::plain(kind) == plain)
                .unwrap(),
        )
        .unwrap()
    };
    let solids = host_solids();
    vec![
        place(
            1,
            building.clone(),
            Ref::Node(w.ground),
            Vec3::new((x + 8) * M, 0, (z + 4) * M),
            Support::Surface {
                surface: w.ground,
                height: 0,
            },
            BTreeMap::from([(import_eden::F_SOLIDS, Value::Array(solids))]),
        ),
        place(
            2,
            pinned(import_eden::FLOOR),
            Ref::New(1),
            Vec3::ZERO,
            Support::None,
            BTreeMap::from([(import_eden::F_LEVEL, int(0))]),
        ),
        Op::Set {
            node: Ref::New(2),
            field: import_eden::F_SURFACES,
            to: Value::Array(vec![Value::Array(vec![
                int(0),
                polygon(-4000, 4000, -2000, 2000),
            ])]),
        },
        place(
            3,
            pinned(import_eden::ROOM),
            Ref::New(2),
            Vec3::new(-2 * M, 0, 0),
            Support::None,
            BTreeMap::from([
                (import_eden::F_LEVEL, int(0)),
                (import_eden::F_HEIGHT, int(2500)),
                (import_eden::F_OUTLINE, polygon(-1900, 1900, -1900, 1900)),
            ]),
        ),
        place(
            4,
            pinned(import_eden::ROOM),
            Ref::New(2),
            Vec3::new(2 * M, 0, 0),
            Support::None,
            BTreeMap::from([
                (import_eden::F_LEVEL, int(0)),
                (import_eden::F_HEIGHT, int(2500)),
                (import_eden::F_OUTLINE, polygon(-1900, 1900, -1900, 1900)),
            ]),
        ),
    ]
}

fn furnishing_batch(
    door_source: &replica::tree::NodeRef<'_>,
    chair_source: &replica::tree::NodeRef<'_>,
    host: Id,
    foyer: Id,
    inner: Id,
) -> Vec<Op> {
    let closed = row(&[0, 0, 100, 2000, 0, 0, 2500, 1, 0]);
    let open = vec![
        row(&[0, -1300, 100, 700, 0, 0, 2500, 1, 0]),
        row(&[0, 1300, 100, 700, 0, 0, 2500, 1, 0]),
    ];
    let mut door_fields = door_source.fields().clone();
    door_fields.remove(&sim::ground::scene::F_OPEN_DOOR_LINK);
    door_fields.remove(&replica::edit::DOOR_GEOMETRY);
    door_fields.insert(import_eden::F_OPEN, int(0));
    let leaf = Op::Place {
        name: 1,
        kind: door_source.kind().clone(),
        parent: Ref::Node(foyer),
        at: Spot {
            slot: None,
            position: Vec3::new(2 * M, 0, 0),
            orientation: Quat::from_yaw_mdeg(90_000).unwrap(),
            support: Support::Surface {
                surface: foyer,
                height: 0,
            },
        },
        audience: Audience::Everyone,
        fields: door_fields,
    };
    let chair = place(
        2,
        chair_source.kind().clone(),
        Ref::Node(inner),
        Vec3::new(0, 0, -509_000),
        Support::Surface {
            surface: inner,
            height: 0,
        },
        chair_source.fields().clone(),
    );
    let passage = Op::Doorway {
        name: 3,
        door: Ref::New(1),
        from: Ref::Node(foyer),
        to: Ref::Node(inner),
        at: [0, 0],
        yaw: 90_000,
        width: 1200,
        height: 2100,
        wall: Ref::Node(host),
        closed: vec![closed],
        open,
    };
    vec![leaf, chair, passage]
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the exported static Eden facts file"]
async fn k18d_creator_builds_room_door_chair_and_live_planner_approaches_its_exact_slot() {
    let text = std::fs::read_to_string(std::env::var("EDEN_FACTS").expect("EDEN_FACTS")).unwrap();
    let im = import_eden::load(&text).unwrap();
    let source = |id| im.tree.node(im.tree.handle(id).unwrap()).unwrap();
    let building = im
        .nodes
        .values()
        .copied()
        .map(source)
        .find(|node| {
            im.rules.kinds[node.kind().as_str()]
                .children
                .contains(import_eden::FLOOR)
                && node.fields().contains_key(&import_eden::F_SOLIDS)
        })
        .expect("an existing pinned floor-admitting building kind");
    let chair_source = source(im.nodes["e_0fc49dc9"]);
    let door_source = im
        .nodes
        .values()
        .copied()
        .map(source)
        .find(|node| {
            node.fields()
                .contains_key(&sim::ground::scene::F_OPEN_DOOR_LINK)
                && im.rules.kinds[node.kind().as_str()].owner == "thing"
        })
        .expect("an existing physical door leaf");
    let (x, z) = clear_row(&text);
    let d = scratch("k18d-room");
    let entries = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let w = seed_entries(&d, &text, 2, (x, z), Some(&entries));
    let (c, actor) = creator(0xd8);
    static_creator(&w, c);
    let socket = d.join("s");
    let served = serve_with(&w, &socket, None);
    served.line("listening ", 120);
    let (url, tokens) = gateway(
        &socket,
        &[actor, Actor::Soul(w.souls[0]), Actor::Soul(w.souls[1])],
    )
    .await;
    let mut maker = sign_in(&url, &tokens[0]).await;
    let mut soul = sign_in(&url, &tokens[1]).await;
    let mut other = sign_in(&url, &tokens[2]).await;
    let batch = room_batch(&w, &im, building.kind(), x, z);
    let bytes = edit_batch_intent(&w, actor, 1, 0, batch);
    replica::intent_decode::decode(&bytes).expect("the actual floor/room batch passes gateway I2");
    let (made, _) = send(&mut maker, bytes).await;
    assert_eq!(
        made.kind, 1,
        "creator's supported building/floor/two rooms commit: {made:?}"
    );
    assert!(!made.entries.is_empty());
    durable(&w, actor, 1, &made);
    let (host, floor, foyer, inner) = (
        made.names[&1],
        made.names[&2],
        made.names[&3],
        made.names[&4],
    );
    let bytes = edit_batch_intent(
        &w,
        actor,
        2,
        made.version,
        furnishing_batch(&door_source, &chair_source, host, foyer, inner),
    );
    replica::intent_decode::decode(&bytes).expect("the actual door/chair batch passes gateway I2");
    let (opened, _) = send(&mut maker, bytes).await;
    assert_eq!(
        opened.kind, 1,
        "new leaf/chair/owned doorway commit: {opened:?}"
    );
    assert!(!opened.entries.is_empty());
    durable(&w, actor, 2, &opened);
    let (door, chair, link) = (opened.names[&1], opened.names[&2], opened.names[&3]);
    let (copy, rules) = served_copy(&w);
    assert_eq!(copy.tree().link(link).unwrap().1, [foyer, inner]);
    let mut town = committed_town(&copy, rules, w.ground);
    let (support, _, _) = town.view().on_floor(chair, Vec3::ZERO).unwrap();
    assert_eq!(support, floor);
    let tick_before = last_tick(&w);
    put(
        &mut other,
        soul_intent(
            &w,
            w.souls[1],
            1,
            "eden:walk",
            Some(w.ground),
            BTreeMap::from([(1, row(&[(x + 2) * M, 0, (z + 7) * M]))]),
        ),
    )
    .await;
    put(
        &mut soul,
        soul_intent(&w, w.souls[0], 1, "eden:walk", Some(chair), BTreeMap::new()),
    )
    .await;
    let approached = terminal(&mut soul).await;
    assert_eq!(
        approached.kind, 1,
        "normal walk reaches the new chair: {approached:?}"
    );
    assert!(!approached.entries.is_empty());
    durable(&w, Actor::Soul(w.souls[0]), 1, &approached);
    put(
        &mut soul,
        soul_intent(&w, w.souls[0], 2, "eden:sit", Some(chair), BTreeMap::new()),
    )
    .await;
    let seated = terminal(&mut soul).await;
    assert_eq!(
        seated.kind, 1,
        "normal sit occupies the approached new chair: {seated:?}"
    );
    assert!(!seated.entries.is_empty());
    durable(&w, Actor::Soul(w.souls[0]), 2, &seated);
    let body = born_body(&w, w.souls[0]);
    assert!(
        poses(&w).iter().any(|(b, pose)| *b == body
            && pose.frame.node == chair
            && pose.frame.slot == Some(1)
            && pose.support == Support::Slot),
        "actual body occupies the new chair's exact slot"
    );
    let walked = terminal(&mut other).await;
    assert_eq!(walked.kind, 1, "unrelated Soul progresses: {walked:?}");
    assert!(!walked.entries.is_empty());
    durable(&w, Actor::Soul(w.souls[1]), 1, &walked);
    assert!(last_tick(&w) > tick_before, "the real clock progressed");
    let (blocked, _) = send(
        &mut maker,
        edit_intent(
            &w,
            actor,
            3,
            seated.version,
            Op::Remove {
                node: Ref::Node(door),
            },
        ),
    )
    .await;
    assert_eq!(
        (blocked.kind, blocked.reason.as_str()),
        (2, "edit.would-cut-off")
    );
    let (copy, _) = served_copy(&w);
    assert!(copy.tree().handle(door).is_some());
    assert!(copy.tree().link(link).is_some());
    let (in_use, _) = send(
        &mut maker,
        edit_intent(
            &w,
            actor,
            4,
            blocked.version,
            Op::Remove {
                node: Ref::Node(chair),
            },
        ),
    )
    .await;
    assert_eq!((in_use.kind, in_use.reason.as_str()), (2, "edit.in-use"));
    // #3826: a second Soul is refused the occupied slot, and a wall over the seated Soul is refused by BUILDSAFE.
    put(
        &mut other,
        soul_intent(&w, w.souls[1], 2, "eden:sit", Some(chair), BTreeMap::new()),
    )
    .await;
    let taken = terminal(&mut other).await;
    assert_eq!(
        taken.kind, 2,
        "the occupied slot refuses a second Soul: {taken:?}"
    );
    let walls = |w: &Seeded| {
        let (copy, _) = served_copy(w);
        let t = copy.tree();
        t.node(t.handle(host).unwrap()).unwrap().fields()[&import_eden::F_SOLIDS].clone()
    };
    let before = walls(&w);
    let Value::Array(mut buried) = before.clone() else {
        panic!("the building's walls: {before:?}")
    };
    // A solid filling the inner room, the chair in it at (2 m, -0.509 m) of the building's frame: no ground is left
    // for the seated Soul to stand up onto.
    buried.push(row(&[2000, 0, 1900, 1900, 0, 0, 2500, 1, 0]));
    let (bury, _) = send(
        &mut maker,
        edit_intent(
            &w,
            actor,
            5,
            in_use.version,
            Op::Set {
                node: Ref::Node(host),
                field: import_eden::F_SOLIDS,
                to: Value::Array(buried),
            },
        ),
    )
    .await;
    // A seated Soul is judged for the ground it would stand up onto (#3280): none left there is a cut-off.
    assert_eq!((bury.kind, bury.reason.as_str()), (2, "edit.would-cut-off"));
    assert_eq!(
        walls(&w),
        before,
        "the refused burial left the building's walls as they were"
    );
    assert!(poses(&w).iter().any(|(b, pose)| *b == body
        && pose.frame.node == chair
        && pose.frame.slot == Some(1)
        && pose.support == Support::Slot));
    let stalls: Vec<String> = served
        .lines
        .try_iter()
        .filter(|l| l.contains("tick-stalled"))
        .collect();
    assert!(stalls.is_empty(), "the clock never stalled: {stalls:?}");
    println!(
        "K18d creator batches {:?}/{:?}; new door/room/chair exact slot sit {:?}; unrelated walk {:?}; occupied cutoff {}, seat {}, second Soul {}, bury {}",
        made.entries,
        opened.entries,
        seated.entries,
        walked.entries,
        blocked.reason,
        in_use.reason,
        taken.reason,
        bury.reason
    );
}

/// The body born for `soul` when it joined (C3): log rows name bodies, not Souls. Found by its `souls:body-of` link.
fn born_body(w: &Seeded, soul: Id) -> Id {
    let (copy, _) = served_copy(w);
    let t = copy.tree();
    t.links_at(soul)
        .iter()
        .filter(|e| t.ty(e).as_str() == "souls:body-of")
        .find_map(|e| Some(t.link(e.link)?.1[0]))
        .expect("the Soul's born body")
}

fn poses(w: &Seeded) -> BTreeMap<Id, replica::pose::Pose> {
    sim::log::recover(&std::fs::read(w.dir.join("log")).unwrap())
        .unwrap()
        .records
        .iter()
        .filter_map(|r| {
            let Value::Map(m) = decode(r).ok()?.value else {
                return None;
            };
            let Value::Array(rows) = m.get(&answers::BODIES)? else {
                return None;
            };
            Some(
                rows.iter()
                    .filter_map(worldd::bodies::read_row)
                    .map(|(body, pose, _)| (body, pose))
                    .collect::<Vec<_>>(),
            )
        })
        .flatten()
        .collect()
}

fn last_tick(w: &Seeded) -> u64 {
    sim::log::recover(&std::fs::read(w.dir.join("log")).unwrap())
        .unwrap()
        .records
        .iter()
        .filter_map(|r| {
            let Value::Map(m) = decode(r).ok()?.value else {
                return None;
            };
            match m.get(&answers::TICK) {
                Some(Value::Uint(n)) => Some(*n),
                _ => None,
            }
        })
        .max()
        .unwrap_or(0)
}

fn durable(w: &Seeded, actor: Actor, sequence: u64, got: &Got) {
    let records = sim::log::recover(&std::fs::read(w.dir.join("log")).unwrap())
        .unwrap()
        .records;
    let parts: Vec<_> = records
        .iter()
        .filter(|r| !sim::recorder::is_input(r))
        .map(|r| replica::effects::Part::read(r).unwrap())
        .collect();
    let actor_value = match actor {
        Actor::Soul(id) => Value::Map(BTreeMap::from([(1, Value::Uint(1)), (2, id.to_value())])),
        Actor::Creator(id) => Value::Map(BTreeMap::from([(1, Value::Uint(2)), (2, id.to_value())])),
        Actor::World => panic!("the fixture sends only owned intents"),
    };
    let key = Value::Bytes(encode(&actor_value).unwrap());
    let answered = parts
        .iter()
        .flat_map(|p| match p.rest.get(&answers::ANSWERED) {
            Some(Value::Array(rows)) => rows.as_slice(),
            _ => &[],
        })
        .find_map(|row| {
            let Value::Map(row) = row else { return None };
            if row.get(&1) != Some(&key) || row.get(&2) != Some(&Value::Uint(sequence)) {
                return None;
            }
            let Value::Bytes(frame) = row.get(&4)? else {
                return None;
            };
            let Value::Map(frame) = decode(frame).ok()?.value else {
                return None;
            };
            let Value::Map(answer) = frame.get(&2)? else {
                return None;
            };
            (answer.get(&3) == Some(&Value::Uint(1))).then_some(row)
        })
        .expect("the exact actor and sequence have a durable answer");
    let intent = replica::effects::read_id(&answered[&3]).unwrap();
    let Value::Bytes(frame) = &answered[&4] else {
        panic!("a recorded answer frame")
    };
    let frame = decode(frame).unwrap().value;
    let Value::Map(outer) = &frame else {
        panic!("an answer frame")
    };
    let Value::Map(answer) = &outer[&2] else {
        panic!("an answer")
    };
    assert_eq!(answer[&1], actor_value);
    assert_eq!(answer[&2], Value::Uint(sequence));
    let actual = read_answer(&frame);
    assert_eq!(actual.kind, 1);
    assert_eq!(replica::effects::read_id(&answer[&4]).unwrap(), intent);
    assert!(!actual.entries.is_empty());
    assert_eq!(actual.entries, got.entries);
    for entry in &got.entries {
        let effect = parts
            .iter()
            .flat_map(|p| &p.effects)
            .find(|e| e.envelope.sequence == *entry)
            .expect("every receipt entry is durable");
        assert_eq!(effect.envelope.actor, actor);
        assert_eq!(
            effect.envelope.cause,
            replica::effects::Cause::Intent(intent)
        );
    }
}

#[test]
#[ignore = "needs the exported static Eden facts file"]
fn k18d_actual_creator_payload_classes_pass_gateway_i2_without_world_startup() {
    let text = std::fs::read_to_string(std::env::var("EDEN_FACTS").expect("EDEN_FACTS")).unwrap();
    let im = import_eden::load(&text).unwrap();
    let source = |id| im.tree.node(im.tree.handle(id).unwrap()).unwrap();
    let building = im
        .nodes
        .values()
        .copied()
        .map(source)
        .find(|node| {
            im.rules.kinds[node.kind().as_str()]
                .children
                .contains(import_eden::FLOOR)
                && node.fields().contains_key(&import_eden::F_SOLIDS)
        })
        .unwrap();
    let door = im
        .nodes
        .values()
        .copied()
        .map(source)
        .find(|node| {
            node.fields()
                .contains_key(&sim::ground::scene::F_OPEN_DOOR_LINK)
                && im.rules.kinds[node.kind().as_str()].owner == "thing"
        })
        .unwrap();
    let chair = source(im.nodes["e_0fc49dc9"]);
    let root = im.nodes["world"];
    let w = Seeded {
        dir: PathBuf::new(),
        souls: Vec::new(),
        root,
        zone: import_eden::header(root, &im.rules).unwrap().zone,
        ground: im.nodes["ground"],
        wall: building.kind().clone(),
    };
    let future = |n| Id::new(root.scope(), n).unwrap();
    let (_, actor) = creator(0xd8);
    let room = edit_batch_intent(&w, actor, 1, 0, room_batch(&w, &im, building.kind(), 0, 0));
    let furnishings = edit_batch_intent(
        &w,
        actor,
        2,
        1,
        furnishing_batch(
            &door,
            &chair,
            future(1_000_001),
            future(1_000_002),
            future(1_000_003),
        ),
    );
    for (label, bytes) in [("floor/room", room), ("door/chair", furnishings)] {
        let decoded = replica::intent_decode::decode(&bytes)
            .unwrap_or_else(|r| panic!("{label}: {}: {}", r.name, r.detail));
        assert_eq!(decoded.actor, actor);
        println!(
            "K18d canonical {label}: {} bytes accepted by unchanged gateway I2",
            bytes.len()
        );
    }
}
