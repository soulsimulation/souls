//! Support to any depth (racks T3): a sheet on joists, on rails, on bents. The frame is the timber shade's (two bents,
//! a rail on each side); the joists, the sheet and their site are test kinds (`fixtures/`), a joist declaring its
//! joining link to the rail and the sheet to the joist, so the rule reads four tiers from the kinds alone. A mat on
//! the sheet is a fifth. `cargo test -p sim deck -- --nocapture` prints each step.

use super::shade_tests::{World, accepted, refused, shade_with};

const JOIST: &str = include_str!("fixtures/test_joist.json");
const SHEET: &str = include_str!("fixtures/test_sheet.json");
const SITE: &str = include_str!("fixtures/test_deck_site.json");

/// The sheet's entry as another kind `kind`, resting on `most` parts of kind `on`.
fn like_the_sheet(kind: &str, on: &str, most: u64) -> String {
    SHEET
        .replace("mars:test_joist", "mars:UNDER")
        .replace("mars:test_sheet", kind)
        .replace("mars:UNDER", on)
        .replace("\"most\": 2,", &format!("\"most\": {most},"))
}

fn deck() -> World {
    let mat = like_the_sheet("mars:test_mat", "mars:test_sheet", 1);
    let ring_a = like_the_sheet("mars:test_ring_a", "mars:test_ring_b", 1);
    let ring_b = like_the_sheet("mars:test_ring_b", "mars:test_ring_a", 1);
    World::of(shade_with(
        &[
            ("mars:test_joist", JOIST),
            ("mars:test_sheet", SHEET),
            ("mars:test_deck_site", SITE),
            ("mars:test_mat", &mat),
            ("mars:test_ring_a", &ring_a),
            ("mars:test_ring_b", &ring_b),
        ],
        "mars:test_deck_site",
    ))
}

#[test]
fn deck_kinds_read_as_tiers_from_what_each_names_and_a_ring_has_none() {
    let w = deck();
    let s = &w.s.structure;
    let tiers: Vec<(&str, Option<u16>)> = [
        "mars:timber_bent",
        "mars:timber_rail",
        "mars:test_joist",
        "mars:shade_cloth",
        "mars:test_sheet",
        "mars:test_mat",
        "mars:test_ring_a",
        "mars:test_ring_b",
        "mars:rack_upright",
        "mars:rack_beam",
    ]
    .into_iter()
    .map(|k| (k, s.tier(k)))
    .collect();
    println!("tiers {tiers:?}");
    assert_eq!(
        tiers.iter().map(|t| t.1).collect::<Vec<_>>(),
        [
            Some(0),
            Some(1),
            Some(2),
            Some(2),
            Some(3),
            Some(4),
            None,
            None,
            Some(0),
            Some(1)
        ]
    );
    assert!(s.is_bay("mars:test_deck_site"));
    assert!(s.is_bay("mars:shade_site") && s.is_bay("mars:rack_bay"));
    // what each is held up by: only the kinds its own link names
    assert!(s.rests_on("mars:timber_rail", "mars:timber_bent"));
    assert!(s.rests_on("mars:test_joist", "mars:timber_rail"));
    assert!(s.rests_on("mars:test_sheet", "mars:test_joist"));
    assert!(!s.rests_on("mars:test_sheet", "mars:timber_rail"));
    assert!(!s.rests_on("mars:test_joist", "mars:test_sheet"));
    assert!(!s.rests_on("mars:test_joist", "mars:timber_bent"));
    // the readers worldd's seating asks: a joist and a sheet rest, a rail bears, a bent stands
    assert!(s.rests("mars:test_joist") && s.rests("mars:test_sheet") && s.rests("mars:test_mat"));
    assert!(s.bears("mars:timber_rail") && !s.bears("mars:test_joist"));
    assert!(s.stands("mars:timber_bent") && !s.stands("mars:test_joist"));
    assert!(s.is_part("mars:test_ring_a") && !s.rests("mars:test_ring_a"));
}

