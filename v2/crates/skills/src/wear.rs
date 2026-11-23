//! A Soul's body chosen (Engine v2 B15a, #2750): the Soul's own intent [`VERB`] names a body the world's
//! [`Catalogue`] admits, and the change is one write, the body's content hash on the Soul's body node ([`BODY`]).
//!
//! - **By hash.** The node holds the content hash (32 bytes), never a preset's name, so a replay draws the body it had
//!   at each moment. A preset's hash is the SHA-256 of its kind file as B13's importer wrote it
//!   (`v2/tools/import-body`), which names both its models by their own hashes and holds its size, height and hover.
//! - **The catalogue** is the world's: `bodies.json` in its folder, `{"format": "souls/bodies/1", "bodies": [{"preset",
//!   "hash" (64 hex), "size", "height" (mm), "hover" (mm)}, ...]}`, the presets it admits. A released preset is never
//!   re-pinned (`docs/design/custom-bodies.md`): a changed body is a new entry with a new hash.
//! - **The intent** `life:wear` names the body in parameter 1 as T8's words shape, `{23: bytes}`: the preset's name
//!   or its 64-hex hash. The world resolves it here and logs only the hash.
//! - A body with no [`BODY`] field wears the world's default ([`DEFAULT`], today's walking body).
//! - **A look** (#3998): a body with no [`BODY`] may carry a humanoid look made in today's editor, its core/humanoid@2
//!   params as UTF-8 JSON (one object, at most [`LOOK_MOST`] bytes), in [`LOOK`]. The world does not read it; the page
//!   draws it over the default body. The Soul's own [`LOOK_VERB`] writes it ([`look`]), only while it wears no hash.
//!
//! The fit check (`sim::ground::sizes::change_size`) is the world's: this crate cannot name `sim`.

use std::collections::BTreeMap;

use replica::effects::Change;
use replica::encode::{Value, from_hex, to_hex};
use replica::ids::Id;
use replica::kinds::sizes::{Build, Size};
use replica::rules::json::{self, Value as Json};

/// The Soul's intent that chooses its body, in the namespace of C3's `life:join` (`souls:` verbs are a closed list).
pub const VERB: &str = "life:wear";
/// The body node's field holding the content hash of the body it wears (32 bytes).
pub const BODY: u64 = 32;
/// The body node's field holding its humanoid look's params (#3998): a costume over the default body.
pub const LOOK: u64 = 33;
/// The most bytes a look's params take.
pub const LOOK_MOST: usize = 2048;
/// The Soul's intent that puts a look on its default body: parameter 1 is the params' bytes.
pub const LOOK_VERB: &str = "life:look";
/// T8's words key: parameter 1 of a wear is `{23: bytes}`.
const WORDS: u64 = 23;
/// The body a node with no [`BODY`] field wears: the standard class, 1.75 m, standing.
pub const DEFAULT: Build = Build {
    size: Size::Standard,
    height_mm: 1_750,
    hover_mm: 0,
};

/// One body a world admits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preset {
    pub name: String,
    pub hash: [u8; 32],
    pub build: Build,
}

/// The presets a world admits, by content hash.
#[derive(Clone, Debug, Default)]
pub struct Catalogue {
    by_hash: BTreeMap<[u8; 32], Preset>,
}

