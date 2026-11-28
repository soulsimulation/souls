//! A creator places a built deck bay (racks, lane C): a place into a bay's slot makes the joints a Soul's `part:put`
//! into that slot makes (`worldd::edit_joins`), so one batch that places the camp's deck kinds in the order a crew
//! builds them (frames, beams, joists, sheets, the stair) is accepted, each part joined as a put joins it, and one that
//! places a beam before the frames is refused `support.none`, naming the beam's operation, its kind and its slot.
use super::deck::{body_on, refused_as};
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
    socket: PathBuf,
    maker: Ws,
    actor: Actor,
    bay: Id,
    slots: BTreeMap<String, u64>,
    kinds: BTreeMap<String, Name>,
}

impl Site {
    async fn serve(tag: &str) -> Site {
        Site::serve_souls(tag, 1).await
    }

    async fn serve_souls(tag: &str, souls: u64) -> Site {
        let d = scratch(tag);
        let (facts, slots) = bay_only(&d);
        let (x, z) = (testworld::SITE_X, testworld::YARD_Z);
        let w = seed_entries(
            &d,
            &facts,
            souls,
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
            socket,
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

/// A joint the batch names itself (`place --joins`, a batch place's "joins"): a bare link from the placed part.
fn joint(name: u64, from: u64, to: Ref) -> Op {
    Op::Link {
        name,
        ty: Name::new("mars:joint").unwrap(),
        ends: [Ref::New(from), to],
        owner: replica::world_model::End::First,
        field: 0,
        row: Vec::new(),
        door: None,
        bare: true,
    }
}

/// Lane C: joints a batch names are its own, never filtered, as `part:put --joins`: a joist named onto the two 0.5 m
/// beams rests on them, not on the 1.8 m beams its level would give. A named joint whose kinds' connectors do not
/// mate is refused `connectors-do-not-mate`, and a bare link that writes a field is refused `edit.link`.
#[tokio::test(flavor = "multi_thread")]
async fn a_creators_named_joins_are_kept_unfiltered_and_checked_as_a_puts() {
    let mut site = Site::serve("creator-bay-named").await;
    let mut ops: Vec<Op> = BUILT[..7]
        .iter()
        .enumerate()
        .map(|(k, (kind, slot))| site.place(k as u64 + 1, kind, slot))
        .collect();
    // The joist (name 7) named onto the low beams (names 3 and 4).
    ops.push(joint(20, 7, Ref::New(3)));
    ops.push(joint(21, 7, Ref::New(4)));
    let got = site.edit(1, ops.clone()).await;
    assert_eq!(got.kind, 1, "named joins accepted: {got:?}");
    let (copy, _) = served_copy(&site.w);
    let t = copy.tree();
    let joist = got.names[&7];
    let on: BTreeSet<Id> = t
        .links_at(joist)
        .iter()
        .filter_map(|e| t.link(e.link))
        .filter(|(ty, ends, ..)| ty.as_str() == "mars:joint" && ends[0] == joist)
        .map(|(_, ends, ..)| ends[1])
        .collect();
    assert_eq!(
        on,
        BTreeSet::from([got.names[&3], got.names[&4]]),
        "on the low beams, unfiltered"
    );
    drop(copy);

    // A beam named onto another beam: their connectors do not mate.
    let mut site = Site::serve("creator-bay-mate").await;
    let mut ops: Vec<Op> = BUILT[..4]
        .iter()
        .enumerate()
        .map(|(k, (kind, slot))| site.place(k as u64 + 1, kind, slot))
        .collect();
    ops.push(joint(20, 4, Ref::New(3)));
    let got = site.edit(1, ops.clone()).await;
    refused_as(&got, "connectors-do-not-mate", "a beam named onto a beam");

    // A bare link writes no field.
    ops.pop();
    let mut bad = joint(20, 4, Ref::New(1));
    if let Op::Link { field, .. } = &mut bad {
        *field = 9;
    }
    ops.push(bad);
    let got = site.edit(2, ops).await;
    refused_as(&got, "edit.link", "a bare link with a field");
}

/// The floors a placed part holds (the import's, or a creator's place's ways): `(floor, its level, ground only while
/// joined)`.
fn floors_of(w: &Seeded, part: Id) -> Vec<(Id, i64, bool)> {
    let (copy, _) = served_copy(w);
    let t = copy.tree();
    t.children(t.handle(part).unwrap())
        .unwrap_or(&[])
        .iter()
        .filter_map(|h| t.node(*h))
        .filter(|n| replica::world_model::plain(n.kind().as_str()) == sim::ground::scene::FLOOR)
        .map(|n| {
            let level = match n.fields().get(&import_eden::F_LEVEL) {
                Some(Value::Uint(l)) => *l as i64,
                _ => -1,
            };
            (
                n.id(),
                level,
                n.fields().contains_key(&import_eden::F_WHILE_JOINED),
            )
        })
        .collect()
}

/// Lane C: a creator-placed bay is walked as a seeded one is. Its parts bring the floors and the stair and ladder
/// rows their kinds declare (as the import gives a seeded thing), so after the creator places the whole deck bay in
/// one batch, a Soul walks from the open ground up the stair onto the first sheet's top, and another climbs frame 1's
/// ladder to its outer 1.8 m standing place.
#[tokio::test(flavor = "multi_thread")]
async fn a_soul_walks_up_a_creator_placed_bays_stair_and_another_climbs_its_frame() {
    let mut site = Site::serve_souls("creator-bay-walk", 2).await;
    let ops: Vec<Op> = BUILT
        .iter()
        .enumerate()
        .map(|(k, (kind, slot))| site.place(k as u64 + 1, kind, slot))
        .collect();
    let got = site.edit(1, ops).await;
    assert_eq!(got.kind, 1, "the built bay is accepted: {got:?}");
    let part = |k: usize| got.names[&(k as u64 + 1)];
    let (frame, sheet, flight) = (part(0), part(11), part(13));
    let deck = floors_of(&site.w, sheet);
    println!(
        "the sheet's floors: {deck:?}; the frame's: {:?}; the flight's: {:?}",
        floors_of(&site.w, frame),
        floors_of(&site.w, flight)
    );
    let deck = deck
        .iter()
        .find(|f| f.1 == 1)
        .expect("the sheet's top, a floor")
        .0;
    let g = site.w.ground;
    {
        // A town built afresh from the served tree stands a body on the sheet's top (the tree holds the way).
        let (copy, rules) = served_copy(&site.w);
        let tree = copy.tree().frozen();
        let header = import_eden::header(site.w.root, &rules).unwrap();
        let next = tree.to_state().next;
        let mut town = sim::walk::town::Town::new_on(
            tree,
            g,
            sim::links::Doors::new(header, rules.clone(), next),
            4,
        )
        .unwrap();
        let fresh = town.view().stand_near(deck, v3(-400_000, 19_000, 0), 0, None);
        println!("a fresh town on the deck: {fresh:?}");
        let t = copy.tree();
        let dump = |id: Id, what: &str| {
            for h in t.children(t.handle(id).unwrap()).unwrap_or(&[]) {
                let n = t.node(*h).unwrap();
                println!("{what} child {} {}: {:?}", replica::world_model::show(n.id()), n.kind().as_str(), n.fields());
                for e in t.links_at(n.id()) {
                    println!("{what}   link {:?}", t.link(e.link));
                }
            }
            let n = t.node(t.handle(id).unwrap()).unwrap();
            println!("{what} itself {}: fields {:?} place {:?}", n.kind().as_str(), n.fields().keys().collect::<Vec<_>>(), n.place());
        };
        dump(flight, "creator flight");
        // The same flight seeded by the import, for comparison.
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds/construction");
        let texts: Vec<(String, String)> = std::fs::read_dir(&root)
            .unwrap()
            .map(|f| f.unwrap().path())
            .map(|p| (p.file_stem().unwrap().to_string_lossy().into_owned(), std::fs::read_to_string(&p).unwrap()))
            .collect();
        let mut f = json::parse(&testworld::generate(1, 0).unwrap().text).unwrap();
        if let json::Value::Obj(top) = &mut f {
            for (k, v) in top.iter_mut() {
                match (k.as_str(), v) {
                    ("kinds", json::Value::Arr(a)) => a.push(json::parse(r#"{"ref": "tw-flight@1", "hash": "00", "name": "mars:stair_flight", "form": "point"}"#).unwrap()),
                    ("things", json::Value::Arr(a)) => a.push(json::parse(r#"{"id": "flight", "def": "tw-flight@1", "ref": "tw-flight@1", "parent": null, "pose": [0, 0, 0, 0], "scale_ppm": 1000000, "name": "flight"}"#).unwrap()),
                    _ => {}
                }
            }
        }
        let im = import_eden::load_with(&f.to_json(), &texts).unwrap();
        let st = &im.tree;
        let fl = im.nodes["flight"];
        for h in st.children(st.handle(fl).unwrap()).unwrap_or(&[]) {
            let n = st.node(*h).unwrap();
            println!("seeded flight child {} {}: {:?}", replica::world_model::show(n.id()), n.kind().as_str(), n.fields());
            for e in st.links_at(n.id()) {
                println!("seeded flight   link {:?}", st.link(e.link));
            }
        }
    }
    let mut hands: Vec<Hand> = site
        .w
        .souls
        .iter()
        .map(|s| Hand::new(&site.socket, &site.w, *s))
        .collect();
    let (x, z) = (testworld::SITE_X, testworld::YARD_Z);
    let at = |dx: i64, dz: i64| v3((x + dx) * 1000, 0, (z + dz) * 1000);

    // Soul 1 to the flight's foot (east of the bay: its slot turns it a half turn, its top at the sheets' east edge),
    // then up onto the first sheet's top, past the stair's top.
    hands[0].walk_to(g, at(4_500, -622));
    let e = socket_end(&mut hands[0].s);
    assert_eq!(e.kind, 1, "Soul 1 to the flight's foot: {e:?}");
    let to = BTreeMap::from([(1, Value::Array(vec![int(-400_000), int(19_000), int(0)]))]);
    hands[0].send("eden:walk", deck, to);
    let e = socket_end(&mut hands[0].s);
    println!("Soul 1 up the stair onto the deck: {e:?}");
    assert_eq!(e.kind, 1, "up the stair onto the deck: {e:?}");
    let (on, p) = body_on(&site.w, body_of(&site.w, site.w.souls[0]));
    assert_eq!((on, p.y), (deck, 19_000), "on the sheet's top");

    // Soul 2 climbs frame 1's ladder to its outer standing place (frame 1 stands at the bay's -z end). The frame's
    // standing places are its kind's floors 1 and 2, at z -488 and +488 mm in its frame: the outer is the one farther
    // from the bay's middle.
    let place_z = |frame_z: i64| {
        let (copy, _) = served_copy(&site.w);
        let t = copy.tree();
        let x = sim::ground::scene::xform_to(t, t.handle(frame).unwrap(), t.handle(g).unwrap())
            .unwrap();
        x.point(v3(0, 0, frame_z)).unwrap().z
    };
    let (face, level) = match place_z(-488_000) < place_z(488_000) {
        true => (-488_000, 1),
        false => (488_000, 2),
    };
    let perch = floors_of(&site.w, frame)
        .into_iter()
        .find(|f| f.1 == level && f.2)
        .expect("the outer standing place, ground while joined")
        .0;
    hands[1].walk_to(g, at(0, -3_900));
    let e = socket_end(&mut hands[1].s);
    assert_eq!(e.kind, 1, "Soul 2 to the ladder's foot: {e:?}");
    let to = BTreeMap::from([(1, Value::Array(vec![int(0), int(1_800_000), int(face)]))]);
    hands[1].send("eden:walk", perch, to);
    let e = socket_end(&mut hands[1].s);
    println!("Soul 2 climbs frame 1: {e:?}");
    assert_eq!(e.kind, 1, "the climb ends on the standing place: {e:?}");
    let (on, p) = body_on(&site.w, body_of(&site.w, site.w.souls[1]));
    assert_eq!(
        (on, p.y),
        (perch, 1_800_000),
        "on the frame's 1.8 m standing place"
    );
}
