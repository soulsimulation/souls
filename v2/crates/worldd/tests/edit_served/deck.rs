//! A deck on a timber frame by intents (racks T3): support to any depth in a served world. The frame is the timber
//! shade's bents and rails; the joists, the sheet and their site are test kinds
//! (`v2/crates/sim/src/structure/fixtures/`): a joist names the rail in its joining link, the sheet names the joist.
use super::*;
use replica::world_model::show;

/// The test deck kinds' folder.
fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../sim/src/structure/fixtures")
}

/// N2's test world with a deck's parts at its build site: the site marked at the site's centre, its two bents
/// standing loose on their slots' places, its two rails lying 0.5 m outside theirs, and each joist and the sheet lying
/// on the ground under its own slot, so each crew takes a part and puts it from where it stands, no load carried.
/// The sheet holds a floor of its own, its top (racks T9: a thing's `floors`, as a building's or a boat's). A stair
/// flight stands 0.5 m beside its slot: 5 m of run from its foot up to the sheet's edge at the sheet's height, its
/// landing too small to stand on, as a roof stair's is.
/// The folder of entries: the construction kinds (the carry), the carpentry kinds, the test deck kinds and the body.
/// Returns the facts and the site's slot numbers, by name.
pub(super) fn deck_world(d: &Path) -> (String, BTreeMap<String, u64>) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let entries = d.join("entries");
    std::fs::create_dir_all(&entries).unwrap();
    for dir in [
        root.join("construction"),
        root.join("carpentry"),
        fixtures(),
    ] {
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
    // The site's slots as its entry numbers them.
    let text = std::fs::read_to_string(fixtures().join("test_deck_site.json")).unwrap();
    let kind = replica::kinds::entry::entry_to_kind(&text).unwrap();
    let mut kinds = replica::kinds::Kinds::default();
    kinds.load(&[("test_deck_site", kind.as_str())]);
    let def = kinds
        .admits()
        .into_keys()
        .find_map(|k| {
            kinds
                .get(&k)
                .filter(|d| d.name.as_str().starts_with("mars:test_deck_site@"))
        })
        .expect("the site's kind");
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
        ("testworld-deck-site@1", "mars:test_deck_site"),
        ("testworld-timber-bent@1", "mars:timber_bent"),
        ("testworld-timber-rail@1", "mars:timber_rail"),
        ("testworld-test-joist@1", "mars:test_joist"),
        ("testworld-test-sheet@1", "mars:test_sheet"),
        ("testworld-test-flight@1", "mars:test_flight"),
    ];
    let (x, z) = (testworld::SITE_X, testworld::YARD_Z);
    let things = [
        ("deck-site", 0, [x, 0, z, 0]),
        ("timber-bent-1", 1, [x, 0, z - 1_500, 0]),
        ("timber-bent-2", 1, [x, 0, z + 1_500, 0]),
        ("timber-rail-1", 2, [x - 1_350, 0, z, 0]),
        ("timber-rail-2", 2, [x + 1_350, 0, z, 0]),
        ("joist-back", 3, [x, 0, z - 900, 0]),
        ("joist-front", 3, [x, 0, z + 900, 0]),
        ("sheet", 4, [x, 0, z, 0]),
        ("flight", 5, [x + 3_500, 0, z + 500, 0]),
    ];
    let quad = |x0: i64, x1: i64, z0: i64, z1: i64| {
        json::Value::Arr(vec![
            ints(&[x0, z0]),
            ints(&[x1, z0]),
            ints(&[x1, z1]),
            ints(&[x0, z1]),
        ])
    };
    let floor = |y: i64, polygon: json::Value| {
        json::Value::Arr(vec![json::Value::Obj(vec![
            ("level".into(), num(1)),
            ("y".into(), num(y)),
            ("polygon".into(), polygon),
        ])])
    };
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
                    if r == 4 {
                        // The sheet's top, 18 mm up, in its own frame.
                        t.push(("floors".into(), floor(18, quad(-1_000, 1_000, -950, 950))));
                    }
                    if r == 5 {
                        // The flight: its landing beyond its top, and its stair from the ground up to it.
                        t.push((
                            "floors".into(),
                            floor(DECK_TOP, quad(-3_000, -2_500, -550, 550)),
                        ));
                        let stair = json::Value::Obj(vec![
                            ("id".into(), json::Value::s("deck-flight")),
                            ("kind".into(), json::Value::s("stairs")),
                            ("from".into(), num(0)),
                            ("to".into(), num(1)),
                            (
                                "path".into(),
                                json::Value::Arr(vec![ints(&[2_500, 0]), ints(&[-2_500, 0])]),
                            ),
                            ("width".into(), num(1_100)),
                            ("y0".into(), num(0)),
                            ("y1".into(), num(DECK_TOP)),
                        ]);
                        t.push(("stairs".into(), json::Value::Arr(vec![stair])));
                    }
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

