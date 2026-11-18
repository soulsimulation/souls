//! The packing inside a stream part (Engine v2 V1, #2710): a small LZ77 written out here, so the same code packs in
//! the world and unpacks in the WASM library, and `replica` gains no dependency. Fact 8 of the V lane's notes:
//! compression is inside the file, because a trained dictionary cannot travel over HTTP to every browser.
//!
//! Format: `varint(raw length)`, then sequences of `varint(literal count)`, the literals, and `varint(match length −
//! 3)` with `varint(offset)` after it; a match code of 0 ends the stream. Lengths and offsets are checked against what
//! is written, and the raw length against [`MOST`], before anything is reserved.

use crate::effects::Refusal;

/// The most bytes a packed part may unpack to.
pub const MOST: usize = 64 << 20;
const MIN_MATCH: usize = 4;
const WINDOW: usize = 1 << 16;
const TABLE_BITS: u32 = 14;

fn refuse<T>(detail: &str) -> Result<T, Refusal> {
    Err(Refusal {
        name: "stream-packing",
        detail: detail.into(),
    })
}

fn put(out: &mut Vec<u8>, mut n: usize) {
    while n >= 0x80 {
        out.push((n as u8) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}

fn get(bytes: &[u8], at: &mut usize) -> Result<usize, Refusal> {
    let mut n: usize = 0;
    for shift in (0..usize::BITS).step_by(7) {
        let Some(&b) = bytes.get(*at) else {
            return refuse("a length runs past the end");
        };
        *at += 1;
        let part = usize::from(b & 0x7f);
        if (part << shift) >> shift != part {
            return refuse("a length is too large");
        }
        n |= part << shift;
        if b & 0x80 == 0 {
            return Ok(n);
        }
    }
    refuse("a length is too long")
}

fn key(b: &[u8]) -> usize {
    let v = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
    (v.wrapping_mul(0x9E37_79B1) >> (32 - TABLE_BITS)) as usize
}

/// Packs `raw`.
pub fn pack(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() / 2 + 16);
    put(&mut out, raw.len());
    let mut table = vec![usize::MAX; 1 << TABLE_BITS];
    let (mut i, mut lit) = (0, 0);
    while i + MIN_MATCH <= raw.len() {
        let k = key(&raw[i..]);
        let cand = table[k];
        table[k] = i;
        if cand != usize::MAX
            && i - cand <= WINDOW
            && raw[cand..cand + MIN_MATCH] == raw[i..i + MIN_MATCH]
        {
            let mut len = MIN_MATCH;
            while i + len < raw.len() && raw[cand + len] == raw[i + len] {
                len += 1;
            }
            put(&mut out, i - lit);
            out.extend_from_slice(&raw[lit..i]);
            put(&mut out, len - 3);
            put(&mut out, i - cand);
            i += len;
            lit = i;
        } else {
            i += 1;
        }
    }
    put(&mut out, raw.len() - lit);
    out.extend_from_slice(&raw[lit..]);
    put(&mut out, 0);
    out
}

/// Unpacks what [`pack`] wrote, or refuses it by name.
pub fn unpack(packed: &[u8]) -> Result<Vec<u8>, Refusal> {
    let mut at = 0;
    let size = get(packed, &mut at)?;
    if size > MOST {
        return refuse("the unpacked size is over the most");
    }
    let mut out = Vec::with_capacity(size.min(packed.len().saturating_mul(16)));
    loop {
        let n = get(packed, &mut at)?;
        let end = at.checked_add(n).filter(|e| *e <= packed.len());
        let Some(end) = end.filter(|_| out.len() + n <= size) else {
            return refuse("literals run past the end");
        };
        out.extend_from_slice(&packed[at..end]);
        at = end;
        let code = get(packed, &mut at)?;
        if code == 0 {
            break;
        }
        let len = code + 3;
        let offset = get(packed, &mut at)?;
        if offset == 0 || offset > out.len() || out.len() + len > size {
            return refuse("a match points outside what is written");
        }
        let from = out.len() - offset;
        for j in 0..len {
            let b = out[from + j];
            out.push(b);
        }
    }
    if at != packed.len() || out.len() != size {
        return refuse("the packed bytes do not end where they say");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{pack, unpack};

    #[test]
    fn round_trips_and_refuses_damage() {
        let mut big = Vec::new();
        for i in 0..5000u32 {
            big.extend_from_slice(&(i % 37).to_le_bytes());
            big.extend_from_slice(b"aaaaaaaaab");
        }
        for raw in [&b""[..], b"a", b"abcd", b"abcabcabcabcabcabc", &big] {
            let p = pack(raw);
            assert_eq!(unpack(&p).expect("unpacks"), raw);
        }
        assert!(pack(&big).len() < big.len() / 4);
        let p = pack(&big);
        for cut in [0, 1, p.len() / 2, p.len() - 1] {
            assert!(unpack(&p[..cut]).is_err(), "a cut at {cut} is refused");
        }
        assert!(unpack(&[0xff, 0xff, 0xff, 0xff, 0x7f]).is_err());
    }
}
