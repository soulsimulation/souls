//! A creator places a built deck bay (racks, lane C): a place into a bay's slot makes the joints a Soul's `part:put`
//! into that slot makes (`worldd::edit_joins`), so one batch that places the camp's deck kinds in the order a crew
//! builds them (frames, beams, joists, sheets, the stair) is accepted, each part joined as a put joins it, and one that
//! places a beam before the frames is refused `support.none`, naming the beam's operation, its kind and its slot.
use super::*;
use std::collections::BTreeSet;

/// N2's test world with an empty deck bay of the camp's kinds (`content/kinds/construction/deck_bay.json`) at its
/// site, the construction kinds its entries. Returns the facts and the bay's slot numbers, by name.
fn bay_only(d: &Path) -> (String, BTreeMap<String, u64>) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let entries = d.join("entries");
    std::fs::create_dir_all(&entries).unwrap();
    for f in std::fs::read_dir(root.join("construction")).unwrap() {
        let p = f.unwrap().path();
        if p.extension().is_some_and(|x| x == "json") {
            std::fs::copy(&p, entries.join(p.file_name().unwrap())).unwrap();
        }
    }
    std::fs::copy(
        root.join("body/humanoid.json"),
        entries.join("humanoid.json"),
    )
    .unwrap();
    let text = std::fs::read_to_string(root.join("construction/deck_bay.json")).unwrap();
    let kind = replica::kinds::entry::entry_to_kind(&text).unwrap();
    let mut kinds = replica::kinds::Kinds::default();
    kinds.load(&[("deck_bay", kind.as_str())]);
    let def = kinds
        .admits()
        .into_keys()
        .find_map(|k| {
            kinds
                .get(&k)
                .filter(|d| d.name.as_str().starts_with("mars:deck_bay@"))
        })
        .expect("the deck bay's kind");
    let slots: Vec<(u64, String, [i64; 3])> = def
        .slots
        .iter()
        .map(|(n, s)| {
            (
                *n,
                s.name.as_ref().unwrap().as_str().to_owned(),
                s.at_mm.unwrap_or([0, 0, 0]),
            )
        })
        .collect();
    let numbers = slots.iter().map(|s| (s.1.clone(), s.0)).collect();
    let mut f = json::parse(&testworld::generate(1, 0).unwrap().text).unwrap();
    let json::Value::Obj(top) = &mut f else {
        panic!("facts")
    };
    let num = |v: i64| json::Value::Int(i128::from(v));
    let ints = |v: &[i64]| json::Value::Arr(v.iter().map(|&x| num(x)).collect());
    let refs = [
        ("testworld-deck-bay@1", "mars:deck_bay"),
        ("testworld-frame-12ft@1", "mars:rack_upright_12ft"),
        ("testworld-deck-beam@1", "mars:deck_beam"),
        ("testworld-two-by-four@1", "mars:two_by_four"),
        ("testworld-plywood-sheet@1", "mars:plywood_sheet"),
        ("testworld-stair-flight@1", "mars:stair_flight"),
    ];
    let (x, z) = (testworld::SITE_X, testworld::YARD_Z);
    for (k, v) in top.iter_mut() {
        match (k.as_str(), v) {
            ("kinds", json::Value::Arr(a)) => {
                for (r, name) in refs {
                    a.push(json::Value::Obj(vec![
                        ("ref".into(), json::Value::s(r)),
                        (
                            "hash".into(),
                            json::Value::s(&replica::encode::to_hex(&replica::ids::sha256(
                                format!("souls/testworld/{r}").as_bytes(),
                            ))),
                        ),
                        ("name".into(), json::Value::s(name)),
                        ("form".into(), json::Value::s("point")),
                    ]));
                }
            }
            ("things", json::Value::Arr(a)) => {
                let rows = slots
                    .iter()
                    .map(|(n, _, at)| {
                        json::Value::Obj(vec![
                            ("n".into(), num(*n as i64)),
                            ("at".into(), ints(at)),
                            ("yaw".into(), num(0)),
                            ("capacity".into(), num(1)),
                        ])
                    })
                    .collect();
                a.push(json::Value::Obj(vec![
                    ("id".into(), json::Value::s("deck-bay")),
                    ("def".into(), json::Value::s(refs[0].0)),
                    ("ref".into(), json::Value::s(refs[0].0)),
                    ("parent".into(), json::Value::Null),
                    ("pose".into(), ints(&[x, 0, z, 0])),
                    ("scale_ppm".into(), num(1_000_000)),
                    ("name".into(), json::Value::s("deck-bay")),
                    ("slots".into(), json::Value::Arr(rows)),
                ]));
            }
            _ => {}
        }
    }
    (f.to_json(), numbers)
}

