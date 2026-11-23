//! #3601: actual declared named parts and private text cross the existing gateway-socket boundary.
use super::*;
use std::sync::Arc;

const DRESSER: &str = "eden:dresser";
const NOTE: &str = "test:private_note";
/// The dresser entry's `open` field (`content/kinds`; clear of the import's field numbers, #1960).
const DRESSER_OPEN: u64 = 28;
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
/// A module of one section each of `sections` (`(id, contents)`), with the WASM header.
fn wasm(sections: &[(u8, &[u8])]) -> Vec<u8> {
    let mut m = b"\0asm\x01\0\0\0".to_vec();
    for (id, c) in sections {
        m.push(*id);
        m.push(c.len() as u8);
        m.extend_from_slice(c);
    }
    m
}
/// A code hatch's module (#3713): memory, `input` at 0, `output` at 1024 and `run`, whose body is `body`.
fn hatch_module(body: &[u8]) -> Vec<u8> {
    let mut code = vec![1, body.len() as u8 + 1, 0];
    code.extend_from_slice(body);
    wasm(&[
        (1, &[1, 0x60, 1, 0x7f, 1, 0x7e]),
        (3, &[1, 0]),
        (5, &[1, 0, 1]),
        (
            6,
            &[2, 0x7f, 0, 0x41, 0, 0x0b, 0x7f, 0, 0x41, 0x80, 0x08, 0x0b],
        ),
        (
            7,
            &[
                4, 6, b'm', b'e', b'm', b'o', b'r', b'y', 2, 0, 5, b'i', b'n', b'p', b'u', b't', 3,
                0, 6, b'o', b'u', b't', b'p', b'u', b't', 3, 1, 3, b'r', b'u', b'n', 0, 0,
            ],
        ),
        (10, &code),
    ])
}
/// The echo: copies its input to its output and answers 1, so each read comes back as the answered field.
fn echo() -> Vec<u8> {
    hatch_module(&[
        0x41, 0x80, 0x08, 0x41, 0, 0x20, 0, 0xfc, 0x0a, 0, 0, 0x42, 1, 0x0b,
    ])
}
/// A hatch that always says no.
fn nay() -> Vec<u8> {
    hatch_module(&[0x42, 0, 0x0b])
}
fn prov(bytes: &[u8]) -> String {
    let hex: String = replica::ids::sha256(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("prov-1220{hex}")
}
/// The note's hatch forms (#3713): `tally` writes its argument to `count` through the echo, in place of the form's
/// own set; `refuse` is told no; `lost` names a module the world does not ship.
fn hatch_forms() -> Vec<(String, Json)> {
    let form = |module: &str| {
        parse(&format!(
            r#"{{"who":"anyone","takes":{{"n":{{"type":"count"}}}},"steps":[],"hatch":{{"module":"{module}","reads":[{{"arg":"n"}}],"steps_most":1000,"answers":{{"fields":["count"]}},"why":"why_tally"}},"effects":[{{"change":"set","field":"count","to":0,"event":"tallied"}}]}}"#
        ))
        .unwrap()
    };
    vec![
        ("tally".into(), form(&prov(&echo()))),
        ("refuse".into(), form(&prov(&nay()))),
        ("lost".into(), form(&prov(b"not shipped"))),
    ]
}
fn note_entry() -> Json {
    let mut e = note_entry_text();
    if let Some(Json::Obj(forms)) = e
        .obj()
        .and_then(|o| o.iter().find(|(k, _)| k == "forms"))
        .map(|(_, f)| f.clone())
    {
        let mut forms = forms;
        forms.extend(hatch_forms());
        if let Json::Obj(o) = &mut e {
            for (k, v) in o.iter_mut() {
                if k == "forms" {
                    *v = Json::Obj(forms.clone());
                }
            }
        }
    }
    e
}
fn note_entry_text() -> Json {
    parse(r#"{"format":"souls-entry/1","kind":"test:private_note","owner":"thing","state":{"words":{"n":1,"type":"text","default":null},"chosen":{"n":2,"type":"enum","values":["rest"],"default":"rest"},"count":{"n":3,"type":"int","default":0,"min":0,"max":100}},"slots":{"rest":{"admits":"thing","at_mm":[0,0,0]}},"forms":{"choose_slot":{"who":"anyone","takes":{"seat":{"type":"slot"}},"steps":[],"effects":[{"change":"set","field":"chosen","to":{"arg":"seat"},"event":"chosen"}]},"ambiguous":{"who":"anyone","steps":[{"step":"move","move":"press","at":{"arg":"left"}},{"step":"move","move":"press","at":{"arg":"right"}}]},"write":{"who":"anyone","takes":{"words":{"type":"text"}},"steps":[],"effects":[{"change":"set","field":"words","to":{"arg":"words"},"event":"written"}]}}}"#).unwrap()
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
    fn field(&self, node: Id, n: u64) -> Value {
        let r = self.replay();
        r.tree()
            .node(r.tree().handle(node).unwrap())
            .unwrap()
            .fields()[&n]
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
/// Each fixture's own socket, as the tests run side by side.
static SOCKETS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
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
            BTreeMap::from([(DRESSER_OPEN, Value::Text(name("eden:shut")))]),
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
    cfg.hatches = vec![echo(), nay()];
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
        "../../../.local/3601/args-{}-{}.sock",
        std::process::id(),
        SOCKETS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
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
        Client(socket, w1(), 0, Vec::new()),
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
        (
            vec![Value::Array(vec![
                Value::Bytes(vec![0xff]),
                Value::Text(name("top")),
            ])],
            "arg-malformed",
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
            run.field(dresser(), DRESSER_OPEN),
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
        run.field(dresser(), DRESSER_OPEN),
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
        run.field(note(), 1),
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
    let Value::Map(reference) = run.field(note(), 1) else {
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

#[test]
fn a_forms_code_hatch_checks_the_act_and_writes_its_fields_through_the_gateway() {
    let (run, mut client) = fixture();
    let n = |v: u64| args(vec![pair("n", Value::Uint(v))]);
    assert!(
        !client
            .act("test:tally", Some(note()), n(42))
            .expect("the echo says yes")
            .is_empty()
    );
    assert_eq!(
        run.field(note(), 3),
        Value::Uint(42),
        "the hatch's answer, not the form's own set"
    );
    for (form, v, reason) in [
        ("test:refuse", 7, "hatch-said-no"),
        ("test:lost", 7, "hatch-module-missing"),
        ("test:tally", 500, "hatch-answer-malformed"),
    ] {
        assert_eq!(
            client.act(form, Some(note()), n(v)),
            Err(reason.into()),
            "{form}"
        );
        assert_eq!(
            run.field(note(), 3),
            Value::Uint(42),
            "{form} changes nothing"
        );
    }
}
