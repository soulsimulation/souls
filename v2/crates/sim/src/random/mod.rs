//! The world's random source (Engine v2 K12, #2675). Every draw is keyed by the world's seed (kept in its
//! checkpoint), the node it is for, a purpose and a counter, so no draw depends on the order systems or threads
//! ran in, and one checkpoint and one recording of inputs give the same draws in every run of one build.
//!
//! **The algorithm, by name** ([`ALGORITHM`]): the stream key is SHA-256 over the seed's length (`u64`,
//! little-endian), the seed, the node's T0 bytes and the purpose's ASCII bytes; a draw is ChaCha8 (ChaCha with
//! 8 rounds, RFC 8439's block with its 20 rounds cut to 8) of that key, block counter = the draw's counter, nonce
//! zero. [`Random::draw`] is the block's first 64 bits, little-endian; [`Random::below`] takes the block's 64-bit
//! words in turn and rejects the few that would bias the result. Written out here, as `replica` writes SHA-256, so
//! no crate's version can change a draw (`StdRng` and `SmallRng` may change between `rand` versions), and a draw is
//! never a `usize`, whose width is the machine's.

use replica::encode::encode;
use replica::ids::{Id, sha256};

/// The name of the algorithm a world's draws use. A change to it is a new name.
pub const ALGORITHM: &str =
    "souls-random/1: ChaCha8, key SHA-256(seed, node, purpose), block counter = counter";

/// One ChaCha block of `rounds` rounds (RFC 8439 section 2.3): 64 bytes as sixteen 32-bit words.
pub fn chacha_block(key: &[u8; 32], counter: u32, nonce: &[u8; 12], rounds: u32) -> [u32; 16] {
    let le = |b: &[u8]| u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
    let mut s = [0u32; 16];
    s[..4].copy_from_slice(&[0x6170_7865, 0x3320_646e, 0x7962_2d32, 0x6b20_6574]);
    for i in 0..8 {
        s[4 + i] = le(&key[4 * i..]);
    }
    s[12] = counter;
    for i in 0..3 {
        s[13 + i] = le(&nonce[4 * i..]);
    }
    let mut x = s;
    let q = |x: &mut [u32; 16], a: usize, b: usize, c: usize, d: usize| {
        x[a] = x[a].wrapping_add(x[b]);
        x[d] = (x[d] ^ x[a]).rotate_left(16);
        x[c] = x[c].wrapping_add(x[d]);
        x[b] = (x[b] ^ x[c]).rotate_left(12);
        x[a] = x[a].wrapping_add(x[b]);
        x[d] = (x[d] ^ x[a]).rotate_left(8);
        x[c] = x[c].wrapping_add(x[d]);
        x[b] = (x[b] ^ x[c]).rotate_left(7);
    };
    for _ in 0..rounds / 2 {
        q(&mut x, 0, 4, 8, 12);
        q(&mut x, 1, 5, 9, 13);
        q(&mut x, 2, 6, 10, 14);
        q(&mut x, 3, 7, 11, 15);
        q(&mut x, 0, 5, 10, 15);
        q(&mut x, 1, 6, 11, 12);
        q(&mut x, 2, 7, 8, 13);
        q(&mut x, 3, 4, 9, 14);
    }
    for (o, i) in x.iter_mut().zip(s) {
        *o = o.wrapping_add(i);
    }
    x
}

/// The 96-bit nonce that carries `counter`'s high 32 bits (little-endian; the rest zero), made from the counter alone.
fn nonce_of(counter: u64) -> [u8; 12] {
    let wide = u128::from(counter >> 32).to_le_bytes();
    std::array::from_fn(|i| wide[i])
}

/// A world's random source: its seed, from its checkpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Random {
    seed: Vec<u8>,
}

impl Random {
    pub fn new(seed: &[u8]) -> Random {
        Random {
            seed: seed.to_vec(),
        }
    }

    pub fn seed(&self) -> &[u8] {
        &self.seed
    }

