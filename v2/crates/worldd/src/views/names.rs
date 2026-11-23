//! Immutable public name bytes beside the canonical records that already authorize their references; and (#3703) the
//! public words of the text references those records hold (`{21: id}`), read from K16's store as the public reads
//! them, so a client reads a notice's or a board's words as a viewer of the public stream does.
use replica::encode::{Value, decode, encode};
use replica::ids::{Id, sha256};
use replica::sync::wire;
use std::collections::BTreeMap;

pub type PublicNames = BTreeMap<[u8; 32], String>;
pub const PUBLIC_NAMES: u64 = 26;
/// The sidecar of public words: `[[reference id, words], ...]`, beside the records whose fields hold the references.
pub const PUBLIC_WORDS: u64 = 27;
// The existing gateway world-link frame limit; optional metadata never enlarges that contract.
const FRAME_MOST: usize = 16 << 20;

pub fn attach(reply: &mut BTreeMap<u64, Value>, names: &PublicNames) {
    if reply.contains_key(&wire::REFUSED) {
        return;
    }
    let Some(Value::Array(records)) = reply.get(&wire::RECORDS) else {
        return;
    };
    let mut found = BTreeMap::new();
    for raw in records {
        let Value::Bytes(bytes) = raw else { continue };
        let Ok(decoded) = decode(bytes) else { continue };
        let Value::Map(record) = decoded.value else {
            continue;
        };
        let Some(Value::Map(audience)) = record.get(&5) else {
            continue;
        };
        if audience.get(&1) != Some(&Value::Uint(1)) {
            continue;
        }
        let Some(Value::Map(fields)) = record.get(&6) else {
            continue;
        };
        let Some(Value::Bytes(reference)) = fields.get(&4) else {
            continue;
        };
        let Ok(key) = <[u8; 32]>::try_from(reference.as_slice()) else {
            continue;
        };
        if let Some(text) = names
            .get(&key)
            .filter(|text| sha256(text.as_bytes()) == key)
        {
            found.insert(key, text.as_bytes().to_vec());
        }
    }
    if found.is_empty() {
        return;
    }
    reply.insert(
        PUBLIC_NAMES,
        Value::Array(
            found
                .into_iter()
                .map(|(key, text)| {
                    Value::Array(vec![Value::Bytes(key.to_vec()), Value::Bytes(text)])
                })
                .collect(),
        ),
    );
    if !matches!(encode(&Value::Map(reply.clone())), Ok(frame) if frame.len() <= FRAME_MOST) {
        reply.remove(&PUBLIC_NAMES);
        eprintln!("worldd: public-names-frame-limit");
    }
}