/// The seated sheet's top above the ground, mm: its slot's height and its own 18 mm.
const DECK_TOP: i64 = 2_056;

/// The deck's world served, its Souls each on its own connection, and what its steps name.
pub(super) struct Deck {
    pub w: Seeded,
    /// Held for the world to keep running.
    pub _s: Served,
    pub hands: Vec<Hand>,
    pub slots: BTreeMap<String, u64>,
    pub site: Id,
    pub bents: [Id; 2],
    pub rails: [Id; 2],
    pub joists: [Id; 2],
    pub sheet: Id,
}

impl Deck {
    /// A place `dx`, `dz` mm from the site's centre, on the ground.
    pub fn at(dx: i64, dz: i64) -> Vec3 {
        v3(
            (testworld::SITE_X + dx) * 1000,
            0,
            (testworld::YARD_Z + dz) * 1000,
        )
    }

    pub fn serve(tag: &str, souls: u64) -> Deck {
        let d = scratch(tag);
        let (facts, slots) = deck_world(&d);
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
        let im = import_eden::load(&facts).unwrap();
        let hands = w.souls.iter().map(|s| Hand::new(&socket, &w, *s)).collect();
        Deck {
            site: im.nodes["deck-site"],
            bents: [im.nodes["timber-bent-1"], im.nodes["timber-bent-2"]],
            rails: [im.nodes["timber-rail-1"], im.nodes["timber-rail-2"]],
            joists: [im.nodes["joist-back"], im.nodes["joist-front"]],
            sheet: im.nodes["sheet"],
            w,
            _s: s,
            hands,
            slots,
        }
    }

    /// `got` is a receipt; else what the world said on its own output about it (why a carry stopped), and a panic.
    pub fn ok(&self, got: Got, what: &str) {
        println!("{what}: {got:?}");
        if got.kind != 1 {
            for l in self._s.lines.try_iter().filter(|l| l.starts_with("worldd:")) {
                println!("  {l}");
            }
            panic!("{what}: {got:?}");
        }
    }

    pub fn walk(&mut self, to: &[(usize, Vec3)], what: &str) {
        walk_all(&mut self.hands, self.w.ground, to, what);
    }

    pub fn crew(&mut self, a: usize, others: &[usize]) -> Id {
        crew_of_all(&self.w, &mut self.hands, a, others)
    }

    pub fn leave(&mut self, k: usize, c: Id) -> Got {
        self.hands[k].act("activity:leave", c, BTreeMap::new())
    }

    pub fn take(&mut self, k: usize, c: Id, p: Id) -> Got {
        self.hands[k].act("part:take", c, BTreeMap::from([(1, p.to_value())]))
    }

    pub fn unseat(&mut self, k: usize, c: Id, p: Id) -> Got {
        self.hands[k].act("part:unseat", c, BTreeMap::from([(1, p.to_value())]))
    }

    /// `part:put` into the site's `slot`, naming the parts it joins when `joins` is given.
    pub fn put(&mut self, k: usize, c: Id, slot: &str, joins: Option<&[Id]>) -> Got {
        let mut p = BTreeMap::from([(1, self.site.to_value()), (2, Value::Uint(self.slots[slot]))]);
        if let Some(j) = joins {
            p.insert(4, Value::Array(j.iter().map(|i| i.to_value()).collect()));
        }
        self.hands[k].act("part:put", c, p)
    }