    fn block(&self, node: Id, purpose: &str, counter: u64) -> [u32; 16] {
        let mut k = (self.seed.len() as u64).to_le_bytes().to_vec();
        k.extend_from_slice(&self.seed);
        k.extend_from_slice(&encode(&node.to_value()).expect("an id encodes"));
        k.extend_from_slice(purpose.as_bytes());
        // ChaCha's 32-bit block counter and its 96-bit nonce together carry the 64-bit counter: the nonce is the
        // counter's high 32 bits, little-endian, widened to 96 bits.
        chacha_block(&sha256(&k), counter as u32, &nonce_of(counter), 8)
    }

    /// The draw for `node`, `purpose` and `counter`: 64 bits.
    pub fn draw(&self, node: Id, purpose: &str, counter: u64) -> u64 {
        let b = self.block(node, purpose, counter);
        b[0] as u64 | (b[1] as u64) << 32
    }

    /// A draw in `0..n` (`n` at least 1), without bias: the block's words in turn, each kept only below the largest
    /// multiple of `n`; if all eight fall above it (a chance below 2^-64 for any `n`), the last is taken modulo `n`.
    pub fn below(&self, node: Id, purpose: &str, counter: u64, n: u64) -> u64 {
        let n = n.max(1);
        let zone = u64::MAX - (u64::MAX % n + 1) % n;
        let b = self.block(node, purpose, counter);
        let mut v = 0;
        for w in b.chunks(2) {
            v = w[0] as u64 | (w[1] as u64) << 32;
            if v <= zone {
                break;
            }
        }
        v % n
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::ids::Scope;

    #[test]
    fn chacha20_matches_rfc_8439() {
        // RFC 8439 section 2.3.2: the block function's test vector, with 20 rounds.
        let key: [u8; 32] = std::array::from_fn(|i| i as u8);
        // The RFC's nonce, read from its fixture (hex) so the vector stays the RFC's exactly.
        let hex = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/random/rfc8439-nonce.hex"
        ))
        .expect("the RFC 8439 nonce fixture");
        let hex = hex.trim();
        let nonce: [u8; 12] =
            std::array::from_fn(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).expect("hex"));
        let want = [
            0xe4e7f110, 0x15593bd1, 0x1fdd0f50, 0xc47120a3, 0xc7f4d1c7, 0x0368c033, 0x9aaa2204,
            0x4e6cd4c3, 0x466482d2, 0x09aa9f07, 0x05d7c214, 0xa2028bd9, 0xd19c12b5, 0xb94e16de,
            0xe883d0cb, 0x4e3c50a2,
        ];
        assert_eq!(chacha_block(&key, 1, &nonce, 20), want);
    }

    #[test]
    fn draws_past_the_32_bit_block_counter_are_pinned() {
        // The counter's high bits ride in the nonce: pinned at counters that set them, so the nonce never changes.
        let node = Id::new(Scope([0xee; 16]), 7).unwrap();
        let r = Random::new(b"seed");
        for (c, want) in [
            (1u64 << 32, 0xde96_372f_da89_a82e_u64),
            ((7u64 << 32) | 3, 0x4576_aed4_c4a0_b660),
            (u64::MAX, 0x6a9a_8440_77c5_3837),
        ] {
            assert_eq!(r.draw(node, "place", c), want, "counter {c:#x}");
        }
    }

    #[test]
    fn a_draw_is_keyed_by_seed_node_purpose_and_counter_alone() {
        let node = Id::new(Scope([0xee; 16]), 7).unwrap();
        let other = Id::new(Scope([0xee; 16]), 8).unwrap();
        let r = Random::new(b"seed");
        let d = r.draw(node, "place", 0);
        assert_eq!(d, Random::new(b"seed").draw(node, "place", 0));
        for changed in [
            Random::new(b"seee").draw(node, "place", 0),
            r.draw(other, "place", 0),
            r.draw(node, "plact", 0),
            r.draw(node, "place", 1),
            r.draw(node, "place", 1 << 32),
        ] {
            assert_ne!(d, changed);
        }
        // Pinned, so a change to the algorithm cannot pass unnoticed: it is a new ALGORITHM name.
        assert_eq!(d, PINNED, "{d:#x}");
        for n in [1, 2, 3, 1000, u64::MAX] {
            assert!(r.below(node, "place", 3, n) < n);
        }
    }

    const PINNED: u64 = 0x046b_95ba_83fe_ebc1;
}
