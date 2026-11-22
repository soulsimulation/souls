//! The code hatch in the world process (Engine v2 F8, #2823). The kit's chess table binds its move form's hatch through
//! the form runner, and a chess-move check (`hatch/chess-move`, built by its `build.sh`) runs on 1,000 generated cases
//! in `replica`'s interpreter. The cases and the world's answers are written for the daemon's and the page's runs of
//! the same WASM build (`v2/client/src/hatch`, `v2/web/src/hatch`, both run by v2/tools/ci.sh), which must give the
//! same verdicts at the same counted steps. Over its budget a hatch ends `hatch-over-budget`; a module with a float
//! instruction or an import is refused at load; a fault is contained in its call. A hatch may answer several fields
//! (#3713): an echo module's words come back as the chess table's own values, enums by name, and a word that does not
//! fit its field is refused by name. Prints the hatch uses in the kit.

use std::fs;
use std::path::{Path, PathBuf};

use replica::encode::Value as V;
use replica::hatch::{Loaded, run_cases};
use replica::host::{Answers, Hatch, Read};
use replica::ids::sha256;
use replica::rules::json::{self, Value};
use skills::form_runner::{Arg, Args, bind_hatch, hatch_no, hatch_reads, hatch_words, run_hatch};
use std::collections::BTreeMap;

const CHESS: &[u8] = include_bytes!("../../../../content/kinds/games/chess_table.wasm");
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

