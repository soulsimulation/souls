//! The chess table's rules, as a code hatch's module (Engine v2 F8, #2823; #3713; v2/docs/bodies.md rule 10). Pure: no
//! imports, no floats. The host writes the declared reads at `input`, each as a count of little-endian i64 words and
//! then the words, and calls `run(bytes)`; it answers 1 (a legal move) or 0. With a yes it has written at `output`,
//! each as a count of words and the words, the table's fields after the move: `pieces`, `turn`, `en_passant`,
//! `castling`, `phase` (1 playing, 2 checkmate, 3 stalemate), `winner` (0 none, 1 white, 2 black) and `check` (1 when
//! the side to move is in check). With two reads (the table's `phase` and `pieces`), it is the setup: it answers 1 and
//! writes the starting `pieces`.
//!
//! The reads, in the chess table's order: `pieces` (square, piece pairs), `turn` (0 white, 1 black), `en_passant` (the
//! square a pawn may take on, 64 for none), `castling` (bits: 1 white king side, 2 white queen side, 4 and 8 black's),
//! and the move's `from`, `to` and `promotion` (0, or 2 to 5). A square is 0 (a1) to 63 (h8); a piece is 1 pawn,
//! 2 knight, 3 bishop, 4 rook, 5 queen, 6 king, plus 8 for black. A move that leaves its own king attacked is refused.
//! A pawn reaching the last rank with promotion 0 becomes a queen, as today's table does.
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

const P: u8 = 1;
const N: u8 = 2;
const B: u8 = 3;
const R: u8 = 4;
const Q: u8 = 5;
const K: u8 = 6;
const BLACK: u8 = 8;

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

fn square(v: i64) -> Option<usize> {
    usize::try_from(v).ok().filter(|s| *s < 64)
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
    match check(w) {
        Some((board, side, ep, castling)) => {
            let enemy = side ^ BLACK;
            let check = (0..64)
                .find(|s| board[*s] == (K | enemy))
                .is_some_and(|k| attacked(&board, k, side));
            let (phase, winner) = match (any_legal(&board, enemy, ep, castling), check) {
                (true, _) => (1, 0),
                (false, true) => (2, if side == 0 { 1 } else { 2 }),
                (false, false) => (3, 0),
            };
            out.pieces(&board);
            out.field(&[i64::from(enemy != 0)]);
            out.field(&[ep]);
            out.field(&[castling]);
            out.field(&[phase]);
            out.field(&[winner]);
            out.field(&[i64::from(check)]);
            1
        }
        None => 0,
    }
}

const START: [u8; 64] = {
    let back = [R, N, B, Q, K, B, N, R];
    let mut b = [0u8; 64];
    let mut f = 0;
    while f < 8 {
        b[f] = back[f];
        b[8 + f] = P;
        b[48 + f] = P | BLACK;
        b[56 + f] = back[f] | BLACK;
        f += 1;
    }
    b
};

/// Whether `side` has any legal move: each of its pieces to each square its pattern could reach, checked in full.
fn any_legal(board: &[u8; 64], side: u8, ep: i64, castling: i64) -> bool {
    (0..64).any(|from| {
        let p = board[from];
        p != 0
            && p & BLACK == side
            && (0..64).any(|to| {
                let (af, ar) = ((file(to) - file(from)).abs(), (rank(to) - rank(from)).abs());
                let near = match p & 7 {
                    P => af <= 1 && ar <= 2 && ar > 0,
                    K => ar <= 1 && af <= 2,
                    _ => reaches(board, p, from, to),
                };
                near && legal(board, side, ep, castling, from, to, 0).is_some()
            })
    })
}

/// The board after a legal move, the side that moved, and the new en passant square and castling rights.
fn check(w: &[i64]) -> Option<([u8; 64], u8, i64, i64)> {
    let mut r = Reads { w, at: 0 };
    let mut board = [0u8; 64];
    let pieces = r.next()?;
    if pieces.len() % 2 != 0 {
        return None;
    }
    for pair in pieces.chunks(2) {
        let s = square(pair[0])?;
        let p = u8::try_from(pair[1]).ok()?;
        if board[s] != 0 || !(1..=6).contains(&(p & 7)) || p & !15 != 0 {
            return None;
        }
        board[s] = p;
    }
    let side = match r.one()? {
        0 => 0,
        1 => BLACK,
        _ => return None,
    };
    let ep = r.one()?;
    let castling = r.one()?;
    let (from, to) = (square(r.one()?)?, square(r.one()?)?);
    let promotion = u8::try_from(r.one()?).ok()?;
    let after = legal(&board, side, ep, castling, from, to, promotion)?;
    let p = board[from];
    let ep = if p & 7 == P && (rank(to) - rank(from)).abs() == 2 {
        ((from + to) / 2) as i64
    } else {
        64
    };
    let mut castling = castling;
    if p & 7 == K {
        castling &= if side == 0 { !3 } else { !12 };
    }
    for (s, bit) in [(7, 1), (0, 2), (63, 4), (56, 8)] {
        if from == s || to == s {
            castling &= !bit;
        }
    }
    Some((after, side, ep, castling))
}

