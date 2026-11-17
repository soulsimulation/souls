//! The encoding profile (contract T6; Engine v2 T0, #2639): the one byte form of everything hashed.
//!
//! CBOR (RFC 8949) cut down to unsigned and negative integers, byte strings, text that is an ASCII name, arrays,
//! and maps keyed by unsigned integers in ascending order. Definite lengths, every argument in its shortest form, no
//! tags, floats, null, booleans or other simple values, no duplicate keys, no trailing bytes, nesting at most
//! [`MAX_DEPTH`] deep. The rules are numbered in `v2/docs/encoding.md`. Only this crate encodes or decodes.
//!
//! A [`Value`] can only hold what the profile allows ([`Name`] checks text, a map is ordered by its type), so
//! [`encode`] cannot fail, and [`decode`] refuses every other form by name, so each value has exactly one byte form.

use std::collections::BTreeMap;
use std::fmt;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::wasm_bindgen;

/// How deep arrays and maps may nest (rule 8). A deeper input is refused before it can exhaust the stack.
pub const MAX_DEPTH: usize = 32;

/// A value the profile can hold.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    /// An integer from 0 to 2^64 − 1 (major type 0).
    Uint(u64),
    /// The integer −1 − n, from −1 to −2^64 (major type 1).
    Nint(u64),
    /// A byte string (major type 2).
    Bytes(Vec<u8>),
    /// Text that is an ASCII name (major type 3).
    Text(Name),
    /// An array (major type 4).
    Array(Vec<Value>),
    /// A map keyed by unsigned integers, written in ascending key order (major type 5).
    Map(BTreeMap<u64, Value>),
}

/// Text the profile allows: ASCII letters, digits and `_ - . : / @` (rule 6), possibly empty.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Name(String);

impl Name {
    /// The name, or `None` if `text` holds any other character.
    pub fn new(text: &str) -> Option<Name> {
        text.bytes()
            .all(is_name_byte)
            .then(|| Name(text.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn is_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':' | b'/' | b'@')
}

/// Why the decoder refused its input. Each form outside the profile has its own name (`v2/docs/encoding.md`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefusalKind {
    /// The input ends inside an item, or a length runs past its end.
    Truncated,
    /// Bytes follow the one top-level item.
    TrailingBytes,
    /// An integer, length or key is written wider than its shortest form.
    NotShortest,
    /// A byte string, text, array or map of indefinite length.
    IndefiniteLength,
    /// Additional information 28 to 30, or 31 on an integer or a tag: not well-formed CBOR.
    ReservedArgument,
    /// A tag (major type 6).
    Tag,
    /// A floating-point number of any width.
    Float,
    /// `null`.
    Null,
    /// `false`, `true`, `undefined` or any other simple value.
    Simple,
    /// A break byte (0xff) outside an indefinite-length item.
    Break,
    /// A map key that is not an unsigned integer.
    MapKeyNotUint,
    /// A map key smaller than the key before it.
    MapKeysOutOfOrder,
    /// A map key equal to the key before it.
    MapKeyDuplicate,
    /// Text with a character outside the name characters (rule 6), non-ASCII included.
    TextNotName,
    /// Arrays and maps nested more than [`MAX_DEPTH`] deep.
    TooDeep,
}

impl RefusalKind {
    /// The refusal's name, as `v2/docs/encoding.md` lists it.
    pub fn name(self) -> &'static str {
        match self {
            RefusalKind::Truncated => "truncated",
            RefusalKind::TrailingBytes => "trailing-bytes",
            RefusalKind::NotShortest => "not-shortest",
            RefusalKind::IndefiniteLength => "indefinite-length",
            RefusalKind::ReservedArgument => "reserved-argument",
            RefusalKind::Tag => "tag",
            RefusalKind::Float => "float",
            RefusalKind::Null => "null",
            RefusalKind::Simple => "simple",
            RefusalKind::Break => "break",
            RefusalKind::MapKeyNotUint => "map-key-not-uint",
            RefusalKind::MapKeysOutOfOrder => "map-keys-out-of-order",
            RefusalKind::MapKeyDuplicate => "map-key-duplicate",
            RefusalKind::TextNotName => "text-not-name",
            RefusalKind::TooDeep => "too-deep",
        }
    }
}

