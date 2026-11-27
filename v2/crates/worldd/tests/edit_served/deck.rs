//! A deck on a timber frame by intents (racks T3): support to any depth in a served world. The frame is the timber
//! shade's bents and rails; the joists, the sheet and their site are test kinds
//! (`v2/crates/sim/src/structure/fixtures/`): a joist names the rail in its joining link, the sheet names the joist.
use super::*;

/// The test deck kinds' folder.
fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../sim/src/structure/fixtures")
}

/// N2's test world with a deck's parts at its build site: the site marked at the site's centre, its two bents
/// standing loose on their slots' places, its two rails lying 0.5 m outside theirs, and each joist and the sheet lying
/// on the ground under its own slot, so each crew takes a part and puts it from where it stands, no load carried.
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

    pub fn serve(tag: &str, souls: usize) -> Deck {
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
            p.insert(4, Value::Array(j.iter().map(Id::to_value).collect()));
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
        done(self.take(0, hold_a, ba), "bent 1 taken");
        done(self.put(0, hold_a, "bent_a", None), "bent 1 in bent_a");
        done(self.leave(0, hold_a), "Soul 1 lets go of bent 1");
        self.walk(
            &[(0, Deck::at(1_350, 1_500)), (2, Deck::at(-1_350, 1_500))],
            "Souls 1 and 3 beside bent 2's edges",
        );
        let hold_b = self.crew(0, &[2]);
        done(self.take(0, hold_b, bb), "bent 2 taken");
        done(self.put(0, hold_b, "bent_b", None), "bent 2 in bent_b");
        done(self.leave(0, hold_b), "Soul 1 lets go of bent 2");
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
            done(self.take(0, c, rails[k]), "a rail taken");
            done(self.put(0, c, slot, None), slot);
            assert_eq!(joints_at(&self.w, rails[k]), 2, "{slot} joins both bents");
        }
        done(self.leave(1, hold_a), "bent 1's holder lets go");
        done(self.leave(2, hold_b), "bent 2's holder lets go");
        let rail = rail.unwrap();
        done(self.leave(0, rail), "Soul 1 leaves the rail crew");
        done(self.leave(3, rail), "Soul 4 leaves the rail crew");
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
    let named = replica::world_model::show(sheet);
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
