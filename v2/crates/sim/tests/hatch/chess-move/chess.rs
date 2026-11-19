//! The chess-move check, as a code hatch's module (Engine v2 F8, #2823; v2/docs/bodies.md rule 10). Pure: no imports,
//! no floats. The host writes the declared reads at `input`, each as a count of little-endian i64 words and then the
//! words, and calls `run(bytes)`; it answers 1 (a legal move) or 0.
//!
//! The reads, in the chess table's order: `pieces` (square, piece pairs), `turn` (0 white, 1 black), `en_passant` (the
//! square a pawn may take on, 64 for none), `castling` (bits: 1 white king side, 2 white queen side, 4 and 8 black's),
//! and the move's `from`, `to` and `promotion` (0, or 2 to 5). A square is 0 (a1) to 63 (h8); a piece is 1 pawn,
//! 2 knight, 3 bishop, 4 rook, 5 queen, 6 king, plus 8 for black. A move that leaves its own king attacked is refused.
#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

const WORDS: usize = 256;

#[unsafe(export_name = "input")]
pub static mut INPUT: [i64; WORDS] = [0; WORDS];

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

#[unsafe(no_mangle)]
pub extern "C" fn run(bytes: i32) -> i64 {
    let n = usize::try_from(bytes).unwrap_or(0) / 8;
    // SAFETY: the host writes the input before the call; nothing else touches it.
    let w = unsafe { &*(&raw const INPUT) };
    i64::from(check(&w[..n.min(WORDS)]).unwrap_or(false))
}

fn check(w: &[i64]) -> Option<bool> {
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
    Some(legal(&board, side, ep, castling, from, to, promotion))
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

fn legal(board: &[u8; 64], side: u8, ep: i64, castling: i64, from: usize, to: usize, promotion: u8) -> bool {
    let p = board[from];
    if p == 0 || p & BLACK != side || from == to || (board[to] != 0 && board[to] & BLACK == side) {
        return false;
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
            if !ok || promotes != (2..=5).contains(&promotion) || (!promotes && promotion != 0) {
                return false;
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
                return false;
            }
            after[rook] = 0;
            after[through] = R | side;
        }
        _ => {
            if promotion != 0 || !reaches(board, p, from, to) {
                return false;
            }
        }
    }
    match (0..64).find(|s| after[*s] == (K | side)) {
        Some(king) => !attacked(&after, king, enemy),
        None => true,
    }
}