/// A refusal and the offset of the byte that caused it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub kind: RefusalKind,
    pub offset: u64,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at byte {}", self.kind.name(), self.offset)
    }
}

impl std::error::Error for Refusal {}

/// A decoded value and the bytes it was read from. A hash covers these stored bytes, never a re-encoding (rule 10).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decoded {
    pub value: Value,
    pub bytes: Vec<u8>,
}

/// The value's one byte form.
pub fn encode(value: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    write_value(&mut out, value);
    out
}

fn write_head(out: &mut Vec<u8>, major: u8, arg: u64) {
    let m = major << 5;
    if arg < 24 {
        out.push(m | arg as u8);
    } else if let Ok(a) = u8::try_from(arg) {
        out.extend([m | 24, a]);
    } else if let Ok(a) = u16::try_from(arg) {
        out.push(m | 25);
        out.extend(a.to_be_bytes());
    } else if let Ok(a) = u32::try_from(arg) {
        out.push(m | 26);
        out.extend(a.to_be_bytes());
    } else {
        out.push(m | 27);
        out.extend(arg.to_be_bytes());
    }
}

/// A length, written from a fixed-width type: `usize` is 32 bits in WASM and 64 natively.
fn len(n: usize) -> u64 {
    n as u64
}

fn write_value(out: &mut Vec<u8>, value: &Value) {
    match value {
        Value::Uint(n) => write_head(out, 0, *n),
        Value::Nint(n) => write_head(out, 1, *n),
        Value::Bytes(b) => {
            write_head(out, 2, len(b.len()));
            out.extend_from_slice(b);
        }
        Value::Text(t) => {
            write_head(out, 3, len(t.0.len()));
            out.extend_from_slice(t.0.as_bytes());
        }
        Value::Array(items) => {
            write_head(out, 4, len(items.len()));
            items.iter().for_each(|v| write_value(out, v));
        }
        Value::Map(entries) => {
            write_head(out, 5, len(entries.len()));
            for (k, v) in entries {
                write_head(out, 0, *k);
                write_value(out, v);
            }
        }
    }
}

