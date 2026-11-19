//! Kinds by hash, and loading a kind's state, points and forms (Engine v2 K3, #2667). What a thing is and can do
//! comes from a kind loaded as data and named by the hash of its meaning (T3, `v2/docs/ids.md`); no engine code names
//! a kind, and a new kind needs no engine release. Running forms (F1), form rules (R2) and revision moves (F9) are not
//! here.
//!
//! A kind is T3's numbered map of sections, in SA-F1's numbers (#2842). This module reads:
//!
//! - **2, owner:** `thing`, `family` (a body's family) or `place`. Kinds are not only for things.
//! - **3, state:** fields by stable number, each `{1: name, 2: type, 3: default, 4: audience}`, and for an `enum`
//!   `5: [values]`. Types are `bool` (0 or 1), `int`, `duration` (whole microseconds), `enum`, `text` and `list`.
//!   An amount (an `int`) may give `6: its unit`, `7: its min` and `8: its max`, its capacity (F4). Numbers are whole:
//!   the encoding has no floats, so a client and the world never disagree over rounding. A `text` field holds a
//!   reference to its words (T8), its words capped at `9: most bytes`; a `list` holds at most `9: most` records whose
//!   fields are `10: {n: {1: name, 2: type, 5: values}}`, set whole (F11, #2774; [`Field::check`]).
//! - **4, links:** the link types it takes part in, `{1: name, 2: from (a category or a kind), 3: most, 4: most_per}`
//!   (B17, #3338). [`Kinds::check_link`] reads them: a link's type against the kinds at its ends.
//! - **5, points:** named places in the thing's frame, `{1: name, 2: [x, y, z] in mm, 3: role, 4: yaw in mdeg}`, the
//!   role one of `stand`, `grip`, `contact`, `outlet`, `joint`, or absent. A `joint` point is a connector (B17): where
//!   the part joins another, with `5: its connector kind` and `6: the connector kind it mates with`.
//! - **6, slots** and **11, children:** what it admits, as T2 reads them (`v2/docs/world-model.md` rule 5). A slot is
//!   its admit list, or `{1: admit list, 2: [x, y, z] in mm, 3: name}` with its place in the thing's frame (B17).
//!
//! A `souls-entry/1` file (`content/kinds`) is turned into this numbered form by [`entry::entry_to_kind`].
//! - **8, forms:** what can be done with it, `{1: name, 2: steps}`, each step a move by name and then its arguments.
//!
//! - **7, geometry:** `{1: bounds_mm [width, height, depth], 2: front}`, read by [`place::Geometry`]: a thing's two
//!   outlines and whether it has a front (E4, #2772).
//! - **19, loose:** how long a thing of the kind lasts loose, once nobody holds or owns it (F10, #2773): `{2: µs}`, a
//!   whole number of microseconds above zero, or `{1: 1}` (or `{}`), for ever. No section is for ever too
//!   ([`KindDef::loose`]).
//!
//! A family's size class, height and hover height are fields of its state, read by [`sizes::Build::of`] (B12). An
//! authored body's resources, declared actions and models are section 13, read by [`body::Decl`] (B13).
//!
//! Every section below 20 is in the hash, whether read here or not, so a section a later task adds (reactions,
//! lifetime, a place's line) is read by that task and already renames the kind. A thing whose kind is missing or bad
//! still loads, as "unknown kind", keeping its generic state; the store keeps why each refused kind was refused.

pub mod body;
pub mod entry;
pub mod place;
pub mod sizes;

use crate::encode::{Name, Value, encode};
use crate::ids::{Hash, KindRefusal, KindSource, name_kinds};
use crate::world_model::Kind as Admits;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub const SECTION_OWNER: u64 = 2;
pub const SECTION_STATE: u64 = 3;
pub const SECTION_LINKS: u64 = 4;
pub const SECTION_POINTS: u64 = 5;
pub const SECTION_SLOTS: u64 = 6;
pub const SECTION_FORMS: u64 = 8;
pub const SECTION_CHILDREN: u64 = 11;
pub const SECTION_LOOSE: u64 = 19;

/// What a node whose kind is not in the store is shown as.
pub const UNKNOWN_KIND: &str = "unknown kind";

