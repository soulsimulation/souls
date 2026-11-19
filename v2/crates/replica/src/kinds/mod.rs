//! Kinds by hash, and loading a kind's state, points and forms (Engine v2 K3, #2667). What a thing is and can do
//! comes from a kind loaded as data and named by the hash of its meaning (T3, `v2/docs/ids.md`); no engine code names
//! a kind, and a new kind needs no engine release. Running forms (F1), form rules (R2) and revision moves (F9) are not
//! here.
//!
//! A kind is T3's numbered map of sections, in SA-F1's numbers (#2842). This module reads:
//!
//! - **2, owner:** `thing`, `family` (a body's family) or `place`. Kinds are not only for things.
//! - **3, state:** fields by stable number, each `{1: name, 2: type, 3: default, 4: audience}`, and for an `enum`
//!   `5: [values]`. Types are `bool` (0 or 1), `int`, `duration` (whole microseconds), `enum` and `text`. Numbers are
//!   whole: the encoding has no floats, so a client and the world never disagree over rounding.
//! - **5, points:** named places in the thing's frame, `{1: name, 2: [x, y, z] in mm, 3: role}`, the role one of
//!   `stand`, `grip`, `contact`, `outlet`, or absent.
//! - **6, slots** and **11, children:** what it admits, as T2 reads them (`v2/docs/world-model.md` rule 5).
//! - **8, forms:** what can be done with it, `{1: name, 2: steps}`, each step a move by name and then its arguments.
//!
//! A family's size class, height and hover height are fields of its state, read by [`sizes::Build::of`] (B12). An
//! authored body's resources, declared actions and models are section 13, read by [`body::Decl`] (B13).
//!
//! Every section below 20 is in the hash, whether read here or not, so a section a later task adds (reactions,
//! lifetime, a place's line) is read by that task and already renames the kind. A thing whose kind is missing or bad
//! still loads, as "unknown kind", keeping its generic state; the store keeps why each refused kind was refused.

pub mod body;
pub mod sizes;

use crate::encode::{Name, Value, encode};
use crate::ids::{Hash, KindRefusal, KindSource, name_kinds};
use crate::world_model::Kind as Admits;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub const SECTION_OWNER: u64 = 2;
pub const SECTION_STATE: u64 = 3;
pub const SECTION_POINTS: u64 = 5;
pub const SECTION_SLOTS: u64 = 6;
pub const SECTION_FORMS: u64 = 8;
pub const SECTION_CHILDREN: u64 = 11;

/// What a node whose kind is not in the store is shown as.
pub const UNKNOWN_KIND: &str = "unknown kind";

/// A state field's type.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Type {
    Bool,
    Int,
    Duration,
    Enum(Vec<Name>),
    Text,
}

/// A state field: its name, type, default and audience (a rule, read by T8).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Field {
    pub name: Name,
    pub ty: Type,
    pub default: Value,
    pub audience: Name,
}

/// What a point is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Stand,
    Grip,
    Contact,
    Outlet,
}

/// A named place in the thing's own frame, in whole millimetres.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Point {
    pub name: Name,
    pub at_mm: [i64; 3],
    pub role: Option<Role>,
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
}

impl KindDef {
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
                        } = d;
                        let def = KindDef {
                            name,
                            hash: k.hash,
                            state,
                            points,
                            forms,
                            admits,
                            body,
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

    /// What each loaded kind admits, by full name, as a commit's [`crate::tree::Rules`] reads it.
    pub fn admits(&self) -> BTreeMap<String, Admits> {
        self.by_hash
            .values()
            .map(|k| (k.name.as_str().to_owned(), k.admits.clone()))
            .collect()
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
            Some("bool") => Type::Bool,
            Some("int") => Type::Int,
            Some("duration") => Type::Duration,
            Some("text") => Type::Text,
            Some("enum") => Type::Enum(
                texts(e.get(&5))
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| why("an enum lists its values in 5".into()))?,
            ),
            _ => {
                return Err(why(
                    "2, the type, is bool, int, duration, enum or text".into()
                ));
            }
        };
        let default = e
            .get(&3)
            .cloned()
            .ok_or_else(|| why("3, the default, is missing".into()))?;
        let fits = match (&ty, &default) {
            (Type::Bool, Value::Uint(b)) => *b <= 1,
            (Type::Int, Value::Uint(_) | Value::Nint(_)) | (Type::Duration, Value::Uint(_)) => true,
            (Type::Enum(values), Value::Text(t)) => values.contains(t),
            (Type::Text, Value::Text(_)) => true,
            _ => false,
        };
        if !fits {
            let word = word.as_ref().map_or("", Name::as_str);
            return Err(why(format!(
                "3, the default, is not a value of type {word}"
            )));
        }
        let audience = text(e.get(&4)).ok_or_else(|| why("4, the audience, is text".into()))?;
        state.insert(
            n,
            Field {
                name,
                ty,
                default,
                audience,
            },
        );
    }

    let mut points = BTreeMap::new();
    for (n, e) in entries(SECTION_POINTS, "kind-point")? {
        let why = |reason: &str| bad("kind-point", SECTION_POINTS, Some(n), reason.into());
        let name = text(e.get(&1)).ok_or_else(|| why("1, the name, is text"))?;
        let at_mm = match e.get(&2) {
            Some(Value::Array(xyz)) if xyz.len() == 3 => {
                let mut at = [0i64; 3];
                for (a, v) in at.iter_mut().zip(xyz) {
                    *a =
                        int(v).ok_or_else(|| why("2, the position, is three whole millimetres"))?;
                }
                at
            }
            _ => return Err(why("2, the position, is three whole millimetres")),
        };
        let role = match e.get(&3) {
            None => None,
            Some(r) => Some(match text(Some(r)).as_ref().map(Name::as_str) {
                Some("stand") => Role::Stand,
                Some("grip") => Role::Grip,
                Some("contact") => Role::Contact,
                Some("outlet") => Role::Outlet,
                _ => return Err(why("3, the role, is stand, grip, contact or outlet")),
            }),
        };
        points.insert(n, Point { name, at_mm, role });
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

    let mut slots = BTreeMap::new();
    if let Some(v) = s.get(&SECTION_SLOTS) {
        let Value::Map(m) = v else {
            return Err(bad(
                "kind-slot",
                SECTION_SLOTS,
                None,
                "a map of slots to what each admits".into(),
            ));
        };
        for (n, admits) in m {
            let list = texts(Some(admits)).ok_or_else(|| {
                bad(
                    "kind-slot",
                    SECTION_SLOTS,
                    Some(*n),
                    "a list of kinds or categories".into(),
                )
            })?;
            slots.insert(*n, list.iter().map(|t| t.as_str().to_owned()).collect());
        }
    }
    let children = match s.get(&SECTION_CHILDREN) {
        None => BTreeSet::new(),
        Some(v) => texts(Some(v))
            .ok_or_else(|| {
                bad(
                    "kind-children",
                    SECTION_CHILDREN,
                    None,
                    "a list of kinds or categories".into(),
                )
            })?
            .iter()
            .map(|t| t.as_str().to_owned())
            .collect(),
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

    Ok(Sections {
        body,
        state,
        points,
        forms,
        admits: Admits {
            owner,
            children,
            slots,
        },
    })
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

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}