    /// The frame as the shade's test builds it: each bent taken where it stands and put in its slot with one holding
    /// it, each rail put across both bents, then the holders let go. Souls 1 to 4.
    pub fn frame(&mut self) {
        let [ba, bb] = self.bents;
        let rails = self.rails;
        self.walk(
            &[(0, Deck::at(1_350, -1_500)), (1, Deck::at(-1_350, -1_500))],
            "Souls 1 and 2 beside bent 1's edges",
        );
        let hold_a = self.crew(0, &[1]);
        let got = self.take(0, hold_a, ba);
        self.ok(got, "bent 1 taken");
        let got = self.put(0, hold_a, "bent_a", None);
        self.ok(got, "bent 1 in bent_a");
        let got = self.leave(0, hold_a);
        self.ok(got, "Soul 1 lets go of bent 1");
        self.walk(
            &[(0, Deck::at(1_350, 1_500)), (2, Deck::at(-1_350, 1_500))],
            "Souls 1 and 3 beside bent 2's edges",
        );
        let hold_b = self.crew(0, &[2]);
        let got = self.take(0, hold_b, bb);
        self.ok(got, "bent 2 taken");
        let got = self.put(0, hold_b, "bent_b", None);
        self.ok(got, "bent 2 in bent_b");
        let got = self.leave(0, hold_b);
        self.ok(got, "Soul 1 lets go of bent 2");
        let mut rail = None;
        for (k, (dx, slot)) in [(-1_350, "rail_l"), (1_350, "rail_r")]
            .into_iter()
            .enumerate()
        {
            self.walk(
                &[(0, Deck::at(dx, -1_750)), (3, Deck::at(dx, 1_750))],
                "Souls 1 and 4 to a rail's ends",
            );
            let c = match rail {
                Some(c) => c,
                None => self.crew(0, &[3]),
            };
            rail = Some(c);
            let got = self.take(0, c, rails[k]);
        self.ok(got, "a rail taken");
            let got = self.put(0, c, slot, None);
        self.ok(got, slot);
            assert_eq!(joints_at(&self.w, rails[k]), 2, "{slot} joins both bents");
        }
        let got = self.leave(1, hold_a);
        self.ok(got, "bent 1's holder lets go");
        let got = self.leave(2, hold_b);
        self.ok(got, "bent 2's holder lets go");
        let rail = rail.unwrap();
        let got = self.leave(0, rail);
        self.ok(got, "Soul 1 leaves the rail crew");
        let got = self.leave(3, rail);
        self.ok(got, "Soul 4 leaves the rail crew");
    }

    /// Souls `a` and `b` walk to the ends of the part lying or seated `dz` mm from the site's middle, its length
    /// across the site (each `dx` mm from the middle, 350 mm beyond its grip), and form a crew.
    pub fn crew_at(&mut self, (a, b): (usize, usize), (dx, dz): (i64, i64), what: &str) -> Id {
        self.walk(&[(a, Deck::at(dx, dz)), (b, Deck::at(-dx, dz))], what);
        self.crew(a, &[b])
    }
}

/// Each Soul named walks to its place, all at once; every walk ends there.
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

pub(super) fn done(got: Got, what: &str) {
    println!("{what}: {got:?}");
    assert_eq!(got.kind, 1, "{what}");
}

/// Where the sheet's carriers stand from the site's middle, mm: each 350 mm beyond its grip.
const SHEET_ENDS: (i64, i64) = (1_300, 0);

pub(super) fn refused_as(got: &Got, name: &str, what: &str) {
    println!("{what}: {got:?}");
    assert_eq!((got.kind, got.reason.as_str()), (2, name), "{what}");
}