/// A state field's type.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Type {
    Bool,
    Int,
    Duration,
    Enum(Vec<Name>),
    /// Words kept apart by reference (T8): a written value is `{21: id}` or `{}` (none), never the words. `most` caps
    /// the words' length in bytes (F11, #2774), checked when they are kept ([`Field::keep`]).
    Text {
        most: Option<u64>,
    },
    /// A short bounded list of small records (F11, #2774): at most `most` (1 to 100) records, each a map numbered 1, 2,
    /// ... in the order of `of`, whose fields are `bool`, `int`, `duration` or `enum` (never text, an id or a list). It
    /// is set whole by a generic set; [`Field::add`] makes the next whole list or refuses `list-full`.
    List {
        most: u64,
        of: Vec<(Name, Type)>,
    },
}

/// The most records a list field may declare: lists stay in tens, since each change sends the whole list again.
pub const LIST_MOST: u64 = 100;

/// A state field: its name, type, default and audience (a rule, read by T8).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Field {
    pub name: Name,
    pub ty: Type,
    pub default: Value,
    pub audience: Name,
    /// An amount's unit (`g`, `count`, ...), its least value and its capacity, whole numbers in that unit (F4).
    pub unit: Option<Name>,
    pub min: Option<i64>,
    pub max: Option<i64>,
}

type Checked<T> = Result<T, crate::effects::Refusal>;

fn no<T>(name: &'static str, detail: String) -> Checked<T> {
    Err(crate::effects::Refusal { name, detail })
}

/// Whether `v` is a value of a plain type (`bool`, `int`, `duration`, `enum`).
fn plain_fits(ty: &Type, v: &Value) -> bool {
    match (ty, v) {
        (Type::Bool, Value::Uint(b)) => *b <= 1,
        (Type::Int, Value::Uint(_) | Value::Nint(_)) | (Type::Duration, Value::Uint(_)) => true,
        (Type::Enum(values), Value::Text(t)) => values.contains(t),
        _ => false,
    }
}

impl Field {
    /// Whether `v` may be written to this field by a set (F11): a value of its type; for a list, an array of at most
    /// `most` well-formed records (`list-full` past it, `list-record-malformed`); for text, a reference `{21: id}` or
    /// `{}`, never the words (`text-inline`, T8 rule 6). Anything else is `value-type`. A text field's default may be
    /// the kind's own words, which are part of the kind, not the log.
    pub fn check(&self, v: &Value) -> Checked<()> {
        let name = self.name.as_str();
        match (&self.ty, v) {
            (Type::List { most, of }, Value::Array(items)) => {
                if items.len() as u64 > *most {
                    return no(
                        "list-full",
                        format!("{name} holds at most {most}; {} given", items.len()),
                    );
                }
                for (i, item) in items.iter().enumerate() {
                    let ok = match item {
                        Value::Map(m) => {
                            m.len() == of.len()
                                && (1u64..).zip(of).all(|(k, (_, ty))| {
                                    m.get(&k).is_some_and(|x| plain_fits(ty, x))
                                })
                        }
                        _ => false,
                    };
                    if !ok {
                        return no("list-record-malformed", format!("{name}: record {i}"));
                    }
                }
                Ok(())
            }
            (Type::Text { .. }, Value::Map(m)) if m.is_empty() => Ok(()),
            (Type::Text { .. }, _) if crate::audience::reference(v).is_some() => Ok(()),
            (Type::Text { .. }, Value::Text(_) | Value::Bytes(_)) => no(
                "text-inline",
                format!("{name} holds a reference to its words, never the words"),
            ),
            (ty, v) if plain_fits(ty, v) => Ok(()),
            _ => no("value-type", format!("{name}: not a value of its type")),
        }
    }

    /// The whole list after `record` is added at its end, to be written by one set: refused `list-full` when the list
    /// already holds `most` records, and as [`Field::check`] refuses a malformed record; `field-not-a-list` for any
    /// other field.
    pub fn add(&self, list: &Value, record: Value) -> Checked<Value> {
        let (Type::List { most, .. }, Value::Array(items)) = (&self.ty, list) else {
            return no("field-not-a-list", self.name.as_str().to_owned());
        };
        if items.len() as u64 >= *most {
            return no(
                "list-full",
                format!("{} holds at most {most}", self.name.as_str()),
            );
        }
        let mut next = items.clone();
        next.push(record);
        let next = Value::Array(next);
        self.check(&next)?;
        Ok(next)
    }