/// The deck bay's parts in the order a crew builds it: `(kind, slot)`.
const BUILT: [(&str, &str); 14] = [
    ("mars:rack_upright_12ft", "upright_a"),
    ("mars:rack_upright_12ft", "upright_b"),
    ("mars:deck_beam", "beam_low_l"),
    ("mars:deck_beam", "beam_low_r"),
    ("mars:deck_beam", "beam_high_l"),
    ("mars:deck_beam", "beam_high_r"),
    ("mars:two_by_four", "j1"),
    ("mars:two_by_four", "j2"),
    ("mars:two_by_four", "j3"),
    ("mars:two_by_four", "j4"),
    ("mars:two_by_four", "j5"),
    ("mars:plywood_sheet", "s1"),
    ("mars:plywood_sheet", "s2"),
    ("mars:stair_flight", "stair"),
];

/// A served world with an empty deck bay, its creator signed in through a gateway: the world, the server, the
/// creator's connection and actor, the bay, its slots and the served kinds' full names by plain name.
struct Site {
    w: Seeded,
    _s: Served,
    maker: Ws,
    actor: Actor,
    bay: Id,
    slots: BTreeMap<String, u64>,
    kinds: BTreeMap<String, Name>,
}

impl Site {
    async fn serve(tag: &str) -> Site {
        let d = scratch(tag);
        let (facts, slots) = bay_only(&d);
        let (x, z) = (testworld::SITE_X, testworld::YARD_Z);
        let w = seed_entries(
            &d,
            &facts,
            1,
            ((x - 4_000) / 1000, (z - 5_000) / 1000),
            Some(&d.join("entries")),
        );
        let (c, actor) = creator(0xc5);
        static_creator(&w, c);
        let socket = d.join("s");
        let s = serve_with(&w, &socket, None);
        s.line("listening ", 120);
        let (url, tokens) = gateway(&socket, &[actor]).await;
        let maker = sign_in(&url, &tokens[0]).await;
        let bay = import_eden::load(&facts).unwrap().nodes["deck-bay"];
        let (_, rules) = served_copy(&w);
        let kinds = rules
            .kinds
            .keys()
            .filter_map(|k| {
                let plain = replica::world_model::plain(k).to_owned();
                BUILT
                    .iter()
                    .any(|(b, _)| *b == plain)
                    .then(|| (plain, Name::new(k).unwrap()))
            })
            .collect();
        Site {
            w,
            _s: s,
            maker,
            actor,
            bay,
            slots,
            kinds,
        }
    }

    /// A place of `kind` into the bay's `slot`, named `name` in the batch.
    fn place(&self, name: u64, kind: &str, slot: &str) -> Op {
        Op::Place {
            name,
            kind: self.kinds[kind].clone(),
            parent: Ref::Node(self.bay),
            at: Spot {
                slot: Some(self.slots[slot]),
                position: Vec3::ZERO,
                orientation: Quat::IDENTITY,
                support: Support::Slot,
            },
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        }
    }

    async fn edit(&mut self, sequence: u64, ops: Vec<Op>) -> Got {
        let bytes = edit_batch_intent(&self.w, self.actor, sequence, 0, ops);
        let (got, _) = send(&mut self.maker, bytes).await;
        println!("the batch: {got:?}");
        got
    }
}

