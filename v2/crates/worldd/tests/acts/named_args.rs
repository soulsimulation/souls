//! #3601: actual declared named parts and private text cross the existing gateway-socket boundary.
use super::*;
use std::sync::Arc;

const DRESSER: &str = "eden:dresser";
const NOTE: &str = "test:private_note";
fn dresser() -> Id {
    id(20)
}
fn note() -> Id {
    id(21)
}
fn pinned(kind: &str) -> String {
    full(kind, if kind == DRESSER { 8 } else { 9 })
}
fn entry() -> Json {
    parse(include_str!(
        "../../../../../content/kinds/storage/dresser.json"
    ))
    .unwrap()
}
fn note_entry() -> Json {
    parse(r#"{"format":"souls-entry/1","kind":"test:private_note","owner":"thing","state":{"words":{"n":1,"type":"text","default":null},"chosen":{"n":2,"type":"enum","values":["rest"],"default":"rest"}},"slots":{"rest":{"admits":"thing","at_mm":[0,0,0]}},"forms":{"choose_slot":{"who":"anyone","takes":{"seat":{"type":"slot"}},"steps":[],"effects":[{"change":"set","field":"chosen","to":{"arg":"seat"},"event":"chosen"}]},"ambiguous":{"who":"anyone","steps":[{"step":"move","move":"press","at":{"arg":"left"}},{"step":"move","move":"press","at":{"arg":"right"}}]},"write":{"who":"anyone","takes":{"words":{"type":"text"}},"steps":[],"effects":[{"change":"set","field":"words","to":{"arg":"words"},"event":"written"}]}}}"#).unwrap()
}
struct NamedRun {
    world: Option<answers::World>,
    store: Mem,
    initial: Replica,
    text: Arc<sim::text::Store>,
    path: std::path::PathBuf,
}
impl NamedRun {
    fn replay(&self) -> Replica {
        let mut r = self.initial.frozen();
        for bytes in recover(&self.store.0.lock().unwrap().bytes)
            .unwrap()
            .records
        {
            if !sim::recorder::is_input(&bytes) {
                r.apply(&Part::read(&bytes).unwrap()).unwrap();
            }
        }
        r
    }
    fn field(&self, node: Id) -> Value {
        let r = self.replay();
        r.tree()
            .node(r.tree().handle(node).unwrap())
            .unwrap()
            .fields()[&1]
            .clone()
    }
}
impl Drop for NamedRun {
    fn drop(&mut self) {
        if let Some(w) = self.world.take() {
            w.stop();
        }
        let _ = std::fs::remove_file(&self.path);
    }
}
fn named_bodies(furniture: &Part) -> Result<Bodies, replica::effects::Refusal> {
    let (mut base, ground) = town();
    assert_eq!(base.ground, ground);
    for node in [dresser(), note()] {
        assert!(base.tree.handle(node).is_none(), "fixture ids are fresh");
    }
    let Value::Map(before) = decode(base.doors.header.stored()).unwrap().value else {
        unreachable!()
    };
    let mut fields = before.clone();
    let Some(Value::Array(kinds)) = fields.get_mut(&6) else {
        unreachable!()
    };
    for kind in [DRESSER, NOTE] {
        kinds.push(Value::Text(name(&pinned(kind))));
    }
    let header = Header::read(&encode(&Value::Map(fields)).unwrap()).unwrap();
    let Value::Map(mut after) = decode(header.stored()).unwrap().value else {
        unreachable!()
    };
    after.insert(6, before[&6].clone());
    assert_eq!(
        after, before,
        "all original header identity fields are unchanged"
    );
    let next = base.tree.next();
    assert_eq!(base.doors.next, next);
    let effects = furniture
        .effects
        .iter()
        .enumerate()
        .map(|(offset, effect)| {
            let mut effect = effect.clone();
            effect.envelope.sequence = next + offset as u64;
            effect.to_value()
        })
        .collect();
    let part = Part::read(
        &encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(header.hash().to_bytes())),
            (2, Value::Array(effects)),
        ])))
        .unwrap(),
    )
    .unwrap();
    base.tree.apply(&header, &part)?;
    base.doors.header = header;
    base.doors.next = base.tree.next();
    let mut town =
        Town::new(base.tree, ground, base.doors).expect("the same town with fixture furniture");
    let mut planner = town.copy().expect("independent planner town");
    for node in [dresser(), note()] {
        for view in [town.view(), planner.view()] {
            assert_eq!(
                view.on_floor(node, Vec3::ZERO).map(|(floor, ..)| floor),
                Some(ground)
            );
        }
    }
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let p1 = town.surfaces[&ground].place(w1(), frame, at1(), Quat::IDENTITY)?;
    let p2 = town.surfaces[&ground].place(w2(), frame, at2(), Quat::IDENTITY)?;
    let mut bodies = Bodies::with_planner(town, planner, 50_000)?;
    bodies.add_body(humanoid(), p1)?;
    bodies.add_body(humanoid(), p2)?;
    Ok(bodies)
}
fn fixture() -> (NamedRun, Client) {
    let old = world();
    let mut hv = match decode(old.header().stored()).unwrap().value {
        Value::Map(m) => m,
        _ => unreachable!(),
    };
    let Some(Value::Array(kinds)) = hv.get_mut(&6) else {
        unreachable!()
    };
    for kind in [DRESSER, NOTE] {
        kinds.push(Value::Text(name(&pinned(kind))));
    }
    let header = Header::read(&encode(&Value::Map(hv)).unwrap()).unwrap();
    let mut initial = Replica::restored(header.clone(), old.tree().frozen(), old.version());
    let mut effects = Vec::new();
    for (offset, (node, kind, position, audience, fields)) in [
        (
            dresser(),
            DRESSER,
            Vec3::new(at1().x, 0, at1().z - 702_000),
            Audience::Everyone,
            BTreeMap::from([(1, Value::Text(name("eden:shut")))]),
        ),
        (
            note(),
            NOTE,
            at1(),
            Audience::Everyone,
            BTreeMap::from([(1, Value::Map(BTreeMap::new()))]),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        effects.push(
            Effect {
                envelope: Envelope {
                    sequence: initial.version() + offset as u64,
                    at: 0,
                    cause: Cause::World,
                    actor: Actor::World,
                    audience,
                    node: ground(),
                },
                body: Body::Changes(vec![ChangeRec {
                    change: Change::Create {
                        node,
                        kind: name(&pinned(kind)),
                        pose: Pose {
                            frame: Frame {
                                node: ground(),
                                slot: None,
                            },
                            position,
                            orientation: Quat::IDENTITY,
                            support: Support::Surface {
                                surface: ground(),
                                height: 0,
                            },
                        },
                        audience,
                        fields,
                    },
                    rest: Rest::new(),
                }]),
                events: None,
                rest: Rest::new(),
            }
            .to_value(),
        );
    }
    let furniture = Part::read(
        &encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(header.hash().to_bytes())),
            (2, Value::Array(effects)),
        ])))
        .unwrap(),
    )
    .unwrap();
    initial.apply(&furniture).unwrap();
    let mut rules = tree_rules();
    for kind in [DRESSER, NOTE] {
        rules.kinds.insert(
            pinned(kind),
            Kind {
                owner: "thing".into(),
                children: BTreeSet::new(),
                slots: BTreeMap::new(),
                hands: None,
            },
        );
    }
    let store = Mem::default();
    let text = Arc::new(worldd::words::in_memory(LINEAGE).unwrap());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.bodies = Some(Box::new(move |_| named_bodies(&furniture)));
    cfg.engine = Some((rules, Vec::new()));
    cfg.text = Some(text.clone());
    let mut kinds = entries();
    let Json::Obj(loaded) = &mut kinds else {
        unreachable!()
    };
    loaded.push((DRESSER.into(), entry()));
    loaded.push((NOTE.into(), note_entry()));
    let world = answers::start(
        initial.frozen(),
        Rules {
            kinds,
            moves: Json::Obj(Vec::new()),
        },
        store.clone(),
        cfg,
    )
    .unwrap();
    let path = std::path::PathBuf::from(format!(
        "../../../.local/3601/args-{}.sock",
        std::process::id()
    ));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    assert!(!path.exists());
    assert!(
        path.as_os_str().len() + 1 < 104,
        "complete relative socket path fits"
    );
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let door = door.clone();
            std::thread::spawn(move || answers::serve(door, stream));
        }
    });
    let socket = UnixStream::connect(&path).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    (
        NamedRun {
            world: Some(world),
            store,
            initial,
            text,
            path,
        },
        Client(socket, w1(), 0),
    )
}
fn pair(key: &str, value: Value) -> Value {
    Value::Array(vec![Value::Bytes(key.as_bytes().to_vec()), value])
}
fn args(pairs: Vec<Value>) -> BTreeMap<u64, Value> {
    BTreeMap::from([(1, Value::Array(pairs))])
}

