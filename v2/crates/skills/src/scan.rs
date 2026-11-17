//! The scan (`v2/docs/bodies.md` rule 8): what safe Rust compiles but a skill must not do. A skill crate that reads a
//! clock, keeps a global, names the fixtures' state harness, or does not forbid `unsafe` fails it by name. It reads the
//! code with comments and literals blanked, so words in them never match.

/// A fault the scan finds: its name, and the code it matched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fault {
    pub name: &'static str,
    pub found: &'static str,
}

/// What the scan refuses: (name, text in code). Order is the report's.
const RULES: &[(&str, &str)] = &[
    ("skill-reads-clock", "std::time"),
    ("skill-reads-clock", "Instant"),
    ("skill-reads-clock", "SystemTime"),
    ("skill-keeps-global", "static "),
    ("skill-keeps-global", "static mut"),
    ("skill-keeps-global", "thread_local!"),
    ("skill-keeps-global", "OnceLock"),
    ("skill-keeps-global", "OnceCell"),
    ("skill-keeps-global", "LazyLock"),
    ("skill-keeps-global", "lazy_static"),
    ("skill-keeps-global", "extern crate std"),
    ("skill-names-state", "effects::State"),
];

/// `src` with comments, strings and character literals blanked, and lifetimes (`'static`) dropped.
pub fn code(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    while i < b.len() {
        let rest = &src[i..];
        if rest.starts_with("//") {
            let end = rest.find('\n').map_or(b.len(), |n| i + n);
            out.push_str(&" ".repeat(end - i));
            i = end;
        } else if rest.starts_with("/*") {
            let end = rest.find("*/").map_or(b.len(), |n| i + n + 2);
            out.extend(
                src[i..end]
                    .chars()
                    .map(|c| if c == '\n' { '\n' } else { ' ' }),
            );
            i = end;
        } else if b[i] == b'"' {
            let mut j = i + 1;
            while j < b.len() && b[j] != b'"' {
                j += if b[j] == b'\\' { 2 } else { 1 };
            }
            let end = (j + 1).min(b.len());
            out.extend(
                src[i..end]
                    .chars()
                    .map(|c| if c == '\n' { '\n' } else { ' ' }),
            );
            i = end;
        } else if b[i] == b'\'' {
            // A lifetime ('static, 'a) or a char literal ('x', '\n'): blank either.
            let mut j = i + 1;
            while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_' || b[j] == b'\\') {
                j += 1;
            }
            if j < b.len() && b[j] == b'\'' {
                j += 1;
            }
            out.push_str(&" ".repeat(j - i));
            i = j;
        } else {
            let c = rest.chars().next().unwrap_or(' ');
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

/// The faults in one crate's sources: each file's code against the rules, and the crate root's `#![forbid(unsafe_code)]`
/// (`skill-allows-unsafe` when it is missing).
pub fn scan(root: &str, files: &[&str]) -> Vec<Fault> {
    let mut faults = Vec::new();
    if !code(root).contains("#![forbid(unsafe_code)]") {
        faults.push(Fault {
            name: "skill-allows-unsafe",
            found: "#![forbid(unsafe_code)] is missing",
        });
    }
    for f in std::iter::once(&root).chain(files) {
        let c = code(f);
        for (name, text) in RULES {
            if c.contains(text) && !faults.iter().any(|x: &Fault| x.found == *text) {
                faults.push(Fault { name, found: text });
            }
        }
    }
    faults
}
