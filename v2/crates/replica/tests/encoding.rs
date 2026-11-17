//! The encoding profile against its vectors (Engine v2 T0, #2639). Each file in `fixtures/encoding/` holds a value in
//! diagnostic notation (then ` # ` and words) and, on its second line, the value's one byte form as hex.
//! `v2/tools/encoding-vectors` runs the same files through the WASM build and a JavaScript library.

use replica::encode::{MAX_DEPTH, decode, encode, from_hex, parse_diagnostic, to_hex};
use std::fs;
use std::path::Path;

fn vectors() -> Vec<(String, String, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/encoding");
    let mut files: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    files
        .iter()
        .map(|path| {
            let text = fs::read_to_string(path).unwrap();
            let mut lines = text.lines();
            let (diag, hex) = (lines.next().unwrap(), lines.next().unwrap());
            assert_eq!(lines.next(), None, "{}: two lines", path.display());
            let (value, _words) = diag.split_once(" # ").unwrap();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            (name, value.to_owned(), hex.to_owned())
        })
        .collect()
}

#[test]
fn every_vector_encodes_to_its_bytes_and_decodes_back() {
    let vectors = vectors();
    assert!(
        vectors.len() >= 24,
        "{} vectors, at least 24 wanted",
        vectors.len()
    );
    for (name, diag, hex) in &vectors {
        let value = parse_diagnostic(diag).unwrap_or_else(|e| panic!("{name}: {e}"));
        let bytes = encode(&value);
        assert_eq!(to_hex(&bytes), *hex, "{name}: {diag}");
        let decoded = decode(&bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(decoded.value, value, "{name}: decodes back");
        assert_eq!(decoded.bytes, bytes, "{name}: keeps the bytes it read");
        println!("native {name}: {hex}");
    }
    println!(
        "native: {} vectors, each encoded to its bytes and decoded back",
        vectors.len()
    );
}

/// Every form outside the profile, as bytes, and the name the decoder gives its refusal.
const REFUSED: &[(&str, &str, &str)] = &[
    ("18", "truncated", "an integer missing its argument byte"),
    ("6261", "truncated", "text of length 2 with one byte left"),
    (
        "9affffffff00",
        "truncated",
        "an array longer than the input",
    ),
    ("0000", "trailing-bytes", "a second item after the first"),
    ("1817", "not-shortest", "23 in a one-byte argument"),
    (
        "1a0000ffff",
        "not-shortest",
        "65535 in a four-byte argument",
    ),
    (
        "3b00000000ffffffff",
        "not-shortest",
        "a negative integer in eight bytes that fits in four",
    ),
    (
        "5800",
        "not-shortest",
        "a length in a wider argument than it needs",
    ),
    (
        "a1180100",
        "not-shortest",
        "a map key in a wider argument than it needs",
    ),
    ("5f40ff", "indefinite-length", "an indefinite byte string"),
    ("7fff", "indefinite-length", "indefinite text"),
    ("9fff", "indefinite-length", "an indefinite array"),
    ("bfff", "indefinite-length", "an indefinite map"),
    ("1c", "reserved-argument", "additional information 28"),
    (
        "3f",
        "reserved-argument",
        "additional information 31 on an integer",
    ),
    ("c11a00000000", "tag", "tag 1 (epoch time)"),
    ("c240", "tag", "tag 2 (a big integer)"),
    ("f93c00", "float", "1.0 as a half-width float"),
    ("fa3f800000", "float", "1.0 as a single-width float"),
    ("fb3ff0000000000000", "float", "1.0 as a double-width float"),
    ("f6", "null", "null"),
    ("f4", "simple", "false"),
    ("f5", "simple", "true"),
    ("f7", "simple", "undefined"),
    ("f820", "simple", "simple value 32"),
    ("ff", "break", "a break byte on its own"),
    ("a12000", "map-key-not-uint", "a negative map key"),
    ("a1616100", "map-key-not-uint", "a text map key"),
    ("a202000100", "map-keys-out-of-order", "key 2 before key 1"),
    ("a201000100", "map-key-duplicate", "key 1 twice"),
    ("6120", "text-not-name", "a space"),
    ("6100", "text-not-name", "a control character"),
    ("62c3a9", "text-not-name", "a letter beyond ASCII"),
];

#[test]
fn each_form_outside_the_profile_is_refused_by_name() {
    for (hex, name, what) in REFUSED {
        let refusal = decode(&from_hex(hex).unwrap()).expect_err(what);
        assert_eq!(refusal.kind.name(), *name, "{hex} ({what})");
        println!("refused {hex}: {refusal} ({what})");
    }
    // Nesting: MAX_DEPTH arrays inside one another decode; one more is refused.
    let nested = |n: usize| from_hex(&format!("{}80", "81".repeat(n - 1))).unwrap();
    assert!(decode(&nested(MAX_DEPTH)).is_ok());
    let refusal = decode(&nested(MAX_DEPTH + 1)).unwrap_err();
    assert_eq!(refusal.kind.name(), "too-deep");
    println!("refused {} arrays nested: {refusal}", MAX_DEPTH + 1);
}