/// Reads exactly one value in the profile from `bytes`, or refuses the input by name.
pub fn decode(bytes: &[u8]) -> Result<Decoded, Refusal> {
    let mut r = Reader { bytes, pos: 0 };
    let value = r.value(0)?;
    if r.pos != bytes.len() {
        return Err(r.refuse(RefusalKind::TrailingBytes));
    }
    Ok(Decoded {
        value,
        bytes: bytes.to_vec(),
    })
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn refuse(&self, kind: RefusalKind) -> Refusal {
        Refusal {
            kind,
            offset: len(self.pos),
        }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], Refusal> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.bytes.len());
        let end = end.ok_or_else(|| self.refuse(RefusalKind::Truncated))?;
        let out = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    /// Reads an item's head: its major type and argument, refusing every head outside the profile.
    fn head(&mut self) -> Result<(u8, u64), Refusal> {
        let start = self.pos;
        let first = self.take(1)?[0];
        let (major, info) = (first >> 5, first & 0x1f);
        let at = |kind| Refusal {
            kind,
            offset: len(start),
        };
        if major == 7 {
            return Err(at(match info {
                22 => RefusalKind::Null,
                25..=27 => RefusalKind::Float,
                28..=30 => RefusalKind::ReservedArgument,
                31 => RefusalKind::Break,
                _ => RefusalKind::Simple,
            }));
        }
        match info {
            28..=30 => return Err(at(RefusalKind::ReservedArgument)),
            31 if (2..=5).contains(&major) => return Err(at(RefusalKind::IndefiniteLength)),
            31 => return Err(at(RefusalKind::ReservedArgument)),
            _ => {}
        }
        if major == 6 {
            return Err(at(RefusalKind::Tag));
        }
        let (arg, shortest_from) = match info {
            0..=23 => (u64::from(info), 0),
            24 => (u64::from(self.take(1)?[0]), 24),
            25 => (u64::from(u16::from_be_bytes(self.array()?)), 0x100),
            26 => (u64::from(u32::from_be_bytes(self.array()?)), 0x1_0000),
            _ => (u64::from_be_bytes(self.array()?), 0x1_0000_0000),
        };
        if arg < shortest_from {
            return Err(at(RefusalKind::NotShortest));
        }
        Ok((major, arg))
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], Refusal> {
        let mut out = [0; N];
        out.copy_from_slice(self.take(N)?);
        Ok(out)
    }

    /// A length that must fit in what is left of the input, at least `min_bytes` per element.
    fn length(&self, arg: u64, min_bytes: u64) -> Result<usize, Refusal> {
        let left = len(self.bytes.len() - self.pos);
        match arg.checked_mul(min_bytes) {
            Some(need) if need <= left => Ok(arg as usize),
            _ => Err(self.refuse(RefusalKind::Truncated)),
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, Refusal> {
        let start = self.pos;
        let (major, arg) = self.head()?;
        Ok(match major {
            0 => Value::Uint(arg),
            1 => Value::Nint(arg),
            2 => Value::Bytes(self.take(self.length(arg, 1)?)?.to_vec()),
            3 => {
                let text = self.take(self.length(arg, 1)?)?;
                if let Some(i) = text.iter().position(|&b| !is_name_byte(b)) {
                    return Err(Refusal {
                        kind: RefusalKind::TextNotName,
                        offset: len(self.pos - text.len() + i),
                    });
                }
                // Every name byte is ASCII, so the text is valid UTF-8.
                Value::Text(Name(text.iter().map(|&b| char::from(b)).collect()))
            }
            4 | 5 if depth >= MAX_DEPTH => {
                return Err(Refusal {
                    kind: RefusalKind::TooDeep,
                    offset: len(start),
                });
            }
            4 => {
                let n = self.length(arg, 1)?;
                let mut items = Vec::with_capacity(n);
                for _ in 0..n {
                    items.push(self.value(depth + 1)?);
                }
                Value::Array(items)
            }
            _ => {
                let n = self.length(arg, 2)?;
                let mut entries = BTreeMap::new();
                let mut last: Option<u64> = None;
                for _ in 0..n {
                    let key_at = self.pos;
                    let (key_major, key) = self.head()?;
                    let at = |kind| Refusal {
                        kind,
                        offset: len(key_at),
                    };
                    if key_major != 0 {
                        return Err(at(RefusalKind::MapKeyNotUint));
                    }
                    match last {
                        Some(prev) if key == prev => return Err(at(RefusalKind::MapKeyDuplicate)),
                        Some(prev) if key < prev => return Err(at(RefusalKind::MapKeysOutOfOrder)),
                        _ => {}
                    }
                    last = Some(key);
                    entries.insert(key, self.value(depth + 1)?);
                }
                Value::Map(entries)
            }
        })
    }
}

/// Reads a value written in CBOR diagnostic notation (RFC 8949, section 8), as far as the profile goes: integers,
/// `h'…'` byte strings, `"…"` names, `[…]` arrays and `{key: value, …}` maps with unsigned keys in any order. The
/// test vectors are written this way (`replica/fixtures/encoding/`); nothing else reads it.
pub fn parse_diagnostic(text: &str) -> Result<Value, String> {
    let mut p = Diag {
        s: text.as_bytes(),
        pos: 0,
    };
    let v = p.value(0)?;
    p.space();
    if p.pos != p.s.len() {
        return Err(format!("unexpected text at column {}", p.pos));
    }
    Ok(v)
}

/// Encodes a value written in diagnostic notation. The vector check calls this in replica's WASM build.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn encode_diagnostic(text: &str) -> Result<Vec<u8>, String> {
    parse_diagnostic(text).map(|v| encode(&v))
}

