//! JSON as the form rules read and answer it (Engine v2 R2, #2685). A kind entry (`souls-entry/1`), a case
//! (`souls-form-cases/1`) and a verdict are plain JSON, so the same text goes into the native build and the WASM one.
//!
//! - Whole numbers are read exactly, as `i128` (a timed value may lie beyond 2^53). A number with a fraction or an
//!   exponent is kept as its text and is never worked with: it only compares equal to the same text.
//! - Objects keep their keys in written order, as JavaScript does, and [`same`] ignores that order.
//! - Nesting deeper than [`MAX_DEPTH`] is refused, so no input can exhaust the stack.

use std::fmt::Write as _;

/// The deepest nesting [`parse`] reads.
pub const MAX_DEPTH: usize = 64;

/// A JSON value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Null,
    Bool(bool),
    /// A whole number.
    Int(i128),
    /// Any other number, as written.
    Num(String),
    Str(String),
    Arr(Vec<Value>),
    /// Keys in written order; a repeated key keeps its last value, in its first place.
    Obj(Vec<(String, Value)>),
}

impl Value {
    /// The value at `key` of an object; `None` for a missing key or anything that is not an object.
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// The text of a string.
    pub fn str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    /// An object's entries, or `None`.
    pub fn obj(&self) -> Option<&[(String, Value)]> {
        match self {
            Value::Obj(e) => Some(e),
            _ => None,
        }
    }

    /// An array's items, or `None`.
    pub fn arr(&self) -> Option<&[Value]> {
        match self {
            Value::Arr(a) => Some(a),
            _ => None,
        }
    }

    /// JavaScript's truthiness: `null`, `false`, `0` and `""` are false.
    pub fn truthy(&self) -> bool {
        !matches!(self, Value::Null | Value::Bool(false) | Value::Int(0))
            && !matches!(self, Value::Str(s) if s.is_empty())
    }

    /// An object from pairs.
    pub fn object<const N: usize>(pairs: [(&str, Value); N]) -> Value {
        Value::Obj(pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    }

    /// A string value.
    pub fn s(text: &str) -> Value {
        Value::Str(text.to_owned())
    }

    /// The value as compact JSON, keys in their stored order.
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        write_value(&mut out, self);
        out
    }
}

