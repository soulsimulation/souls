//! A deck bay by intents (racks T2, the scripted build's bay: `mars/viewer/engine/scenarios/build-bay.ts`): two Souls
//! carry a plywood sheet and set it down; a deck bay's two 12 ft frames are held while four 9 ft beams are seated at
//! 0.5 m and 1.8 m; a crew seats a 2x4 joist across the two 1.8 m beams, which it rests on by the support rule's resting
//! tier; a beam under it cannot be taken out; a sheet onto the joists is refused today (racks T3); the joist comes out
//! again by the same rules.
use super::*;

/// The joist slot `j4`'s and the sheet slot `s1`'s places along the bay (mm from its middle, `deck_bay.json`).
const J4_Z: i64 = 578;
const S1_Z: i64 = -612;

/// N2's test world with a deck bay's parts at its site (`content/kinds/construction/`): the bay at the site's centre,
/// its two 12 ft frames standing loose on their slots' places, its four beams lying outside their columns (the low
/// ones 0.5 m out, the high ones 1 m), one 2x4 lying on the ground under its slot `j4` and one plywood sheet under its
/// slot `s1` (each crew takes its part where it lies and puts it from there, one carrier each side of the bay), and a
/// plywood sheet lying 5 m east. The folder of entries: the construction kinds and the body. Returns the facts and the
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