    /// Keeps `words` in `store` under `reference` (a minted id, never a hash of the words) for `audience`, and returns
    /// the value a set writes: `{21: reference}` (T8 rule 6). Refused `text-too-long` past the field's `most` bytes,
    /// and `field-not-text` for any other field; a refused text is not kept.
    pub fn keep(
        &self,
        store: &mut crate::audience::TextStore,
        reference: crate::ids::Id,
        audience: crate::world_model::Audience,
        words: &str,
    ) -> Checked<Value> {
        let Type::Text { most } = self.ty else {
            return no("field-not-text", self.name.as_str().to_owned());
        };
        if let Some(most) = most
            && words.len() as u64 > most
        {
            return no(
                "text-too-long",
                format!(
                    "{} holds at most {most} bytes; {} given",
                    self.name.as_str(),
                    words.len()
                ),
            );
        }
        store.keep(reference, audience, words);
        Ok(Value::Map(BTreeMap::from([(
            crate::audience::REFERENCE,
            reference.to_value(),
        )])))
    }
}

/// What a point is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Stand,
    Grip,
    Contact,
    Outlet,
    /// A connector: where a part joins another (B17).
    Joint,
}

/// A connector's own kind and the connector kind it mates with (`beam_end` with `beam_seat`, say; B17).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Connector {
    pub kind: Name,
    pub mates: Name,
}

/// A named place in the thing's own frame, in whole millimetres.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Point {
    pub name: Name,
    pub at_mm: [i64; 3],
    pub role: Option<Role>,
    /// Its heading in the thing's frame, in millidegrees (0 when not written).
    pub yaw_mdeg: i64,
    /// A `joint` point's connector; `None` for every other role.
    pub connector: Option<Connector>,
}

/// A numbered slot: its name and place in the thing's frame when the kind gives them, and what it admits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Slot {
    pub name: Option<Name>,
    pub at_mm: Option<[i64; 3]>,
    pub admits: BTreeSet<String>,
}

/// A link type a kind takes part in (section 4): the kind declaring it is one end, `from` (a category or a plain
/// `namespace:name`) the other.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkType {
    pub name: Name,
    pub from: Name,
    pub most: Option<u64>,
    pub most_per: Option<u64>,
}

/// One end of a link as [`Kinds::check_link`] reads it: the node's kind (full name) and, for a part that joins, the
/// connector it joins at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinkEnd<'a> {
    pub kind: &'a str,
    pub connector: Option<&'a str>,
}

/// Something that can be done with a thing of the kind. Its steps are F1's to run; each starts with a move's name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Form {
    pub name: Name,
    pub steps: Vec<Vec<Value>>,
}

/// A loaded kind: its full name `namespace:name@hash`, and what it declares.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KindDef {
    pub name: Name,
    pub hash: Hash,
    pub state: BTreeMap<u64, Field>,
    pub points: BTreeMap<u64, Point>,
    pub forms: BTreeMap<u64, Form>,
    pub admits: Admits,
    /// Section 13, an authored body's declaration (B13), for a family kind that has one.
    pub body: Option<body::Decl>,
    pub slots: BTreeMap<u64, Slot>,
    pub links: BTreeMap<u64, LinkType>,
    /// Section 11's bound: how many children of each admitted kind (plain `namespace:name`) it holds at most. A kind
    /// read from a list of names alone (a fixture's, no bound) has none here.
    pub most: BTreeMap<String, u64>,
    /// Section 7, its size and front (E4), for a kind that declares one.
    pub geometry: Option<place::Geometry>,
    /// Section 19, how long a thing of the kind lasts loose (F10), in µs; `None` is for ever.
    pub loose: Option<crate::time::Micros>,
}

impl KindDef {
    /// The point of this name.
    pub fn point(&self, name: &str) -> Option<&Point> {
        self.points.values().find(|p| p.name.as_str() == name)
    }

    /// Whether any point is a connector.
    pub fn joins(&self) -> bool {
        self.points.values().any(|p| p.connector.is_some())
    }

    /// The fields a new thing of this kind starts with: every state field at its default.
    pub fn defaults(&self) -> BTreeMap<u64, Value> {
        self.state
            .iter()
            .map(|(n, f)| (*n, f.default.clone()))
            .collect()
    }
}

/// Why a kind was refused: its name (or, if the text is not a kind, its source's label), the section and field
/// number where that is known, and the reason.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KindError {
    pub name: &'static str,
    pub kind: String,
    pub section: Option<u64>,
    pub field: Option<u64>,
    pub reason: String,
}

