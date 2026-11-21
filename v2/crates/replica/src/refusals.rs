//! The refusal registry (Engine v2 I2, #2689): every name the gateway and the owner's client give an intent refused
//! for its form, with what it means. Native and WASM builds both read this one table, so a client learns a name from
//! the same file the world refuses by. Names are dotted and stable, like `capability.params`: a name is never renamed
//! or reused, since every client matches on it. Add a name; never change one.

/// `(name, meaning)`, every name an intent can be refused by for its form (`intent_decode::decode`).
pub const REFUSALS: [(&str, &str); 32] = [
    // Limits, checked before anything else reads the intent (`intent_limits.txt`).
    (
        "intent.too-large",
        "the frame is over the byte limit; refused from its length alone",
    ),
    (
        "intent.too-deep",
        "arrays and maps nest over the depth limit",
    ),
    ("intent.text-too-long", "a text is over the text limit"),
    ("intent.fallbacks-too-many", "more fallbacks than the limit"),
    // The encoding profile (`v2/docs/encoding.md`): bytes that are not one value in deterministic CBOR.
    ("intent.cbor.truncated", "the bytes end inside a value"),
    (
        "intent.cbor.trailing-bytes",
        "bytes follow the one top-level value",
    ),
    (
        "intent.cbor.not-shortest",
        "an integer, length or key not in its shortest form",
    ),
    ("intent.cbor.indefinite-length", "a length left open"),
    (
        "intent.cbor.reserved-argument",
        "additional information 28 to 31 where not allowed",
    ),
    ("intent.cbor.tag", "a tag"),
    ("intent.cbor.float", "a floating-point number"),
    ("intent.cbor.null", "null"),
    (
        "intent.cbor.simple",
        "true, false, undefined or another simple value",
    ),
    ("intent.cbor.break", "a break byte outside an open length"),
    (
        "intent.cbor.map-key-not-uint",
        "a map key that is not an unsigned integer",
    ),
    (
        "intent.cbor.map-keys-out-of-order",
        "map keys not in ascending order",
    ),
    ("intent.cbor.map-key-duplicate", "a map key written twice"),
    (
        "intent.cbor.text-not-name",
        "text with a character outside the name characters",
    ),
    // The envelope (`v2/docs/intents.md`, rules 2 to 10).
    (
        "intent.not-a-record",
        "not the envelope's shape: a field missing, unknown or of the wrong type",
    ),
    (
        "intent.not-canonical",
        "an empty field written, or bytes that do not re-encode to themselves",
    ),
    (
        "intent.int-out-of-range",
        "an integer outside its field's range",
    ),
    (
        "intent.text-not-a-name",
        "a verb, or any other text in the intent, that is not namespace:name",
    ),
    (
        "intent.order-unknown",
        "an engine verb outside the closed list",
    ),
    (
        "intent.order-without-target",
        "a follow or queue with no target",
    ),
    (
        "intent.fallback-not-an-act",
        "a fallback that is an engine verb",
    ),
    (
        "intent.fallbacks-not-on-an-act",
        "fallbacks on an intent that is not an act",
    ),
    (
        "intent.cancel-without-replaces",
        "a cancel that names nothing to end",
    ),
    (
        "intent.cancel-not-bare",
        "a cancel carrying a target, parameters or resources",
    ),
    (
        "intent.creator-without-body",
        "a creator naming no body it drives",
    ),
    (
        "intent.body-not-a-creators",
        "a Soul naming a body other than its own",
    ),
    // An edit (rule 15, Engine v2 G1b #3362).
    (
        "intent.edit-not-bare",
        "an edit carrying a target, resources, a replaced intent or a body",
    ),
    (
        "intent.edit-not-a-batch",
        "an edit's parameters not {1: [operation, ...]} of 1 to 256 operations, each in its one byte form",
    ),
];

/// The registry's `&'static` copy of `name`, if the registry has it.
pub fn named(name: &str) -> Option<&'static str> {
    REFUSALS.iter().map(|(n, _)| *n).find(|n| *n == name)
}
