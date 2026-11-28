//! A deck bay by intents (racks T2, the scripted build's bay: `mars/viewer/engine/scenarios/build-bay.ts`): two Souls
//! carry a plywood sheet and set it down; a deck bay's two 12 ft frames are held while four 9 ft beams are seated at
//! 0.5 m and 1.8 m; a crew seats a 2x4 joist across the two 1.8 m beams, which it rests on by the support rule's resting
//! tier; a beam under it cannot be taken out; the joist comes out again by the same rules. A sheet on two joists waits
//! for support to any depth (draft PR #5256): that test is ignored until it merges.
use super::*;

/// The joist slots `j1`, `j2`, `j4`'s and the sheet slot `s1`'s places along the bay (mm from its middle,
/// `deck_bay.json`).
const J1_Z: i64 = -1_172;
const J2_Z: i64 = -572;
const J4_Z: i64 = 578;
const J3_Z: i64 = -2;
const J5_Z: i64 = 1_178;
const S1_Z: i64 = -612;

/// N2's test world with a deck bay's parts at its site (`content/kinds/construction/`): the bay at the site's centre,
/// its two 12 ft frames standing loose on their slots' places, its four beams lying outside their columns (the low
/// ones 0.5 m out, the high ones 1 m), a 2x4 lying on the ground under each of its slots `j1`, `j2` and `j4`, and one
/// plywood sheet under its slot `s1` (each crew takes its part where it lies and puts it from there, one carrier each
/// side of the bay; on the ground the sheet and the `j2` joist overlap), and a plywood sheet lying 5 m east. The folder of entries: the construction kinds and the body. Returns the facts and the
/// bay's slot numbers, by name.
fn deck_world(d: &Path) -> (String, BTreeMap<String, u64>) {
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
    ];
    let (x, z) = (testworld::SITE_X, testworld::YARD_Z);
    let things = [
        ("deck-bay", 0, [x, 0, z, 0]),
        ("deck-frame-1", 1, [x, 0, z - 1_448, 0]),
        ("deck-frame-2", 1, [x, 0, z + 1_448, 0]),
        ("deck-beam-low-l", 2, [x - 1_072, 0, z, 0]),
        ("deck-beam-low-r", 2, [x + 1_072, 0, z, 0]),
        ("deck-beam-high-l", 2, [x - 1_572, 0, z, 0]),
        ("deck-beam-high-r", 2, [x + 1_572, 0, z, 0]),
        ("two-by-four", 3, [x, 0, z + J4_Z, 0]),
        ("two-by-four-1", 3, [x, 0, z + J1_Z, 0]),
        ("two-by-four-2", 3, [x, 0, z + J2_Z, 0]),
        ("two-by-four-3", 3, [x, 0, z + J3_Z, 0]),
        ("two-by-four-5", 3, [x, 0, z + J5_Z, 0]),
        ("plywood-sheet", 4, [x + 5_000, 0, z, 0]),
        ("plywood-sheet-2", 4, [x, 0, z + S1_Z, 0]),
    ];
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
                for (id, r, pose) in things {
                    let mut t = vec![
                        ("id".into(), json::Value::s(id)),
                        ("def".into(), json::Value::s(refs[r].0)),
                        ("ref".into(), json::Value::s(refs[r].0)),
                        ("parent".into(), json::Value::Null),
                        ("pose".into(), ints(&pose)),
                        ("scale_ppm".into(), num(1_000_000)),
                        ("name".into(), json::Value::s(id)),
                    ];
                    if r == 0 {
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
                        t.push(("slots".into(), json::Value::Arr(rows)));
                    }
                    a.push(json::Value::Obj(t));
                }
            }
            _ => {}
        }
    }
    (f.to_json(), numbers)
}

/// A served deck world (`deck_world`) and a hand for each of its Souls.
struct Yard {
    w: Seeded,
    _s: Served,
    hands: Vec<Hand>,
    slots: BTreeMap<String, u64>,
    nodes: BTreeMap<String, Id>,
    x: i64,
    z: i64,
}

impl Yard {
    fn serve(tag: &str, souls: u64) -> Yard {
        Yard::serve_edited(tag, souls, |_, f| f)
    }