/// Adds, beside a records answer, the words of each text reference (`{21: id}`) in the fields of a record seen by
/// everyone, as `read` gives them to a reader with no ids (the public): words of any other audience, and removed words,
/// are never given. The records themselves are unchanged. A sidecar past the frame limit is left out.
pub fn attach_words(reply: &mut BTreeMap<u64, Value>, read: &dyn Fn(Id) -> Option<Vec<u8>>) {
    if reply.contains_key(&wire::REFUSED) {
        return;
    }
    let Some(Value::Array(records)) = reply.get(&wire::RECORDS) else {
        return;
    };
    let mut found = BTreeMap::new();
    for raw in records {
        let Value::Bytes(bytes) = raw else { continue };
        let Ok(decoded) = decode(bytes) else { continue };
        let Value::Map(record) = decoded.value else {
            continue;
        };
        let Some(Value::Map(audience)) = record.get(&5) else {
            continue;
        };
        if audience.get(&1) != Some(&Value::Uint(1)) {
            continue;
        }
        let Some(Value::Map(fields)) = record.get(&6) else {
            continue;
        };
        for v in fields.values() {
            if let Some(r) = replica::audience::reference(v)
                && let Some(words) = read(r)
            {
                found.insert(r, words);
            }
        }
    }
    if found.is_empty() {
        return;
    }
    reply.insert(
        PUBLIC_WORDS,
        Value::Array(
            found
                .into_iter()
                .map(|(r, w)| Value::Array(vec![r.to_value(), Value::Bytes(w)]))
                .collect(),
        ),
    );
    if !matches!(encode(&Value::Map(reply.clone())), Ok(frame) if frame.len() <= FRAME_MOST) {
        reply.remove(&PUBLIC_WORDS);
        eprintln!("worldd: public-words-frame-limit");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(text: &str, public: bool) -> Value {
        Value::Bytes(
            encode(&Value::Map(BTreeMap::from([
                (
                    5,
                    Value::Map(BTreeMap::from([(
                        1,
                        Value::Uint(if public { 1 } else { 2 }),
                    )])),
                ),
                (
                    6,
                    Value::Map(BTreeMap::from([(
                        4,
                        Value::Bytes(sha256(text.as_bytes()).to_vec()),
                    )])),
                ),
            ])))
            .expect("record"),
        )
    }

    #[test]
    fn same_delivered_public_references_only_and_records_unchanged() {
        let names = PublicNames::from([
            (sha256(b"Plaza"), "Plaza".into()),
            (sha256(b"Private"), "Private".into()),
            (sha256(b"Not delivered"), "Not delivered".into()),
        ]);
        let records = Value::Array(vec![
            record("Plaza", true),
            record("Private", false),
            record("Unknown", true),
        ]);
        let mut reply = BTreeMap::from([
            (wire::ASK, Value::Uint(7)),
            (wire::RECORDS, records.clone()),
        ]);
        attach(&mut reply, &names);
        assert_eq!(reply.get(&wire::RECORDS), Some(&records));
        assert_eq!(reply.get(&wire::ASK), Some(&Value::Uint(7)));
        assert_eq!(
            reply.get(&PUBLIC_NAMES),
            Some(&Value::Array(vec![Value::Array(vec![
                Value::Bytes(sha256(b"Plaza").to_vec()),
                Value::Bytes(b"Plaza".to_vec())
            ])]))
        );
        for mut reply in [
            BTreeMap::from([(wire::IDS, Value::Array(vec![]))]),
            BTreeMap::from([(wire::REFUSED, Value::Uint(1))]),
        ] {
            attach(&mut reply, &names);
            assert!(!reply.contains_key(&PUBLIC_NAMES));
        }
    }

    #[test]
    fn wrong_dictionary_hash_and_oversize_sidecar_do_not_change_canonical_reply() {
        let mut reply =
            BTreeMap::from([(wire::RECORDS, Value::Array(vec![record("Plaza", true)]))]);
        let original = reply.clone();
        attach(
            &mut reply,
            &PublicNames::from([(sha256(b"Plaza"), "wrong".into())]),
        );
        assert_eq!(reply, original);
        let text = "x".repeat(FRAME_MOST);
        let mut reply = BTreeMap::from([(wire::RECORDS, Value::Array(vec![record(&text, true)]))]);
        let original = reply.clone();
        attach(
            &mut reply,
            &PublicNames::from([(sha256(text.as_bytes()), text)]),
        );
        assert_eq!(reply, original);
    }

    /// #3703: a public record's reference gets its public words; words of another audience, or in a record not seen
    /// by everyone, never do.
    #[test]
    fn public_words_beside_public_records_only() {
        let scope = replica::ids::Scope([9; 16]);
        let (open, private, hidden) = (
            Id::new(scope, 1).unwrap(),
            Id::new(scope, 2).unwrap(),
            Id::new(scope, 3).unwrap(),
        );
        let refer = |r: Id, public: bool| {
            Value::Bytes(
                encode(&Value::Map(BTreeMap::from([
                    (
                        5,
                        Value::Map(BTreeMap::from([(
                            1,
                            Value::Uint(if public { 1 } else { 2 }),
                        )])),
                    ),
                    (
                        6,
                        Value::Map(BTreeMap::from([(
                            30,
                            Value::Map(BTreeMap::from([(
                                replica::audience::REFERENCE,
                                r.to_value(),
                            )])),
                        )])),
                    ),
                ])))
                .expect("record"),
            )
        };
        // The store's public read: `open` is everyone's; `private` is one body's; `hidden` is everyone's but sits in
        // a record only its audience sees.
        let read = |r: Id| {
            (r == open || r == hidden).then(|| format!("words {}", r.counter()).into_bytes())
        };
        let records = Value::Array(vec![
            refer(open, true),
            refer(private, true),
            refer(hidden, false),
        ]);
        let mut reply = BTreeMap::from([(wire::RECORDS, records.clone())]);
        attach_words(&mut reply, &read);
        assert_eq!(
            reply.get(&wire::RECORDS),
            Some(&records),
            "the records are unchanged"
        );
        assert_eq!(
            reply.get(&PUBLIC_WORDS),
            Some(&Value::Array(vec![Value::Array(vec![
                open.to_value(),
                Value::Bytes(b"words 1".to_vec())
            ])]))
        );
        let mut refused = BTreeMap::from([(wire::REFUSED, Value::Uint(1))]);
        attach_words(&mut refused, &read);
        assert!(!refused.contains_key(&PUBLIC_WORDS));
    }
}