/// Racks T3, in a served world by Souls' intents, each on its own connection:
///
/// - the frame stands (two bents, a rail on each side: the shade's);
/// - the sheet put before any joist is in is refused `support.none` and stays in its crew's hands;
/// - two take each joist and put it across both rails, naming no joins: it rests on the two rails;
/// - the sheet put on one joist is refused `support.none`; put on both it is in, its two joints one to each joist;
/// - a crew unseating a joist under the sheet is refused `support.none`, the refusal naming the sheet, the joist
///   where it was;
/// - a crew takes the sheet off and sets it down; the joist then comes out.
#[test]
fn deck_joists_on_rails_take_a_sheet_and_a_joist_under_it_stays_until_the_sheet_is_off() {
    let mut k = Deck::serve("deck", 4);
    k.frame();
    let g = k.w.ground;
    let (site, sheet) = (k.site, k.sheet);
    let [jb, jf] = k.joists;
    let slot_of = |k: &Deck, name: &str| (Some(site), Some(k.slots[name]));

    // The sheet first: nothing to rest on.
    let c = k.crew_at((0, 1), SHEET_ENDS, "Souls 1 and 2 to the sheet's ends");
    done(k.take(0, c, sheet), "Souls 1 and 2 take the sheet");
    let got = k.put(0, c, "sheet", Some(&[]));
    refused_as(&got, "support.none", "the sheet before any joist");
    assert!(got.detail.contains("would rest on nothing"), "{got:?}");
    assert_eq!(where_is(&k.w, sheet).0, Some(c), "the sheet stays held");
    done(k.leave(0, c), "Soul 1 lets go: the sheet is set down");
    done(k.leave(1, c), "Soul 2 leaves");
    assert_eq!(where_is(&k.w, sheet).0, Some(g), "the sheet on the ground");

    // The joists, each across both rails by default.
    for (j, slot, dz) in [(jb, "joist_back", -900), (jf, "joist_front", 900)] {
        let c = k.crew_at((2, 3), (1_250, dz), "Souls 3 and 4 to a joist's ends");
        done(k.take(2, c, j), "a joist taken");
        done(k.put(2, c, slot, None), slot);
        let (parent, in_slot, _) = where_is(&k.w, j);
        assert_eq!(
            (parent, in_slot),
            slot_of(&k, slot),
            "{slot}: the joist in it"
        );
        assert_eq!(joints_at(&k.w, j), 2, "{slot} rests on both rails");
        done(k.leave(2, c), "Soul 3 leaves");
        done(k.leave(3, c), "Soul 4 leaves");
    }

    // The sheet: on one joist refused, on both in.
    let c = k.crew_at((0, 1), SHEET_ENDS, "Souls 1 and 2 to the sheet's ends");
    done(k.take(0, c, sheet), "Souls 1 and 2 take the sheet");
    let got = k.put(0, c, "sheet", Some(&[jb]));
    refused_as(&got, "support.none", "the sheet on one joist");
    done(
        k.put(0, c, "sheet", Some(&[jb, jf])),
        "the sheet on both joists",
    );
    let (parent, in_slot, _) = where_is(&k.w, sheet);
    assert_eq!(
        (parent, in_slot),
        slot_of(&k, "sheet"),
        "the sheet in its slot"
    );
    assert_eq!(joints_at(&k.w, sheet), 2, "the sheet's joints");
    assert_eq!(joints_at(&k.w, jb), 3, "two rails under, the sheet over");
    done(k.leave(0, c), "Soul 1 leaves");
    done(k.leave(1, c), "Soul 2 leaves");

    // A joist under the sheet stays.
    let under = k.crew_at(
        (2, 3),
        (1_250, -900),
        "Souls 3 and 4 under the back joist's ends",
    );
    let got = k.unseat(2, under, jb);
    refused_as(&got, "support.none", "the back joist out from under the sheet");
    let named = show(sheet);
    assert!(
        got.detail.contains(&named) && got.detail.contains("would rest on"),
        "the refusal names the sheet {named}: {got:?}"
    );
    let (parent, in_slot, _) = where_is(&k.w, jb);
    assert_eq!(
        (parent, in_slot),
        slot_of(&k, "joist_back"),
        "the joist where it was"
    );
    assert_eq!(joints_at(&k.w, jb), 3, "its joints as they were");

    // The sheet off frees it.
    let c = k.crew_at((0, 1), SHEET_ENDS, "Souls 1 and 2 under the sheet's ends");
    done(k.unseat(0, c, sheet), "Souls 1 and 2 take the sheet off");
    assert_eq!(where_is(&k.w, sheet).0, Some(c), "the sheet rides its crew");
    done(
        k.unseat(2, under, jb),
        "the back joist out, nothing resting on it",
    );
    assert_eq!(
        where_is(&k.w, jb).0,
        Some(under),
        "the joist rides its crew"
    );
    assert_eq!(joints_at(&k.w, jb), 0, "its joints undone");
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

/// Every row of body `body` in the log, in order: the node it was on and its place there.
fn body_rows(w: &Seeded, body: Id) -> Vec<(Id, Vec3)> {
    let mut out = Vec::new();
    for p in logged(w) {
        if let Some(Value::Array(rows)) = p.rest.get(&answers::BODIES) {
            for (b, pose, _) in rows.iter().filter_map(worldd::bodies::read_row) {
                if b == body {
                    out.push((pose.frame.node, pose.position));
                }
            }
        }
    }
    out
}

// --- The deck bay (racks T9, the brief's task 3): the scripted build's bay at #5258's sizes, in test kinds. ----------

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
    /// The import's rules and the world's root, for a town built afresh from the served tree (a check).
    rules: replica::tree::Rules,
    root: Id,
}