#[test]
fn named_args_dresser_part_and_private_text_through_gateway() {
    let (run, mut client) = fixture();
    for (pairs, reason) in [
        (Vec::new(), "arg-missing"),
        (
            vec![pair("drawer", Value::Text(name("not_a_drawer")))],
            "point-unknown",
        ),
        (vec![pair("drawer", vessel().to_value())], "arg-type"),
        (
            vec![pair("drawer", Value::Bytes(vec![0xff]))],
            "arg-malformed",
        ),
        (
            vec![
                pair("drawer", Value::Bytes(b"top".to_vec())),
                pair("drawer", Value::Uint(1)),
            ],
            "arg-ambiguous",
        ),
    ] {
        assert_eq!(
            client.act("eden:open", Some(dresser()), args(pairs)),
            Err(reason.into())
        );
        assert_eq!(
            run.field(dresser()),
            Value::Text(name("eden:shut")),
            "refusal changes no drawer or different thing"
        );
    }
    let receipt = client
        .act(
            "eden:open",
            Some(dresser()),
            args(vec![pair("drawer", Value::Bytes(b"top".to_vec()))]),
        )
        .expect("the real dresser's declared top part works");
    assert!(!receipt.is_empty());
    assert_eq!(
        run.field(dresser()),
        Value::Text(name("eden:top")),
        "durable state matches the requested part"
    );
    assert_eq!(
        client.act(
            "test:ambiguous",
            Some(note()),
            args(vec![
                pair("left", vessel().to_value()),
                pair("right", plank().to_value())
            ])
        ),
        Err("arg-ambiguous".into())
    );
    assert_eq!(
        client.act(
            "test:write",
            Some(note()),
            args(vec![pair("words", vessel().to_value())])
        ),
        Err("arg-type".into())
    );
    assert_eq!(
        run.field(note()),
        Value::Map(BTreeMap::new()),
        "a refused text argument selects no thing"
    );
    assert!(
        !client
            .act(
                "test:choose_slot",
                Some(note()),
                args(vec![pair("seat", Value::Uint(1))])
            )
            .unwrap()
            .is_empty()
    );
    let slot_state = run.replay();
    assert_eq!(
        slot_state
            .tree()
            .node(slot_state.tree().handle(note()).unwrap())
            .unwrap()
            .fields()[&2],
        Value::Text(name("test:rest")),
        "existing numeric slot argument keeps its declared name"
    );
    let words = b"private named argument";
    let receipt = client
        .act(
            "test:write",
            Some(note()),
            args(vec![pair(
                "words",
                Value::Map(BTreeMap::from([(23, Value::Bytes(words.to_vec()))])),
            )]),
        )
        .expect("private words reach the existing typed binder");
    assert!(!receipt.is_empty());
    let Value::Map(reference) = run.field(note()) else {
        panic!("a T8 reference")
    };
    let reference = replica::effects::read_id(&reference[&21]).unwrap();
    assert_eq!(run.text.read(reference, &[w1()]).unwrap(), words);
    assert_eq!(
        run.text.read(reference, &[]).unwrap_err().name,
        "not-entitled",
        "public container does not make private words public"
    );
    assert_eq!(
        run.text.read(reference, &[w2()]).unwrap_err().name,
        "not-entitled"
    );
    assert!(
        !run.store
            .0
            .lock()
            .unwrap()
            .bytes
            .windows(words.len())
            .any(|w| w == words),
        "raw words never enter the durable log"
    );
}