struct Diag<'a> {
    s: &'a [u8],
    pos: usize,
}

impl<'a> Diag<'a> {
    fn space(&mut self) {
        while self.s.get(self.pos).is_some_and(u8::is_ascii_whitespace) {
            self.pos += 1;
        }
    }

    fn eat(&mut self, c: u8) -> bool {
        self.space();
        let hit = self.s.get(self.pos) == Some(&c);
        if hit {
            self.pos += 1;
        }
        hit
    }

    fn err<T>(&self, what: &str) -> Result<T, String> {
        Err(format!("{what} at column {}", self.pos))
    }

    fn until(&mut self, end: u8) -> Result<&'a str, String> {
        let from = self.pos;
        let len = self.s[from..].iter().position(|&b| b == end);
        let len = len.map_or_else(|| self.err("unclosed literal"), Ok)?;
        self.pos = from + len + 1;
        std::str::from_utf8(&self.s[from..from + len]).map_err(|e| e.to_string())
    }

    fn int(&mut self) -> Result<i128, String> {
        self.space();
        let from = self.pos;
        if self.s.get(self.pos) == Some(&b'-') {
            self.pos += 1;
        }
        while self.s.get(self.pos).is_some_and(u8::is_ascii_digit) {
            self.pos += 1;
        }
        let digits = std::str::from_utf8(&self.s[from..self.pos]).map_err(|e| e.to_string())?;
        digits
            .parse::<i128>()
            .or_else(|_| self.err("expected a value"))
    }

    fn value(&mut self, depth: usize) -> Result<Value, String> {
        if self.eat(b'h') {
            if !self.eat(b'\'') {
                return self.err("expected h'");
            }
            let hex = self.until(b'\'')?;
            return from_hex(hex).map(Value::Bytes);
        }
        if self.eat(b'"') {
            let text = self.until(b'"')?;
            return Name::new(text)
                .map(Value::Text)
                .ok_or_else(|| format!("{text:?} is not a name"));
        }
        if depth >= MAX_DEPTH && (self.eat(b'[') || self.eat(b'{')) {
            return self.err("nested too deep");
        }
        if self.eat(b'[') {
            let mut items = Vec::new();
            if !self.eat(b']') {
                loop {
                    items.push(self.value(depth + 1)?);
                    if self.eat(b']') {
                        break;
                    }
                    if !self.eat(b',') {
                        return self.err("expected , or ]");
                    }
                }
            }
            return Ok(Value::Array(items));
        }
        if self.eat(b'{') {
            let mut entries = BTreeMap::new();
            if !self.eat(b'}') {
                loop {
                    let key = u64::try_from(self.int()?)
                        .or_else(|_| self.err("a map key is an unsigned integer"))?;
                    if !self.eat(b':') {
                        return self.err("expected :");
                    }
                    if entries.insert(key, self.value(depth + 1)?).is_some() {
                        return self.err("duplicate map key");
                    }
                    if self.eat(b'}') {
                        break;
                    }
                    if !self.eat(b',') {
                        return self.err("expected , or }");
                    }
                }
            }
            return Ok(Value::Map(entries));
        }
        let n = self.int()?;
        if let Ok(u) = u64::try_from(n) {
            Ok(Value::Uint(u))
        } else if let Ok(m) = u64::try_from(-1 - n) {
            Ok(Value::Nint(m))
        } else {
            self.err("integer out of range")
        }
    }
}

/// Lower-case or upper-case hex, with no separators, to bytes.
pub fn from_hex(hex: &str) -> Result<Vec<u8>, String> {
    if !hex.is_ascii() || !hex.len().is_multiple_of(2) {
        return Err(format!("not an even number of hex digits: {hex:?}"));
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).map_err(|_| format!("not hex: {hex:?}")))
        .collect()
}

/// Bytes as lower-case hex.
pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