/// Racks T2, by Souls' intents, each on its own connection:
///
/// - Two Souls at a plywood sheet's ends take it, carry it 2 m north and lay it down there.
/// - The deck bay's frames: two take each where it stands and put it in its slot, one staying to hold it (a 12 ft frame
///   needs beams at two heights on each column to stand). Two seat the 0.5 m beams from where they lie, then carry each
///   1.8 m beam in from 1 m outside its column and seat it; the holders let go and the frames stand.
/// - A crew of two, one each side of the bay, takes the 2x4 where it lies and seats it in `j4` (1.9 m up), naming the
///   two 1.8 m beams: it rests on both (one joint to each).
/// - A sheet onto the joists (`s1`) is not seated: the engine has no rule yet for a part resting on a part that itself
///   rests (racks T3). The test prints the refusals it meets, by name, for the engine lanes.
/// - A crew at the left 1.8 m beam's ends unseats it: refused `support.none`. The joist's crew unseats the joist and
///   lays it back where it lay.
#[test]
fn deck_two_carry_a_plywood_sheet_and_a_crew_seats_a_two_by_four_across_two_seated_beams() {
    let d = scratch("deck");
    let (facts, slots) = deck_world(&d);
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
    let bay = im.nodes["deck-bay"];
    let frames = [im.nodes["deck-frame-1"], im.nodes["deck-frame-2"]];
    let low = [im.nodes["deck-beam-low-l"], im.nodes["deck-beam-low-r"]];
    let high = [im.nodes["deck-beam-high-l"], im.nodes["deck-beam-high-r"]];
    let joist = im.nodes["two-by-four"];
    let sheet = im.nodes["plywood-sheet"];
    let sheet2 = im.nodes["plywood-sheet-2"];
    let g = w.ground;
    let mut hands: Vec<Hand> = w.souls.iter().map(|s| Hand::new(&socket, &w, *s)).collect();
    let at = |dx: i64, dz: i64| v3((x + dx) * 1000, 0, (z + dz) * 1000);
    let walk = |hands: &mut [Hand], to: &[(usize, Vec3)], what: &str| {
        for (k, p) in to {
            hands[*k].walk_to(g, *p);
        }
        for (k, _) in to {
            let got = socket_end(&mut hands[*k].s);
            assert_eq!(got.kind, 1, "{what}: Soul {}: {got:?}", k + 1);
        }
    };
    let crew = |hands: &mut [Hand], a: usize, others: &[usize]| {
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
        for o in others {
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
    let into = |slot: &str| BTreeMap::from([(1, bay.to_value()), (2, Value::Uint(slots[slot]))]);
    let ground_at = |p: Vec3| {
        BTreeMap::from([
            (1, g.to_value()),
            (3, Value::Array(vec![int(p.x), int(0), int(p.z)])),
        ])
    };
    let ok = |got: Got, what: &str| {
        println!("{what}: {got:?}");
        assert_eq!(got.kind, 1, "{what}");
    };
    // Each refusal met on the way, for the engine lanes: (step, refusal).
    let mut refusals: Vec<(String, String)> = Vec::new();

    // The sheet: Souls 2 and 3 at its ends (its grips on its short edges, 0.91 m from its middle), 0.35 m beyond.
    walk(
        &mut hands,
        &[(1, at(5_000 - 1_264, 0)), (2, at(5_000 + 1_264, 0))],
        "Souls 2 and 3 at the sheet's ends",
    );
    let pair = crew(&mut hands, 1, &[2]);
    ok(
        hands[1].act("part:take", pair, part(sheet)),
        "Souls 2 and 3 take the sheet",
    );
    assert_eq!(
        where_is(&w, sheet).0,
        Some(pair),
        "the sheet rides its crew"
    );
    walk(
        &mut hands,
        &[(1, at(5_000 - 1_264, 2_000)), (2, at(5_000 + 1_264, 2_000))],
        "the sheet carried 2 m north",
    );
    assert_eq!(where_is(&w, sheet).0, Some(pair), "still carried");
    ok(
        hands[1].act("part:put", pair, ground_at(at(5_000, 2_000))),
        "the sheet laid down",
    );
    let (parent, _, lies) = where_is(&w, sheet);
    println!("the sheet lies at {lies:?}");
    assert_eq!(parent, Some(g), "the sheet on the open ground");
    assert!(
        (lies.x - (x + 5_000) * 1000).abs() < 300_000
            && (lies.z - (z + 2_000) * 1000).abs() < 300_000,
        "where it was laid: {lies:?}"
    );
    leave(&mut hands, 1, pair);
    leave(&mut hands, 2, pair);

    // The frames, each held by one of its crew: Soul 2 holds frame 1, Soul 3 frame 2.
    let mut holds = Vec::new();
    for (k, (dz, holder, slot)) in [(-1_448, 1, "upright_a"), (1_448, 2, "upright_b")]
        .into_iter()
        .enumerate()
    {
        walk(
            &mut hands,
            &[(0, at(1_060, dz)), (holder, at(-1_060, dz))],
            "beside a frame's edges",
        );
        let hold = crew(&mut hands, 0, &[holder]);
        ok(
            hands[0].act("part:take", hold, part(frames[k])),
            "a 12 ft frame taken",
        );
        ok(hands[0].act("part:put", hold, into(slot)), slot);
        leave(&mut hands, 0, hold);
        holds.push((holder, hold));
    }
    // The beams, by Souls 1 and 4 at each beam's ends: the 0.5 m ones from where they lie, 0.5 m outside their slots;
    // the 1.8 m ones carried in from 1 m outside to there first.
    let mut beam_crew = None;
    for (beam, (dx, from, slot)) in [
        (low[0], (-1_072, -1_072, "beam_low_l")),
        (low[1], (1_072, 1_072, "beam_low_r")),
        (high[0], (-1_072, -1_572, "beam_high_l")),
        (high[1], (1_072, 1_572, "beam_high_r")),
    ] {
        walk(
            &mut hands,
            &[(0, at(from, -1_547)), (3, at(from, 1_547))],
            "Souls 1 and 4 to a beam's ends",
        );
        let beam_crew = *beam_crew.get_or_insert_with(|| crew(&mut hands, 0, &[3]));
        ok(
            hands[0].act("part:take", beam_crew, part(beam)),
            "a beam taken",
        );
        if from != dx {
            walk(
                &mut hands,
                &[(0, at(dx, -1_547)), (3, at(dx, 1_547))],
                "the beam carried to 0.5 m outside its slot",
            );
        }
        let got = hands[0].act("part:put", beam_crew, into(slot));
        println!("{slot}: {got:?}");
        assert_eq!(got.kind, 1, "{slot}: {got:?}");
        assert_eq!(joints_at(&w, beam), 2, "{slot} joins both frames");
    }
    for (holder, hold) in holds {
        leave(&mut hands, holder, hold);
    }
    let beam_crew = beam_crew.unwrap();
    leave(&mut hands, 0, beam_crew);
    leave(&mut hands, 3, beam_crew);
    assert_eq!(
        (crews_on(&w, frames[0]).0, crews_on(&w, frames[1]).0),
        (0, 0),
        "the frames stand unheld on two levels of beams"
    );

    // The joist: Souls 1 and 4 beside the bay at its ends (its grips 0.73 m from its middle, 0.35 m beyond), take it
    // where it lies and seat it in j4, joined to the two 1.8 m beams.
    walk(
        &mut hands,
        &[(0, at(-1_082, J4_Z)), (3, at(1_082, J4_Z))],
        "Souls 1 and 4 at the joist's ends, either side of the bay",
    );
    let pair = crew(&mut hands, 0, &[3]);
    ok(
        hands[0].act("part:take", pair, part(joist)),
        "Souls 1 and 4 take the joist",
    );
    let mut on_high = into("j4");
    on_high.insert(
        4,
        Value::Array(vec![high[0].to_value(), high[1].to_value()]),
    );
    ok(
        hands[0].act("part:put", pair, on_high),
        "the joist across both 1.8 m beams",
    );
    let (parent, slot, _) = where_is(&w, joist);
    assert_eq!(
        (parent, slot),
        (Some(bay), Some(slots["j4"])),
        "the joist in its slot"
    );
    let (copy, _) = served_copy(&w);
    let t = copy.tree();
    let mut rests_on: Vec<Id> = t
        .links_at(joist)
        .iter()
        .filter(|e| t.ty(e).as_str().contains("joint"))
        .filter_map(|e| t.link(e.link))
        .flat_map(|(_, ends, _, _)| ends)
        .filter(|e| *e != joist)
        .collect();
    rests_on.sort();
    let mut both = high.to_vec();
    both.sort();
    println!("the joist rests on {rests_on:?}; the 1.8 m beams are {both:?}");
    assert_eq!(rests_on, both, "the joist's joints: one to each 1.8 m beam");
    leave(&mut hands, 0, pair);
    leave(&mut hands, 3, pair);
    assert_eq!(where_is(&w, joist).0, Some(bay), "it stays, unheld");

    // A sheet onto the joists, s1: Souls 2 and 3 at its ends either side of the bay take it where it lies under s1 and
    // put it there, first by default, then naming the joist. Each refusal is recorded; neither may seat it on one joist.
    walk(
        &mut hands,
        &[(1, at(-1_264, S1_Z)), (2, at(1_264, S1_Z))],
        "Souls 2 and 3 at the second sheet's ends",
    );
    let pair = crew(&mut hands, 1, &[2]);
    let got = hands[1].act("part:take", pair, part(sheet2));
    println!("Souls 2 and 3 take the second sheet: {got:?}");
    if got.kind == 1 {
        let got = hands[1].act("part:put", pair, into("s1"));
        println!("the sheet into s1, no joins named: {got:?}");
        if got.kind != 1 {
            refusals.push(("sheet into s1, default joins".into(), got.reason.clone()));
        }
        if where_is(&w, sheet2).1.is_none() {
            let mut on_joist = into("s1");
            on_joist.insert(4, Value::Array(vec![joist.to_value()]));
            let got = hands[1].act("part:put", pair, on_joist);
            println!("the sheet into s1, on the joist: {got:?}");
            if got.kind != 1 {
                refusals.push(("sheet into s1, on the joist".into(), got.reason.clone()));
            }
        }
        assert_ne!(
            where_is(&w, sheet2).0,
            Some(bay),
            "no sheet seated on one joist"
        );
    } else {
        refusals.push(("take the second sheet".into(), got.reason.clone()));
    }
    leave(&mut hands, 1, pair);
    leave(&mut hands, 2, pair);

    // The left 1.8 m beam out from under the joist: Souls 2 and 3 at its ends, 0.5 m outside its slot. Refused.
    walk(
        &mut hands,
        &[(1, at(-1_072, -1_547)), (2, at(-1_072, 1_547))],
        "Souls 2 and 3 to the left 1.8 m beam's ends",
    );
    let out = crew(&mut hands, 1, &[2]);
    let got = hands[1].act("part:unseat", out, part(high[0]));
    println!("the left 1.8 m beam out from under the joist: {got:?}");
    assert_eq!((got.kind, got.reason.as_str()), (2, "support.none"));
    assert_eq!(where_is(&w, high[0]).0, Some(bay), "the beam stays seated");
    leave(&mut hands, 1, out);
    leave(&mut hands, 2, out);

    // The joist out again by its crew, and laid back where it lay.
    walk(
        &mut hands,
        &[(0, at(-1_082, J4_Z)), (3, at(1_082, J4_Z))],
        "Souls 1 and 4 back at the joist's ends",
    );
    let pair = crew(&mut hands, 0, &[3]);
    ok(
        hands[0].act("part:unseat", pair, part(joist)),
        "the joist unseated",
    );
    assert_eq!(
        where_is(&w, joist).0,
        Some(pair),
        "the joist rides its crew"
    );
    assert_eq!(joints_at(&w, joist), 0, "its joints gone");
    std::thread::sleep(Duration::from_millis(1500));
    let got = hands[0].act("part:put", pair, ground_at(at(0, J4_Z)));
    println!("the joist laid back where it lay: {got:?}");
    if got.kind != 1 {
        refusals.push(("joist laid down under the bay".into(), got.reason.clone()));
    }
    println!("refusals met: {refusals:?}");
}