/// Lane C: the creator places the whole deck bay in one batch, in the order a crew builds it, and it is accepted. Each
/// part is joined as a Soul's put joins it: a beam to both frames, a joist to the two 1.8 m beams it lies on, a sheet
/// to the five joists under it, the stair to the beams; the frames stand braced at both levels.
#[tokio::test(flavor = "multi_thread")]
async fn a_creators_batch_places_the_whole_deck_bay_joined_as_a_crew_builds_it() {
    let mut site = Site::serve("creator-bay").await;
    let ops: Vec<Op> = BUILT
        .iter()
        .enumerate()
        .map(|(k, (kind, slot))| site.place(k as u64 + 1, kind, slot))
        .collect();
    let got = site.edit(1, ops).await;
    assert_eq!(got.kind, 1, "the built bay is accepted: {got:?}");
    let part = |k: usize| got.names[&(k as u64 + 1)];
    let (copy, _) = served_copy(&site.w);
    let t = copy.tree();
    for (k, (kind, slot)) in BUILT.iter().enumerate() {
        let id = part(k);
        let n = t.node(t.handle(id).unwrap()).unwrap();
        assert_eq!(n.parent(), Some(site.bay), "{slot} in the bay");
        assert_eq!(n.slot(), Some(site.slots[*slot]), "{kind} in {slot}");
    }
    let joined = |k: usize| -> BTreeSet<Id> {
        let id = part(k);
        t.links_at(id)
            .iter()
            .filter(|e| t.ty(e).as_str().contains("joint"))
            .filter_map(|e| t.link(e.link))
            .filter(|(_, ends, ..)| ends[0] == id)
            .map(|(_, ends, ..)| ends[1])
            .collect()
    };
    let frames = BTreeSet::from([part(0), part(1)]);
    for k in 2..6 {
        assert_eq!(joined(k), frames, "{} joins both frames", BUILT[k].1);
    }
    let high = BTreeSet::from([part(4), part(5)]);
    for k in 6..11 {
        assert_eq!(
            joined(k),
            high,
            "{} rests on the two 1.8 m beams",
            BUILT[k].1
        );
    }
    let joists: BTreeSet<Id> = (6..11).map(part).collect();
    for k in 11..13 {
        assert_eq!(
            joined(k),
            joists,
            "{} rests on the joists at its level",
            BUILT[k].1
        );
    }
    let beams: BTreeSet<Id> = (2..6).map(part).collect();
    assert_eq!(
        joined(13),
        beams,
        "the stair joins the beams, as a put's default"
    );
    assert!(
        joined(0).is_empty() && joined(1).is_empty(),
        "a frame joins nothing itself"
    );
}

/// Lane C: a batch that places a beam before the frames leaves it joined to nothing (nothing stood in the bay when it
/// was placed), and is refused `support.none`, naming the beam's operation, its kind and its slot. Nothing is placed.
#[tokio::test(flavor = "multi_thread")]
async fn a_creators_batch_with_a_beam_before_the_frames_is_refused_naming_the_beam() {
    let mut site = Site::serve("creator-bay-order").await;
    let order = [2, 3, 4, 5, 0, 1];
    let ops: Vec<Op> = order
        .iter()
        .enumerate()
        .map(|(k, b)| site.place(k as u64 + 1, BUILT[*b].0, BUILT[*b].1))
        .collect();
    let got = site.edit(1, ops).await;
    refused_as(&got, "support.none", "a beam placed before the frames");
    assert!(
        got.detail.contains("operation 0 (mars:deck_beam in slot"),
        "names the first beam's operation, kind and slot: {got:?}"
    );
    assert!(got.detail.contains("would hang by nothing"), "{got:?}");
    let (copy, _) = served_copy(&site.w);
    let t = copy.tree();
    assert!(
        t.children(t.handle(site.bay).unwrap())
            .unwrap_or(&[])
            .is_empty(),
        "nothing placed"
    );
}
