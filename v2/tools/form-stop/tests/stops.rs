//! F3's acceptance (#2768), A1, A2 and A4: the stop table, every row passing. The kill rows run this crate's program
//! as the killed child and as the restarted one.

use std::path::Path;

#[test]
fn every_stop_leaves_nobody_held_nothing_reserved_a_legal_posture_and_a_named_ending() {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("form-stop");
    let (table, ok) = form_stop::table(Path::new(env!("CARGO_BIN_EXE_form-stop")), &dir);
    println!("{table}");
    assert!(ok, "a stop left something held, reserved or unnamed");
    // Six points (each of three steps' boundary and middle), three ways each.
    assert_eq!(table.lines().count(), 2 + 6 * 3);
}