impl fmt::Display for KindError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.name, self.kind)?;
        if let Some(s) = self.section {
            write!(f, " section {s}")?;
        }
        if let Some(n) = self.field {
            write!(f, " field {n}")?;
        }
        write!(f, ": {}", self.reason)
    }
}

impl std::error::Error for KindError {}

/// The kinds a world has loaded, by hash. Revisions of one `namespace:name` sit side by side.
#[derive(Clone, Debug, Default)]
pub struct Kinds {
    by_hash: BTreeMap<Hash, KindDef>,
    by_name: BTreeMap<String, Hash>,
    refused: Vec<KindError>,
}

impl Kinds {
    /// Loads kinds from their texts, each with a label (its file name) to name it by if it is not a kind. Kinds in
    /// one call may refer to each other (section 10). A bad kind is refused and kept in [`Kinds::refused`]; the rest
    /// load. Returns the full names loaded, in the order given.
    pub fn load(&mut self, sources: &[(&str, &str)]) -> Vec<Name> {
        let mut good: Vec<(KindSource, Sections)> = Vec::new();
        for (label, text) in sources {
            let read = KindSource::parse(text)
                .map_err(|r| refusal(&r, label))
                .and_then(|s| read_sections(&s).map(|d| (s, d)));
            match read {
                Ok((s, _)) if good.iter().any(|(g, _)| g.name() == s.name()) => {
                    let r = KindRefusal::Duplicate(s.name().to_owned());
                    self.refused.push(refusal(&r, s.name()));
                }
                Ok(pair) => good.push(pair),
                Err(e) => self.refused.push(e),
            }
        }
        // T3 names the set; a refusal drops the kinds it names and the rest are named again.
        loop {
            let sources: Vec<KindSource> = good.iter().map(|(s, _)| s.clone()).collect();
            match name_kinds(&sources) {
                Ok(named) => {
                    let mut loaded = Vec::new();
                    for (s, d) in good {
                        let k = &named[s.name()];
                        let name = Name::new(&k.to_string()).expect("a full kind name is a name");
                        self.by_name.insert(k.to_string(), k.hash);
                        loaded.push(name.clone());
                        let Sections {
                            state,
                            points,
                            forms,
                            admits,
                            body,
                            slots,
                            links,
                            most,
                            geometry,
                            loose,
                        } = d;
                        let def = KindDef {
                            name,
                            hash: k.hash,
                            state,
                            points,
                            forms,
                            admits,
                            body,
                            slots,
                            links,
                            most,
                            geometry,
                            loose,
                        };
                        self.by_hash.insert(k.hash, def);
                    }
                    return loaded;
                }
                Err(r) => {
                    let out: Vec<String> = match &r {
                        KindRefusal::UnknownReference { kind, .. } => vec![kind.clone()],
                        KindRefusal::Circular(path) => path.clone(),
                        KindRefusal::Duplicate(n) => vec![n.clone()],
                        // Each kind's meaning was encoded alone in `read_sections`, so naming fails on none of them.
                        KindRefusal::Source(_) => {
                            good.iter().map(|(s, _)| s.name().to_owned()).collect()
                        }
                    };
                    for n in BTreeSet::from_iter(out.iter()) {
                        self.refused.push(refusal(&r, n));
                    }
                    good.retain(|(s, _)| !out.iter().any(|n| n == s.name()));
                }
            }
        }
    }

    /// The kind of this full name, if it is loaded.
    pub fn get(&self, full: &str) -> Option<&KindDef> {
        self.by_hash.get(self.by_name.get(full)?)
    }

    /// The kind with this hash, if it is loaded.
    pub fn by_hash(&self, hash: &Hash) -> Option<&KindDef> {
        self.by_hash.get(hash)
    }

    /// How a node of this kind is shown: its full name if loaded, otherwise [`UNKNOWN_KIND`]. The node itself keeps
    /// its id, parent, slot, pose and fields either way.
    pub fn label(&self, full: &str) -> &str {
        self.get(full).map_or(UNKNOWN_KIND, |k| k.name.as_str())
    }

    /// Every kind refused so far, with why.
    pub fn refused(&self) -> &[KindError] {
        &self.refused
    }

    /// Each loaded kind's section 11 bounds, by full name: how many children of each admitted kind it holds at most.
    pub fn most(&self) -> BTreeMap<String, BTreeMap<String, u64>> {
        self.by_hash
            .values()
            .filter(|k| !k.most.is_empty())
            .map(|k| (k.name.as_str().to_owned(), k.most.clone()))
            .collect()
    }