impl Catalogue {
    /// Reads `bodies.json` (`souls/bodies/1`); an entry malformed is refused by its index.
    pub fn read(text: &str) -> Result<Catalogue, String> {
        let v = json::parse(text)?;
        if v.get("format").and_then(Json::str) != Some("souls/bodies/1") {
            return Err("bodies.json is not souls/bodies/1".into());
        }
        let mut by_hash = BTreeMap::new();
        for (i, e) in v
            .get("bodies")
            .and_then(Json::arr)
            .unwrap_or(&[])
            .iter()
            .enumerate()
        {
            let bad = |what: &str| format!("bodies.json body {i}: {what}");
            let text = |k: &str| e.get(k).and_then(Json::str).ok_or_else(|| bad(k));
            let mm = |k: &str| match e.get(k) {
                Some(Json::Int(n)) if *n >= 0 => i64::try_from(*n).map_err(|_| bad(k)),
                None if k == "hover" => Ok(0),
                _ => Err(bad(k)),
            };
            let hash = hash_of(text("hash")?).ok_or_else(|| bad("hash is 64 hex"))?;
            let build = Build {
                size: Size::from_name(text("size")?).map_err(|r| bad(&r.detail))?,
                height_mm: mm("height")?,
                hover_mm: mm("hover")?,
            };
            if build.height_mm <= 0 || build.hover_mm.checked_mul(1000).is_none() {
                return Err(bad("body dimensions"));
            }
            let name = text("preset")?.to_owned();
            by_hash.insert(hash, Preset { name, hash, build });
        }
        Ok(Catalogue { by_hash })
    }

    pub fn classes(&self) -> impl Iterator<Item = Size> + '_ {
        self.by_hash.values().map(|p| p.build.size)
    }

    /// The preset of this hash.
    pub fn get(&self, hash: &[u8; 32]) -> Option<&Preset> {
        self.by_hash.get(hash)
    }

    /// The preset named `asked`: its name, or its hash in hex.
    pub fn find(&self, asked: &str) -> Option<&Preset> {
        match hash_of(asked) {
            Some(h) => self.get(&h),
            None => self.by_hash.values().find(|p| p.name == asked),
        }
    }

    /// The recorded admitted build. Only an absent hash uses [`DEFAULT`]; unknown or malformed hashes refuse.
    pub fn build_of(&self, worn: Option<&Value>) -> Result<Build, &'static str> {
        match worn {
            None => Ok(DEFAULT),
            Some(Value::Bytes(b)) => <[u8; 32]>::try_from(b.as_slice())
                .ok()
                .and_then(|h| self.get(&h))
                .map(|p| p.build)
                .ok_or("body-unknown"),
            Some(_) => Err("body-unknown"),
        }
    }
}

/// A hash in hex (64 digits, `sha256:` allowed before them).
pub fn hash_of(text: &str) -> Option<[u8; 32]> {
    let hex = text.strip_prefix("sha256:").unwrap_or(text);
    (hex.len() == 64).then_some(())?;
    from_hex(hex).ok()?.try_into().ok()
}

/// A hash as the catalogue writes it.
pub fn hex(hash: &[u8; 32]) -> String {
    to_hex(hash)
}

/// What a wear's parameters ask for: parameter 1's words, as text.
pub fn asked(parameters: &BTreeMap<u64, Value>) -> Option<String> {
    match parameters.get(&1)? {
        Value::Map(m) => match m.get(&WORDS)? {
            Value::Bytes(b) => String::from_utf8(b.clone()).ok(),
            _ => None,
        },
        _ => None,
    }
}

/// The one write: `body` wears `hash`.
pub fn change(body: Id, hash: &[u8; 32]) -> Change {
    Change::Set {
        node: body,
        field: BODY,
        to: Value::Bytes(hash.to_vec()),
        by: None,
    }
}

/// Where a body stands for a look, from its node's fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Look {
    /// It wears a body by hash: a look is not put on it.
    WearsBody,
    /// It already carries these very params.
    Worn,
    /// The look is written.
    Write,
}

/// A look's params from parameter 1, checked: one JSON object as UTF-8, at most [`LOOK_MOST`] bytes.
pub fn look_params(parameters: &BTreeMap<u64, Value>) -> Result<&[u8], &'static str> {
    let Some(Value::Bytes(b)) = parameters.get(&1) else {
        return Err("look.malformed");
    };
    let text = std::str::from_utf8(b).map_err(|_| "look.malformed")?;
    let object = json::parse(text).is_ok_and(|v| v.obj().is_some());
    if b.len() > LOOK_MOST || !object {
        return Err("look.malformed");
    }
    Ok(b)
}

