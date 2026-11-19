//! The code hatch in the world process (Engine v2 F8, #2823). The kit's chess table binds its move form's hatch through
//! the form runner, and a chess-move check (`hatch/chess-move`, built by its `build.sh`) runs on 1,000 generated cases
//! in `replica`'s interpreter. The cases and the world's answers are written for the daemon's and the page's runs of
//! the same WASM build (`v2/client/src/hatch`, `v2/web/src/hatch`, both run by v2/tools/ci.sh), which must give the
//! same verdicts at the same counted steps. Over its budget a hatch ends `hatch-over-budget`; a module with a float
//! instruction or an import is refused at load; a fault is contained in its call. Prints the hatch uses in the kit.

use std::fs;
use std::path::{Path, PathBuf};

use replica::encode::Value as V;
use replica::hatch::{Loaded, run_cases};
use replica::ids::sha256;
use replica::rules::json::{self, Value};
use skills::form_runner::{bind_hatch, hatch_no, hatch_words, run_hatch};

const CHESS: &[u8] = include_bytes!("hatch/chess-move.wasm");
const SEED: u64 = 2823;
const CASES: usize = 1000;
/// A budget every case exceeds, for A2.
const SMALL: u64 = 100;

fn named(bytes: &[u8]) -> Vec<u8> {
    let mut m = vec![0x12, 32];
    m.extend(sha256(bytes));
    m
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn kit() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds")
}

