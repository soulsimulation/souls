//! The deck bay taken down by Souls' intents (racks T, take-down survey): the bay `deck.rs`'s deck test builds (two
//! frames, four beams, three 2x4s, two sheets at 1.8 m, the stair flight in its slot), then everyone stands clear and
//! it is taken down in reverse, one test a stage, each from the built bay through the stages before it. Wrong orders
//! assert their refusals by name. A step refused for no good reason, or with no command to do it, is a test marked
//! `#[ignore]` named for the gap, its refusal in a comment. Nothing is fixed here.
//!
//! The piles are where each part lay or stood before the build (`bay_world`): a part is carried there and let go.
//! The setup helpers are copied from `deck.rs`.
use super::*;
use replica::world_model::show;

/// The test deck kinds' folder.
fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../sim/src/structure/fixtures")
}

fn walk_all(hands: &mut [Hand], g: Id, to: &[(usize, Vec3)], what: &str) {
    for (k, p) in to {
        hands[*k].walk_to(g, *p);
    }
    for (k, _) in to {
        let got = socket_end(&mut hands[*k].s);
        assert_eq!(got.kind, 1, "{what}: Soul {}: {got:?}", k + 1);
    }
}

/// A carry crew Soul `a` offers on the open ground to `others`, who each accept.
fn crew_of_all(w: &Seeded, hands: &mut [Hand], a: usize, others: &[usize]) -> Id {
    let bodies = others
        .iter()
        .map(|o| body_of(w, w.souls[*o]).to_value())
        .collect();
    let got = hands[a].act(
        "activity:offer",
        w.ground,
        BTreeMap::from([
            (1, pinned_activity(w, "mars:carry_activity")),
            (2, Value::Text(Name::new("mars:front").unwrap())),
            (3, Value::Array(bodies)),
        ]),
    );
    assert_eq!(got.kind, 1, "offered: {got:?}");
    let made = created_by(w, &got.entries, "mars:carry_activity@");
    for o in others {
        let got = hands[*o].act("activity:accept", made, BTreeMap::new());
        assert_eq!(got.kind, 1, "Soul {} accepts: {got:?}", o + 1);
    }
    made
}

fn refused_as(got: &Got, name: &str, what: &str) {
    println!("{what}: {got:?}");
    assert_eq!((got.kind, got.reason.as_str()), (2, name), "{what}");
}

/// Where body `body` last was, as the log's body rows have it: the node it stands on and its place there.
fn body_on(w: &Seeded, body: Id) -> (Id, Vec3) {
    let mut at = None;
    for p in logged(w) {
        if let Some(Value::Array(rows)) = p.rest.get(&answers::BODIES) {
            for (b, pose, _) in rows.iter().filter_map(worldd::bodies::read_row) {
                if b == body {
                    at = Some((pose.frame.node, pose.position));
                }
            }
        }
    }
    at.expect("a body row")
}

/// Where each 2x4 in the bay sits, mm from the bay's middle along z: `j2`, `j3`, `j4`.
const JOISTS_Z: [i64; 3] = [-572, -2, 578];
/// Where each sheet sits, mm from the bay's middle along z: `s1`, `s2`.
const SHEETS_Z: [i64; 2] = [-612, 607];
/// How far west of its slot the flight stands before it is set, mm: clear of the 1.8 m beams lying 1 m outside.
const FLIGHT_OFF: i64 = 800;
/// The stair slot's place in the bay, mm: its top at the sheets' west edge (x = -914), over `s1`, on `j2`'s line.
const STAIR_AT: [i64; 2] = [-2_164, -572];