impl Bay {
    fn at(dx: i64, dz: i64) -> Vec3 {
        Deck::at(dx, dz)
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
            rules: im.rules.clone(),
            root: n("world"),
            w,
            _s: s,
            hands,
            slots,
        }
    }

    /// Where a body would stand at `p` on `node` on a town built afresh from the served world's tree (a check that
    /// the world's own ground, kept up as parts move, agrees).
    fn fresh(&self, node: Id, p: Vec3) -> Option<Vec3> {
        let (copy, _) = served_copy(&self.w);
        let tree = copy.tree().frozen();
        let header = import_eden::header(self.root, &self.rules).unwrap();
        let next = tree.to_state().next;
        let mut town = sim::walk::town::Town::new_on(
            tree,
            self.w.ground,
            sim::links::Doors::new(header, self.rules.clone(), next),
            4,
        )
        .unwrap();
        for b in &town.buildings {
            for l in &b.links {
                if l.nodes.contains(&node) {
                    println!(
                        "DEBUG link {} {:?} nodes {:?} blocked {:?} ends {:?} line {:?}",
                        show(l.id),
                        l.kind,
                        l.nodes.map(show),
                        l.blocked,
                        l.ends,
                        l.line
                    );
                }
            }
        }
        town.view().stand_near(node, p, 0, None)
    }

    fn ok(&self, got: Got, what: &str) {
        println!("{what}: {got:?}");
        if got.kind != 1 {
            for l in self._s.lines.try_iter().filter(|l| l.starts_with("worldd:")) {
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
            let c = self.crew_at((2, 3), (1_082, JOISTS_Z[k]), "Souls 3 and 4 to a 2x4's ends");
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
            assert_eq!(joints_at(&self.w, self.sheets[k]), 2, "{slot}: its two joints");
            self.leave(0, c);
            self.leave(1, c);
        }
    }
}

