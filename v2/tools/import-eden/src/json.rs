//! The little JSON the exporter writes: objects, arrays, strings, whole numbers, booleans and null. No fractions and no
//! exponents (every number in the facts file is a whole millimetre, millidegree or count), so none is read as a float.

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Int(i64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(o) => o.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn int(&self) -> Option<i64> {
        match self {
            Json::Int(n) => Some(*n),
            _ => None,
        }
    }
    pub fn str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn arr(&self) -> &[Json] {
        match self {
            Json::Arr(a) => a,
            _ => &[],
        }
    }
    pub fn bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }
}

pub fn parse(text: &str) -> Result<Json, String> {
    parse_with(text, true)
}

/// Today's catalog, whose positions are fractions of a metre: they are skipped (read as null), since the comparison
/// reads only its ids, kinds and names.
pub fn parse_skipping_fractions(text: &str) -> Result<Json, String> {
    parse_with(text, false)
}

fn parse_with(text: &str, whole: bool) -> Result<Json, String> {
    let mut p = P {
        b: text.as_bytes(),
        i: 0,
        whole,
    };
    let v = p.value(0)?;
    p.ws();
    if p.i != p.b.len() {
        return Err(format!("bytes after the value at {}", p.i));
    }
    Ok(v)
}

struct P<'a> {
    b: &'a [u8],
    i: usize,
    whole: bool,
}

impl P<'_> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\n' | b'\r' | b'\t') {
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
    fn value(&mut self, depth: u32) -> Result<Json, String> {
        if depth > 64 {
            return self.err("nested deeper than 64");
        }
        self.ws();
        match self.b.get(self.i) {
            Some(b'{') => {
                self.i += 1;
                let mut o = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(Json::Obj(o));
                }
                loop {
                    self.ws();
                    let k = self.string()?;
                    self.eat(b':')?;
                    o.push((k, self.value(depth + 1)?));
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Json::Obj(o));
                        }
                        _ => return self.err("expected ',' or '}'"),
                    }
                }
            }
            Some(b'[') => {
                self.i += 1;
                let mut a = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(Json::Arr(a));
                }
                loop {
                    a.push(self.value(depth + 1)?);
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Json::Arr(a));
                        }
                        _ => return self.err("expected ',' or ']'"),
                    }
                }
            }
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b't') if self.b[self.i..].starts_with(b"true") => {
                self.i += 4;
                Ok(Json::Bool(true))
            }
            Some(b'f') if self.b[self.i..].starts_with(b"false") => {
                self.i += 5;
                Ok(Json::Bool(false))
            }
            Some(b'n') if self.b[self.i..].starts_with(b"null") => {
                self.i += 4;
                Ok(Json::Null)
            }
            Some(b'-' | b'0'..=b'9') => {
                let start = self.i;
                if self.b[self.i] == b'-' {
                    self.i += 1;
                }
                while self.i < self.b.len() && self.b[self.i].is_ascii_digit() {
                    self.i += 1;
                }
                if matches!(self.b.get(self.i), Some(b'.' | b'e' | b'E')) {
                    if self.whole {
                        return self.err("a number that is not whole");
                    }
                    while matches!(
                        self.b.get(self.i),
                        Some(b'.' | b'e' | b'E' | b'+' | b'-' | b'0'..=b'9')
                    ) {
                        self.i += 1;
                    }
                    return Ok(Json::Null);
                }
                let s = std::str::from_utf8(&self.b[start..self.i]).map_err(|e| e.to_string())?;
                s.parse::<i64>()
                    .map(Json::Int)
                    .map_err(|e| format!("{e} at byte {start}"))
            }
            _ => self.err("expected a value"),
        }
    }
    fn string(&mut self) -> Result<String, String> {
        if self.b.get(self.i) != Some(&b'"') {
            return self.err("expected a string");
        }
        self.i += 1;
        let mut out: Vec<u8> = Vec::new();
        loop {
            match self.b.get(self.i) {
                None => return self.err("an unterminated string"),
                Some(b'"') => {
                    self.i += 1;
                    return String::from_utf8(out).map_err(|e| e.to_string());
                }
                Some(b'\\') => {
                    let c = *self.b.get(self.i + 1).ok_or("a string ends in '\\'")?;
                    self.i += 2;
                    let ch = match c {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let mut code = self.hex4()?;
                            if (0xd800..0xdc00).contains(&code)
                                && self.b[self.i..].starts_with(b"\\u")
                            {
                                self.i += 2;
                                let low = self.hex4()?;
                                code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
                            }
                            char::from_u32(code).unwrap_or('\u{fffd}')
                        }
                        _ => return self.err("an unknown escape"),
                    };
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                }
                Some(&c) => {
                    out.push(c);
                    self.i += 1;
                }
            }
        }
    }
    fn hex4(&mut self) -> Result<u32, String> {
        let s = self.b.get(self.i..self.i + 4).ok_or("a short \\u escape")?;
        self.i += 4;
        u32::from_str_radix(std::str::from_utf8(s).map_err(|e| e.to_string())?, 16)
            .map_err(|e| e.to_string())
    }
}
