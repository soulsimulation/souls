//! The fact sheet on a short recording (Engine v2 V10, #2720): the live parts and the history bundles give equal
//! sheets (A1), a body moved 30 cm is reported at its second (A2), and no sheet holds words (A4). The hour is
//! `cargo run -p facts --release -- hour <dir>`.

use std::path::PathBuf;

use facts::{Side, fault, record, scan, sheet};
use replica::facts::{compare, show};

#[test]
fn live_and_history_sheets_agree_and_a_moved_body_is_caught() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("facts-test");
    let _ = std::fs::remove_dir_all(&dir);
    let bodies = record(&dir, 20).expect("recorded");
    assert_eq!(bodies.len(), 100, "100 acting bodies");

    let (live, _) = sheet(&dir, Side::Live, 0, 20, None).expect("the live sheet");
    let (history, _) = sheet(&dir, Side::History, 0, 20, None).expect("the history sheet");
    assert_eq!(compare(&live, &history).expect("compared"), None, "A1");

    let f = fault(&dir, &dir.join("fault"), 10_250_000).expect("a fault");
    let (faulted, _) = sheet(&dir.join("fault"), Side::History, 0, 20, None).expect("faulted");
    let d = compare(&live, &faulted)
        .expect("compared")
        .expect("the fault is caught");
    assert_eq!(d.second, f.second, "A2: {d:?} for {f:?}");
    assert!(d.what.contains(&show(f.body)), "A2: {d:?} names the body");

    for s in [&live, &history] {
        let s = scan(s).expect("scanned");
        assert!(s.words_found.is_empty(), "A4: {:?}", s.words_found);
        assert!(s.speech_acts > 0, "speech is on the sheet, by reference");
        assert!(
            s.texts.iter().all(|t| t.starts_with("souls:")),
            "names only: {:?}",
            s.texts
        );
    }
}