    /// What each loaded kind admits, by full name, as a commit's [`crate::tree::Rules`] reads it.
    pub fn admits(&self) -> BTreeMap<String, Admits> {
        self.by_hash
            .values()
            .map(|k| (k.name.as_str().to_owned(), k.admits.clone()))
            .collect()
    }

    /// Whether a link of type `ty` may join these two ends (B17; `v2/docs/world-model.md` rule 11 leaves a link's type
    /// against its ends' kinds to K3). One end's kind declares the type in section 4 with the other's kind (or its
    /// category) as `from`. When either kind has connectors, each end names one of its kind's connectors, and the two
    /// mate: each one's `mates` is the other's connector kind. Refused by name: `link-kind-unknown`,
    /// `link-type-undeclared`, `connector-missing`, `connector-unknown`, `connectors-do-not-mate`.
    pub fn check_link(&self, ty: &str, a: LinkEnd, b: LinkEnd) -> Result<(), KindError> {
        let refuse = |name, kind: &str, reason: String| KindError {
            name,
            kind: kind.to_owned(),
            section: None,
            field: None,
            reason,
        };
        let def = |e: LinkEnd| {
            self.get(e.kind)
                .ok_or_else(|| refuse("link-kind-unknown", e.kind, "the kind is not loaded".into()))
        };
        let (ka, kb) = (def(a)?, def(b)?);
        let declares = |k: &KindDef, other: &KindDef| {
            let plain = crate::world_model::plain(other.name.as_str());
            let category = match other.admits.owner.as_str() {
                "family" => "body",
                o => o,
            };
            k.links.values().any(|l| {
                l.name.as_str() == ty && (l.from.as_str() == plain || l.from.as_str() == category)
            })
        };
        if !declares(ka, kb) && !declares(kb, ka) {
            return Err(refuse(
                "link-type-undeclared",
                ka.name.as_str(),
                format!(
                    "neither end declares {ty} with the other's kind, {}",
                    kb.name.as_str()
                ),
            ));
        }
        if !ka.joins() && !kb.joins() {
            return Ok(());
        }
        let connector = |e: LinkEnd, k: &KindDef| -> Result<Connector, KindError> {
            let n = e.connector.ok_or_else(|| {
                refuse(
                    "connector-missing",
                    k.name.as_str(),
                    format!("a {ty} names a connector at each end"),
                )
            })?;
            k.point(n).and_then(|p| p.connector.clone()).ok_or_else(|| {
                refuse(
                    "connector-unknown",
                    k.name.as_str(),
                    format!("{n} is not a connector of this kind"),
                )
            })
        };
        let (ca, cb) = (connector(a, ka)?, connector(b, kb)?);
        if ca.mates != cb.kind || cb.mates != ca.kind {
            return Err(refuse(
                "connectors-do-not-mate",
                ka.name.as_str(),
                format!(
                    "{} does not mate with {}",
                    ca.kind.as_str(),
                    cb.kind.as_str()
                ),
            ));
        }
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.by_hash.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_hash.is_empty()
    }
}

fn refusal(r: &KindRefusal, kind: &str) -> KindError {
    KindError {
        name: r.name(),
        kind: kind.to_owned(),
        section: None,
        field: None,
        reason: match r {
            KindRefusal::Source(why) => why.clone(),
            _ => r.to_string(),
        },
    }
}

/// What a kind declares, read before the set is named.
struct Sections {
    state: BTreeMap<u64, Field>,
    points: BTreeMap<u64, Point>,
    forms: BTreeMap<u64, Form>,
    admits: Admits,
    body: Option<body::Decl>,
    slots: BTreeMap<u64, Slot>,
    links: BTreeMap<u64, LinkType>,
    most: BTreeMap<String, u64>,
    geometry: Option<place::Geometry>,
    loose: Option<crate::time::Micros>,
}

