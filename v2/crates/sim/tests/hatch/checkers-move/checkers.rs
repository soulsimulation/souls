//! The checkers board's rules (English draughts), as a code hatch's module (#3713; v2/docs/bodies.md rule 10), ported
//! from today's (`packages/world-compiler/src/core-kit/checkers.ts`). Pure: no imports, no floats. The host writes the
//! declared reads at `input`, each as a count of little-endian i64 words and then the words, and calls `run(bytes)`;
//! it answers 1 (a legal move) or 0. With a yes it has written at `output`, each as a count of words and the words, the
//! board's fields after the move: `pieces`, `turn` (0 x, 1 o), `chain` (the square of a piece that must jump again,
//! 64 for none), `phase` (1 playing, 2 won) and `winner` (0 none, 1 x, 2 o). With two reads (the board's `phase` and
//! `pieces`), it is the setup: it answers 1 and writes the starting `pieces`.
//!
//! The move's reads, in the board's order: `pieces` (square, piece pairs), `turn`, `chain`, and the move's `from` and
//! `to`. A square is 0 (a1) to 63 (h8), rank * 8 + file; pieces stand on the dark squares (file + rank even, a1 dark).
//! A piece is 1 a man, 2 a king, plus 8 for o. x starts on ranks 1 to 3 and moves up. A jump, when one is open, must be
//! taken; a piece that jumped and can jump again keeps the turn; a man reaching the far rank is crowned, which ends the
//! turn; a side with no move left has lost.
#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

const WORDS: usize = 256;

#[unsafe(export_name = "input")]
pub static mut INPUT: [i64; WORDS] = [0; WORDS];

const OUT: usize = 96;

#[unsafe(export_name = "output")]
pub static mut OUTPUT: [i64; OUT] = [0; OUT];

const MAN: u8 = 1;
const KING: u8 = 2;
const O: u8 = 8;
const NONE: usize = 64;

struct Reads<'a> {
    w: &'a [i64],
    at: usize,
}

impl Reads<'_> {
    /// The next read's words.
    fn next(&mut self) -> Option<&[i64]> {
        let n = usize::try_from(*self.w.get(self.at)?).ok()?;
        let start = self.at + 1;
        let words = self.w.get(start..start.checked_add(n)?)?;
        self.at = start + n;
        Some(words)
    }

    fn one(&mut self) -> Option<i64> {
        match self.next()? {
            [v] => Some(*v),
            _ => None,
        }
    }
}

/// The fields written at `output`, each a count of words and then the words.
struct Out<'a> {
    w: &'a mut [i64; OUT],
    at: usize,
}

impl Out<'_> {
    fn field(&mut self, words: &[i64]) {
        self.w[self.at] = words.len() as i64;
        self.w[self.at + 1..self.at + 1 + words.len()].copy_from_slice(words);
        self.at += 1 + words.len();
    }

    fn pieces(&mut self, board: &[u8; 64]) {
        let mut words = [0i64; 64];
        let mut n = 0;
        for (s, p) in board.iter().enumerate() {
            if *p != 0 {
                words[n] = s as i64;
                words[n + 1] = i64::from(*p);
                n += 2;
            }
        }
        self.field(&words[..n]);
    }
}

fn file(s: usize) -> i32 {
    (s % 8) as i32
}

fn rank(s: usize) -> i32 {
    (s / 8) as i32
}

/// The dark square at file `f`, rank `r`, if it is one of the board's.
fn at(f: i32, r: i32) -> Option<usize> {
    ((0..8).contains(&f) && (0..8).contains(&r) && (f + r) % 2 == 0).then_some((r * 8 + f) as usize)
}

const START: [u8; 64] = {
    let mut b = [0u8; 64];
    let mut s = 0;
    while s < 64 {
        let (f, r) = (s % 8, s / 8);
        if (f + r) % 2 == 0 {
            if r < 3 {
                b[s] = MAN;
            } else if r > 4 {
                b[s] = MAN | O;
            }
        }
        s += 1;
    }
    b
};