#[test]
fn deck_builds_sheet_on_joists_on_rails_and_nothing_leaves_from_under_what_rests_on_it() {
    let mut w = deck();
    let [a, b] = w.bents;
    let [rl, rr] = w.rails;
    let (jb, jf, sheet, mat) = (w.id(), w.id(), w.id(), w.id());
    let sheet_name = replica::world_model::show(sheet);
    let mat_name = replica::world_model::show(mat);
    // The frame, as the shade builds it.
    accepted(w.raise(0, "bent_a", 1), "1. bent a raised and held");
    accepted(w.raise(1, "bent_b", 1), "2. bent b raised and held");
    refused(
        w.put(jb, "mars:test_joist", "joist_back", &[]),
        "support.none",
        "would rest on nothing",
        "3. a joist before any rail",
    );
    accepted(
        w.put(rl, "mars:timber_rail", "rail_l", &[a, b]),
        "4. the left rail",
    );
    refused(
        w.put(jb, "mars:test_joist", "joist_back", &[rl]),
        "support.none",
        "it needs 2 joined to parts that are held up",
        "5. a joist on one rail",
    );
    accepted(
        w.put(rr, "mars:timber_rail", "rail_r", &[a, b]),
        "6. the right rail",
    );
    accepted(w.release(0), "7. bent a let go");
    accepted(w.release(1), "8. bent b let go");
    // The deck.
    refused(
        w.put(sheet, "mars:test_sheet", "sheet", &[]),
        "support.none",
        "would rest on nothing",
        "9. the sheet before any joist",
    );
    refused(
        w.put(sheet, "mars:test_sheet", "sheet", &[rl, rr]),
        "support.none",
        "would rest on nothing",
        "10. the sheet joined to the rails, which its kind does not name",
    );
    accepted(
        w.put(jb, "mars:test_joist", "joist_back", &[rl, rr]),
        "11. the back joist across both rails",
    );
    refused(
        w.put(sheet, "mars:test_sheet", "sheet", &[jb]),
        "support.none",
        "it needs 2 joined to parts that are held up",
        "12. the sheet on one joist",
    );
    accepted(
        w.put(jf, "mars:test_joist", "joist_front", &[rl, rr]),
        "13. the front joist across both rails",
    );
    accepted(
        w.put(sheet, "mars:test_sheet", "sheet", &[jb, jf]),
        "14. the sheet on both joists",
    );
    accepted(
        w.put(mat, "mars:test_mat", "sheet", &[sheet]),
        "15. a mat on the sheet, a fifth tier",
    );
    // Nothing leaves from under what rests on it, however deep.
    refused(
        w.take_out(sheet),
        "support.none",
        &mat_name,
        "16. the sheet out from under the mat",
    );
    accepted(w.take_out(mat), "17. the mat off");
    refused(
        w.take_out(jb),
        "support.none",
        &sheet_name,
        "18. a joist out from under the sheet",
    );
    refused(
        w.take_out(rl),
        "support.none",
        "would rest on",
        "19. a rail out from under the joists",
    );
    // Taking the sheet off frees the joists, and the joists the rails.
    accepted(w.take_out(sheet), "20. the sheet off");
    accepted(w.take_out(jb), "21. the back joist out");
    accepted(w.take_out(jf), "22. the front joist out");
    refused(
        w.take_out(rl),
        "support.none",
        "held by nobody",
        "23. a rail out while nobody holds the bents",
    );
}

#[test]
fn deck_parts_of_kinds_that_name_each_other_are_held_up_by_nothing() {
    let mut w = deck();
    let [a, b] = w.bents;
    let [rl, rr] = w.rails;
    accepted(w.raise(0, "bent_a", 1), "bent a");
    accepted(w.raise(1, "bent_b", 1), "bent b");
    accepted(w.put(rl, "mars:timber_rail", "rail_l", &[a, b]), "rail l");
    accepted(w.put(rr, "mars:timber_rail", "rail_r", &[a, b]), "rail r");
    let (ra, rb) = (w.id(), w.id());
    refused(
        w.put(ra, "mars:test_ring_a", "sheet", &[]),
        "support.none",
        "would rest on nothing",
        "a ring part alone",
    );
    // Both in one change, joined to each other: each rests on the other, and neither on anything that stands.
    let both = w.put_both(
        (ra, "mars:test_ring_a", "joist_back"),
        (rb, "mars:test_ring_b", "joist_front"),
    );
    refused(
        both,
        "support.none",
        "0 held up",
        "two ring parts joined to each other",
    );
}
