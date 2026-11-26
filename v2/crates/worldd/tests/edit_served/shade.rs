//! The timber shade by intents (PR #5014's review): a served world refuses a crew's take of a part by the crew's size
//! before anyone moves, and puts the shade cloth onto both rails by default.
use super::*;

/// N2's test world with a timber shade's parts at its build site (`content/kinds/carpentry/`): the site marked at the
/// site's centre, its two bents standing loose on their slots' places, its two rails lying 0.5 m outside theirs and its
/// cloth lying under its own, so each crew takes a part and puts it from where it stands, no load carried. The parts
/// have no walk boxes. The folder of entries: the construction kinds (the carry), the carpentry kinds and the body.
/// Returns the facts and the site's slot numbers, by name.
fn shade_world(d: &Path) -> (String, BTreeMap<String, u64>) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let entries = d.join("entries");
    std::fs::create_dir_all(&entries).unwrap();
    for family in ["construction", "carpentry"] {
        for f in std::fs::read_dir(root.join(family)).unwrap() {
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
    let text = std::fs::read_to_string(root.join("carpentry/shade_site.json")).unwrap();
    let kind = replica::kinds::entry::entry_to_kind(&text).unwrap();
    let mut kinds = replica::kinds::Kinds::default();
    kinds.load(&[("shade_site", kind.as_str())]);
    let def = kinds
        .admits()
        .into_keys()
        .find_map(|k| {
            kinds
                .get(&k)
                .filter(|d| d.name.as_str().starts_with("mars:shade_site@"))
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
        ("testworld-shade-site@1", "mars:shade_site"),
        ("testworld-timber-bent@1", "mars:timber_bent"),
        ("testworld-timber-rail@1", "mars:timber_rail"),
        ("testworld-shade-cloth@1", "mars:shade_cloth"),
    ];
    let (x, z) = (testworld::SITE_X, testworld::YARD_Z);
    let things = [
        ("shade-site", 0, [x, 0, z, 0]),
        ("timber-bent-1", 1, [x, 0, z - 1_500, 0]),
        ("timber-bent-2", 1, [x, 0, z + 1_500, 0]),
        ("timber-rail-1", 2, [x - 1_350, 0, z, 0]),
        ("timber-rail-2", 2, [x + 1_350, 0, z, 0]),
        ("shade-cloth", 3, [x, 0, z, 0]),
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

/// PR #5014's review: the crew-size check on a take, and the cloth's default joins, in a served world by Souls'
/// intents, each on its own connection.
///
/// - Five Souls take a rail, which four grip: refused `carry-crew-too-large` before anyone moves.
/// - Two take each bent where it stands and put it in its slot, one staying to hold it; two take each rail and put it
///   across both bents; the holders let go once both rails brace the bents.
/// - Three take the shade cloth, which four carry: refused `carry-crew-too-small`, the cloth where it lay. The fourth
///   joins, the four take it and put it in the site's `cloth` slot naming no joins: it rests on both rails (its two
///   joints, one to each rail), the site's bearing parts, not on its standing bents.
#[test]
fn shade_a_take_by_too_many_or_too_few_is_refused_and_the_cloth_rests_on_both_rails() {
    let d = scratch("shade");
    let (facts, slots) = shade_world(&d);
    let (x, z) = (testworld::SITE_X, testworld::YARD_Z);
    let w = seed_entries(
        &d,
        &facts,
        5,
        ((x - 4_000) / 1000, (z - 5_000) / 1000),
        Some(&d.join("entries")),
    );
    let socket = d.join("s");
    let s = serve_with(&w, &socket, None);
    s.line("listening ", 120);
    let im = import_eden::load(&facts).unwrap();
    let site = im.nodes["shade-site"];
    let bents = [im.nodes["timber-bent-1"], im.nodes["timber-bent-2"]];
    let rails = [im.nodes["timber-rail-1"], im.nodes["timber-rail-2"]];
    let cloth = im.nodes["shade-cloth"];
    let g = w.ground;
    let mut hands: Vec<Hand> = w.souls.iter().map(|s| Hand::new(&socket, &w, *s)).collect();
    // A place `dx`, `dz` mm from the site's centre.
    let at = |dx: i64, dz: i64| v3((x + dx) * 1000, 0, (z + dz) * 1000);
    // Each Soul named walks to its place, all at once; every walk ends there.
    let walk = |hands: &mut [Hand], to: &[(usize, Vec3)], what: &str| {
        for (k, p) in to {
            hands[*k].walk_to(g, *p);
        }
        for (k, _) in to {
            let got = socket_end(&mut hands[*k].s);
            assert_eq!(got.kind, 1, "{what}: Soul {}: {got:?}", k + 1);
        }
    };
    // A carry crew Soul `a` offers on the open ground to `others`, the first `accept` of whom accept.
    let crew = |hands: &mut [Hand], a: usize, others: &[usize], accept: usize| {
        let bodies = others
            .iter()
            .map(|o| body_of(&w, w.souls[*o]).to_value())
            .collect();
        let got = hands[a].act(
            "activity:offer",
            g,
            BTreeMap::from([
                (1, pinned_activity(&w, "mars:carry_activity")),
                (2, Value::Text(Name::new("mars:front").unwrap())),
                (3, Value::Array(bodies)),
            ]),
        );
        assert_eq!(got.kind, 1, "offered: {got:?}");
        let made = created_by(&w, &got.entries, "mars:carry_activity@");
        for o in &others[..accept] {
            let got = hands[*o].act("activity:accept", made, BTreeMap::new());
            assert_eq!(got.kind, 1, "Soul {} accepts: {got:?}", o + 1);
        }
        made
    };
    let leave = |hands: &mut [Hand], k: usize, c: Id| {
        let got = hands[k].act("activity:leave", c, BTreeMap::new());
        assert_eq!(got.kind, 1, "Soul {} leaves: {got:?}", k + 1);
    };
    let part = |p: Id| BTreeMap::from([(1, p.to_value())]);
    let into = |slot: &str| BTreeMap::from([(1, site.to_value()), (2, Value::Uint(slots[slot]))]);
    let ok = |got: Got, what: &str| {
        println!("{what}: {got:?}");
        assert_eq!(got.kind, 1, "{what}");
    };
    let refused = |got: &Got, name: &str, what: &str| {
        println!("{what}: {got:?}");
        assert_eq!((got.kind, got.reason.as_str()), (2, name), "{what}");
    };

    // Five around rail 1, which four grip: too many. Refused before anyone moves.
    walk(
        &mut hands,
        &[
            (0, at(-2_000, -1_200)),
            (1, at(-2_700, -500)),
            (2, at(-2_700, 500)),
            (3, at(-2_000, 1_200)),
            (4, at(-2_700, -1_600)),
        ],
        "five around rail 1",
    );
    let five = crew(&mut hands, 0, &[3, 1, 2, 4], 4);
    let got = hands[0].act("part:take", five, part(rails[0]));
    refused(&got, "carry-crew-too-large", "five take rail 1");
    assert_eq!(where_is(&w, rails[0]).0, Some(g), "rail 1 lies where it lay");
    for k in 0..5 {
        leave(&mut hands, k, five);
    }

    // Bent 1: Souls 1 and 2 at its faces take it where it stands and put it in bent_a; Soul 1 lets go and Soul 2 holds
    // it (a bent's hold crew is one).
    walk(
        &mut hands,
        &[(0, at(0, 700)), (1, at(0, -3_700))],
        "Souls 1 and 2 to bent 1's faces",
    );
    let hold_a = crew(&mut hands, 0, &[1], 1);
    ok(
        hands[0].act("part:take", hold_a, part(bents[0])),
        "Souls 1 and 2 take bent 1",
    );
    ok(
        hands[0].act("part:put", hold_a, into("bent_a")),
        "bent 1 in bent_a",
    );
    leave(&mut hands, 0, hold_a);
    // Bent 2: Souls 1 and 3; Soul 3 holds it.
    walk(
        &mut hands,
        &[(0, at(0, -700)), (2, at(0, 3_700))],
        "Souls 1 and 3 to bent 2's faces",
    );
    let hold_b = crew(&mut hands, 0, &[2], 1);
    ok(
        hands[0].act("part:take", hold_b, part(bents[1])),
        "Souls 1 and 3 take bent 2",
    );
    ok(
        hands[0].act("part:put", hold_b, into("bent_b")),
        "bent 2 in bent_b",
    );
    leave(&mut hands, 0, hold_b);
    assert_eq!(
        [where_is(&w, bents[0]).0, where_is(&w, bents[1]).0],
        [Some(site); 2]
    );

    // The rails: Souls 1 and 4 at each rail's ends take it and put it across both bents (a bearing part joins the
    // site's standing parts by default).
    let mut rail = None;
    for (k, (dx, slot)) in [(-1_350, "rail_l"), (1_350, "rail_r")].into_iter().enumerate() {
        walk(
            &mut hands,
            &[(0, at(dx, -2_200)), (3, at(dx, 2_200))],
            "Souls 1 and 4 to a rail's ends",
        );
        let c = *rail.get_or_insert_with(|| crew(&mut hands, 0, &[3], 1));
        ok(
            hands[0].act("part:take", c, part(rails[k])),
            "Souls 1 and 4 take a rail",
        );
        ok(hands[0].act("part:put", c, into(slot)), slot);
        assert_eq!(joints_at(&w, rails[k]), 2, "{slot} joins both bents");
    }
    // Both rails brace both bents: the holders let go and the frame stands unheld.
    leave(&mut hands, 1, hold_a);
    leave(&mut hands, 2, hold_b);
    let rail = rail.unwrap();
    leave(&mut hands, 0, rail);
    leave(&mut hands, 3, rail);
    assert_eq!((crews_on(&w, bents[0]).0, crews_on(&w, bents[1]).0), (0, 0));

    // The cloth: Souls 1 and 2 at its ends, 3 and 4 beside it. Three are too few: refused before anyone moves.
    walk(
        &mut hands,
        &[
            (0, at(0, -2_000)),
            (1, at(0, 2_000)),
            (2, at(-2_000, -500)),
            (3, at(2_000, 500)),
        ],
        "four at the cloth",
    );
    let four = crew(&mut hands, 0, &[1, 2, 3], 2);
    let got = hands[0].act("part:take", four, part(cloth));
    refused(&got, "carry-crew-too-small", "three take the cloth");
    assert_eq!(where_is(&w, cloth).0, Some(g), "the cloth lies where it lay");
    ok(
        hands[3].act("activity:accept", four, BTreeMap::new()),
        "Soul 4 joins",
    );
    ok(
        hands[0].act("part:take", four, part(cloth)),
        "four take the cloth",
    );
    ok(
        hands[0].act("part:put", four, into("cloth")),
        "the cloth onto the rails, no joins named",
    );
    let (parent, slot, _) = where_is(&w, cloth);
    assert_eq!(
        (parent, slot),
        (Some(site), Some(slots["cloth"])),
        "the cloth in its slot"
    );
    let (copy, _) = served_copy(&w);
    let t = copy.tree();
    let mut rests_on: Vec<Id> = t
        .links_at(cloth)
        .iter()
        .filter(|e| t.ty(e).as_str().contains("joint"))
        .filter_map(|e| t.link(e.link))
        .flat_map(|(_, ends, _, _)| ends)
        .filter(|e| *e != cloth)
        .collect();
    rests_on.sort();
    let mut both = rails.to_vec();
    both.sort();
    println!("the cloth rests on {rests_on:?}; the rails are {both:?}");
    assert_eq!(rests_on, both, "the cloth's joints: one to each rail");
    for k in 0..4 {
        leave(&mut hands, k, four);
    }
}