/// Whether the piece on `from` may go to `to`: `Some(over)` for a step (`NONE`) or a jump over `over`, when its
/// pattern allows it (no compulsory-capture rule here).
fn pattern(board: &[u8; 64], from: usize, to: usize) -> Option<usize> {
    let p = board[from];
    if p == 0 || board[to] != 0 {
        return None;
    }
    let side = p & O;
    let (df, dr) = (file(to) - file(from), rank(to) - rank(from));
    let forward = if side == 0 { 1 } else { -1 };
    if df.abs() != dr.abs() || !(1..=2).contains(&df.abs()) || at(file(to), rank(to)).is_none() {
        return None;
    }
    if p & 7 == MAN && dr.signum() != forward {
        return None;
    }
    if df.abs() == 1 {
        return Some(NONE);
    }
    let over = at(file(from) + df / 2, rank(from) + dr / 2)?;
    (board[over] != 0 && board[over] & O != side).then_some(over)
}

/// Whether the piece on `from` can jump.
fn can_jump(board: &[u8; 64], from: usize) -> bool {
    [(-2, -2), (-2, 2), (2, -2), (2, 2)].iter().any(|(df, dr)| {
        at(file(from) + df, rank(from) + dr).is_some_and(|to| pattern(board, from, to).is_some_and(|o| o != NONE))
    })
}

/// Whether `side` has a jump open anywhere.
fn any_jump(board: &[u8; 64], side: u8) -> bool {
    (0..64).any(|s| board[s] != 0 && board[s] & O == side && can_jump(board, s))
}

/// Whether `side` has any move.
fn any_move(board: &[u8; 64], side: u8) -> bool {
    (0..64).any(|s| {
        board[s] != 0
            && board[s] & O == side
            && [(-1, -1), (-1, 1), (1, -1), (1, 1), (-2, -2), (-2, 2), (2, -2), (2, 2)]
                .iter()
                .any(|(df, dr)| at(file(s) + df, rank(s) + dr).is_some_and(|to| pattern(board, s, to).is_some()))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn run(bytes: i32) -> i64 {
    let n = usize::try_from(bytes).unwrap_or(0) / 8;
    // SAFETY: the host writes the input before the call and reads the output after it; nothing else touches them.
    let (w, out) = unsafe { (&*(&raw const INPUT), &mut *(&raw mut OUTPUT)) };
    let mut out = Out { w: out, at: 0 };
    let w = &w[..n.min(WORDS)];
    let mut r = Reads { w, at: 0 };
    if r.next().is_some() && r.next().is_some() && r.next().is_none() {
        out.pieces(&START);
        return 1;
    }
    match play(w) {
        Some((board, turn, chain, winner)) => {
            out.pieces(&board);
            out.field(&[i64::from(turn != 0)]);
            out.field(&[chain as i64]);
            out.field(&[if winner == 0 { 1 } else { 2 }]);
            out.field(&[winner]);
            1
        }
        None => 0,
    }
}

/// The board after a legal move, the side to move next, the square that must jump again and the winner (0 none).
fn play(w: &[i64]) -> Option<([u8; 64], u8, usize, i64)> {
    let mut r = Reads { w, at: 0 };
    let mut board = [0u8; 64];
    let pieces = r.next()?;
    if pieces.len() % 2 != 0 {
        return None;
    }
    for pair in pieces.chunks(2) {
        let s = usize::try_from(pair[0]).ok().filter(|s| *s < 64)?;
        let p = u8::try_from(pair[1]).ok()?;
        if board[s] != 0 || at(file(s), rank(s)).is_none() || !(1..=2).contains(&(p & 7)) || p & !15 != 0 {
            return None;
        }
        board[s] = p;
    }
    let side = match r.one()? {
        0 => 0,
        1 => O,
        _ => return None,
    };
    let chain = usize::try_from(r.one()?).ok().filter(|c| *c <= NONE)?;
    let from = usize::try_from(r.one()?).ok().filter(|s| *s < 64)?;
    let to = usize::try_from(r.one()?).ok().filter(|s| *s < 64)?;
    let p = board[from];
    if p == 0 || p & O != side || (chain != NONE && from != chain) {
        return None;
    }
    let over = pattern(&board, from, to)?;
    // A jump, when one is open, must be taken; mid-chain only the jumping piece's.
    if over == NONE && (chain != NONE || any_jump(&board, side)) {
        return None;
    }
    board[to] = p;
    board[from] = 0;
    if over != NONE {
        board[over] = 0;
    }
    let last = if side == 0 { 7 } else { 0 };
    let crowned = p & 7 == MAN && rank(to) == last;
    if crowned {
        board[to] = KING | side;
    }
    if over != NONE && !crowned && can_jump(&board, to) {
        return Some((board, side, to, 0));
    }
    let next = side ^ O;
    let winner = if any_move(&board, next) { 0 } else if side == 0 { 1 } else { 2 };
    Some((board, next, NONE, winner))
}