    /// [`Yard::serve`] with the deck world's facts and entries changed first by `edit` (the scratch folder, the facts).
    fn serve_edited(tag: &str, souls: u64, edit: impl FnOnce(&Path, String) -> String) -> Yard {
        let d = scratch(tag);
        let (facts, slots) = deck_world(&d);
        let facts = edit(&d, facts);
        let (x, z) = (testworld::SITE_X, testworld::YARD_Z);
        let w = seed_entries(
            &d,
            &facts,
            souls,
            ((x - 4_000) / 1000, (z - 5_000) / 1000),
            Some(&d.join("entries")),
        );
        let socket = d.join("s");
        let s = serve_with(&w, &socket, None);
        s.line("listening ", 120);
        let nodes = import_eden::load(&facts)
            .unwrap()
            .nodes
            .into_iter()
            .collect();
        let hands = w.souls.iter().map(|s| Hand::new(&socket, &w, *s)).collect();
        Yard {
            w,
            _s: s,
            hands,
            slots,
            nodes,
            x,
            z,
        }
    }

    fn id(&self, name: &str) -> Id {
        self.nodes[name]
    }

    /// A place `dx`, `dz` mm from the bay's middle, on the ground.
    fn at(&self, dx: i64, dz: i64) -> Vec3 {
        v3((self.x + dx) * 1000, 0, (self.z + dz) * 1000)
    }

    /// Each Soul named walks to its place, all at once; every walk ends there.
    fn walk(&mut self, to: &[(usize, (i64, i64))], what: &str) {
        let g = self.w.ground;
        for (k, (dx, dz)) in to {
            let p = self.at(*dx, *dz);
            self.hands[*k].walk_to(g, p);
        }
        for (k, _) in to {
            let got = socket_end(&mut self.hands[*k].s);
            assert_eq!(got.kind, 1, "{what}: Soul {}: {got:?}", k + 1);
        }
    }

    /// A carry crew Soul `a` offers on the open ground to `others`, who each accept.
    fn crew(&mut self, a: usize, others: &[usize]) -> Id {
        let bodies = others
            .iter()
            .map(|o| body_of(&self.w, self.w.souls[*o]).to_value())
            .collect();
        let got = self.hands[a].act(
            "activity:offer",
            self.w.ground,
            BTreeMap::from([
                (1, pinned_activity(&self.w, "mars:carry_activity")),
                (2, Value::Text(Name::new("mars:front").unwrap())),
                (3, Value::Array(bodies)),
            ]),
        );
        assert_eq!(got.kind, 1, "offered: {got:?}");
        let made = created_by(&self.w, &got.entries, "mars:carry_activity@");
        for o in others {
            let got = self.hands[*o].act("activity:accept", made, BTreeMap::new());
            assert_eq!(got.kind, 1, "Soul {} accepts: {got:?}", o + 1);
        }
        made
    }

    fn leave(&mut self, k: usize, c: Id) {
        let got = self.hands[k].act("activity:leave", c, BTreeMap::new());
        assert_eq!(got.kind, 1, "Soul {} leaves: {got:?}", k + 1);
    }

    fn act(&mut self, k: usize, verb: &str, c: Id, p: BTreeMap<u64, Value>, what: &str) -> Got {
        let got = self.hands[k].act(verb, c, p);
        println!("{what}: {got:?}");
        got
    }

    fn ok(&mut self, k: usize, verb: &str, c: Id, p: BTreeMap<u64, Value>, what: &str) {
        let got = self.act(k, verb, c, p, what);
        assert_eq!(got.kind, 1, "{what}");
    }

    fn part(p: Id) -> BTreeMap<u64, Value> {
        BTreeMap::from([(1, p.to_value())])
    }

    /// Into the bay's slot `slot`, joined to `joins` when named.
    fn slot_in(&self, slot: &str, joins: &[Id]) -> BTreeMap<u64, Value> {
        let mut p = BTreeMap::from([
            (1, self.id("deck-bay").to_value()),
            (2, Value::Uint(self.slots[slot])),
        ]);
        if !joins.is_empty() {
            p.insert(
                4,
                Value::Array(joins.iter().map(|j| j.to_value()).collect()),
            );
        }
        p
    }

