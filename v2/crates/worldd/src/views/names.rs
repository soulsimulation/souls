//! Immutable public name bytes beside the canonical records that already authorize their references.
use replica::encode::{Value, decode, encode};
use replica::ids::sha256;
use replica::sync::wire;
use std::collections::BTreeMap;

pub type PublicNames = BTreeMap<[u8; 32], String>;
pub const PUBLIC_NAMES: u64 = 26;
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
}