/// Reads and checks the sections this module knows.
fn read_sections(src: &KindSource) -> Result<Sections, KindError> {
    let kind = src.name();
    let s = src.sections();
    let bad = |name, section, field, reason: String| KindError {
        name,
        kind: kind.to_owned(),
        section: Some(section),
        field,
        reason,
    };
    let meaning: BTreeMap<u64, Value> = s
        .range(..crate::ids::BESIDE_FROM)
        .map(|(k, v)| (*k, v.clone()))
        .collect();
    if let Err(e) = encode(&Value::Map(meaning)) {
        return Err(KindError {
            name: "kind-source",
            kind: kind.to_owned(),
            section: None,
            field: None,
            reason: e.to_string(),
        });
    }
    let owner = match s.get(&SECTION_OWNER) {
        Some(Value::Text(o)) if ["thing", "family", "place"].contains(&o.as_str()) => {
            o.as_str().to_owned()
        }
        _ => {
            return Err(bad(
                "kind-owner",
                SECTION_OWNER,
                None,
                "the owner is thing, family or place".into(),
            ));
        }
    };
    let entries = |section: u64,
                   name: &'static str|
     -> Result<BTreeMap<u64, BTreeMap<u64, Value>>, KindError> {
        let Some(v) = s.get(&section) else {
            return Ok(BTreeMap::new());
        };
        let Value::Map(m) = v else {
            return Err(bad(name, section, None, "a map of numbered entries".into()));
        };
        m.iter()
            .map(|(n, e)| match e {
                Value::Map(e) => Ok((*n, e.clone())),
                _ => Err(bad(name, section, Some(*n), "an entry is a map".into())),
            })
            .collect()
    };

    let mut state = BTreeMap::new();
    for (n, e) in entries(SECTION_STATE, "kind-state")? {
        let why = |reason: String| bad("kind-state", SECTION_STATE, Some(n), reason);
        let name = text(e.get(&1)).ok_or_else(|| why("1, the name, is text".into()))?;
        let word = text(e.get(&2));
        let ty = match word.as_ref().map(Name::as_str) {
            Some("text") => Type::Text {
                most: match e.get(&9) {
                    None => None,
                    Some(Value::Uint(m)) if *m > 0 => Some(*m),
                    Some(_) => return Err(why("9, the most bytes, is a whole number".into())),
                },
            },
            Some("list") => {
                let most = match e.get(&9) {
                    Some(Value::Uint(m)) if (1..=LIST_MOST).contains(m) => *m,
                    _ => return Err(why(format!("9, the most records, is 1 to {LIST_MOST}"))),
                };
                let of = match e.get(&10) {
                    Some(Value::Map(of)) if (1..=8).contains(&of.len()) => of,
                    _ => {
                        return Err(why(
                            "10, the record's fields, is a map of one to eight".into()
                        ));
                    }
                };
                let of = of
                    .values()
                    .map(|r| {
                        let Value::Map(r) = r else {
                            return Err(why("a record field is a map".into()));
                        };
                        let name = text(r.get(&1))
                            .ok_or_else(|| why("a record field's 1, its name, is text".into()))?;
                        let ty = plain_type(text(r.get(&2)), r.get(&5)).ok_or_else(|| {
                            why("a record field is bool, int, duration or enum".into())
                        })?;
                        Ok((name, ty))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Type::List { most, of }
            }
            _ => plain_type(word.clone(), e.get(&5)).ok_or_else(|| {
                why(
                    "2, the type, is bool, int, duration, enum (its values in 5), text or list"
                        .into(),
                )
            })?,
        };
        let default = e
            .get(&3)
            .cloned()
            .ok_or_else(|| why("3, the default, is missing".into()))?;
        let audience = text(e.get(&4)).ok_or_else(|| why("4, the audience, is text".into()))?;
        let unit = e
            .get(&6)
            .map(|u| text(Some(u)).ok_or_else(|| why("6, the unit, is text".into())));
        let bound = |k: u64, what: &str| {
            e.get(&k)
                .map(|v| int(v).ok_or_else(|| why(format!("{k}, the {what}, is a whole number"))))
                .transpose()
        };
        let field = Field {
            name,
            ty,
            default,
            audience,
            unit: unit.transpose()?,
            min: bound(7, "min")?,
            max: bound(8, "max")?,
        };
        // A text field's default may be the kind's own words (T8 rule 6); every other default is a value it may hold.
        let fits = match (&field.ty, &field.default) {
            (Type::Text { .. }, Value::Text(_)) => true,
            (_, d) => field.check(d).is_ok(),
        };
        if !fits {
            let word = word.as_ref().map_or("", Name::as_str);
            return Err(why(format!(
                "3, the default, is not a value of type {word}"
            )));
        }
        state.insert(n, field);
    }

    let mut points = BTreeMap::new();
    for (n, e) in entries(SECTION_POINTS, "kind-point")? {
        let why = |reason: &str| bad("kind-point", SECTION_POINTS, Some(n), reason.into());
        let name = text(e.get(&1)).ok_or_else(|| why("1, the name, is text"))?;
        let at_mm = e
            .get(&2)
            .and_then(xyz)
            .ok_or_else(|| why("2, the position, is three whole millimetres"))?;
        let role = match e.get(&3) {
            None => None,
            Some(r) => Some(match text(Some(r)).as_ref().map(Name::as_str) {
                Some("stand") => Role::Stand,
                Some("grip") => Role::Grip,
                Some("contact") => Role::Contact,
                Some("outlet") => Role::Outlet,
                Some("joint") => Role::Joint,
                _ => return Err(why("3, the role, is stand, grip, contact, outlet or joint")),
            }),
        };
        let yaw_mdeg = match e.get(&4) {
            None => 0,
            Some(v) => int(v).ok_or_else(|| why("4, the yaw, is whole millidegrees"))?,
        };
        let connector = match (role, text(e.get(&5)), text(e.get(&6))) {
            (Some(Role::Joint), Some(kind), Some(mates)) => Some(Connector { kind, mates }),
            (Some(Role::Joint), _, _) => {
                return Err(why(
                    "a joint names its connector kind in 5 and what it mates with in 6",
                ));
            }
            (_, None, None) => None,
            _ => {
                return Err(why(
                    "only a joint names a connector kind (5) and what it mates with (6)",
                ));
            }
        };
        points.insert(
            n,
            Point {
                name,
                at_mm,
                role,
                yaw_mdeg,
                connector,
            },
        );
    }

    let mut forms = BTreeMap::new();
    for (n, e) in entries(SECTION_FORMS, "kind-form")? {
        let why = |reason: &str| bad("kind-form", SECTION_FORMS, Some(n), reason.into());
        let name = text(e.get(&1)).ok_or_else(|| why("1, the name, is text"))?;
        let Some(Value::Array(steps)) = e.get(&2) else {
            return Err(why("2, the steps, is a list"));
        };
        let steps = steps
            .iter()
            .map(|st| match st {
                Value::Array(a) if matches!(a.first(), Some(Value::Text(_))) => Ok(a.clone()),
                _ => Err(why("a step is a move's name and then its arguments")),
            })
            .collect::<Result<Vec<_>, _>>()?;
        forms.insert(n, Form { name, steps });
    }

    let mut links = BTreeMap::new();
    for (n, e) in entries(SECTION_LINKS, "kind-link")? {
        let why = |reason: &str| bad("kind-link", SECTION_LINKS, Some(n), reason.into());
        let name = text(e.get(&1)).ok_or_else(|| why("1, the name, is text"))?;
        let from =
            text(e.get(&2)).ok_or_else(|| why("2, the other end, is a category or a kind"))?;
        let count = |k| match e.get(&k) {
            None => Ok(None),
            Some(Value::Uint(u)) if *u > 0 => Ok(Some(*u)),
            Some(_) => Err(why(
                "3 and 4, most and most_per, are whole numbers above zero",
            )),
        };
        let (most, most_per) = (count(3)?, count(4)?);
        links.insert(
            n,
            LinkType {
                name,
                from,
                most,
                most_per,
            },
        );
    }

    let mut slots = BTreeMap::new();
    let mut named_slots = BTreeMap::new();
    if let Some(v) = s.get(&SECTION_SLOTS) {
        let Value::Map(m) = v else {
            return Err(bad(
                "kind-slot",
                SECTION_SLOTS,
                None,
                "a map of slots to what each admits".into(),
            ));
        };
        for (n, entry) in m {
            let why = |reason: &str| bad("kind-slot", SECTION_SLOTS, Some(*n), reason.into());
            let (admits, at_mm, name) = match entry {
                Value::Map(e) => {
                    let at_mm = match e.get(&2) {
                        None => None,
                        Some(v) => Some(
                            xyz(v)
                                .ok_or_else(|| why("2, the place, is three whole millimetres"))?,
                        ),
                    };
                    (e.get(&1), at_mm, text(e.get(&3)))
                }
                list => (Some(list), None, None),
            };
            let list = texts(admits).ok_or_else(|| why("a list of kinds or categories"))?;
            let admits: BTreeSet<String> = list.iter().map(|t| t.as_str().to_owned()).collect();
            slots.insert(*n, admits.clone());
            named_slots.insert(
                *n,
                Slot {
                    name,
                    at_mm,
                    admits,
                },
            );
        }
    }
    // Section 11: each child as `{1: kind, 2: most}` (an entry's, B19), or a kind's name alone (a fixture's, no bound).
    let mut children = BTreeSet::new();
    let mut most = BTreeMap::new();
    if let Some(v) = s.get(&SECTION_CHILDREN) {
        let why = || {
            bad(
                "kind-children",
                SECTION_CHILDREN,
                None,
                "a list of kinds or categories, each a name or {1: kind, 2: most}".into(),
            )
        };
        let Value::Array(list) = v else {
            return Err(why());
        };
        for c in list {
            match c {
                Value::Map(m) => {
                    let name = text(m.get(&1)).ok_or_else(why)?;
                    let bound = match m.get(&2) {
                        Some(Value::Uint(n)) if *n > 0 => *n,
                        _ => return Err(why()),
                    };
                    most.insert(name.as_str().to_owned(), bound);
                    children.insert(name.as_str().to_owned());
                }
                other => {
                    children.insert(text(Some(other)).ok_or_else(why)?.as_str().to_owned());
                }
            }
        }
    }

    // How a thing moves (section 18, `{1: how}`): held in one or two hands, or not held (B4, #2739).
    let hands = match s.get(&crate::world_model::SECTION_MOTION) {
        None => None,
        Some(Value::Map(m)) => match text(m.get(&1)).as_ref().map(Name::as_str) {
            Some("one_hand") => Some(1),
            Some("two_hands") => Some(2),
            _ => None,
        },
        Some(_) => return Err(bad("kind-motion", 18, None, "{1: how}".into())),
    };

    let body = match s.get(&body::SECTION_BODY) {
        None => None,
        Some(v) => {
            let why = |reason: String| bad("kind-body", body::SECTION_BODY, None, reason);
            if owner != "family" {
                return Err(why("only a family kind declares a body".into()));
            }
            let Value::Map(m) = v else {
                return Err(why("a map of numbered entries".into()));
            };
            Some(body::Decl::read(kind, m).map_err(why)?)
        }
    };

    // Section 7 is in the hash whatever it holds; one not in E4's shape is not read, as an unread section is not.
    let geometry = s
        .get(&place::SECTION_GEOMETRY)
        .and_then(|v| place::Geometry::read(v).ok());

    // Section 19 (F10): `{2: µs}` above zero, or `{1: 1}` for ever; anything else is refused by name.
    let loose = match s.get(&SECTION_LOOSE) {
        None => None,
        Some(Value::Map(m)) => match (m.get(&1), m.get(&2).map(int)) {
            (None, None) if m.is_empty() => None,
            (Some(Value::Uint(1)), None) if m.len() == 1 => None,
            (None, Some(Some(us))) if us > 0 && m.len() == 1 => Some(us),
            _ => {
                return Err(bad(
                    "kind-loose",
                    SECTION_LOOSE,
                    None,
                    "{1: 1} for ever, or {2: microseconds above zero}".into(),
                ));
            }
        },
        Some(_) => {
            return Err(bad(
                "kind-loose",
                SECTION_LOOSE,
                None,
                "a map: {1: 1} or {2: microseconds}".into(),
            ));
        }
    };

    Ok(Sections {
        body,
        geometry,
        loose,
        state,
        points,
        forms,
        admits: Admits {
            owner,
            children,
            slots,
            hands,
        },
        slots: named_slots,
        links,
        most,
    })
}

/// A plain type from its word and, for an enum, its values.
fn plain_type(word: Option<Name>, values: Option<&Value>) -> Option<Type> {
    match word.as_ref().map(Name::as_str) {
        Some("bool") => Some(Type::Bool),
        Some("int") => Some(Type::Int),
        Some("duration") => Some(Type::Duration),
        Some("enum") => texts(values).filter(|v| !v.is_empty()).map(Type::Enum),
        _ => None,
    }
}

fn text(v: Option<&Value>) -> Option<Name> {
    match v {
        Some(Value::Text(t)) => Some(t.clone()),
        _ => None,
    }
}

fn texts(v: Option<&Value>) -> Option<Vec<Name>> {
    match v {
        Some(Value::Array(a)) => a.iter().map(|x| text(Some(x))).collect(),
        _ => None,
    }
}

fn xyz(v: &Value) -> Option<[i64; 3]> {
    match v {
        Value::Array(a) if a.len() == 3 => Some([int(&a[0])?, int(&a[1])?, int(&a[2])?]),
        _ => None,
    }
}

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}