/// What a look `params` does to a body whose node holds `fields`.
pub fn look(fields: &BTreeMap<u64, Value>, params: &[u8]) -> Look {
    match (fields.get(&BODY), fields.get(&LOOK)) {
        (Some(_), _) => Look::WearsBody,
        (None, Some(Value::Bytes(b))) if b == params => Look::Worn,
        _ => Look::Write,
    }
}

/// The one write of a look: `body` carries `params`.
pub fn look_change(body: Id, params: &[u8]) -> Change {
    Change::Set {
        node: body,
        field: LOOK,
        to: Value::Bytes(params.to_vec()),
        by: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::ids::Scope;

    const H: &str = "0a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20212223242526272829";

    fn cat() -> Catalogue {
        Catalogue::read(&format!(
            r#"{{"format": "souls/bodies/1", "bodies": [
              {{"preset": "verdelis", "hash": "{H}", "size": "large", "height": 1450, "hover": 1450}}]}}"#
        ))
        .unwrap()
    }

    #[test]
    fn a_preset_is_found_by_name_or_hash_and_the_write_is_its_hash() {
        let c = cat();
        let p = c.find("verdelis").unwrap();
        assert_eq!(hex(&p.hash), H);
        assert_eq!(c.find(&format!("sha256:{H}")), Some(p));
        assert_eq!(p.build.size, Size::Large);
        assert!(c.find("nobody").is_none());
        let body = Id::new(Scope([1; 16]), 7).unwrap();
        let Change::Set {
            node, field, to, ..
        } = change(body, &p.hash)
        else {
            panic!("a set")
        };
        assert_eq!((node, field), (body, BODY));
        assert_eq!(c.build_of(Some(&to)), Ok(p.build));
        assert_eq!(c.build_of(None), Ok(DEFAULT));
        assert_eq!(
            c.build_of(Some(&Value::Bytes(vec![0xff; 32]))),
            Err("body-unknown")
        );
        assert_eq!(c.build_of(Some(&Value::Uint(1))), Err("body-unknown"));
    }

    #[test]
    fn a_wear_names_its_body_in_parameter_one() {
        let p = BTreeMap::from([(
            1,
            Value::Map(BTreeMap::from([(WORDS, Value::Bytes(b"pip".to_vec()))])),
        )]);
        assert_eq!(asked(&p).as_deref(), Some("pip"));
        assert_eq!(asked(&BTreeMap::new()), None);
    }

    #[test]
    fn a_look_is_one_object_and_goes_only_on_a_default_body() {
        let params = br##"{"frame":"fem","hair":"bob","skin":"#a0785a"}"##;
        let p = |b: &[u8]| BTreeMap::from([(1, Value::Bytes(b.to_vec()))]);
        assert_eq!(look_params(&p(params)), Ok(&params[..]));
        let long = format!("{{\"a\":\"{}\"}}", "x".repeat(LOOK_MOST));
        for bad in [&b"[1]"[..], b"nope", &[0xff], long.as_bytes()] {
            assert_eq!(look_params(&p(bad)), Err("look.malformed"));
        }
        assert_eq!(look_params(&BTreeMap::new()), Err("look.malformed"));
        let mut fields = BTreeMap::new();
        assert_eq!(look(&fields, params), Look::Write);
        fields.insert(LOOK, Value::Bytes(b"{}".to_vec()));
        assert_eq!(look(&fields, params), Look::Write);
        fields.insert(LOOK, Value::Bytes(params.to_vec()));
        assert_eq!(look(&fields, params), Look::Worn);
        fields.insert(BODY, Value::Bytes(vec![1; 32]));
        assert_eq!(look(&fields, params), Look::WearsBody);
        let body = Id::new(Scope([1; 16]), 7).unwrap();
        assert!(matches!(
            look_change(body, params),
            Change::Set { field: LOOK, .. }
        ));
    }

    #[test]
    fn a_malformed_catalogue_is_refused() {
        assert!(Catalogue::read(r#"{"format": "x"}"#).is_err());
        let e = Catalogue::read(
            r#"{"format": "souls/bodies/1", "bodies": [{"preset": "a", "hash": "zz"}]}"#,
        );
        assert!(e.unwrap_err().contains("hash"));
    }
}