/// The kit's chess table, which names its rules' module by the hash of the bytes it ships beside it.
fn chess_table() -> Value {
    let text =
        fs::read_to_string(kit().join("games/chess_table.json")).expect("the kit's chess table");
    assert!(
        text.contains(&format!("prov-{}", hex(&named(CHESS)))),
        "the kit names the module it ships"
    );
    json::parse(&text).unwrap()
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
    assert_eq!((hatch.reads.len(), hatch.steps_most), (7, 1_000_000));
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
        let v = run_hatch(&hatch, &module, &entry, &case(&start(), 0, 64, 15, mv)).unwrap();
        assert_eq!(v.yes, want, "{mv:?}");
    }

    let mut r = Rng(SEED);
    let cases: Vec<Vec<V>> = (0..CASES).map(|_| generated(&mut r)).collect();
    let mut lines = String::new();
    let (mut yes, mut steps) = (0, 0);
    for (i, c) in cases.iter().enumerate() {
        let v = run_hatch(&hatch, &module, &entry, c).unwrap();
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
        let refused = run_hatch(&small, &module, &entry, c).unwrap_err();
        assert_eq!(refused.name, "hatch-over-budget", "case {i}");
        lines.push_str(&format!("{SMALL} {i} refused {}\n", refused.name));
    }
    assert_eq!(hatch_no(&hatch).detail, "why_chess");

    // The document the daemon and the page run, through the same library function, natively here.
    let words: Vec<String> = cases
        .iter()
        .map(|c| {
            let w = hatch_words(&entry, &hatch, c).unwrap();
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

/// A module of one section each of `sections`: `(id, contents)`, the size written here.
fn sections(sections: &[(u8, &[u8])]) -> Vec<u8> {
    let mut m = Vec::new();
    for (id, c) in sections {
        assert!(c.len() < 128, "one-byte sizes");
        m.push(*id);
        m.push(c.len() as u8);
        m.extend_from_slice(c);
    }
    module(&m)
}

/// A module with memory, `input` and `run: (i32) -> i64` answering `answer`, and no `output`.
fn bare(answer: u8) -> Vec<u8> {
    sections(&[
        (1, &[1, 0x60, 1, 0x7f, 1, 0x7e]),
        (3, &[1, 0]),
        (5, &[1, 0, 1]),
        (6, &[1, 0x7f, 0, 0x41, 0, 0x0b]),
        (
            7,
            &[
                3, 6, b'm', b'e', b'm', b'o', b'r', b'y', 2, 0, 5, b'i', b'n', b'p', b'u', b't', 3,
                0, 3, b'r', b'u', b'n', 0, 0,
            ],
        ),
        (10, &[1, 4, 0, 0x42, answer, 0x0b]),
    ])
}

fn nay() -> Vec<u8> {
    bare(0)
}

fn yea() -> Vec<u8> {
    bare(1)
}

/// The echo: memory, `input` at 0, `output` at 1024 and `run`, which copies its input to its output and answers 1,
/// so each read comes back as the answered field in the same place.
fn echo() -> Vec<u8> {
    sections(&[
        (1, &[1, 0x60, 1, 0x7f, 1, 0x7e]),
        (3, &[1, 0]),
        (5, &[1, 0, 1]),
        (
            6,
            &[2, 0x7f, 0, 0x41, 0, 0x0b, 0x7f, 0, 0x41, 0x80, 0x08, 0x0b],
        ),
        (
            7,
            &[
                4, 6, b'm', b'e', b'm', b'o', b'r', b'y', 2, 0, 5, b'i', b'n', b'p', b'u', b't', 3,
                0, 6, b'o', b'u', b't', b'p', b'u', b't', 3, 1, 3, b'r', b'u', b'n', 0, 0,
            ],
        ),
        (
            10,
            &[
                1, 15, 0, 0x41, 0x80, 0x08, 0x41, 0, 0x20, 0, 0xfc, 0x0a, 0, 0, 0x42, 1, 0x0b,
            ],
        ),
    ])
}

#[test]
fn a_hatch_answers_several_fields_checked_against_their_definitions() {
    let entry = chess_table();
    let (pieces, turn, castling, en_passant) = (31, 28, 32, 33);
    let bytes = echo();
    let module = Loaded::load(&bytes, &named(&bytes)).expect("the echo loads");
    let hatch = |reads: &[u64], answers: &[u64]| Hatch {
        module: named(&bytes),
        reads: reads.iter().map(|f| Read::Field(*f)).collect(),
        steps_most: 1000,
        answers: Answers::Fields(answers.to_vec()),
        why: replica::encode::Name::new("why_chess").unwrap(),
    };
    let board: Vec<V> = start()
        .iter()
        .take(3)
        .map(|&(s, p)| V::Map([(1, V::Uint(s)), (2, V::Uint(p))].into()))
        .collect();
    let black = V::Text(replica::encode::Name::new("eden:black").unwrap());
    let values = [V::Array(board), black.clone(), V::Uint(9)];
    let h = hatch(&[pieces, turn, castling], &[pieces, turn, castling]);
    assert_eq!(
        hatch_words(&entry, &h, &values).unwrap(),
        vec![vec![0, 4, 8, 1, 48, 9], vec![1], vec![9]],
        "an enum is read as its place in its values"
    );
    let v = run_hatch(&h, &module, &entry, &values).unwrap();
    assert!(v.yes);
    assert_eq!(
        v.sets,
        vec![
            (pieces, values[0].clone()),
            (turn, black),
            (castling, V::Uint(9))
        ],
        "the words come back as the fields' own values"
    );

    // A word that does not fit the field it answers is refused by name: past its bounds, not one of an enum's
    // values, the wrong number of words.
    let refused = |reads: &[u64], answers: &[u64], values: &[V]| {
        run_hatch(&hatch(reads, answers), &module, &entry, values)
            .map(|_| ())
            .map_err(|r| r.name)
    };
    assert_eq!(
        refused(&[en_passant], &[castling], &[V::Uint(64)]),
        Err("hatch-answer-malformed")
    );
    assert_eq!(
        refused(&[castling], &[turn], &[V::Uint(15)]),
        Err("hatch-answer-malformed")
    );
    assert_eq!(
        refused(&[pieces], &[turn], &values[..1]),
        Err("hatch-answer-malformed")
    );
    // A module with no output, as a fields hatch, is refused by name; a no answers no fields.
    let mut silent = h.clone();
    silent.module = named(&nay());
    let nay_module = Loaded::load(&nay(), &silent.module).unwrap();
    assert_eq!(
        run_hatch(&silent, &nay_module, &entry, &values).map(|v| (v.yes, v.sets.len())),
        Ok((false, 0))
    );
    let mut yes = silent.clone();
    yes.module = named(&yea());
    assert_eq!(
        run_hatch(
            &yes,
            &Loaded::load(&yea(), &yes.module).unwrap(),
            &entry,
            &values
        )
        .map_err(|r| r.name),
        Err("hatch-module-shape")
    );

    // The entry's move names the fields it answers.
    let bound = bind_hatch(&entry, "move_white").unwrap().unwrap();
    assert_eq!(
        bound.answers,
        Answers::Fields(vec![pieces, turn, en_passant, castling, 29, 30, 34])
    );
    println!(
        "fields: echo of {} bytes answered pieces, turn and castling as their values in {} steps; \
         misfits refused hatch-answer-malformed",
        bytes.len(),
        v.steps
    );
}

/// A square's number from its name, `e2` 12.
fn sq(name: &str) -> i64 {
    let b = name.as_bytes();
    i64::from(b[1] - b'1') * 8 + i64::from(b[0] - b'a')
}

#[test]
fn the_chess_table_sets_up_moves_its_pieces_and_ends_in_checkmate() {
    let entry = chess_table();
    let module = Loaded::load(CHESS, &named(CHESS)).expect("the kit's module loads by its hash");
    let mut state: BTreeMap<u64, V> = BTreeMap::new();
    let mut steps = Vec::new();
    let mut act = |form: &str, mv: Option<(&str, &str)>, state: &mut BTreeMap<u64, V>| {
        let h = bind_hatch(&entry, form).unwrap().expect("a hatch");
        let mut args = Args::new();
        if let Some((from, to)) = mv {
            args.insert("from".into(), Arg::Int(sq(from)));
            args.insert("to".into(), Arg::Int(sq(to)));
            args.insert("promotion".into(), Arg::Int(0));
        }
        let reads = hatch_reads(&entry, &h, state, &args).map_err(|r| r.name)?;
        let v = run_hatch(&h, &module, &entry, &reads).map_err(|r| r.name)?;
        if !v.yes {
            return Err(hatch_no(&h).name);
        }
        steps.push(v.steps);
        for (f, value) in v.sets {
            state.insert(f, value);
        }
        Ok(())
    };
    let named_value = |s: &str| V::Text(replica::encode::Name::new(s).unwrap());
    let piece_on = |state: &BTreeMap<u64, V>, square: u64| match &state[&31] {
        V::Array(rs) => rs.iter().find_map(|r| match r {
            V::Map(m) if m[&1] == V::Uint(square) => Some(m[&2].clone()),
            _ => None,
        }),
        _ => None,
    };
    act("begin", None, &mut state).unwrap();
    assert!(
        matches!(&state[&31], V::Array(rs) if rs.len() == 32),
        "the setup"
    );
    assert_eq!(
        piece_on(&state, 4),
        Some(V::Uint(6)),
        "the white king on e1"
    );
    // The fool's mate, with an illegal move refused by name on the way.
    act("move_white", Some(("f2", "f3")), &mut state).unwrap();
    assert_eq!(state[&28], named_value("eden:black"));
    assert_eq!(
        (piece_on(&state, 13), piece_on(&state, 21)),
        (None, Some(V::Uint(1)))
    );
    act("move_black", Some(("e7", "e5")), &mut state).unwrap();
    assert_eq!(state[&33], V::Uint(44), "e6 may be taken en passant");
    assert_eq!(
        act("move_white", Some(("e1", "e3")), &mut state),
        Err("hatch-said-no")
    );
    act("move_white", Some(("g2", "g4")), &mut state).unwrap();
    act("move_black", Some(("d8", "h4")), &mut state).unwrap();
    assert_eq!(
        piece_on(&state, 31),
        Some(V::Uint(13)),
        "the black queen on h4"
    );
    assert_eq!(state[&29], named_value("eden:checkmate"));
    assert_eq!(state[&30], named_value("eden:black"));
    assert_eq!(state[&34], V::Uint(1), "white is in check");
    assert_eq!(
        act("move_white", Some(("e2", "e3")), &mut state),
        Err("hatch-said-no"),
        "no move gets a mated king out"
    );
    println!(
        "chess table: setup and the fool's mate in {steps:?} steps; e1e3 refused hatch-said-no (why_chess)"
    );
}