    fn ground_at(&self, dx: i64, dz: i64) -> BTreeMap<u64, Value> {
        let p = self.at(dx, dz);
        BTreeMap::from([
            (1, self.w.ground.to_value()),
            (3, Value::Array(vec![int(p.x), int(0), int(p.z)])),
        ])
    }

    /// The parts `part` is joined to.
    fn joined(&self, part: Id) -> Vec<Id> {
        let (copy, _) = served_copy(&self.w);
        let t = copy.tree();
        let mut on: Vec<Id> = t
            .links_at(part)
            .iter()
            .filter(|e| t.ty(e).as_str().contains("joint"))
            .filter_map(|e| t.link(e.link))
            .flat_map(|(_, ends, _, _)| ends)
            .filter(|e| *e != part)
            .collect();
        on.sort();
        on
    }

    /// The frame by six Souls: Souls 2 and 3 take frame 1 where it stands and put it in `upright_a`, Souls 4 and 5
    /// frame 2 in `upright_b`, each pair staying to hold it (a 12 ft frame's hold crew is two, and it needs beams at two
    /// heights on each column to stand). Souls 1 and 6 seat the 0.5 m beams from where they lie, 0.5 m outside their
    /// slots, then carry each 1.8 m beam in from 1 m outside its column and seat it; the holders let go.
    fn frame(&mut self) {
        let mut holds = Vec::new();
        for (frame, dz, (a, b), slot) in [
            ("deck-frame-1", -1_448, (1, 2), "upright_a"),
            ("deck-frame-2", 1_448, (3, 4), "upright_b"),
        ] {
            self.walk(
                &[(a, (1_060, dz)), (b, (-1_060, dz))],
                "beside a frame's edges",
            );
            let hold = self.crew(a, &[b]);
            let f = self.id(frame);
            self.ok(a, "part:take", hold, Self::part(f), "a 12 ft frame taken");
            let p = self.slot_in(slot, &[]);
            self.ok(a, "part:put", hold, p, slot);
            holds.push(((a, b), hold));
        }
        let mut beams = None;
        for (beam, dx, from, slot) in [
            ("deck-beam-low-l", -1_072, -1_072, "beam_low_l"),
            ("deck-beam-low-r", 1_072, 1_072, "beam_low_r"),
            ("deck-beam-high-l", -1_072, -1_572, "beam_high_l"),
            ("deck-beam-high-r", 1_072, 1_572, "beam_high_r"),
        ] {
            self.walk(
                &[(0, (from, -1_547)), (5, (from, 1_547))],
                "Souls 1 and 6 to a beam's ends",
            );
            let c = match beams {
                Some(c) => c,
                None => *beams.insert(self.crew(0, &[5])),
            };
            let b = self.id(beam);
            self.ok(0, "part:take", c, Self::part(b), "a beam taken");
            if from != dx {
                self.walk(
                    &[(0, (dx, -1_547)), (5, (dx, 1_547))],
                    "the beam carried to 0.5 m outside its slot",
                );
            }
            let p = self.slot_in(slot, &[]);
            self.ok(0, "part:put", c, p, slot);
            assert_eq!(joints_at(&self.w, b), 2, "{slot} joins both frames");
        }
        for ((a, b), hold) in holds {
            self.leave(a, hold);
            self.leave(b, hold);
        }
        let beams = beams.unwrap();
        self.leave(0, beams);
        self.leave(5, beams);
        let frames = [self.id("deck-frame-1"), self.id("deck-frame-2")];
        assert_eq!(
            (
                crews_on(&self.w, frames[0]).0,
                crews_on(&self.w, frames[1]).0
            ),
            (0, 0),
            "the frames stand unheld on two levels of beams"
        );
    }