/// The kit's chess table, its hatch's stand-in module name replaced by the check's hash.
fn chess_table() -> Value {
    let text =
        fs::read_to_string(kit().join("games/chess_table.json")).expect("the kit's chess table");
    let stand_in = format!("prov-1220{}", "0".repeat(64));
    assert!(text.contains(&stand_in), "the kit names a stand-in module");
    json::parse(&text.replace(&stand_in, &format!("prov-{}", hex(&named(CHESS))))).unwrap()
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// One case's reads, in the chess table's order: pieces, turn, en passant, castling, from, to, promotion.
fn case(pieces: &[(u64, u64)], turn: u64, ep: u64, castling: u64, mv: (u64, u64, u64)) -> Vec<V> {
    let pieces = pieces
        .iter()
        .map(|&(s, p)| V::Map([(1, V::Uint(s)), (2, V::Uint(p))].into()))
        .collect();
    [
        V::Array(pieces),
        V::Uint(turn),
        V::Uint(ep),
        V::Uint(castling),
        V::Uint(mv.0),
        V::Uint(mv.1),
        V::Uint(mv.2),
    ]
    .into()
}

fn start() -> Vec<(u64, u64)> {
    let back = [4, 2, 3, 5, 6, 3, 2, 4];
    let mut p = Vec::new();
    for f in 0..8u64 {
        p.extend([
            (f, back[f as usize]),
            (8 + f, 1),
            (48 + f, 9),
            (56 + f, back[f as usize] + 8),
        ]);
    }
    p
}

/// A generated position and move: both kings, up to 14 other pieces (no pawn on its side's back rank), and a move
/// from one of the side's pieces, half the time to a square near it.
fn generated(r: &mut Rng) -> Vec<V> {
    let mut board = [0u64; 64];
    let mut put = |r: &mut Rng, piece: u64| loop {
        let s = r.below(64) as usize;
        let rank = s / 8;
        if board[s] == 0 && !(piece & 7 == 1 && (rank == 0 || rank == 7)) {
            board[s] = piece;
            return;
        }
    };
    put(r, 6);
    put(r, 14);
    for _ in 0..r.below(15) {
        let p = 1 + r.below(5) + 8 * r.below(2);
        put(r, p);
    }
    let turn = r.below(2);
    let own: Vec<u64> = (0..64)
        .filter(|&s| board[s as usize] != 0 && (board[s as usize] & 8 == 8) == (turn == 1))
        .collect();
    let from = own[r.below(own.len() as u64) as usize];
    let to = if r.below(2) == 0 {
        r.below(64)
    } else {
        let (f, k) = (
            (from % 8) as i64 + r.below(5) as i64 - 2,
            (from / 8) as i64 + r.below(5) as i64 - 2,
        );
        if (0..8).contains(&f) && (0..8).contains(&k) {
            (k * 8 + f) as u64
        } else {
            r.below(64)
        }
    };
    let last = if turn == 0 { 7 } else { 0 };
    let promotion = if board[from as usize] & 7 == 1 && to / 8 == last {
        2 + r.below(4)
    } else {
        0
    };
    let ep = if r.below(4) == 0 {
        16 + r.below(32)
    } else {
        64
    };
    let pieces: Vec<(u64, u64)> = (0..64)
        .filter(|&s| board[s as usize] != 0)
        .map(|s| (s, board[s as usize]))
        .collect();
    case(&pieces, turn, ep, r.below(16), (from, to, promotion))
}

#[test]
fn a1_a2_the_chess_check_through_the_form_runner_and_its_table_for_the_daemon_and_the_page() {
    let entry = chess_table();
    let hatch = bind_hatch(&entry, "move_white")
        .unwrap()
        .expect("move_white has a hatch");
    assert_eq!((hatch.reads.len(), hatch.steps_most), (7, 20_000));
    let module = Loaded::load(CHESS, &hatch.module).expect("the check loads by its hash");

    // A few known positions first: the check is a chess-move check.
    let known = [
        ((12, 28, 0), true),  // e2e4
        ((12, 36, 0), false), // e2e5
        ((6, 21, 0), true),   // Ng1f3
        ((4, 12, 0), false),  // Ke1e2 onto its own pawn
        ((3, 39, 0), false),  // Qd1h5 through its own pawn
    ];
    for (mv, want) in known {
        let v = run_hatch(&hatch, &module, &case(&start(), 0, 64, 15, mv)).unwrap();
        assert_eq!(v.yes, want, "{mv:?}");
    }

    let mut r = Rng(SEED);
    let cases: Vec<Vec<V>> = (0..CASES).map(|_| generated(&mut r)).collect();
    let mut lines = String::new();
    let (mut yes, mut steps) = (0, 0);
    for (i, c) in cases.iter().enumerate() {
        let v = run_hatch(&hatch, &module, c).unwrap();
        yes += usize::from(v.yes);
        steps += v.steps;
        lines.push_str(&format!(
            "{} {i} {} {}\n",
            hatch.steps_most,
            u8::from(v.yes),
            v.steps
        ));
    }
    assert!(
        (50..=CASES - 50).contains(&yes),
        "a mix of yes and no: {yes} yes"
    );
    // A2: over its budget the same check ends by name, every case.
    let mut small = hatch.clone();
    small.steps_most = SMALL;
    for (i, c) in cases.iter().enumerate() {
        let refused = run_hatch(&small, &module, c).unwrap_err();
        assert_eq!(refused.name, "hatch-over-budget", "case {i}");
        lines.push_str(&format!("{SMALL} {i} refused {}\n", refused.name));
    }
    assert_eq!(hatch_no(&hatch).detail, "why_chess");

    // The document the daemon and the page run, through the same library function, natively here.
    let words: Vec<String> = cases
        .iter()
        .map(|c| {
            let w = hatch_words(&hatch, c).unwrap();
            format!(
                "[{}]",
                w.iter()
                    .map(|r| format!("{r:?}").replace(' ', ""))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        })
        .collect();
    let doc = format!(
        "{{\"module\":\"{}\",\"named\":\"{}\",\"budgets\":[{},{SMALL}],\"cases\":[{}]}}",
        hex(CHESS),
        hex(&hatch.module),
        hatch.steps_most,
        words.join(",")
    );
    assert_eq!(
        run_cases(&doc),
        lines,
        "the library's table equals the form runner's"
    );
    let out = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("hatch");
    fs::create_dir_all(&out).unwrap();
    fs::write(out.join("run.json"), &doc).unwrap();
    fs::write(out.join("native.txt"), &lines).unwrap();
    println!(
        "world process: {CASES} cases, {yes} yes, {} no, {steps} steps in all, table {}; at {SMALL} steps all {CASES} \
         hatch-over-budget; module {} bytes; wrote target/tmp/hatch/run.json and native.txt",
        CASES - yes,
        hex(&sha256(lines.as_bytes())[..8]),
        CHESS.len()
    );
}

/// A module of the given sections after the header.
fn module(sections: &[u8]) -> Vec<u8> {
    let mut m = b"\0asm\x01\0\0\0".to_vec();
    m.extend_from_slice(sections);
    m
}

#[test]
fn a3_a_float_instruction_or_an_import_is_refused_at_load_and_a_fault_is_contained() {
    let load = |b: &[u8]| Loaded::load(b, &named(b)).map(|_| ()).map_err(|r| r.name);
    // (func (result i32) f32.const 0 i32.trunc_f32_s)
    let float = module(&[
        1, 5, 1, 0x60, 0, 1, 0x7f, 3, 2, 1, 0, 10, 10, 1, 8, 0, 0x43, 0, 0, 0, 0, 0xa8, 0x0b,
    ]);
    // (import "env" "f" (func))
    let import = module(&[
        1, 4, 1, 0x60, 0, 0, 2, 9, 1, 3, b'e', b'n', b'v', 1, b'f', 0, 0,
    ]);
    // memory, input and run: (i32) -> i64, whose body is `unreachable`.
    let trap = module(&[
        1, 6, 1, 0x60, 1, 0x7f, 1, 0x7e, 3, 2, 1, 0, 5, 3, 1, 0, 1, 6, 6, 1, 0x7f, 0, 0x41, 0,
        0x0b, 7, 24, 3, 6, b'm', b'e', b'm', b'o', b'r', b'y', 2, 0, 5, b'i', b'n', b'p', b'u',
        b't', 3, 0, 3, b'r', b'u', b'n', 0, 0, 10, 5, 1, 3, 0, 0, 0x0b,
    ]);
    assert_eq!(load(&float), Err("hatch-module-float"));
    assert_eq!(load(&import), Err("hatch-module-imports"));
    assert_eq!(load(b"not wasm"), Err("hatch-module-invalid"));
    assert_eq!(
        Loaded::load(CHESS, &named(b"another module"))
            .map(|_| ())
            .map_err(|r| r.name),
        Err("hatch-module-hash-differs")
    );
    // A fault ends its own call by name, and the next call runs.
    let faulty = Loaded::load(&trap, &named(&trap)).unwrap();
    assert_eq!(
        faulty.run(&[vec![1]], 1000).map_err(|r| r.name),
        Err("hatch-trapped")
    );
    let chess = Loaded::load(CHESS, &named(CHESS)).unwrap();
    assert!(chess.run(&[vec![]], 1000).is_ok());
    println!(
        "load refusals: float {:?}, import {:?}; a trap is hatch-trapped and the next call runs",
        load(&float),
        load(&import)
    );
}

#[test]
fn a4_the_hatch_uses_in_the_kit_are_counted() {
    let (mut kinds, mut forms, mut uses) = (0, 0, Vec::new());
    let mut dirs = vec![kit()];
    while let Some(d) = dirs.pop() {
        for e in fs::read_dir(&d).expect("the kit").map(Result::unwrap) {
            let p = e.path();
            if p.is_dir() {
                dirs.push(p);
            } else if p.extension().is_some_and(|x| x == "json") {
                let Ok(entry) = json::parse(&fs::read_to_string(&p).unwrap()) else {
                    continue;
                };
                let Some(Value::Obj(fs)) = entry.get("forms") else {
                    continue;
                };
                kinds += 1;
                for (name, f) in fs {
                    forms += 1;
                    if f.get("hatch").is_some() {
                        uses.push(format!(
                            "{}.{name}",
                            entry.get("kind").and_then(Value::str).unwrap_or("?")
                        ));
                    }
                }
            }
        }
    }
    uses.sort();
    assert!(!uses.is_empty() && kinds > 0);
    println!(
        "hatch uses in the kit: {} of {forms} forms in {kinds} kinds: {}",
        uses.len(),
        uses.join(", ")
    );
}