/// Racks T9, the brief's task 3, in a served world by Souls' intents, each on its own connection:
///
/// - the bay's frames stand on four beams; three 2x4s rest on the 1.8 m beams and two plywood sheets on them, seated
///   at 1.8 m, each sheet a floor at its top, 2.01 m up;
/// - two take the stair flight (one part: its treads are part of it) and seat it in the bay's `stair` slot, its top at
///   the first sheet's edge, hooked onto a 2x4: the declared way up;
/// - a fifth Soul walks from the open ground up the flight onto the first sheet and across to the second: its body rows
///   end on each sheet's floor, at its top;
/// - a crew unseating the sheet under it is refused `part.stood-on`, naming the body;
/// - the Soul walks down to the ground, and the sheet comes out.
#[test]
fn deck_bay_two_sheets_seated_at_1_8_m_a_soul_walks_up_the_stair_and_across_both() {
    let mut k = Bay::serve("deck-bay", 5);
    k.frame();
    k.deck();
    let g = k.w.ground;
    let (flight, decks, sheets) = (k.flight, k.decks, k.sheets);

    // The flight: Souls 1 and 2 at its ends (its grips 1 m from its middle, 0.35 m beyond), set in the stair slot
    // 0.8 m east of where it stands, hooked onto j2.
    let (fx, fz) = (STAIR_AT[0] - FLIGHT_OFF, STAIR_AT[1]);
    k.walk(
        &[(0, Bay::at(fx - 1_350, fz)), (1, Bay::at(fx + 1_350, fz))],
        "Souls 1 and 2 to the flight's ends",
    );
    let c = k.crew(0, &[1]);
    let got = k.act(0, "part:take", c, flight);
    k.ok(got, "Souls 1 and 2 take the flight");
    let got = k.put(0, c, "stair", Some(&[k.joists[0]]));
    k.ok(got, "the flight in the stair slot, hooked onto j2");
    assert_eq!(where_is(&k.w, flight).0, Some(k.bay), "the flight seated");
    k.leave(0, c);
    k.leave(1, c);
    k.walk(
        &[(0, Bay::at(-5_000, -3_500)), (1, Bay::at(-6_000, -3_500))],
        "Souls 1 and 2 step away",
    );

    // Soul 5 walks up onto the first sheet, then across onto the second.
    k.walk(&[(4, Bay::at(-4_500, STAIR_AT[1]))], "Soul 5 to the flight's foot");
    let walker = body_of(&k.w, k.w.souls[4]);
    // The served tree's geometry, read afresh: a body stands on the first sheet's top.
    assert!(
        k.fresh(decks[0], v3(0, 19_000, 0)).is_some(),
        "a town built afresh from the served tree stands a body on the deck"
    );
    let up = |k: &mut Bay, node: Id, p: Vec3, what: &str| {
        let to = BTreeMap::from([(1, Value::Array(vec![int(p.x), int(p.y), int(p.z)]))]);
        k.hands[4].send("eden:walk", node, to);
        let got = socket_end(&mut k.hands[4].s);
        println!("{what}: {got:?}");
        if got.kind != 1 {
            for l in k._s.lines.try_iter().filter(|l| l.starts_with("worldd:")) {
                println!("  {l}");
            }
        }
        assert_eq!(got.kind, 1, "{what}");
        let at = body_on(&k.w, walker);
        println!("{what}: the body on {} at {:?}", show(at.0), at.1);
        at
    };
    // Past the stair's top, more than 0.7 m in from the deck's edge: no stopping on a stair.
    let (on, at) = up(&mut k, decks[0], v3(400_000, 19_000, 0), "Soul 5 up onto the first sheet");
    assert_eq!((on, at.y), (decks[0], 19_000), "on the first sheet's top");
    assert!(at.x > 0, "past the stair's top: {at:?}");
    let (on, at) = up(&mut k, decks[1], v3(400_000, 19_000, 100_000), "Soul 5 across to the second sheet");
    assert_eq!((on, at.y), (decks[1], 19_000), "on the second sheet's top");

    // Nothing under it leaves.
    let under = {
        k.walk(
            &[(2, Bay::at(-1_264, SHEETS_Z[1])), (3, Bay::at(1_264, SHEETS_Z[1]))],
            "Souls 3 and 4 under the second sheet's ends",
        );
        k.crew(2, &[3])
    };
    let got = k.act(2, "part:unseat", under, sheets[1]);
    refused_as(&got, "part.stood-on", "the second sheet out from under Soul 5");
    assert!(got.detail.contains(&show(walker)), "names the body: {got:?}");
    assert_eq!(where_is(&k.w, sheets[1]).0, Some(k.bay), "the sheet stays");
    assert_eq!(body_on(&k.w, walker).0, decks[1], "the body where it was");

    // Down again, and the sheet comes out.
    let (on, at) = up(&mut k, g, Bay::at(-5_000, 3_000), "Soul 5 down to the ground");
    assert_eq!((on, at.y), (g, 0), "on the open ground");
    let got = k.act(2, "part:unseat", under, sheets[1]);
    k.ok(got, "the second sheet out, nobody on it");
    assert_eq!(where_is(&k.w, sheets[1]).0, Some(under), "the sheet rides its crew");
}