    /// Souls `a` and `b` beside the bay at the ends of the joist `name` lying under slot `slot` (`dz` along the bay)
    /// take it and seat it there across the two 1.8 m beams. → the crew, still holding it
    fn joist(&mut self, (a, b): (usize, usize), name: &str, slot: &str, dz: i64) -> Id {
        // The back 20 mm off the front's line: with both on one line along x this crew's take was refused `part-pose`
        // (`OrientationSign`) on #5207's head 70a07fdca, an engine defect reported to that lane.
        self.walk(
            &[(a, (-1_082, dz)), (b, (1_082, dz + 20))],
            "at a joist's ends, either side of the bay",
        );
        let c = self.crew(a, &[b]);
        let j = self.id(name);
        self.ok(a, "part:take", c, Self::part(j), "a joist taken");
        let high = [self.id("deck-beam-high-l"), self.id("deck-beam-high-r")];
        let p = self.slot_in(slot, &high);
        self.ok(a, "part:put", c, p, "the joist across both 1.8 m beams");
        let (parent, at, _) = where_is(&self.w, j);
        assert_eq!(
            (parent, at),
            (Some(self.id("deck-bay")), Some(self.slots[slot])),
            "the joist in {slot}"
        );
        let mut both = high.to_vec();
        both.sort();
        assert_eq!(
            self.joined(j),
            both,
            "the joist's joints: one to each 1.8 m beam"
        );
        c
    }
}

/// Racks T2, by Souls' intents, each on its own connection:
///
/// - Two Souls at a plywood sheet's ends take it, carry it 2 m north and lay it down there.
/// - The deck bay's frame by six ([`Yard::frame`]).
/// - A crew of two, one each side of the bay, takes the 2x4 where it lies and seats it in `j4` (1.9 m up), naming the
///   two 1.8 m beams: it rests on both (one joint to each); its crew lets go and it stays.
/// - A crew at the left 1.8 m beam's ends unseats it: refused `support.none`. The joist's crew unseats the joist and
///   lays it back where it lay.
#[test]
fn deck_two_carry_a_plywood_sheet_and_a_crew_seats_a_two_by_four_across_two_seated_beams() {
    let mut y = Yard::serve("deck", 6);
    let sheet = y.id("plywood-sheet");
    // The sheet: Souls 2 and 3 at its ends (its grips on its short edges, 0.91 m from its middle), 0.35 m beyond.
    y.walk(
        &[(1, (5_000 - 1_264, 0)), (2, (5_000 + 1_264, 0))],
        "Souls 2 and 3 at the sheet's ends",
    );
    let pair = y.crew(1, &[2]);
    y.ok(
        1,
        "part:take",
        pair,
        Yard::part(sheet),
        "Souls 2 and 3 take the sheet",
    );
    assert_eq!(
        where_is(&y.w, sheet).0,
        Some(pair),
        "the sheet rides its crew"
    );
    y.walk(
        &[(1, (5_000 - 1_264, 2_000)), (2, (5_000 + 1_264, 2_000))],
        "the sheet carried 2 m north",
    );
    assert_eq!(where_is(&y.w, sheet).0, Some(pair), "still carried");
    let p = y.ground_at(5_000, 2_000);
    y.ok(1, "part:put", pair, p, "the sheet laid down");
    let (parent, _, lies) = where_is(&y.w, sheet);
    println!("the sheet lies at {lies:?}");
    assert_eq!(parent, Some(y.w.ground), "the sheet on the open ground");
    let to = y.at(5_000, 2_000);
    assert!(
        (lies.x - to.x).abs() < 300_000 && (lies.z - to.z).abs() < 300_000,
        "where it was laid: {lies:?}"
    );
    y.leave(1, pair);
    y.leave(2, pair);

    y.frame();
    let joist = y.id("two-by-four");
    let pair = y.joist((0, 5), "two-by-four", "j4", J4_Z);
    y.leave(0, pair);
    y.leave(5, pair);
    assert_eq!(
        where_is(&y.w, joist).0,
        Some(y.id("deck-bay")),
        "it stays, unheld"
    );

    // The left 1.8 m beam out from under the joist: Souls 2 and 3 at its ends, 0.5 m outside its slot. Refused.
    y.walk(
        &[(1, (-1_072, -1_547)), (2, (-1_072, 1_547))],
        "Souls 2 and 3 to the left 1.8 m beam's ends",
    );
    let out = y.crew(1, &[2]);
    let high_l = y.id("deck-beam-high-l");
    let got = y.act(
        1,
        "part:unseat",
        out,
        Yard::part(high_l),
        "the left 1.8 m beam out from under the joist",
    );
    assert_eq!((got.kind, got.reason.as_str()), (2, "support.none"));
    assert_eq!(
        where_is(&y.w, high_l).0,
        Some(y.id("deck-bay")),
        "the beam stays seated"
    );
    y.leave(1, out);
    y.leave(2, out);

    // The joist out again by its crew, and laid back where it lay.
    y.walk(
        &[(0, (-1_082, J4_Z)), (5, (1_082, J4_Z + 20))],
        "Souls 1 and 6 back at the joist's ends",
    );
    let pair = y.crew(0, &[5]);
    y.ok(
        0,
        "part:unseat",
        pair,
        Yard::part(joist),
        "the joist unseated",
    );
    assert_eq!(
        where_is(&y.w, joist).0,
        Some(pair),
        "the joist rides its crew"
    );
    assert_eq!(joints_at(&y.w, joist), 0, "its joints gone");
    std::thread::sleep(Duration::from_millis(1500));
    let p = y.ground_at(0, J4_Z);
    y.ok(0, "part:put", pair, p, "the joist laid back where it lay");
    assert_eq!(
        where_is(&y.w, joist).0,
        Some(y.w.ground),
        "the joist on the ground"
    );
}

