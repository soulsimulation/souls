//! The timber shade by intents (PR #5014's review): a served world refuses a crew's take of a part by the crew's size
//! before anyone moves, and puts the shade cloth onto both rails by default.
use super::*;

/// N2's test world with a timber shade's parts at its build site (`content/kinds/carpentry/`): the site marked at the
/// site's centre, its two bents standing loose on their slots' places, its two rails lying 0.5 m outside theirs and its
/// cloth lying under its own, so each crew takes a part and puts it from where it stands, no load carried. With
/// `posts`, each bent has the walk boxes of its two posts (its entry's `solids_mm`, as the Mars camp's bents have
/// them); else the parts have none. The folder of entries: the construction kinds (the carry), the carpentry kinds
/// and the body. Returns the facts and the site's slot numbers, by name.
fn shade_world(d: &Path, posts: bool) -> (String, BTreeMap<String, u64>) {
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
                    if r == 1 && posts {
                        // Each post 100 mm square and 1.8 m high, 850 mm either side of the bent's middle.
                        let post = |cx: i64| ints(&[cx, 0, 50, 50, 0, 0, 1_800, 5, 0]);
                        let boxes = json::Value::Arr(vec![post(-850), post(850)]);
                        t.push(("solids".into(), boxes));
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
    let (facts, slots) = shade_world(&d, false);
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
    assert_eq!(
        where_is(&w, rails[0]).0,
        Some(g),
        "rail 1 lies where it lay"
    );
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
    for (k, (dx, slot)) in [(-1_350, "rail_l"), (1_350, "rail_r")]
        .into_iter()
        .enumerate()
    {
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
    assert_eq!(
        where_is(&w, cloth).0,
        Some(g),
        "the cloth lies where it lay"
    );
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

fn done(got: Got, what: &str) {
    println!("{what}: {got:?}");
    assert_eq!(got.kind, 1, "{what}");
}

/// Every load the world set down off its crew, and why (`souls:carry-set-down`: blocked, apart, a partner left).
fn set_downs(w: &Seeded) -> Vec<String> {
    logged(w)
        .iter()
        .flat_map(|p| p.effects.iter())
        .flat_map(|e| e.events.iter().flatten())
        .filter(|ev| ev.name.as_str() == "souls:carry-set-down")
        .map(|ev| match ev.fields.get(&3) {
            Some(Value::Text(t)) => t.as_str().to_owned(),
            _ => String::new(),
        })
        .collect()
}

/// PR #5033's run 2 (six build the shade, two crews taking the two bents at once): the second crew's carry was stopped
/// `souls:carry-blocked` by its own bent's posts where the bent had stood. The carries' fixed geometry is kept from
/// step to step while the walkers' ground is unchanged, and a take changes no walker's map: read while the first
/// crew carried and the second bent still stood, it kept that bent there. In a served world whose bents have their
/// posts' walk boxes, by the Souls' own intents:
///
/// - Crew A (Souls 1 and 2) takes bent 1 where it stands and carries it 3 m west: its carry reads the ground's fixed
///   geometry, bent 2 standing.
/// - Crew B (Souls 3 and 4) stands 400 mm south of bent 2's faces, so the bent it takes is held clear of where its
///   own posts stood (on the plan it is 1.8 m by 0.1 m, its posts 100 mm square on its line), and takes it.
/// - Both crews walk at once: A 1 m further west, B 1.2 m north, its bent across where it stood. Both bents ride their
///   crews at the end, and the world set nothing down.
#[test]
fn shade_two_crews_carry_the_two_bents_at_once_neither_meets_where_its_bent_stood() {
    let d = scratch("shade2bents");
    let (facts, _) = shade_world(&d, true);
    let (x, z) = (testworld::SITE_X, testworld::YARD_Z);
    let w = seed_entries(
        &d,
        &facts,
        4,
        ((x - 4_000) / 1000, (z - 5_000) / 1000),
        Some(&d.join("entries")),
    );
    let socket = d.join("s");
    let s = serve_with(&w, &socket, None);
    s.line("listening ", 120);
    let im = import_eden::load(&facts).unwrap();
    let bents = [im.nodes["timber-bent-1"], im.nodes["timber-bent-2"]];
    let g = w.ground;
    let mut hands: Vec<Hand> = w.souls.iter().map(|s| Hand::new(&socket, &w, *s)).collect();
    let at = |dx: i64, dz: i64| v3((x + dx) * 1000, 0, (z + dz) * 1000);
    let part = |p: Id| BTreeMap::from([(1, p.to_value())]);

    walk_all(
        &mut hands,
        g,
        &[(0, at(0, 700)), (1, at(0, -3_700))],
        "crew A to bent 1's faces",
    );
    let a = crew_of_all(&w, &mut hands, 0, &[1]);
    done(
        hands[0].act("part:take", a, part(bents[0])),
        "crew A takes bent 1",
    );
    walk_all(
        &mut hands,
        g,
        &[(0, at(-3_000, 700)), (1, at(-3_000, -3_700))],
        "crew A carries bent 1 3 m west",
    );

    walk_all(
        &mut hands,
        g,
        &[(2, at(0, 4_100)), (3, at(0, -300))],
        "crew B 400 mm south of bent 2's faces",
    );
    let (p, q) = (
        body_at(&w, body_of(&w, w.souls[2])),
        body_at(&w, body_of(&w, w.souls[3])),
    );
    let middle = (p.z + q.z) / 2;
    println!(
        "crew B's middle {} mm south of bent 2",
        (middle - (z + 1_500) * 1000) / 1000
    );
    // The bent held there clears its posts' old boxes (z + 1450 to 1550 mm) by more than 100 mm.
    assert!(
        middle - 50_000 > (z + 1_550 + 100) * 1000,
        "crew B stands clear of bent 2's posts: {p:?} {q:?}"
    );
    let b = crew_of_all(&w, &mut hands, 2, &[3]);
    done(
        hands[2].act("part:take", b, part(bents[1])),
        "crew B takes bent 2",
    );
    walk_all(
        &mut hands,
        g,
        &[
            (0, at(-4_000, 700)),
            (1, at(-4_000, -3_700)),
            (2, at(0, 2_900)),
            (3, at(0, -1_500)),
        ],
        "both crews carry at once, bent 2 across where it stood",
    );
    let set_down = set_downs(&w);
    println!("set down: {set_down:?}");
    assert_eq!(
        [where_is(&w, bents[0]).0, where_is(&w, bents[1]).0],
        [Some(a), Some(b)],
        "both bents ride their crews; set down: {set_down:?}"
    );
    assert!(set_down.is_empty(), "nothing set down: {set_down:?}");
    let at_b = where_is(&w, bents[1]).2;
    assert!(
        at_b.z < (z + 1_000) * 1000,
        "bent 2 carried past where it stood: {at_b:?}"
    );
}

/// PR #5033's run 1 (the take-down by four): a rail's carriers stood at its ends on its own line, which is its bents'
/// posts' line, so the rail they unseated came down at their middle against a post, and its carry out was stopped
/// `souls:carry-blocked`. A part is unseated to its carriers' middle; carriers who stand 0.9 m outside the posts'
/// line (`carry grip <rail> back|front --from 2.2 --out 0.9`, as the build sets a rail in from there) have it come
/// down clear of the posts, and carry it away. In a served world whose bents have their posts' walk boxes, by the
/// Souls' own intents:
///
/// - The frame built: two take each bent and put it in its slot, one staying to hold it; two take each rail and put
///   it across both bents.
/// - The rail crew stands 0.9 m outside rail 1's posts, 2.2 m beyond its middle each way, and unseats it: it is at
///   their middle, more than 0.8 m from the posts' line. They carry it 1.1 m on west and lay it there: it lies there,
///   and the world set nothing down.
#[test]
fn shade_a_rail_unseated_from_outside_its_posts_comes_down_clear_and_is_carried_away() {
    let d = scratch("shaderailout");
    let (facts, slots) = shade_world(&d, true);
    let (x, z) = (testworld::SITE_X, testworld::YARD_Z);
    let w = seed_entries(
        &d,
        &facts,
        4,
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
    let g = w.ground;
    let mut hands: Vec<Hand> = w.souls.iter().map(|s| Hand::new(&socket, &w, *s)).collect();
    let at = |dx: i64, dz: i64| v3((x + dx) * 1000, 0, (z + dz) * 1000);
    let part = |p: Id| BTreeMap::from([(1, p.to_value())]);
    let into = |slot: &str| BTreeMap::from([(1, site.to_value()), (2, Value::Uint(slots[slot]))]);

    // The bents, each held by one of its crew: Soul 2 holds bent 1, Soul 3 bent 2.
    for (k, (faces, holder, slot)) in [
        ([at(0, 700), at(0, -3_700)], 1, "bent_a"),
        ([at(0, -700), at(0, 3_700)], 2, "bent_b"),
    ]
    .into_iter()
    .enumerate()
    {
        walk_all(
            &mut hands,
            g,
            &[(0, faces[0]), (holder, faces[1])],
            "to a bent's faces",
        );
        let hold = crew_of_all(&w, &mut hands, 0, &[holder]);
        done(
            hands[0].act("part:take", hold, part(bents[k])),
            "a bent taken",
        );
        done(hands[0].act("part:put", hold, into(slot)), slot);
        done(
            hands[0].act("activity:leave", hold, BTreeMap::new()),
            "Soul 1 lets go",
        );
    }
    // The rails, by Souls 1 and 4 at each rail's ends, across both bents.
    let mut rail = None;
    for (k, (dx, slot)) in [(-1_350, "rail_l"), (1_350, "rail_r")]
        .into_iter()
        .enumerate()
    {
        walk_all(
            &mut hands,
            g,
            &[(0, at(dx, -2_200)), (3, at(dx, 2_200))],
            "Souls 1 and 4 to a rail's ends",
        );
        let c = *rail.get_or_insert_with(|| crew_of_all(&w, &mut hands, 0, &[3]));
        done(hands[0].act("part:take", c, part(rails[k])), "a rail taken");
        done(hands[0].act("part:put", c, into(slot)), slot);
    }
    let rail = rail.unwrap();

    // Rail 1 (rail_l, on the posts' line 850 mm west of the site's middle) out: its crew 0.9 m outside that line.
    walk_all(
        &mut hands,
        g,
        &[(0, at(-1_750, -2_200)), (3, at(-1_750, 2_200))],
        "the rail crew 0.9 m outside rail 1's posts",
    );
    done(
        hands[0].act("part:unseat", rail, part(rails[0])),
        "rail 1 unseated",
    );
    // The rail rides its crew's node, which stands at its carriers' middle (the part has no place of its own there).
    assert_eq!(
        where_is(&w, rails[0]).0,
        Some(rail),
        "rail 1 rides its crew"
    );
    let held = where_is(&w, rail).2;
    println!("rail 1 unseated, held at {held:?}");
    assert!(
        ((x - 850) * 1000 - held.x) > 800_000,
        "rail 1 came down clear of its posts' line: {held:?}"
    );
    walk_all(
        &mut hands,
        g,
        &[(0, at(-2_850, -2_200)), (3, at(-2_850, 2_200))],
        "rail 1 carried 1.1 m on west",
    );
    let set_down = set_downs(&w);
    assert_eq!(
        where_is(&w, rails[0]).0,
        Some(rail),
        "rail 1 still rides its crew; set down: {set_down:?}"
    );
    done(
        hands[0].act(
            "part:put",
            rail,
            BTreeMap::from([
                (1, g.to_value()),
                (
                    3,
                    Value::Array(vec![int((x - 2_850) * 1000), int(0), int(z * 1000)]),
                ),
            ]),
        ),
        "rail 1 laid down",
    );
    let (parent, _, lies) = where_is(&w, rails[0]);
    println!("rail 1 lies at {lies:?}");
    assert_eq!(parent, Some(g), "rail 1 on the open ground");
    assert!(
        (lies.x - (x - 2_850) * 1000).abs() < 300_000 && (lies.z - z * 1000).abs() < 300_000,
        "where it was laid: {lies:?}"
    );
    let set_down = set_downs(&w);
    assert!(set_down.is_empty(), "nothing set down: {set_down:?}");
}