/// N2's test world with a deck bay's parts at the site, in the test kinds `test_deck_*` (`#5258`'s sizes, with a
/// `stair` slot and a flight that hooks onto a 2x4): the bay at the site's centre, its two 12 ft frames standing loose
/// on their slots' places, its four beams lying outside their columns (the low ones 0.5 m out, the high ones 1 m),
/// the three 2x4s and the two sheets lying under their slots, and the flight standing 0.8 m west of its slot.
/// What each part is walked on and up is its kind's (`geometry.floors`, `stairs`, `ladders`): a sheet's top, the
/// flight's stair from the ground to the deck's top, each frame's standing places and ladders. Returns the facts and
/// the bay's slot numbers, by name.
fn bay_world(d: &Path) -> (String, BTreeMap<String, u64>) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let entries = d.join("entries");
    std::fs::create_dir_all(&entries).unwrap();
    for dir in [root.join("construction"), fixtures()] {
        for f in std::fs::read_dir(dir).unwrap() {
            let p = f.unwrap().path();
            if p.extension().is_some_and(|x| x == "json") {
                std::fs::copy(&p, entries.join(p.file_name().unwrap())).unwrap();
            }
        }
    }
    std::fs::copy(
        root.join("body/humanoid.json"),
        entries.join("humanoid.json"),
    )
    .unwrap();
    let text = std::fs::read_to_string(fixtures().join("test_deck_bay.json")).unwrap();
    let kind = replica::kinds::entry::entry_to_kind(&text).unwrap();
    let mut kinds = replica::kinds::Kinds::default();
    kinds.load(&[("test_deck_bay", kind.as_str())]);
    let def = kinds
        .admits()
        .into_keys()
        .find_map(|k| {
            kinds
                .get(&k)
                .filter(|d| d.name.as_str().starts_with("mars:test_deck_bay@"))
        })
        .expect("the bay's kind");
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
        ("testworld-test-deck-bay@1", "mars:test_deck_bay"),
        ("testworld-test-deck-frame@1", "mars:test_deck_frame"),
        ("testworld-test-deck-beam@1", "mars:test_deck_beam"),
        ("testworld-test-two-by-four@1", "mars:test_two_by_four"),
        ("testworld-test-plywood@1", "mars:test_plywood"),
        ("testworld-test-stair-flight@1", "mars:test_stair_flight"),
    ];
    let (x, z) = (testworld::SITE_X, testworld::YARD_Z);
    let mut things: Vec<(String, usize, [i64; 4])> = vec![
        ("bay".into(), 0, [x, 0, z, 0]),
        ("frame-1".into(), 1, [x, 0, z - 1_448, 0]),
        ("frame-2".into(), 1, [x, 0, z + 1_448, 0]),
        ("beam-low-l".into(), 2, [x - 1_072, 0, z, 0]),
        ("beam-low-r".into(), 2, [x + 1_072, 0, z, 0]),
        ("beam-high-l".into(), 2, [x - 1_572, 0, z, 0]),
        ("beam-high-r".into(), 2, [x + 1_572, 0, z, 0]),
        (
            "flight".into(),
            5,
            [x + STAIR_AT[0] - FLIGHT_OFF, 0, z + STAIR_AT[1], 0],
        ),
    ];
    for (k, jz) in JOISTS_Z.iter().enumerate() {
        things.push((format!("joist-{}", k + 2), 3, [x, 0, z + jz, 0]));
    }
    for (k, sz) in SHEETS_Z.iter().enumerate() {
        things.push((format!("sheet-{}", k + 1), 4, [x, 0, z + sz, 0]));
    }
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
                for (id, r, pose) in &things {
                    let mut t = vec![
                        ("id".into(), json::Value::s(id)),
                        ("def".into(), json::Value::s(refs[*r].0)),
                        ("ref".into(), json::Value::s(refs[*r].0)),
                        ("parent".into(), json::Value::Null),
                        ("pose".into(), ints(pose)),
                        ("scale_ppm".into(), num(1_000_000)),
                        ("name".into(), json::Value::s(id)),
                    ];
                    if *r == 0 {
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

/// The deck bay's world served, its Souls each on its own connection, and its parts.
struct Bay {
    w: Seeded,
    _s: Served,
    hands: Vec<Hand>,
    slots: BTreeMap<String, u64>,
    bay: Id,
    frames: [Id; 2],
    low: [Id; 2],
    high: [Id; 2],
    joists: [Id; 3],
    sheets: [Id; 2],
    flight: Id,
    /// The floor each sheet holds: its top.
    decks: [Id; 2],
    /// Each frame's standing places at 1.8 m, as its kind declares them: its back face's, then its front's.
    places: [[Id; 2]; 2],
}

impl Bay {
    fn at(dx: i64, dz: i64) -> Vec3 {
        v3(
            (testworld::SITE_X + dx) * 1000,
            0,
            (testworld::YARD_Z + dz) * 1000,
        )
    }

    fn serve(tag: &str, souls: u64) -> Bay {
        let d = scratch(tag);
        let (facts, slots) = bay_world(&d);
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
        // The import with the entries, as the world's: the kinds' floors and stairs are nodes too.
        let texts: Vec<(String, String)> = std::fs::read_dir(d.join("entries"))
            .unwrap()
            .map(|f| f.unwrap().path())
            .map(|p| {
                let name = p.file_stem().unwrap().to_string_lossy().into_owned();
                (name, std::fs::read_to_string(&p).unwrap())
            })
            .collect();
        let im = import_eden::load_with(&facts, &texts).unwrap();
        let hands = w.souls.iter().map(|s| Hand::new(&socket, &w, *s)).collect();
        let n = |k: &str| im.nodes[k];
        Bay {
            bay: n("bay"),
            frames: [n("frame-1"), n("frame-2")],
            low: [n("beam-low-l"), n("beam-low-r")],
            high: [n("beam-high-l"), n("beam-high-r")],
            joists: [n("joist-2"), n("joist-3"), n("joist-4")],
            sheets: [n("sheet-1"), n("sheet-2")],
            flight: n("flight"),
            decks: [n("sheet-1/floor-1"), n("sheet-2/floor-1")],
            places: ["frame-1", "frame-2"].map(|f| [1, 2].map(|l| n(&format!("{f}/floor-{l}")))),
            w,
            _s: s,
            hands,
            slots,
        }
    }

    fn ok(&self, got: Got, what: &str) {
        println!("{what}: {got:?}");
        if got.kind != 1 {
            for l in self
                ._s
                .lines
                .try_iter()
                .filter(|l| l.starts_with("worldd:"))
            {
                println!("  {l}");
            }
            panic!("{what}: {got:?}");
        }
    }

    fn walk(&mut self, to: &[(usize, Vec3)], what: &str) {
        walk_all(&mut self.hands, self.w.ground, to, what);
    }

    fn crew(&mut self, a: usize, others: &[usize]) -> Id {
        crew_of_all(&self.w, &mut self.hands, a, others)
    }

    fn act(&mut self, k: usize, form: &str, c: Id, p: Id) -> Got {
        self.hands[k].act(form, c, BTreeMap::from([(1, p.to_value())]))
    }

    fn leave(&mut self, k: usize, c: Id) {
        let got = self.hands[k].act("activity:leave", c, BTreeMap::new());
        self.ok(got, &format!("Soul {} leaves", k + 1));
    }

    /// `part:put` into the bay's `slot`, joined to `joins` when given.
    fn put(&mut self, k: usize, c: Id, slot: &str, joins: Option<&[Id]>) -> Got {
        let mut p = BTreeMap::from([(1, self.bay.to_value()), (2, Value::Uint(self.slots[slot]))]);
        if let Some(j) = joins {
            p.insert(4, Value::Array(j.iter().map(|i| i.to_value()).collect()));
        }
        self.hands[k].act("part:put", c, p)
    }

    /// Souls `a` and `b` at the ends of a part lying or seated at `dz` from the bay's middle, each `dx` from it along
    /// x, as a crew.
    fn crew_at(&mut self, (a, b): (usize, usize), (dx, dz): (i64, i64), what: &str) -> Id {
        self.walk(&[(a, Bay::at(-dx, dz)), (b, Bay::at(dx, dz))], what);
        self.crew(a, &[b])
    }

    /// The frame as #5258's test builds it: each frame taken where it stands and put in its slot, one of its crew
    /// staying to hold it; the four beams seated (the 0.5 m ones from where they lie, the 1.8 m ones carried in from
    /// 1 m outside); the holders let go, and the frames stand on two levels of beams. Souls 1 to 4.
    fn frame(&mut self) {
        let mut holds = Vec::new();
        for (k, (dz, holder, slot)) in [(-1_448, 1, "upright_a"), (1_448, 2, "upright_b")]
            .into_iter()
            .enumerate()
        {
            self.walk(
                &[(0, Bay::at(1_060, dz)), (holder, Bay::at(-1_060, dz))],
                "beside a frame's edges",
            );
            let hold = self.crew(0, &[holder]);
            let got = self.act(0, "part:take", hold, self.frames[k]);
            self.ok(got, "a 12 ft frame taken");
            let got = self.put(0, hold, slot, None);
            self.ok(got, slot);
            self.leave(0, hold);
            holds.push((holder, hold));
        }
        let mut crew = None;
        for (beam, (dx, from, slot)) in [
            (self.low[0], (-1_072, -1_072, "beam_low_l")),
            (self.low[1], (1_072, 1_072, "beam_low_r")),
            (self.high[0], (-1_072, -1_572, "beam_high_l")),
            (self.high[1], (1_072, 1_572, "beam_high_r")),
        ] {
            self.walk(
                &[(0, Bay::at(from, -1_547)), (3, Bay::at(from, 1_547))],
                "Souls 1 and 4 to a beam's ends",
            );
            let c = match crew {
                Some(c) => c,
                None => self.crew(0, &[3]),
            };
            crew = Some(c);
            let got = self.act(0, "part:take", c, beam);
            self.ok(got, "a beam taken");
            if from != dx {
                self.walk(
                    &[(0, Bay::at(dx, -1_547)), (3, Bay::at(dx, 1_547))],
                    "the beam carried to 0.5 m outside its slot",
                );
            }
            let got = self.put(0, c, slot, None);
            self.ok(got, slot);
            assert_eq!(joints_at(&self.w, beam), 2, "{slot} joins both frames");
        }
        for (holder, hold) in holds {
            self.leave(holder, hold);
        }
        let c = crew.unwrap();
        self.leave(0, c);
        self.leave(3, c);
    }

    /// The deck: each 2x4 seated across the two 1.8 m beams by Souls 3 and 4 from where it lies, then each sheet by
    /// Souls 1 and 2 from where it lies, on its two 2x4s (`s1` on `j2` and `j3`, `s2` on `j3` and `j4`).
    fn deck(&mut self) {
        let high = self.high;
        for (k, (j, slot)) in self.joists.into_iter().zip(["j2", "j3", "j4"]).enumerate() {
            let c = self.crew_at(
                (2, 3),
                (1_082, JOISTS_Z[k]),
                "Souls 3 and 4 to a 2x4's ends",
            );
            let got = self.act(2, "part:take", c, j);
            self.ok(got, "a 2x4 taken");
            let got = self.put(2, c, slot, Some(&high));
            self.ok(got, slot);
            assert_eq!(joints_at(&self.w, j), 2, "{slot} rests on both 1.8 m beams");
            self.leave(2, c);
            self.leave(3, c);
        }
        let [j2, j3, j4] = self.joists;
        for (k, (slot, on)) in [("s1", [j2, j3]), ("s2", [j3, j4])].into_iter().enumerate() {
            let sz = SHEETS_Z[k];
            self.walk(
                &[(0, Bay::at(-1_264, sz)), (1, Bay::at(1_264, sz))],
                "Souls 1 and 2 to a sheet's ends",
            );
            let c = self.crew(0, &[1]);
            let got = self.act(0, "part:take", c, self.sheets[k]);
            self.ok(got, "a sheet taken");
            let got = self.put(0, c, slot, Some(&on));
            self.ok(got, slot);
            assert_eq!(
                joints_at(&self.w, self.sheets[k]),
                2,
                "{slot}: its two joints"
            );
            self.leave(0, c);
            self.leave(1, c);
        }
    }
}

// --- The take-down. -------------------------------------------------------------------------------------------------

/// How many Souls the take-down serves: two holders a frame, a crew of two, and a seventh who walks onto the bay.
const SOULS: u64 = 7;

/// The low beams' and high beams' piles, mm from the bay's middle along x (where they lay: the low ones on their slots'
/// line, the high ones 0.5 m further out); a beam's carriers stand at its ends, `BEAM_END` along z.
const LOW_X: [i64; 2] = [-1_072, 1_072];
const HIGH_X: [i64; 2] = [-1_572, 1_572];
const BEAM_END: i64 = 1_547;
/// The frames' places along z, mm from the bay's middle.
const FRAME_Z: [i64; 2] = [-1_448, 1_448];
/// Where a holder stands beside a frame, along its own x (the client's `carry grip <frame> left|right`, 1.2 m).
const BESIDE: i64 = 1_200;
/// Where a frame's footer and lifter stand to lower it (the client's `carry grip <frame> foot|top`): beside its base,
/// half its width (1.219 m) and 0.42 m beyond each post's outer face.
const LOWER_SIDE: i64 = 1_030;
/// How far out from the bay the flight's carriers stand to unseat it, mm (`carry grip ... --out 0.9`).
const FLIGHT_OUT: i64 = 900;

impl Bay {
    /// The bay as `deck.rs`'s deck test builds it, the flight set in its slot, then everyone standing clear.
    fn built(tag: &str) -> Bay {
        let mut k = Bay::serve(tag, SOULS);
        k.frame();
        k.deck();
        let (fx, fz) = (STAIR_AT[0] - FLIGHT_OFF, STAIR_AT[1]);
        k.walk(
            &[(0, Bay::at(fx - 1_350, fz)), (1, Bay::at(fx + 1_350, fz))],
            "Souls 1 and 2 to the flight's ends",
        );
        let c = k.crew(0, &[1]);
        let got = k.act(0, "part:take", c, k.flight);
        k.ok(got, "Souls 1 and 2 take the flight");
        let got = k.put(0, c, "stair", Some(&[k.joists[0]]));
        k.ok(got, "the flight in the stair slot, hooked onto j2");
        k.leave(0, c);
        k.leave(1, c);
        k.clear(&[0, 1, 2, 3, 4, 5, 6]);
        k
    }

    /// Souls `who` walk clear of the bay, each to its own place: north-west of it (the flight, seated or let go, lies
    /// along its south-west side and walls off the west ends of the sheets and 2x4s from the south: Soul 1 stopped
    /// 714 mm short of sheet 2's west end), Soul 7 south-west, by the ladder it climbs.
    fn clear(&mut self, who: &[usize]) {
        let to: Vec<(usize, Vec3)> = who
            .iter()
            .map(|s| {
                let z = if *s == 6 { -4_000 } else { 4_000 };
                (*s, Bay::at(-3_000 - 700 * *s as i64, z))
            })
            .collect();
        self.walk(&to, "standing clear");
    }

    /// Crew `c` (`a` and `b`, standing at the part's ends) unseats `part`, then lets go: it comes down where they stand.
    fn unseat_and_let_go(&mut self, (a, b): (usize, usize), c: Id, part: Id, what: &str) {
        let got = self.act(a, "part:unseat", c, part);
        self.ok(got, &format!("{what} unseated"));
        assert_eq!(where_is(&self.w, part).0, Some(c), "{what} rides its crew");
        self.leave(a, c);
        self.leave(b, c);
        assert_eq!(
            where_is(&self.w, part).0,
            Some(self.w.ground),
            "{what} let go of, on the ground"
        );
    }

    /// Stage 1: the flight unseated by Souls 1 and 2 at its seated ends, 0.9 m out from the bay as the client's
    /// `carry grip <flight> back|front --out 0.9` puts them (on its line its west end is on its own stair: stopped
    /// 674 mm short), carried 0.8 m west to where it stood, let go.
    fn flight_off(&mut self) {
        let (sx, sz) = (STAIR_AT[0], STAIR_AT[1] - FLIGHT_OUT);
        self.walk(
            &[(0, Bay::at(sx - 1_350, sz)), (1, Bay::at(sx + 1_350, sz))],
            "Souls 1 and 2 at the seated flight's ends",
        );
        let c = self.crew(0, &[1]);
        let got = self.act(0, "part:unseat", c, self.flight);
        self.ok(got, "the flight unseated");
        assert_eq!(
            where_is(&self.w, self.flight).0,
            Some(c),
            "the flight rides its crew"
        );
        let fx = sx - FLIGHT_OFF;
        self.walk(
            &[(0, Bay::at(fx - 1_350, sz)), (1, Bay::at(fx + 1_350, sz))],
            "the flight carried to where it stood",
        );
        self.leave(0, c);
        self.leave(1, c);
        assert_eq!(
            where_is(&self.w, self.flight).0,
            Some(self.w.ground),
            "the flight on the ground"
        );
        let (_, _, at) = where_is(&self.w, self.flight);
        let o = Bay::at(0, 0);
        println!(
            "the flight let go at {} mm, {} mm from the bay's middle",
            (at.x - o.x) / 1000,
            (at.z - o.z) / 1000
        );
        self.clear(&[0, 1]);
    }

    /// Stage 2: each sheet unseated (lifted off its 2x4s) by Souls 1 and 2 at its ends and let go onto its pile, the
    /// ground under its slot where it lay.
    fn sheets_off(&mut self) {
        for k in [1, 0] {
            let c = self.crew_at(
                (0, 1),
                (1_264, SHEETS_Z[k]),
                "Souls 1 and 2 to a sheet's ends",
            );
            self.unseat_and_let_go((0, 1), c, self.sheets[k], &format!("sheet {}", k + 1));
        }
        self.clear(&[0, 1]);
    }

    /// Stage 3: each 2x4 unseated by Souls 3 and 4 at its ends and let go onto its pile under its slot.
    fn joists_off(&mut self) {
        for k in [2, 1, 0] {
            let c = self.crew_at(
                (2, 3),
                (1_082, JOISTS_Z[k]),
                "Souls 3 and 4 to a 2x4's ends",
            );
            self.unseat_and_let_go((2, 3), c, self.joists[k], &format!("2x4 j{}", k + 2));
        }
        self.clear(&[2, 3]);
    }

    /// Two holders for frame `f`: Souls `a` and `b` beside it along its own x, outside the bay, a crew offered on the
    /// frame (`carry offer <b> --on <frame>`, `carry accept`).
    fn holders(&mut self, f: usize, (a, b): (usize, usize)) -> Id {
        let z = FRAME_Z[f];
        self.walk(
            &[(a, Bay::at(-BESIDE, z)), (b, Bay::at(BESIDE, z))],
            "two holders beside a frame",
        );
        let got = self.hands[a].act(
            "activity:offer",
            self.frames[f],
            BTreeMap::from([
                (1, pinned_activity(&self.w, "mars:carry_activity")),
                (2, Value::Text(Name::new("mars:front").unwrap())),
                (
                    3,
                    Value::Array(vec![body_of(&self.w, self.w.souls[b]).to_value()]),
                ),
            ]),
        );
        let entries = got.entries.clone();
        self.ok(got, "a holder's crew offered on the frame");
        let made = created_by(&self.w, &entries, "mars:carry_activity@");
        let got = self.hands[b].act("activity:accept", made, BTreeMap::new());
        self.ok(got, "the other holder accepts");
        made
    }

    /// Stage 4, first half: Souls 3 and 4 hold frame 1, Souls 5 and 6 frame 2. Returns the two crews.
    fn hold_frames(&mut self) -> [Id; 2] {
        [self.holders(0, (2, 3)), self.holders(1, (4, 5))]
    }

    /// Stage 4, second half, and stage 5: the high beams (or the low ones) unseated by Souls 1 and 2 at their ends,
    /// standing on the beam's pile line, and let go there.
    fn beams_off(&mut self, high: bool) {
        let (beams, xs) = match high {
            true => (self.high, HIGH_X),
            false => (self.low, LOW_X),
        };
        for k in 0..2 {
            self.walk(
                &[
                    (0, Bay::at(xs[k], -BEAM_END)),
                    (1, Bay::at(xs[k], BEAM_END)),
                ],
                "Souls 1 and 2 to a beam's ends",
            );
            let c = self.crew(0, &[1]);
            self.unseat_and_let_go((0, 1), c, beams[k], &format!("beam {k} (high {high})"));
        }
        self.clear(&[0, 1]);
    }

    /// Stage 6: each frame lowered out of its slot by its holders (the asker its lifter, beside its base), laid down,
    /// then its holders let go.
    fn frames_down(&mut self, crews: [Id; 2]) {
        for (f, (c, (a, b))) in crews.into_iter().zip([(2, 3), (4, 5)]).enumerate() {
            let z = FRAME_Z[f];
            self.walk(
                &[(a, Bay::at(LOWER_SIDE, z)), (b, Bay::at(-LOWER_SIDE, z))],
                "a frame's lifter and footer beside its base",
            );
            let got = self.act(a, "part:lower", c, self.frames[f]);
            self.ok(got, &format!("frame {} lowered", f + 1));
            // The lowering is a track; the part lies at its end and its crew can let go.
            std::thread::sleep(Duration::from_secs(8));
            self.leave(a, c);
            self.leave(b, c);
            assert_eq!(
                where_is(&self.w, self.frames[f]).0,
                Some(self.w.ground),
                "frame {} lies on the ground",
                f + 1
            );
        }
    }

    /// Every stage before `stage`; the sheets come off before the flight (nothing rests on the flight).
    fn down_to(tag: &str, stage: u32) -> (Bay, Option<[Id; 2]>) {
        let mut k = Bay::built(tag);
        let mut crews = None;
        if stage > 2 {
            k.sheets_off();
            k.flight_off();
        }
        if stage > 3 {
            k.joists_off();
        }
        if stage > 4 {
            crews = Some(k.hold_frames());
            k.beams_off(true);
        }
        if stage > 5 {
            k.beams_off(false);
        }
        if stage > 6 {
            k.frames_down(crews.unwrap());
        }
        (k, crews)
    }
}

#[test]
fn teardown_1_the_stair_flight_unseated_and_carried_away() {
    let (mut k, _) = Bay::down_to("td1", 1);
    k.flight_off();
}

/// Gap: a sheet's west end, 1.26 m out from the bay's middle on its line, where the build's crew stood to seat it,
/// cannot be reached from clear of the bay (from the north-west, the flight seated or let go; from the south-west the
/// same): `walk.stopped-short`: "stopped 700 mm short of the point it was sent to: no way nearer it that this body can
/// walk (ground it cannot stand on, or bodies in the way)". The deck test reaches it only from the 2x4s' ends beside
/// it, during the build.
#[test]
#[ignore = "gap: a sheet's west end cannot be reached from clear of the bay"]
fn gap_2_a_sheets_west_end_cannot_be_reached_from_clear_of_the_bay() {
    let (mut k, _) = Bay::down_to("td2", 2);
    k.sheets_off();
    assert_eq!(
        joints_at(&k.w, k.joists[1]),
        2,
        "j3 on its two beams, nothing on it"
    );
}

#[test]
#[ignore = "waits on gap 2: its setup takes the sheets off"]
fn teardown_3_each_two_by_four_unseated_and_carried_away() {
    let (mut k, _) = Bay::down_to("td3", 3);
    k.joists_off();
}

#[test]
#[ignore = "waits on gap 2: its setup takes the sheets off"]
fn teardown_4_holders_take_each_frame_then_the_high_beams_come_out() {
    let (mut k, _) = Bay::down_to("td4", 4);
    k.hold_frames();
    k.beams_off(true);
}

#[test]
#[ignore = "waits on gap 2: its setup takes the sheets off"]
fn teardown_5_the_low_beams_come_out_while_the_frames_are_held() {
    let (mut k, _) = Bay::down_to("td5", 5);
    k.beams_off(false);
}

/// Gap: `part lower` is refused for the deck frame, so no frame comes out of its slot and down:
/// `raise.no-foot`: "10:55 names no foot to turn about" (`test_deck_frame` has no `foot` point, which
/// `sim::activity::carry::raise::Spec::of` needs). The text is from frame 1's lowering under a Soul on its standing
/// place, where it is refused before anything else is judged; this test's own setup waits on gap 2.
#[test]
#[ignore = "gap: part lower is refused raise.no-foot for the deck frame"]
fn gap_6_part_lower_is_refused_the_deck_frame_names_no_foot() {
    let (mut k, crews) = Bay::down_to("td6", 6);
    k.frames_down(crews.unwrap());
}

/// Stage 7: everything lies on its pile: each part on the ground within 1 m of where it lay or stood before the build
/// (a frame by its foot, where it stood).
/// Gap: waits on gap 6 (no frame can be lowered and laid down).
#[test]
#[ignore = "gap: waits on gap 6, the frames cannot be lowered"]
fn gap_7_everything_back_at_its_pile_waits_on_the_frames_being_laid_down() {
    let (k, _) = Bay::down_to("td7", 7);
    let piles: Vec<(Id, [i64; 2])> = [
        (k.flight, [STAIR_AT[0] - FLIGHT_OFF, STAIR_AT[1]]),
        (k.sheets[0], [0, SHEETS_Z[0]]),
        (k.sheets[1], [0, SHEETS_Z[1]]),
        (k.joists[0], [0, JOISTS_Z[0]]),
        (k.joists[1], [0, JOISTS_Z[1]]),
        (k.joists[2], [0, JOISTS_Z[2]]),
        (k.high[0], [HIGH_X[0], 0]),
        (k.high[1], [HIGH_X[1], 0]),
        (k.low[0], [LOW_X[0], 0]),
        (k.low[1], [LOW_X[1], 0]),
        (k.frames[0], [0, FRAME_Z[0]]),
        (k.frames[1], [0, FRAME_Z[1]]),
    ]
    .into();
    for (part, [dx, dz]) in piles {
        let (parent, _, at) = where_is(&k.w, part);
        let pile = Bay::at(dx, dz);
        let off = (i128::from(at.x - pile.x).pow(2) + i128::from(at.z - pile.z).pow(2)).isqrt();
        println!(
            "{} on {parent:?}, {} mm from its pile",
            show(part),
            off / 1000
        );
        assert_eq!(parent, Some(k.w.ground), "{} on the ground", show(part));
        assert!(
            off < 1_000_000,
            "{} within 1 m of its pile: {} mm",
            show(part),
            off / 1000
        );
    }
}

// --- Wrong orders. --------------------------------------------------------------------------------------------------

/// A 2x4 under a sheet stays: unseating j4 under sheet 2 is refused `support.none`, naming the sheet.
#[test]
fn teardown_wrong_a_two_by_four_under_a_sheet_is_refused_naming_the_sheet() {
    let mut k = Bay::built("tdw1");
    let c = k.crew_at(
        (2, 3),
        (1_082, JOISTS_Z[2]),
        "Souls 3 and 4 under j4's ends",
    );
    let got = k.act(2, "part:unseat", c, k.joists[2]);
    refused_as(&got, "support.none", "j4 out from under sheet 2");
    assert!(
        got.detail.contains(&show(k.sheets[1])),
        "names sheet 2 {}: {got:?}",
        show(k.sheets[1])
    );
    assert_eq!(
        where_is(&k.w, k.joists[2]).0,
        Some(k.bay),
        "j4 where it was"
    );
}

/// Gap: Soul 7 walks up the flight onto sheet 1; frame 1 taken out of its slot meanwhile is refused, but by the beam
/// it would leave hanging, not by the Soul on the deck: `support.none`: "10:75 would hang by its joint to 10:65; it
/// needs 2 joined to parts that stand" (the brief's `part.stood-on` is checked after support). Its lowering is gap 6.
#[test]
#[ignore = "gap: refused support.none before part.stood-on"]
fn gap_a_frame_under_a_soul_on_the_deck_is_refused_support_none_not_part_stood_on() {
    let mut k = Bay::built("tdw2");
    k.walk(
        &[(6, Bay::at(-4_500, STAIR_AT[1]))],
        "Soul 7 to the flight's foot",
    );
    let walker = body_of(&k.w, k.w.souls[6]);
    let to = BTreeMap::from([(1, Value::Array(vec![int(400_000), int(19_000), int(0)]))]);
    k.hands[6].send("eden:walk", k.decks[0], to);
    let got = socket_end(&mut k.hands[6].s);
    k.ok(got, "Soul 7 up onto sheet 1");
    assert_eq!(body_on(&k.w, walker).0, k.decks[0], "on sheet 1's top");
    let c = k.crew_at(
        (0, 1),
        (1_060, FRAME_Z[0]),
        "Souls 1 and 2 beside frame 1's edges",
    );
    let got = k.act(0, "part:unseat", c, k.frames[0]);
    refused_as(
        &got,
        "part.stood-on",
        "frame 1 taken out with Soul 7 on the deck",
    );
    assert!(
        got.detail.contains(&show(walker)),
        "names the body: {got:?}"
    );
    let got = k.act(0, "part:lower", c, k.frames[0]);
    refused_as(
        &got,
        "part.stood-on",
        "frame 1 lowered with Soul 7 on the deck",
    );
    assert!(
        got.detail.contains(&show(walker)),
        "names the body: {got:?}"
    );
    assert_eq!(where_is(&k.w, k.frames[0]).0, Some(k.bay), "frame 1 stays");
}

/// Soul 7 climbs frame 1's ladder to its outer 1.8 m standing place; frame 1 taken out meanwhile is refused
/// `part.stood-on`, naming the body.
#[test]
fn teardown_wrong_a_frame_under_a_soul_on_its_standing_place_is_refused_stood_on() {
    let mut k = Bay::built("tdw3");
    let perch = k.places[0][0];
    k.walk(&[(6, Bay::at(0, -3_900))], "Soul 7 to the ladder's foot");
    let walker = body_of(&k.w, k.w.souls[6]);
    let to = BTreeMap::from([(1, Value::Array(vec![int(0), int(1_800_000), int(-488_000)]))]);
    k.hands[6].send("eden:walk", perch, to);
    let got = socket_end(&mut k.hands[6].s);
    k.ok(got, "Soul 7 climbs to frame 1's standing place");
    assert_eq!(body_on(&k.w, walker).0, perch, "on the standing place");
    let c = k.crew_at(
        (0, 1),
        (1_060, FRAME_Z[0]),
        "Souls 1 and 2 beside frame 1's edges",
    );
    let got = k.act(0, "part:unseat", c, k.frames[0]);
    refused_as(&got, "part.stood-on", "frame 1 taken out with Soul 7 on it");
    assert!(
        got.detail.contains(&show(walker)),
        "names the body: {got:?}"
    );
    // Its lowering is refused `raise.no-foot` before anything else is judged: gap 6.
    assert_eq!(where_is(&k.w, k.frames[0]).0, Some(k.bay), "frame 1 stays");
}

/// With every beam out, a holder of frame 1 letting go is refused `support.holders`, and both still hold it.
#[test]
#[ignore = "waits on gap 2: its setup takes the sheets off"]
fn teardown_wrong_a_holder_letting_go_of_an_unbraced_frame_is_refused() {
    let (mut k, crews) = Bay::down_to("tdw4", 6);
    let c = crews.unwrap()[0];
    let got = k.hands[2].act("activity:leave", c, BTreeMap::new());
    refused_as(
        &got,
        "support.holders",
        "a holder lets go of unbraced frame 1",
    );
    assert_eq!(
        where_is(&k.w, k.frames[0]).0,
        Some(k.bay),
        "frame 1 still in its slot"
    );
    // A refused leave changes nothing: the crew's last word of who holds it still names both.
    std::thread::sleep(Duration::from_millis(500));
    let (a, b) = (body_of(&k.w, k.w.souls[2]), body_of(&k.w, k.w.souls[3]));
    let last = grips_said(&k.w, c, |_, _| true);
    assert_eq!(
        last,
        ("souls:held".to_owned(), vec![a, b]),
        "both still hold frame 1"
    );
}

// --- Take-down without the deck, on the scripted build's own kinds (N5, 28 Nov). ---------------------------------------
//
// The bay `deck_kinds.rs` builds (`content/kinds/construction/`: two 12 ft frames, four 9 ft deck beams, five 2x4s)
// and its stances: each frame put in its slot by two who stay to hold it, the beams seated by a crew of two at their
// ends, the holders let go, each 2x4 seated across the 1.8 m beams by a crew at its ends from where it lies. Then it is
// taken down by the same Souls' ordinary intents, in reverse, with the wrong orders refused by name on the way. A
// part's pile is where it lay before the build (a frame by its foot, where it stood): the 2x4s under their slots, the
// 0.5 m beams 0.5 m outside their columns, the 1.8 m beams 1 m outside.

/// The 2x4 slots `j1` to `j5`'s places along the bay, mm from its middle (`deck_bay.json`).
const KJ_Z: [i64; 5] = [-1_172, -572, -2, 578, 1_178];
/// The deck beams' slots (on their frames' posts) and their piles, mm from the bay's middle along x.
const KBEAM: [(&str, i64, i64); 4] = [
    ("beam_low_l", -1_072, -1_072),
    ("beam_low_r", 1_072, 1_072),
    ("beam_high_l", -1_072, -1_572),
    ("beam_high_r", 1_072, 1_572),
];
/// Where a beam's carriers stand along z, at its ends outside the frames.
const KBEAM_END: i64 = 1_547;
/// Where a frame's holders stand beside its edges, mm along x from the bay's middle (`deck_kinds.rs`'s stance).
const KBESIDE: i64 = 1_060;

/// N2's test world with the deck bay's parts at its site, as `deck_kinds.rs` lays them, without the sheets: the bay
/// at the site's centre, its two 12 ft frames standing loose on their slots' places, its four beams lying outside
/// their columns (the low ones 0.5 m out, the high ones 1 m), and a 2x4 lying on the ground under each of its five
/// slots. Returns the facts and the bay's slot numbers, by name.
fn kinds_world(d: &Path) -> (String, BTreeMap<String, u64>) {
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
    ];
    let (x, z) = (testworld::SITE_X, testworld::YARD_Z);
    let mut things: Vec<(String, usize, [i64; 4])> = vec![
        ("deck-bay".into(), 0, [x, 0, z, 0]),
        ("deck-frame-1".into(), 1, [x, 0, z - 1_448, 0]),
        ("deck-frame-2".into(), 1, [x, 0, z + 1_448, 0]),
    ];
    for (slot, _, pile) in KBEAM {
        things.push((slot.replace('_', "-"), 2, [x + pile, 0, z, 0]));
    }
    for (k, jz) in KJ_Z.iter().enumerate() {
        things.push((format!("two-by-four-{}", k + 1), 3, [x, 0, z + jz, 0]));
    }
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
                for (id, r, pose) in &things {
                    let mut t = vec![
                        ("id".into(), json::Value::s(id)),
                        ("def".into(), json::Value::s(refs[*r].0)),
                        ("ref".into(), json::Value::s(refs[*r].0)),
                        ("parent".into(), json::Value::Null),
                        ("pose".into(), ints(pose)),
                        ("scale_ppm".into(), num(1_000_000)),
                        ("name".into(), json::Value::s(id)),
                    ];
                    if *r == 0 {
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

/// The kinds' bay served, six Souls each on its own connection, and its parts by name.
struct Kinds {
    w: Seeded,
    _s: Served,
    hands: Vec<Hand>,
    slots: BTreeMap<String, u64>,
    nodes: BTreeMap<String, Id>,
}

impl Kinds {
    fn serve(tag: &str) -> Kinds {
        let d = scratch(tag);
        let (facts, slots) = kinds_world(&d);
        let (x, z) = (testworld::SITE_X, testworld::YARD_Z);
        let w = seed_entries(
            &d,
            &facts,
            6,
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
        Kinds {
            w,
            _s: s,
            hands,
            slots,
            nodes,
        }
    }

    fn id(&self, name: &str) -> Id {
        self.nodes[name]
    }

    fn bay(&self) -> Id {
        self.id("deck-bay")
    }

    fn frames(&self) -> [Id; 2] {
        [self.id("deck-frame-1"), self.id("deck-frame-2")]
    }

    fn beam(&self, slot: &str) -> Id {
        self.id(&slot.replace('_', "-"))
    }

    fn joist(&self, k: usize) -> Id {
        self.id(&format!("two-by-four-{}", k + 1))
    }

    fn ok(&self, got: Got, what: &str) {
        println!("{what}: {got:?}");
        if got.kind != 1 {
            for l in self
                ._s
                .lines
                .try_iter()
                .filter(|l| l.starts_with("worldd:"))
            {
                println!("  {l}");
            }
            panic!("{what}: {got:?}");
        }
    }

    fn walk(&mut self, to: &[(usize, (i64, i64))], what: &str) {
        let to: Vec<(usize, Vec3)> = to.iter().map(|(k, (x, z))| (*k, Bay::at(*x, *z))).collect();
        walk_all(&mut self.hands, self.w.ground, &to, what);
    }

    fn crew(&mut self, a: usize, others: &[usize]) -> Id {
        crew_of_all(&self.w, &mut self.hands, a, others)
    }

    fn act(&mut self, k: usize, form: &str, c: Id, p: Id) -> Got {
        self.hands[k].act(form, c, BTreeMap::from([(1, p.to_value())]))
    }

    fn leave(&mut self, k: usize, c: Id) {
        let got = self.hands[k].act("activity:leave", c, BTreeMap::new());
        self.ok(got, &format!("Soul {} leaves", k + 1));
    }

    /// `part:put` into the bay's `slot`, joined to `joins` when given.
    fn put(&mut self, k: usize, c: Id, slot: &str, joins: &[Id]) -> Got {
        let mut p = BTreeMap::from([
            (1, self.bay().to_value()),
            (2, Value::Uint(self.slots[slot])),
        ]);
        if !joins.is_empty() {
            p.insert(
                4,
                Value::Array(joins.iter().map(|i| i.to_value()).collect()),
            );
        }
        self.hands[k].act("part:put", c, p)
    }

    /// `part:put` onto the open ground at `dx`, `dz` from the bay's middle: a carried part laid down on its pile.
    fn lay(&mut self, k: usize, c: Id, (dx, dz): (i64, i64), what: &str) {
        let p = Bay::at(dx, dz);
        let to = BTreeMap::from([
            (1, self.w.ground.to_value()),
            (3, Value::Array(vec![int(p.x), int(0), int(p.z)])),
        ]);
        let got = self.hands[k].act("part:put", c, to);
        self.ok(got, what);
    }

    /// The frame as `deck_kinds.rs` builds it: Souls 2 and 3 put frame 1 in `upright_a`, Souls 4 and 5 frame 2 in
    /// `upright_b`, each pair holding it; Souls 1 and 6 seat the four beams; the holders let go. Then each 2x4 is
    /// seated across the two 1.8 m beams by Souls 1 and 6 at its ends, from where it lies.
    fn build(&mut self) {
        let mut holds = Vec::new();
        for (f, dz, (a, b), slot) in [
            (0, -1_448, (1, 2), "upright_a"),
            (1, 1_448, (3, 4), "upright_b"),
        ] {
            self.walk(
                &[(a, (KBESIDE, dz)), (b, (-KBESIDE, dz))],
                "beside a frame's edges",
            );
            let hold = self.crew(a, &[b]);
            let got = self.act(a, "part:take", hold, self.frames()[f]);
            self.ok(got, "a 12 ft frame taken");
            let got = self.put(a, hold, slot, &[]);
            self.ok(got, slot);
            holds.push(((a, b), hold));
        }
        let mut crew = None;
        for (slot, dx, from) in KBEAM {
            self.walk(
                &[(0, (from, -KBEAM_END)), (5, (from, KBEAM_END))],
                "Souls 1 and 6 to a beam's ends",
            );
            let c = match crew {
                Some(c) => c,
                None => *crew.insert(self.crew(0, &[5])),
            };
            let beam = self.beam(slot);
            let got = self.act(0, "part:take", c, beam);
            self.ok(got, "a beam taken");
            if from != dx {
                self.walk(
                    &[(0, (dx, -KBEAM_END)), (5, (dx, KBEAM_END))],
                    "the beam carried to 0.5 m outside its slot",
                );
            }
            let got = self.put(0, c, slot, &[]);
            self.ok(got, slot);
            assert_eq!(joints_at(&self.w, beam), 2, "{slot} joins both frames");
        }
        for ((a, b), hold) in holds {
            self.leave(a, hold);
            self.leave(b, hold);
        }
        let c = crew.unwrap();
        self.leave(0, c);
        self.leave(5, c);
        let high = [self.beam("beam_high_l"), self.beam("beam_high_r")];
        for (k, dz) in KJ_Z.iter().enumerate() {
            // The back 20 mm off the front's line, as `deck_kinds.rs`'s joist crew stands.
            self.walk(
                &[(0, (-1_082, *dz)), (5, (1_082, dz + 20))],
                "Souls 1 and 6 at a 2x4's ends",
            );
            let c = self.crew(0, &[5]);
            let got = self.act(0, "part:take", c, self.joist(k));
            self.ok(got, "a 2x4 taken");
            let got = self.put(0, c, &format!("j{}", k + 1), &high);
            self.ok(got, &format!("j{} across both 1.8 m beams", k + 1));
            assert_eq!(
                joints_at(&self.w, self.joist(k)),
                2,
                "j{} rests on both 1.8 m beams",
                k + 1
            );
            self.leave(0, c);
            self.leave(5, c);
        }
    }

    /// Two holders for frame `f`, Souls `a` and `b` beside its edges outside the bay: a crew offered on the frame
    /// (`carry offer <b> --on <frame>`), accepted.
    fn holders(&mut self, f: usize, (a, b): (usize, usize)) -> Id {
        let z = FRAME_Z[f];
        self.walk(
            &[(a, (KBESIDE, z)), (b, (-KBESIDE, z))],
            "two holders beside a frame",
        );
        let (frame, activity) = (
            self.frames()[f],
            pinned_activity(&self.w, "mars:carry_activity"),
        );
        let other = body_of(&self.w, self.w.souls[b]).to_value();
        let got = self.hands[a].act(
            "activity:offer",
            frame,
            BTreeMap::from([
                (1, activity),
                (2, Value::Text(Name::new("mars:front").unwrap())),
                (3, Value::Array(vec![other])),
            ]),
        );
        let entries = got.entries.clone();
        self.ok(got, "a holders' crew offered on the frame");
        let made = created_by(&self.w, &entries, "mars:carry_activity@");
        let got = self.hands[b].act("activity:accept", made, BTreeMap::new());
        self.ok(got, "the other holder accepts");
        made
    }

    /// `part:lower` of frame `f` by its crew `c`, laid away from the bay (parameter 3, the direction on the plan).
    fn lower(&mut self, k: usize, c: Id, f: usize) -> Got {
        let out = if f == 0 { -1_000_000 } else { 1_000_000 };
        let frame = self.frames()[f];
        self.hands[k].act(
            "part:lower",
            c,
            BTreeMap::from([
                (1, frame.to_value()),
                (3, Value::Array(vec![int(0), int(0), int(out)])),
            ]),
        )
    }
}

/// The take-down without the deck (N5), on the scripted build's kinds, by six Souls' ordinary intents:
///
/// - built: two frames held by two each, four beams, the holders let go, five 2x4s across the 1.8 m beams;
/// - wrong: a 1.8 m beam out while 2x4s rest on it is refused `support.none`;
/// - (1) each 2x4 unseated by Souls 1 and 6 at its ends and laid back on its pile under its slot;
/// - (2) Souls 2 and 3 take frame 1, Souls 4 and 5 frame 2, beside its edges outside the bay;
/// - wrong: frame 1 lowered while the beams are braced by it is refused, by name;
/// - (3) the 1.8 m beams, then the 0.5 m beams, unseated by Souls 1 and 6 at their ends and carried to their piles;
/// - wrong: a holder letting go of an unbraced frame is refused `support.holders`;
/// - (4) each frame lowered out of its slot by its holders, away from the bay, laid down; its holders let go;
/// - (5) every part on the ground within 1 m of where it lay or stood before the build (a frame by its foot).
#[test]
fn teardown_without_the_deck_by_intents_and_every_part_back_on_its_pile() {
    let mut k = Kinds::serve("tdk");
    k.build();
    let (bay, g) = (k.bay(), k.w.ground);

    // Wrong: a 1.8 m beam out from under the 2x4s.
    k.walk(
        &[(0, (-1_072, -KBEAM_END)), (5, (-1_072, KBEAM_END))],
        "Souls 1 and 6 to the left 1.8 m beam's ends",
    );
    let c = k.crew(0, &[5]);
    let high_l = k.beam("beam_high_l");
    let got = k.act(0, "part:unseat", c, high_l);
    refused_as(
        &got,
        "support.none",
        "the left 1.8 m beam out from under the 2x4s",
    );
    assert_eq!(where_is(&k.w, high_l).0, Some(bay), "the beam stays seated");
    k.leave(0, c);
    k.leave(5, c);

    // (1) The 2x4s, last first, each laid back on its pile.
    for j in (0..5).rev() {
        let dz = KJ_Z[j];
        k.walk(
            &[(0, (-1_082, dz)), (5, (1_082, dz + 20))],
            "Souls 1 and 6 at a 2x4's ends",
        );
        let c = k.crew(0, &[5]);
        let got = k.act(0, "part:unseat", c, k.joist(j));
        k.ok(got, &format!("j{} unseated", j + 1));
        assert_eq!(
            where_is(&k.w, k.joist(j)).0,
            Some(c),
            "j{} rides its crew",
            j + 1
        );
        assert_eq!(joints_at(&k.w, k.joist(j)), 0, "j{}'s joints undone", j + 1);
        std::thread::sleep(Duration::from_millis(1500));
        k.lay(0, c, (0, dz), &format!("j{} laid on its pile", j + 1));
        k.leave(0, c);
        k.leave(5, c);
    }

    // (2) The holders.
    let crews = [k.holders(0, (1, 2)), k.holders(1, (3, 4))];

    // Wrong: frame 1 lowered while the four beams are braced by it.
    let got = k.lower(1, crews[0], 0);
    println!("frame 1 lowered with its beams in: {got:?}");
    assert_eq!(got.kind, 2, "refused: {got:?}");
    println!("REFUSED-AS {}: {}", got.reason, got.detail);
    assert_eq!(
        where_is(&k.w, k.frames()[0]).0,
        Some(bay),
        "frame 1 stays in its slot"
    );

    // (3) The beams, the 1.8 m ones first, each to its pile.
    for (slot, dx, pile) in [KBEAM[2], KBEAM[3], KBEAM[0], KBEAM[1]] {
        k.walk(
            &[(0, (dx, -KBEAM_END)), (5, (dx, KBEAM_END))],
            "Souls 1 and 6 to a beam's ends",
        );
        let c = k.crew(0, &[5]);
        let beam = k.beam(slot);
        let got = k.act(0, "part:unseat", c, beam);
        k.ok(got, &format!("{slot} unseated"));
        assert_eq!(where_is(&k.w, beam).0, Some(c), "{slot} rides its crew");
        if pile != dx {
            k.walk(
                &[(0, (pile, -KBEAM_END)), (5, (pile, KBEAM_END))],
                "the beam carried to its pile",
            );
        }
        std::thread::sleep(Duration::from_millis(1500));
        k.lay(0, c, (pile, 0), &format!("{slot} laid on its pile"));
        k.leave(0, c);
        k.leave(5, c);
    }

    // Wrong: a holder lets go of frame 1, braced by nothing now.
    let got = k.hands[2].act("activity:leave", crews[0], BTreeMap::new());
    refused_as(
        &got,
        "support.holders",
        "a holder lets go of unbraced frame 1",
    );
    assert_eq!(
        where_is(&k.w, k.frames()[0]).0,
        Some(bay),
        "frame 1 still in its slot"
    );

    // (4) Each frame lowered out of its slot, away from the bay, by its holders (the asker its lifter).
    for (f, (a, b)) in [(1, 2), (3, 4)].into_iter().enumerate() {
        let at = |k: &Kinds, s: usize| {
            let (p, o) = (body_at(&k.w, body_of(&k.w, k.w.souls[s])), Bay::at(0, 0));
            ((p.x - o.x) / 1000, (p.z - o.z) / 1000)
        };
        println!(
            "frame {}'s holders stand at {:?} and {:?} mm from the bay's middle; the frame at {:?}",
            f + 1,
            at(&k, a),
            at(&k, b),
            where_is(&k.w, k.frames()[f]).2
        );
        let mut got = k.lower(a, crews[f], f);
        if got.reason == "part.grip-out-of-reach" {
            println!("frame {} lowered from where they hold it: {got:?}", f + 1);
            // The raise crew's places for a standing part (the client's `carry grip <frame> top|foot`): beside its
            // base, half its width and `raise::SIDE` beyond each post, the asker on the frame's own +x.
            let z = FRAME_Z[f];
            k.walk(
                &[(a, (1_030, z)), (b, (-1_030, z))],
                "the lifter and the footer beside the frame's base",
            );
            println!("then at {:?} and {:?}", at(&k, a), at(&k, b));
            got = k.lower(a, crews[f], f);
        }
        k.ok(got, &format!("frame {} lowered", f + 1));
        let t0 = std::time::Instant::now();
        while where_is(&k.w, k.frames()[f]).0 != Some(g) {
            assert!(
                t0.elapsed() < Duration::from_secs(40),
                "frame {} laid down within 40 s",
                f + 1
            );
            std::thread::sleep(Duration::from_millis(250));
        }
        println!("frame {} lies after {} ms", f + 1, t0.elapsed().as_millis());
        for s in [a, b] {
            let got = k.hands[s].act("activity:leave", crews[f], BTreeMap::new());
            println!("Soul {} lets go of frame {}: {got:?}", s + 1, f + 1);
        }
    }

    // (5) Every part on its pile.
    let mut piles: Vec<(Id, (i64, i64))> = vec![
        (k.frames()[0], (0, FRAME_Z[0])),
        (k.frames()[1], (0, FRAME_Z[1])),
    ];
    for (slot, _, pile) in KBEAM {
        piles.push((k.beam(slot), (pile, 0)));
    }
    for (j, dz) in KJ_Z.iter().enumerate() {
        piles.push((k.joist(j), (0, *dz)));
    }
    for (part, (dx, dz)) in piles {
        let (parent, _, at) = where_is(&k.w, part);
        let pile = Bay::at(dx, dz);
        let off = (i128::from(at.x - pile.x).pow(2) + i128::from(at.z - pile.z).pow(2)).isqrt();
        println!(
            "{} on {parent:?}, {} mm from its pile",
            show(part),
            off / 1000
        );
        assert_eq!(parent, Some(g), "{} on the ground", show(part));
        assert!(
            off < 1_000_000,
            "{} within 1 m of its pile: {} mm",
            show(part),
            off / 1000
        );
        assert_eq!(crews_on(&k.w, part).0, 0, "{} held by nobody", show(part));
    }
}