/// Racks T2's sheet, once support reaches any depth (draft PR #5256): the frame by six; joists in `j1` and `j2`; a
/// crew of two takes the plywood sheet lying under `s1` and seats it there on the two joists (its two joints, one to
/// each); its crew lets go and it stays; the `j1` joist cannot be unseated from under it (`support.none`); the sheet
/// comes out again. Today a sheet resting on a joist, which itself rests, is refused (`support.none`, "would rest on
/// nothing").
#[test]
#[ignore = "a sheet resting on joists needs support to any depth: draft PR #5256 (agent/racks-deck-floor)"]
fn deck_a_crew_seats_a_plywood_sheet_on_two_joists_and_a_joist_under_it_stays() {
    let mut y = Yard::serve("decksheet", 6);
    y.frame();
    let j1 = y.joist((0, 5), "two-by-four-1", "j1", J1_Z);
    y.leave(0, j1);
    y.leave(5, j1);
    let j2 = y.joist((0, 5), "two-by-four-2", "j2", J2_Z);
    y.leave(0, j2);
    y.leave(5, j2);
    let (joist_1, joist_2) = (y.id("two-by-four-1"), y.id("two-by-four-2"));
    let sheet = y.id("plywood-sheet-2");
    y.walk(
        &[(1, (-1_164, S1_Z)), (2, (1_164, S1_Z))],
        "Souls 2 and 3 at the sheet's ends",
    );
    let pair = y.crew(1, &[2]);
    y.ok(1, "part:take", pair, Yard::part(sheet), "the sheet taken");
    let p = y.slot_in("s1", &[joist_1, joist_2]);
    y.ok(1, "part:put", pair, p, "the sheet onto two joists");
    let mut both = vec![joist_1, joist_2];
    both.sort();
    assert_eq!(
        y.joined(sheet),
        both,
        "the sheet's joints: one to each joist"
    );
    y.leave(1, pair);
    y.leave(2, pair);
    assert_eq!(
        where_is(&y.w, sheet).0,
        Some(y.id("deck-bay")),
        "it stays, unheld"
    );
    y.walk(
        &[(0, (-1_082, J1_Z)), (5, (1_082, J1_Z + 20))],
        "Souls 1 and 6 at joist 1's ends",
    );
    let out = y.crew(0, &[5]);
    let got = y.act(
        0,
        "part:unseat",
        out,
        Yard::part(joist_1),
        "joist 1 out from under the sheet",
    );
    assert_eq!((got.kind, got.reason.as_str()), (2, "support.none"));
    y.leave(0, out);
    y.leave(5, out);
    y.walk(
        &[(1, (-1_164, S1_Z)), (2, (1_164, S1_Z))],
        "Souls 2 and 3 back at the sheet's ends",
    );
    let pair = y.crew(1, &[2]);
    y.ok(
        1,
        "part:unseat",
        pair,
        Yard::part(sheet),
        "the sheet unseated",
    );
    assert_eq!(
        where_is(&y.w, sheet).0,
        Some(pair),
        "the sheet rides its crew"
    );
}

