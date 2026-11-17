//! The scan (`v2/docs/bodies.md` rule 8): what safe Rust compiles but a skill must not do. A skill crate that reads a
//! clock or the machine, keeps a global, iterates a hash's order, names the fixtures' state harness, or does not forbid
//! `unsafe` fails it by name. It reads tokens, with comments and string, char and byte literals blanked, so words in
//! them never match and spacing does not matter.

/// A fault the scan finds: its name, and what it matched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fault {
    pub name: &'static str,
    pub found: String,
}

/// `src` with comments, strings (raw ones included), and char and byte literals blanked; lifetimes (`'static`) too.
pub fn code(src: &str) -> String {
    let c: Vec<char> = src.chars().collect();
    let blank = |s: &[char]| {
        s.iter()
            .map(|x| if *x == '\n' { '\n' } else { ' ' })
            .collect::<String>()
    };
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    while i < c.len() {
        let at = |k: usize| c.get(i + k).copied().unwrap_or('\0');
        let end = if at(0) == '/' && at(1) == '/' {
            (i..c.len()).find(|j| c[*j] == '\n').unwrap_or(c.len())
        } else if at(0) == '/' && at(1) == '*' {
            (i + 2..c.len().saturating_sub(1))
                .find(|j| c[*j] == '*' && c[*j + 1] == '/')
                .map_or(c.len(), |j| j + 2)
        } else if at(0) == 'r'
            && (at(1) == '"' || at(1) == '#')
            && (i == 0 || !c[i - 1].is_alphanumeric())
        {
            let hashes = (i + 1..c.len()).take_while(|j| c[*j] == '#').count();
            let open = i + 1 + hashes;
            if c.get(open) == Some(&'"') {
                let close: String = std::iter::once('"')
                    .chain(std::iter::repeat_n('#', hashes))
                    .collect();
                let rest: String = c[open + 1..].iter().collect();
                rest.find(&close).map_or(c.len(), |k| {
                    open + 1 + rest[..k].chars().count() + close.chars().count()
                })
            } else {
                i + 1
            }
        } else if at(0) == '"' {
            let mut j = i + 1;
            while j < c.len() && c[j] != '"' {
                j += if c[j] == '\\' { 2 } else { 1 };
            }
            (j + 1).min(c.len())
        } else if at(0) == '\'' {
            if at(1) == '\\' {
                (i + 2..c.len())
                    .find(|j| c[*j] == '\'')
                    .map_or(c.len(), |j| j + 1)
            } else if at(2) == '\'' {
                i + 3
            } else {
                // A lifetime: the quote and its name.
                i + 1
                    + (i + 1..c.len())
                        .take_while(|j| c[*j].is_alphanumeric() || c[*j] == '_')
                        .count()
            }
        } else {
            out.push(c[i]);
            i += 1;
            continue;
        };
        out.push_str(&blank(&c[i..end]));
        i = end;
    }
    out
}

/// The tokens of code: words, and each other non-space character on its own.
fn tokens(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    for ch in code.chars() {
        if ch.is_alphanumeric() || ch == '_' {
            word.push(ch);
        } else {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
            if !ch.is_whitespace() {
                out.push(ch.to_string());
            }
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

/// What one token sequence, starting at `i`, breaks: a rule's name and what it matched.
fn rule(t: &[String], i: usize) -> Option<(&'static str, String)> {
    let w = t[i].as_str();
    let next = |k: usize| t.get(i + k).map_or("", String::as_str);
    let after_std = i >= 3 && t[i - 1] == ":" && t[i - 2] == ":" && t[i - 3] == "std";
    // `std::{time, ...}` and the like: a word inside a `use std` braces.
    let in_std_use = t[..i].iter().rposition(|x| x == "use").is_some_and(|u| {
        t[u + 1..i].first().is_some_and(|x| x == "std") && !t[u..i].iter().any(|x| x == ";")
    });
    let std_path = after_std || in_std_use;
    match w {
        "time" if std_path => Some(("skill-reads-clock", "std::time".into())),
        "Instant" | "SystemTime" | "UNIX_EPOCH" => Some(("skill-reads-clock", w.into())),
        "env" | "fs" | "net" | "process" | "thread" if std_path => {
            Some(("skill-reaches-out", format!("std::{w}")))
        }
        "static" => Some(("skill-keeps-global", "static".into())),
        "thread_local" | "lazy_static" if next(1) == "!" => {
            Some(("skill-keeps-global", format!("{w}!")))
        }
        "OnceLock" | "OnceCell" | "LazyLock" | "LazyCell" => Some(("skill-keeps-global", w.into())),
        "extern" if next(1) == "crate" => Some(("skill-keeps-global", "extern crate".into())),
        "HashMap" | "HashSet" | "RandomState" => Some(("skill-uses-hash-order", w.into())),
        "State" if t[..i].iter().rev().take(12).any(|x| x == "effects") => {
            Some(("skill-names-state", "effects::State".into()))
        }
        _ => None,
    }
}

/// The faults in one crate's sources: the crate root must `#![forbid(unsafe_code)]` (`skill-allows-unsafe`), and no
/// file may break a rule. Each (name, match) is reported once.
pub fn scan(root: &str, files: &[&str]) -> Vec<Fault> {
    let mut faults: Vec<Fault> = Vec::new();
    let root_tokens = tokens(&code(root)).concat();
    if !root_tokens.contains("#![forbid(unsafe_code)]") {
        faults.push(Fault {
            name: "skill-allows-unsafe",
            found: "#![forbid(unsafe_code)] is missing".into(),
        });
    }
    for f in std::iter::once(&root).chain(files) {
        let t = tokens(&code(f));
        for i in 0..t.len() {
            if let Some((name, found)) = rule(&t, i)
                && !faults.iter().any(|x| x.name == name && x.found == found)
            {
                faults.push(Fault { name, found });
            }
        }
    }
    faults
}