fn file(s: usize) -> i32 {
    (s % 8) as i32
}

fn rank(s: usize) -> i32 {
    (s / 8) as i32
}

fn at(f: i32, r: i32) -> Option<usize> {
    ((0..8).contains(&f) && (0..8).contains(&r)).then_some((r * 8 + f) as usize)
}

/// Whether the squares strictly between `a` and `b`, on one line, are empty.
fn clear(board: &[u8; 64], a: usize, b: usize) -> bool {
    let (df, dr) = ((file(b) - file(a)).signum(), (rank(b) - rank(a)).signum());
    let (mut f, mut r) = (file(a) + df, rank(a) + dr);
    while let Some(s) = at(f, r) {
        if s == b {
            return true;
        }
        if board[s] != 0 {
            return false;
        }
        f += df;
        r += dr;
    }
    false
}

/// Whether piece `p` on `from` could move to (or take on) `to` by its pattern, ignoring pawns' pushes.
fn reaches(board: &[u8; 64], p: u8, from: usize, to: usize) -> bool {
    let (df, dr) = (file(to) - file(from), rank(to) - rank(from));
    let (af, ar) = (df.abs(), dr.abs());
    match p & 7 {
        P => af == 1 && dr == if p & BLACK == 0 { 1 } else { -1 },
        N => (af == 1 && ar == 2) || (af == 2 && ar == 1),
        B => af == ar && af > 0 && clear(board, from, to),
        R => (af == 0) != (ar == 0) && clear(board, from, to),
        Q => (af == ar || af == 0 || ar == 0) && (af | ar) > 0 && clear(board, from, to),
        K => af.max(ar) == 1,
        _ => false,
    }
}

fn attacked(board: &[u8; 64], s: usize, by: u8) -> bool {
    (0..64).any(|f| board[f] != 0 && board[f] & BLACK == by && reaches(board, board[f], f, s))
}

/// The board after the move, if it is legal.
fn legal(
    board: &[u8; 64],
    side: u8,
    ep: i64,
    castling: i64,
    from: usize,
    to: usize,
    promotion: u8,
) -> Option<[u8; 64]> {
    let p = board[from];
    if p == 0 || p & BLACK != side || from == to || (board[to] != 0 && board[to] & BLACK == side) {
        return None;
    }
    let enemy = side ^ BLACK;
    let last = if side == 0 { 7 } else { 0 };
    let mut after = *board;
    after[from] = 0;
    after[to] = p;
    let (df, dr) = (file(to) - file(from), rank(to) - rank(from));
    match p & 7 {
        P => {
            let dir = if side == 0 { 1 } else { -1 };
            let start = if side == 0 { 1 } else { 6 };
            let ok = if df == 0 {
                board[to] == 0
                    && (dr == dir
                        || (dr == 2 * dir
                            && rank(from) == start
                            && board[at(file(from), rank(from) + dir).unwrap_or(from)] == 0))
            } else if df.abs() == 1 && dr == dir {
                if board[to] != 0 {
                    true
                } else if ep == to as i64 {
                    after[at(file(to), rank(from)).unwrap_or(to)] = 0;
                    true
                } else {
                    false
                }
            } else {
                false
            };
            let promotes = rank(to) == last;
            let promotion = if promotes && promotion == 0 { Q } else { promotion };
            if !ok || promotes != (2..=5).contains(&promotion) || (!promotes && promotion != 0) {
                return None;
            }
            if promotes {
                after[to] = promotion | side;
            }
        }
        K if df.abs() == 2 && dr == 0 => {
            let home = if side == 0 { 4 } else { 60 };
            let (bit, rook, through) =
                if df > 0 { (1, home + 3, home + 1) } else { (2, home - 4, home - 1) };
            let bit = if side == 0 { bit } else { bit << 2 };
            if promotion != 0
                || from != home
                || castling & bit == 0
                || board[rook] != (R | side)
                || !clear(board, from, rook)
                || attacked(board, from, enemy)
                || attacked(board, through, enemy)
            {
                return None;
            }
            after[rook] = 0;
            after[through] = R | side;
        }
        _ => {
            if promotion != 0 || !reaches(board, p, from, to) {
                return None;
            }
        }
    }
    match (0..64).find(|s| after[*s] == (K | side)) {
        Some(king) if attacked(&after, king, enemy) => None,
        _ => Some(after),
    }
}