/// #5067 (the joists' puts, page lane's rehearsal): the bay's frame stands on its beams ([`Yard::frame`]); then each of
/// its five joists is taken by a crew of two at its ends, carried 0.6 m along the bay, and put into its slot from
/// there. A put the crew cannot reach from where it stands is refused `part.grip-out-of-reach`, naming the place its
/// node is admitted from (`admitted with the crew's node at x= z= mm`, that 50 mm inside every reach); the crew walks
/// there by that place alone (no point of the test's own) and puts it again: seated across both 1.8 m beams.
#[test]
fn deck_five_joists_seated_across_the_high_beams_from_where_their_put_is_admitted() {
    let mut y = Yard::serve("deckjoists", 6);
    y.frame();
    let high = [y.id("deck-beam-high-l"), y.id("deck-beam-high-r")];
    for (name, slot, dz) in [
        ("two-by-four-1", "j1", J1_Z),
        ("two-by-four-2", "j2", J2_Z),
        ("two-by-four-3", "j3", J3_Z),
        ("two-by-four", "j4", J4_Z),
        ("two-by-four-5", "j5", J5_Z),
    ] {
        y.walk(&[(0, (-1_082, dz)), (5, (1_082, dz))], "at a joist's ends");
        let c = y.crew(0, &[5]);
        let j = y.id(name);
        y.ok(0, "part:take", c, Yard::part(j), "a joist taken");
        // 0.6 m along the bay, off its slot's line.
        let off = if dz > 0 { -600 } else { 600 };
        y.walk(
            &[(0, (-1_082, dz + off)), (5, (1_082, dz + off))],
            "carried along the bay",
        );
        let p = y.slot_in(slot, &high);
        let mut got = y.act(0, "part:put", c, p.clone(), "the joist put from 0.6 m off");
        for _ in 0..2 {
            if got.kind == 1 {
                break;
            }
            assert_eq!(
                got.reason, "part.grip-out-of-reach",
                "{slot}: refused only out of reach: {got:?}"
            );
            let m = got
                .detail
                .split("admitted with the crew's node at x=")
                .nth(1)
                .unwrap_or_else(|| {
                    panic!(
                        "{slot}: the refusal names where it is admitted: {}",
                        got.detail
                    )
                });
            let n: Vec<i64> = m
                .split(|c: char| !(c.is_ascii_digit() || c == '-'))
                .filter(|w| !w.is_empty())
                .take(2)
                .map(|w| w.parse().unwrap())
                .collect();
            // The whole crew moved by the node's way there, each its own walk.
            let node = where_is(&y.w, c).2;
            let (dx, dz2) = (n[0] - node.x / 1000, n[1] - node.z / 1000);
            let feet: Vec<Vec3> = [0, 5]
                .iter()
                .map(|k| body_at(&y.w, body_of(&y.w, y.w.souls[*k])))
                .collect();
            let (bx, bz) = (y.x, y.z);
            let rel = |f: Vec3| ((f.x / 1000 - bx) + dx, (f.z / 1000 - bz) + dz2);
            let to = [(0, rel(feet[0])), (5, rel(feet[1]))];
            y.walk(&to, "to where the put is admitted");
            got = y.act(0, "part:put", c, p.clone(), "the joist put again");
        }
        assert_eq!(got.kind, 1, "{slot} seated: {got:?}");
        let (parent, at, _) = where_is(&y.w, j);
        assert_eq!(
            (parent, at),
            (Some(y.id("deck-bay")), Some(y.slots[slot])),
            "the joist in {slot}"
        );
        let mut both = high.to_vec();
        both.sort();
        assert_eq!(y.joined(j), both, "{slot}: one joint to each 1.8 m beam");
        y.leave(0, c);
        y.leave(5, c);
    }
}

/// The slot `node` is in, and the turn of its own pose there.
fn yaw_in_slot(w: &Seeded, node: Id) -> (Option<u64>, Quat) {
    let (copy, _) = served_copy(w);
    let t = copy.tree();
    let n = t.node(t.handle(node).unwrap()).unwrap();
    (n.slot(), n.place().unwrap().orientation)
}