/// Deep equality of JSON values: object key order does not matter, array order does.
pub fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Arr(x), Value::Arr(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        (Value::Obj(x), Value::Obj(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| b.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

/// Reads JSON text. The error names the byte offset.
pub fn parse(text: &str) -> Result<Value, String> {
    let mut p = Parser {
        b: text.as_bytes(),
        i: 0,
    };
    let v = p.value(0)?;
    p.ws();
    if p.i != p.b.len() {
        return Err(format!("trailing text at byte {}", p.i));
    }
    Ok(v)
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn err<T>(&self, what: &str) -> Result<T, String> {
        Err(format!("{what} at byte {}", self.i))
    }

    fn eat(&mut self, c: u8) -> Result<(), String> {
        self.ws();
        if self.b.get(self.i) == Some(&c) {
            self.i += 1;
            Ok(())
        } else {
            self.err(&format!("expected '{}'", c as char))
        }
    }

    fn word(&mut self, w: &str, v: Value) -> Result<Value, String> {
        if self.b[self.i..].starts_with(w.as_bytes()) {
            self.i += w.len();
            Ok(v)
        } else {
            self.err("unexpected word")
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, String> {
        if depth > MAX_DEPTH {
            return self.err("nested too deep");
        }
        self.ws();
        match self.b.get(self.i) {
            None => self.err("unexpected end"),
            Some(b'n') => self.word("null", Value::Null),
            Some(b't') => self.word("true", Value::Bool(true)),
            Some(b'f') => self.word("false", Value::Bool(false)),
            Some(b'"') => self.string().map(Value::Str),
            Some(b'[') => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(Value::Arr(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Value::Arr(items));
                        }
                        _ => return self.err("expected ',' or ']'"),
                    }
                }
            }
            Some(b'{') => {
                self.i += 1;
                let mut entries: Vec<(String, Value)> = Vec::new();
                // Each key's place in `entries`: a repeated key is found in log time, not by a scan of all before it,
                // which made a client's state of 10,000 nodes take a second to read (G-late, 0.132).
                let mut at: std::collections::BTreeMap<String, usize> =
                    std::collections::BTreeMap::new();
                self.ws();
                if self.b.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(Value::Obj(entries));
                }
                loop {
                    self.ws();
                    if self.b.get(self.i) != Some(&b'"') {
                        return self.err("expected a key");
                    }
                    let k = self.string()?;
                    self.eat(b':')?;
                    let v = self.value(depth + 1)?;
                    match at.get(&k) {
                        Some(&n) => entries[n].1 = v,
                        None => {
                            at.insert(k.clone(), entries.len());
                            entries.push((k, v));
                        }
                    }
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Value::Obj(entries));
                        }
                        _ => return self.err("expected ',' or '}'"),
                    }
                }
            }
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => self.err("unexpected byte"),
        }
    }

    fn number(&mut self) -> Result<Value, String> {
        let start = self.i;
        let digits = |p: &mut Self| {
            let s = p.i;
            while p.i < p.b.len() && p.b[p.i].is_ascii_digit() {
                p.i += 1;
            }
            p.i - s
        };
        if self.b[self.i] == b'-' {
            self.i += 1;
        }
        if digits(self) == 0 {
            return self.err("expected a digit");
        }
        let int_end = self.i;
        let mut whole = true;
        if self.b.get(self.i) == Some(&b'.') {
            self.i += 1;
            let s = self.i;
            if digits(self) == 0 {
                return self.err("expected a digit");
            }
            whole = self.b[s..self.i].iter().all(|c| *c == b'0');
        }
        if matches!(self.b.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.b.get(self.i), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if digits(self) == 0 {
                return self.err("expected a digit");
            }
            whole = false;
        }
        // The input is ASCII here, so the slice is valid UTF-8.
        let text = String::from_utf8_lossy(&self.b[start..self.i]).into_owned();
        if whole && let Ok(n) = text[..int_end - start].parse::<i128>() {
            return Ok(Value::Int(n));
        }
        Ok(Value::Num(text))
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let Some(h) = self.b.get(self.i..self.i + 4) else {
            return self.err("short \\u escape");
        };
        let Ok(n) = u32::from_str_radix(&String::from_utf8_lossy(h), 16) else {
            return self.err("bad \\u escape");
        };
        self.i += 4;
        Ok(n)
    }

    fn string(&mut self) -> Result<String, String> {
        self.i += 1;
        let mut out = String::new();
        loop {
            let start = self.i;
            while self.i < self.b.len() && self.b[self.i] != b'"' && self.b[self.i] != b'\\' {
                if self.b[self.i] < 0x20 {
                    return self.err("control byte in a string");
                }
                self.i += 1;
            }
            match std::str::from_utf8(&self.b[start..self.i]) {
                Ok(s) => out.push_str(s),
                Err(_) => return self.err("bad UTF-8"),
            }
            match self.b.get(self.i) {
                None => return self.err("unterminated string"),
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(_) => {
                    self.i += 1;
                    let Some(&c) = self.b.get(self.i) else {
                        return self.err("unterminated escape");
                    };
                    self.i += 1;
                    match c {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let code = if (0xd800..0xdc00).contains(&hi)
                                && self.b[self.i..].starts_with(b"\\u")
                            {
                                self.i += 2;
                                let lo = self.hex4()?;
                                0x10000 + ((hi - 0xd800) << 10) + (lo.wrapping_sub(0xdc00) & 0x3ff)
                            } else {
                                hi
                            };
                            out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                        }
                        _ => return self.err("bad escape"),
                    }
                }
            }
        }
    }
}

fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_value(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Int(n) => {
            let _ = write!(out, "{n}");
        }
        Value::Num(t) => out.push_str(t),
        Value::Str(s) => write_str(out, s),
        Value::Arr(items) => {
            out.push('[');
            for (i, x) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, x);
            }
            out.push(']');
        }
        Value::Obj(entries) => {
            out.push('{');
            for (i, (k, x)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_str(out, k);
                out.push(':');
                write_value(out, x);
            }
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// G-late (0.132): a repeated key keeps its first place and its last value, as JavaScript's `JSON.parse` does, and
    /// an object of 20,000 keys (a client's state of a big world) is read whole.
    #[test]
    fn a_repeated_key_keeps_its_place_and_its_last_value() {
        let v = parse(r#"{"a":1,"b":2,"a":3}"#).unwrap();
        let Value::Obj(e) = &v else {
            panic!("an object")
        };
        assert_eq!(
            e.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert!(same(v.get("a").unwrap(), &parse("3").unwrap()));
        let keys: Vec<String> = (0..20_000)
            .map(|i| format!("\"{}-{i}\":{i}", "ab".repeat(16)))
            .collect();
        let Value::Obj(e) = parse(&format!("{{{}}}", keys.join(","))).unwrap() else {
            panic!("an object")
        };
        assert_eq!(e.len(), 20_000);
    }
}