/// Racks T6, the brief's task 4, in a served world by Souls' intents: a Soul climbs a frame to its 1.8 m standing place.
///
/// - the bay's frames stand on four beams. Each frame's kind declares, on each face, a ladder from the ground to each
///   1.8 m beam level and a standing place there, 0.9 m deep and as wide as the frame, that exists only while a part
///   joined to the frame sits at its level (a beam braces it) and nothing lies over it within a body's height;
/// - a fifth Soul walks to frame 1's outer standing place at 1.8 m: its way is the ladder, climbed as a track (its
///   body's rows rise from the ground, none a jump), and it stands on the place at its height;
/// - a step off the place's outer edge is refused, and the body stays where it was;
/// - a crew unseating (lowering) frame 1 meanwhile is refused `part.stood-on`, naming the body;
/// - it climbs down, and the walk ends on the open ground.
#[test]
fn deck_bay_a_soul_climbs_a_frame_to_its_1_8_m_standing_place_and_the_frame_stays_under_it() {
    let mut k = Bay::serve("deck-climb", 5);
    k.frame();
    let g = k.w.ground;
    let frame = k.frames[0];
    // Frame 1's back face is its outer one (it stands at the bay's -z end).
    let perch = k.places[0][0];
    let walker = {
        k.walk(&[(4, Bay::at(0, -3_200))], "Soul 5 to the ladder's foot");
        body_of(&k.w, k.w.souls[4])
    };
    assert!(
        k.fresh(perch, v3(0, 1_800_000, -488_000)).is_some(),
        "a town built afresh from the served tree stands a body on the standing place"
    );
    let before = body_rows(&k.w, walker).len();
    let to = BTreeMap::from([(1, Value::Array(vec![int(0), int(1_800_000), int(-488_000)]))]);
    k.hands[4].send("eden:walk", perch, to);
    let got = socket_end(&mut k.hands[4].s);
    println!("Soul 5 climbs to the 1.8 m standing place: {got:?}");
    k.ok(got, "the climb ends on the standing place");
    let rows = body_rows(&k.w, walker);
    let (on, at) = *rows.last().expect("rows");
    println!("the body on {} at {at:?}", show(on));
    assert_eq!(on, perch, "the body stands on the frame's standing place");
    assert_eq!(at.y, 1_800_000, "at the beam level");
    let climb: Vec<Vec3> = rows[before..]
        .iter()
        .filter(|(n, p)| *n == g && p.y > 0)
        .map(|(_, p)| *p)
        .collect();
    let mut most = 0;
    for w in climb.windows(2) {
        let d = |a: i64, b: i64| i128::from(a - b) * i128::from(a - b);
        let step = (d(w[0].x, w[1].x) + d(w[0].y, w[1].y) + d(w[0].z, w[1].z)).isqrt() as i64;
        most = most.max(step);
    }
    let high = climb.iter().map(|p| p.y).max().unwrap_or(0);
    println!(
        "the climb: {} rows off the ground, the highest {} mm up, the longest step between two {} mm",
        climb.len(),
        high / 1000,
        most / 1000
    );
    assert!(climb.len() >= 10, "sampled on the way up: {}", climb.len());
    assert!(high > 1_500_000, "up the ladder: {high}");
    assert!(most <= 300_000, "no jump on the way: {most}");

    // A second step, off the place's outer edge (0.9 m from the face), is refused.
    let off = BTreeMap::from([(1, Value::Array(vec![int(0), int(1_800_000), int(-1_300_000)]))]);
    k.hands[4].send("eden:walk", perch, off);
    let got = socket_end(&mut k.hands[4].s);
    println!("Soul 5 steps off the edge: {got:?}");
    assert_eq!(got.kind, 2, "a step off the standing place's edge is refused: {got:?}");
    assert_eq!(body_on(&k.w, walker).0, perch, "the body where it was");

    // Lowering the frame under it is refused.
    k.walk(
        &[(0, Bay::at(1_060, -1_448)), (1, Bay::at(-1_060, -1_448))],
        "Souls 1 and 2 beside frame 1's edges",
    );
    let c = k.crew(0, &[1]);
    let got = k.act(0, "part:unseat", c, frame);
    refused_as(&got, "part.stood-on", "frame 1 lowered with Soul 5 on it");
    assert!(got.detail.contains(&show(walker)), "names the body: {got:?}");
    assert_eq!(where_is(&k.w, frame).0, Some(k.bay), "the frame stays");
    k.leave(0, c);
    k.leave(1, c);

    // Down again.
    let down = Bay::at(0, -3_500);
    let to = BTreeMap::from([(1, Value::Array(vec![int(down.x), int(0), int(down.z)]))]);
    k.hands[4].send("eden:walk", g, to);
    let got = socket_end(&mut k.hands[4].s);
    println!("Soul 5 climbs down: {got:?}");
    k.ok(got, "the climb down ends on the ground");
    assert_eq!(body_on(&k.w, walker).0, g, "on the open ground");
}