/// Whether two turns are the same (a unit quaternion and its negation are one turn).
fn same_turn(a: Quat, b: Quat) -> bool {
    let (p, q) = (a.parts(), b.parts());
    let d = |s: i64| (0..4).map(|k| (p[k] - s * q[k]).abs()).max().unwrap();
    d(1).min(d(-1)) <= Quat::IDENTITY.parts()[0] / 10_000
}

/// FOR-FABLE 10, slots that declare a turn, in a served world by Souls' intents: the deck bay's two upright slots
/// declare `turn_mdeg: 90000` (its entry, changed for this test). Frame 1 stands loose on `upright_a`'s place turned
/// 90°, frame 2 on `upright_b`'s turned 270° (the half turn from it; a 12 ft frame is the same either way,
/// `symmetry` `front_back`). Two take each frame from beside its edges and put it in its slot: frame 1 is seated turned
/// 90° in it, frame 2 at the half turn, 270°, the nearer to how it is held, as a slot with no turn seats at 0 and 180.
#[test]
fn deck_slots_that_declare_a_turn_seat_their_frames_turned_90_and_the_half_turn_270() {
    let turns = [("deck-frame-1", 90_000), ("deck-frame-2", 270_000)];
    let mut y = Yard::serve_edited("deckturn", 5, |d, facts| {
        let path = d.join("entries/deck_bay.json");
        let mut bay = json::parse(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let json::Value::Obj(top) = &mut bay else {
            panic!("an entry")
        };
        let (_, json::Value::Obj(slots)) = top.iter_mut().find(|(k, _)| k == "slots").unwrap()
        else {
            panic!("its slots")
        };
        for (name, s) in slots.iter_mut() {
            if let (true, json::Value::Obj(s)) = (name.starts_with("upright_"), s) {
                s.push(("turn_mdeg".into(), json::Value::Int(90_000)));
            }
        }
        std::fs::write(&path, bay.to_json()).unwrap();
        let mut f = json::parse(&facts).unwrap();
        let json::Value::Obj(top) = &mut f else {
            panic!("facts")
        };
        let (_, json::Value::Arr(things)) = top.iter_mut().find(|(k, _)| k == "things").unwrap()
        else {
            panic!("things")
        };
        for t in things.iter_mut() {
            let json::Value::Obj(t) = t else { continue };
            let id = t
                .iter()
                .find(|(k, _)| k == "id")
                .and_then(|(_, v)| v.str())
                .map(str::to_owned);
            if let Some((_, yaw)) = turns.iter().find(|(n, _)| Some(*n) == id.as_deref())
                && let Some((_, json::Value::Arr(pose))) = t.iter_mut().find(|(k, _)| k == "pose")
            {
                pose[3] = json::Value::Int(i128::from(*yaw));
            }
        }
        f.to_json()
    });
    for ((frame, yaw), (dz, (a, b), slot)) in turns
        .into_iter()
        .zip([(-1_448, (1, 2), "upright_a"), (1_448, (3, 4), "upright_b")])
    {
        // Beside its edges: 1.06 m either side of its middle along its own x, turned as it stands.
        let q = Quat::from_yaw_mdeg(yaw).unwrap();
        let e = q.rotate(v3(1_060_000, 0, 0)).unwrap();
        let (ex, ez) = (e.x / 1000, e.z / 1000);
        y.walk(
            &[(a, (ex, dz + ez)), (b, (-ex, dz - ez))],
            "beside a turned frame's edges",
        );
        let hold = y.crew(a, &[b]);
        let f = y.id(frame);
        assert!(
            same_turn(yaw_in_slot(&y.w, f).1, q),
            "{frame} stands turned {yaw} mdeg"
        );
        y.ok(
            a,
            "part:take",
            hold,
            Yard::part(f),
            "a turned 12 ft frame taken",
        );
        let p = y.slot_in(slot, &[]);
        y.ok(a, "part:put", hold, p, slot);
        let (in_slot, turn) = yaw_in_slot(&y.w, f);
        println!("{frame} in slot {in_slot:?} turned {:?}", turn.parts());
        assert_eq!(in_slot, Some(y.slots[slot]), "{frame} in {slot}");
        assert!(
            same_turn(turn, q),
            "{frame} seated turned {yaw} mdeg in {slot}: {:?}",
            turn.parts()
        );
    }
}

/// FOR-FABLE 10, a creator's place into a slot that declares a turn: the frame stand's slot `frame_1` declares
/// `turn_mdeg: 90000` (its entry, changed for this test). A creator places two stands on the open ground and a rack
/// upright into each one's `frame_1`: the first given no turn is seated turned 90°, the second given 270° (the half turn
/// from the slot's; an upright is the same either way) is seated at 270°, as a crew's put would seat them.
#[test]
fn deck_a_creators_place_into_a_slot_that_declares_a_turn_seats_the_part_turned_so() {
    let d = scratch("deckplace");
    let (facts, _) = deck_world(&d);
    let path = d.join("entries/frame_stand.json");
    let mut stand = json::parse(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let json::Value::Obj(top) = &mut stand else {
        panic!("an entry")
    };
    let (_, json::Value::Obj(slots)) = top.iter_mut().find(|(k, _)| k == "slots").unwrap() else {
        panic!("its slots")
    };
    let (_, json::Value::Obj(first)) = slots.iter_mut().find(|(k, _)| k == "frame_1").unwrap()
    else {
        panic!("frame_1")
    };
    first.push(("turn_mdeg".into(), json::Value::Int(90_000)));
    std::fs::write(&path, stand.to_json()).unwrap();
    let (x, z) = (testworld::SITE_X, testworld::YARD_Z);
    let w = seed_entries(
        &d,
        &facts,
        1,
        ((x - 4_000) / 1000, (z - 5_000) / 1000),
        Some(&d.join("entries")),
    );
    let (creator_id, creator_actor) = creator(0xd7);
    static_creator(&w, creator_id);
    let socket = d.join("s");
    let s = serve_with(&w, &socket, None);
    s.line("listening ", 120);
    let (_, rules) = served_copy(&w);
    let mut world = connect_socket(&socket);
    world
        .set_read_timeout(Some(Duration::from_secs(60)))
        .unwrap();
    let (mut edits, mut planned) = (0, 0);
    let mut creator_edit = |op: Op| loop {
        edits += 1;
        let bytes = edit_intent(&w, creator_actor, edits, planned, op.clone());
        world
            .write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
            .unwrap();
        world.write_all(&bytes).unwrap();
        let got = socket_answer(&mut world);
        planned = planned.max(got.version);
        if got.reason != "edit.stale" {
            return got;
        }
    };
    let g = w.ground;
    let stand_kind = rules
        .kinds
        .keys()
        .find(|k| k.starts_with("mars:frame_stand@"))
        .expect("the stand's kind")
        .clone();
    for (k, yaw) in [(0, 0), (1, 270_000)] {
        let got = creator_edit(Op::Place {
            name: 1,
            kind: Name::new(&stand_kind).unwrap(),
            parent: Ref::Node(g),
            at: Spot {
                slot: None,
                position: v3((x - 3_000 + k * 6_000) * 1000, 0, (z + 7_000) * 1000),
                orientation: Quat::IDENTITY,
                support: Support::Surface {
                    surface: g,
                    height: 0,
                },
            },
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        });
        assert_eq!(got.kind, 1, "a frame stand commits: {got:?}");
        let stand = got.names[&1];
        let mut op = upright(&w, &rules, Some((stand, 1)), 0, 0);
        let given = Quat::from_yaw_mdeg(yaw).unwrap();
        if let Op::Place { at, .. } = &mut op {
            at.orientation = given;
        }
        let got = creator_edit(op);
        assert_eq!(
            got.kind, 1,
            "an upright in the stand's frame_1 commits: {got:?}"
        );
        let (slot, turn) = yaw_in_slot(&w, got.names[&1]);
        let want = Quat::from_yaw_mdeg(if yaw == 0 { 90_000 } else { 270_000 }).unwrap();
        println!(
            "given {yaw} mdeg: seated in slot {slot:?} turned {:?}",
            turn.parts()
        );
        assert_eq!(slot, Some(1), "in frame_1");
        assert!(
            same_turn(turn, want),
            "given {yaw} mdeg, seated at {:?}",
            turn.parts()
        );
    }
}
