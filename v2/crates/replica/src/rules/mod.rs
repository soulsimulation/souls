//! Form rules (Engine v2 R2, #2685): whether a form of a kind can be done now, decided from plain data by one
//! function, [`decide`], that the world, the agent's client and a page all run, natively or in WASM. A form is the
//! data description of an act: what it needs, its steps and its effects (`souls-entry/1`, the Soul Actions entry
//! format). The cases are the specification: the Soul Actions folder `packages/form-rules/cases` and this crate's
//! `cases/` (`souls-form-cases/1`), read by `tests/rules.rs`; adding a case changes no code.
//!
//! **The closed list of needs** ([`NEEDS`]), shared with Soul Actions SA-F2 (#2843):
//!
//! | need | meets when | unmet reason |
//! |---|---|---|
//! | `state` | a field (or a `field` argument) `is` / is `not` a value (or a `value` argument), or lies in `at_least`..`at_most` (a `timed` field at `state.now_us`); with `of`, a field of the thing an argument names; with `link`, of the place this thing is linked to | `field_differs`, `not_linked` |
//! | `slot_free` | a slot (of this thing, or `{node, slot}` of another) has fewer occupants than its `most` | `slot_taken` |
//! | `within_reach` | a point is within the reach of the move the form's step makes there, as squares in `i128`; a thing the form walks to first is reached when it is in the actor's place | `out_of_reach` |
//! | `hand` | the actor has a free hand (`free: true`), every hand empty (`empty: true`) or a hand holding a kind (`holds`: a thing of that kind or one whose `entry` borrows it, [`is_kind`]) | `no_free_hand`, `hand_not_empty`, `not_holding_kind` |
//! | `held_by_actor` | this thing (or the `thing` argument) is in one of the actor's hands | `not_held` |
//! | `not_in_hand` | this thing is in no one's hand | `in_hand` |
//! | `moves` | the `thing` argument's kind moves `by` carry (that many free hands) or push (one Soul) | `motion_unsaid`, `moves_by`, `needs_souls`, `no_free_hand` |
//! | `linked` / `unlinked` | this thing has some / no link of that type (with `end: "actor"`: the actor is / is not an end) | `not_linked`, `already_linked` |
//! | `most_per` | the actor is an end on fewer than the link's `most_per` things of this kind under one parent | `already_linked` |
//! | `room` | every amount the form's `transfer` effects move has room where it lands | `no_room` |
//! | `enough` | every amount the form's `transfer` effects ask is there to give | `not_enough` |
//! | `sum` | int `fields` of this kind add up within `at_least`..`at_most` (with `after_moves`, as the transfers leave them) | `field_differs` |
//! | `any` | at least one of `fields` is `not` the value | `field_differs` |
//!
//! A refused need that names its words (`says`, a key of the entry's text table) returns them with its refusal, but
//! never with `bad_input`. A `field` or `value` argument must be one of its `takes` choices (`not_a_choice`).
//! Malformed data is `no` with reason `bad_input` and `detail.what`: the function never panics on any input.
//!
//! **A verdict** is `yes`; `no` with `reason`, the need's index, `detail` and one `fix` taken only from data (or
//! `null`); or `unknown`, with the need's index and the `node` and `field`, `link` or `slot` the asker cannot read.
//! A definite `no` from any need wins over `unknown`. Every verdict carries `read`, the `[address, value]` pairs it
//! read: `<node>/field/<n>`, `<node>/link/<n>`, `<node>/slot/<name>`, `<body>/hand/<name>`, `<body>/effector_mm`,
//! `move/<name>/reach_mm`.
//!
//! **Unknown** has exactly two causes, and only these: the field or link is outside the asker's audience
//! (`asker.sees`), or the node is one the asker's copy holds at an index level only (`"held": "index"` on the node,
//! E1): then the unknown carries `"held": "index"` too. Unknown never blocks a send (R8). A `within_reach` of another
//! thing's point (`of: {arg}`) reads that thing's pose as `field: "at_mm"`: unknown when the input gives none, as for
//! anyone, server included.
//!
//! Whole numbers only (`i128`), no float is ever worked with, and the only list an asker states (a body's hands) is
//! capped at [`MAX_HANDS`]; every other loop runs over lists the kind declares.

pub mod json;
mod select;

use json::Value;

/// The closed list of needs.
pub const NEEDS: [&str; 14] = [
    "state",
    "slot_free",
    "within_reach",
    "hand",
    "held_by_actor",
    "not_in_hand",
    "linked",
    "unlinked",
    "most_per",
    "room",
    "enough",
    "sum",
    "any",
    "moves",
];

/// The closed list of reasons a verdict of `no` names (`link_full` comes from working out effects, not a need).
pub const REASONS: [&str; 18] = [
    "field_differs",
    "slot_taken",
    "out_of_reach",
    "no_free_hand",
    "hand_not_empty",
    "not_holding_kind",
    "not_held",
    "in_hand",
    "not_linked",
    "already_linked",
    "no_room",
    "not_enough",
    "link_full",
    "moves_by",
    "motion_unsaid",
    "needs_souls",
    "none_selected",
    "bad_input",
];

/// The most hands a body may state.
pub const MAX_HANDS: usize = 8;

const SAFE: i128 = (1 << 53) - 1;
const I64_MIN: i128 = i64::MIN as i128;
const I64_MAX: i128 = i64::MAX as i128;
const MICROS: i128 = 1_000_000;

type Obj = Vec<(String, Value)>;

fn has<'a>(o: Option<&'a Value>, k: &str) -> Option<&'a Value> {
    o.and_then(|o| o.get(k))
}

/// Whether `node` is of kind `k` (W14, #4090): its own `kind`, or the entry it borrows (`entry`, from its world's map:
/// a Mars watering can borrows `eden:watering_can`). One rule for every need and selector that names a kind, in the
/// world and in the client's copy alike.
pub fn is_kind(node: Option<&Value>, k: &str) -> bool {
    ["entry", "kind"]
        .iter()
        .any(|f| has(node, f).and_then(Value::str) == Some(k))
}

/// The entry `node` is read by: the one it borrows (`entry`) when `kinds` has it, else its own kind's (W14, #4090).
fn entry_in<'a>(kinds: &'a Value, node: Option<&Value>) -> Option<&'a Value> {
    ["entry", "kind"]
        .iter()
        .filter_map(|f| has(node, f).filter(|k| k.truthy()))
        .find_map(|k| kinds.get(&js_text(Some(k))))
}

fn sorted(o: Option<&Value>) -> Vec<&str> {
    let mut keys: Vec<&str> = o
        .and_then(Value::obj)
        .map(|e| e.iter().map(|(k, _)| k.as_str()).collect())
        .unwrap_or_default();
    keys.sort_unstable();
    keys.dedup();
    keys
}

/// A whole number that JavaScript holds exactly (a safe integer).
fn whole(v: Option<&Value>) -> Option<i128> {
    match v {
        Some(Value::Int(n)) if (-SAFE..=SAFE).contains(n) => Some(*n),
        _ => None,
    }
}

/// Any whole number.
fn int(v: Option<&Value>) -> Option<i128> {
    match v {
        Some(Value::Int(n)) => Some(*n),
        _ => None,
    }
}

/// JavaScript's `===` on JSON values: objects and arrays are never equal to one another.
fn strict_eq(a: &Value, b: &Value) -> bool {
    !matches!(a, Value::Arr(_) | Value::Obj(_)) && a == b
}

/// `===` where either side may be missing (`undefined`).
fn js_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => strict_eq(a, b),
        _ => false,
    }
}

/// A flag is stored as 0 or 1; an entry may still write `true` or `false`.
fn flag(def: Option<&Value>, v: Option<&Value>) -> Option<Value> {
    let is_bool = has(def, "type").and_then(Value::str) == Some("bool");
    match v {
        Some(Value::Bool(b)) if is_bool => Some(Value::Int(i128::from(*b))),
        other => other.cloned(),
    }
}

/// How JavaScript writes a value into a template string, for addresses.
fn js_text(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_owned(),
        Some(Value::Str(s)) => s.clone(),
        Some(Value::Arr(_) | Value::Obj(_)) => "[object]".to_owned(),
        Some(v) => v.to_json(),
    }
}

fn resolve(r: Option<&Value>, args: Option<&Value>) -> Option<String> {
    match r {
        Some(Value::Str(s)) => Some(s.clone()),
        Some(o @ Value::Obj(_)) => {
            let name = o.get("arg")?;
            has(args, &js_text(Some(name)))
                .and_then(Value::str)
                .map(str::to_owned)
        }
        _ => None,
    }
}

/// Whether an asker whose `sees` is `sees` belongs to `audience`.
pub fn sees_audience(sees: Option<&Value>, audience: Option<&Value>) -> bool {
    if sees.and_then(Value::str) == Some("all") {
        return true;
    }
    let list: &[Value] = sees.and_then(Value::arr).unwrap_or(&[]);
    let holds = |s: &str| list.iter().any(|v| v.str() == Some(s));
    match audience {
        Some(Value::Str(s)) => holds(s),
        Some(a @ Value::Obj(_)) => match a.get("rule").and_then(Value::str) {
            Some("everyone") => true,
            Some("linked") => holds(&format!("linked:{}", js_text(a.get("link")))),
            Some(rule) => holds(rule),
            None => holds("undefined"),
        },
        _ => false,
    }
}

/// Who may see a state field: the container's audience when the kind is closed and names the field, else its own.
fn audience_of<'a>(
    entry: Option<&'a Value>,
    field: &str,
    def: Option<&'a Value>,
) -> Option<&'a Value> {
    let closed = has(entry, "closed");
    let named = has(closed, "fields")
        .and_then(Value::arr)
        .is_some_and(|f| f.iter().any(|v| v.str() == Some(field)));
    if named {
        has(closed, "audience")
    } else {
        has(def, "audience")
    }
}

/// Whether the asker's copy holds this node at an index level only (E1).
fn index_only(node: Option<&Value>) -> bool {
    has(node, "held").and_then(Value::str) == Some("index")
}

enum Outcome {
    Ok,
    No(Value),
    Unknown(Value),
}

/// The value of a timed field (`{value, per_s, set_us}`) at `now_us`: the whole units accrued since it was set
/// (rate x elapsed / 1,000,000, truncated toward zero) added to its value, held within `min` and `max`. Shared with
/// SA-F5a; an error names what is wrong.
pub fn value_at(
    def: Option<&Value>,
    stored: Option<&Value>,
    now_us: Option<&Value>,
) -> Result<i128, &'static str> {
    let Some(s @ Value::Obj(_)) = stored else {
        return Err("not_timed");
    };
    let in_i64 = |v: Option<&Value>| -> Result<Option<i128>, &'static str> {
        match int(v) {
            None => Ok(None),
            Some(n) if (I64_MIN..=I64_MAX).contains(&n) => Ok(Some(n)),
            Some(_) => Err("beyond_i64"),
        }
    };
    let three = [s.get("value"), s.get("per_s"), s.get("set_us")].map(in_i64);
    let now = in_i64(now_us);
    let bound = |k| has(def, k).map(|b| in_i64(Some(b)));
    let (lo, hi) = (bound("min"), bound("max"));
    // The order of the checks is SA-F5a's: a missing number, then no time, then a bound that is not whole, then range.
    if three.iter().any(|t| matches!(t, Ok(None))) {
        return Err("not_whole_number");
    }
    if matches!(now, Ok(None)) {
        return Err("no_time");
    }
    if [lo, hi].iter().any(|b| matches!(b, Some(Ok(None)))) {
        return Err("not_whole_number");
    }
    let all = three.iter().chain([&now]).chain(lo.iter()).chain(hi.iter());
    if all.clone().any(Result::is_err) {
        return Err("beyond_i64");
    }
    let get = |t: &Result<Option<i128>, &str>| t.ok().flatten().unwrap_or(0);
    let (v0, rate, set, at) = (get(&three[0]), get(&three[1]), get(&three[2]), get(&now));
    let lo = lo.and_then(|b| b.ok().flatten());
    let hi = hi.and_then(|b| b.ok().flatten());
    if at < set {
        return Err("time_before_set");
    }
    if let (Some(l), Some(h)) = (lo, hi)
        && l > h
    {
        return Err("bounds_crossed");
    }
    let clamp = |v: i128| match (lo, hi) {
        (Some(l), _) if v < l => l,
        (_, Some(h)) if v > h => h,
        _ => v,
    };
    let v0 = clamp(v0);
    let value = match rate.checked_mul(at - set) {
        Some(p) => clamp(v0 + p / MICROS),
        // Beyond i128 only when both are near the ends of i64: far beyond i64 once divided, so a bound holds it.
        None if rate > 0 => hi.ok_or("beyond_i64")?,
        None => lo.ok_or("beyond_i64")?,
    };
    if (I64_MIN..=I64_MAX).contains(&value) {
        Ok(value)
    } else {
        Err("beyond_i64")
    }
}

/// What a `transfer` effect moves (SA-F2b): the field it leaves and the one it lands in, both ends, what each has,
/// the target's room, the amount moved and the amount asked.
struct Measure<'a> {
    field: String,
    into_field: String,
    from: String,
    into: String,
    from_def: &'a Value,
    into_def: &'a Value,
    there: i128,
    held: i128,
    room: Option<i128>,
    moved: i128,
    asked: i128,
}

fn measure<'a>(
    kinds: &'a Value,
    nodes: Option<&'a Value>,
    this: &str,
    args: Option<&Value>,
    e: &Value,
) -> Result<Measure<'a>, (&'static str, Obj)> {
    let end = |r: Option<&Value>| {
        if r.and_then(Value::str) == Some("this") {
            Some(this.to_owned())
        } else {
            resolve(r, args)
        }
    };
    let (from, into) = (end(e.get("from")), end(e.get("into")));
    let field = e.get("field").and_then(Value::str).unwrap_or("").to_owned();
    let into_field = e
        .get("into_field")
        .and_then(Value::str)
        .map_or_else(|| field.clone(), str::to_owned);
    // One node gives and takes only between two of its fields; two nodes move one field.
    let (Some(from), Some(into)) = (
        from.clone().filter(|s| !s.is_empty()),
        into.clone().filter(|s| !s.is_empty()),
    ) else {
        let show = |x: Option<String>| x.map_or(Value::Null, Value::Str);
        return Err((
            "malformed_transfer",
            vec![("from".into(), show(from)), ("into".into(), show(into))],
        ));
    };
    if (from == into) == (into_field == field) {
        return Err((
            "malformed_transfer",
            vec![
                ("from".into(), Value::Str(from)),
                ("into".into(), Value::Str(into)),
            ],
        ));
    }
    let mut defs = Vec::new();
    let mut values = Vec::new();
    for (id, name) in [(&from, &field), (&into, &into_field)] {
        let node = has(nodes, id);
        let entry = entry_in(kinds, node);
        let def = has(has(entry, "state"), name);
        let detail = vec![
            ("node".into(), Value::Str(id.clone())),
            ("field".into(), Value::Str(name.clone())),
        ];
        let Some(def) = def.filter(|d| d.get("type").and_then(Value::str) == Some("int")) else {
            return Err(("no_such_field", detail));
        };
        if node.is_none() {
            return Err(("no_such_field", detail));
        }
        let value = has(has(node, "fields"), name).or(def.get("default"));
        match whole(value) {
            Some(v) if v >= 0 => values.push(v),
            _ => return Err(("not_whole_number", detail)),
        }
        defs.push(def);
    }
    let (from_def, into_def) = (defs[0], defs[1]);
    let (there, held) = (values[0], values[1]);
    if from_def.get("unit") != into_def.get("unit") {
        return Err(("units_differ", vec![("field".into(), Value::Str(field))]));
    }
    let mut room = None;
    if let Some(max) = into_def.get("max") {
        match whole(Some(max)) {
            Some(m) if m >= held => room = Some(m - held),
            _ => {
                return Err((
                    "over_capacity",
                    vec![
                        ("node".into(), Value::Str(into)),
                        ("field".into(), Value::Str(into_field)),
                    ],
                ));
            }
        }
    }
    let floor = match from_def.get("min") {
        None => Some(0),
        Some(m) => whole(Some(m)).filter(|f| *f >= 0),
    };
    let Some(floor) = floor else {
        return Err((
            "not_whole_number",
            vec![
                ("node".into(), Value::Str(from)),
                ("field".into(), Value::Str(field)),
            ],
        ));
    };
    let amount = e.get("amount");
    let want = if amount.and_then(Value::str) == Some("room") {
        match room {
            Some(r) => Some(r),
            None => {
                return Err((
                    "no_capacity",
                    vec![
                        ("node".into(), Value::Str(into)),
                        ("field".into(), Value::Str(into_field)),
                    ],
                ));
            }
        }
    } else if let Some(a @ Value::Obj(_)) = amount
        && a.get("arg").is_some()
    {
        whole(has(args, &js_text(a.get("arg"))))
    } else {
        whole(amount)
    };
    let Some(want) = want.filter(|w| *w >= 0) else {
        return Err((
            "not_whole_number",
            vec![("amount".into(), amount.cloned().unwrap_or(Value::Null))],
        ));
    };
    Ok(Measure {
        moved: want.min((there - floor).max(0)),
        asked: want,
        field,
        into_field,
        from,
        into,
        from_def,
        into_def,
        there,
        held,
        room,
    })
}

/// A reference to a form argument (`{"arg": <name>}`): its name.
fn arg_ref(v: Option<&Value>) -> Option<&str> {
    match v {
        Some(o @ Value::Obj(_)) => o.get("arg").and_then(Value::str),
        _ => None,
    }
}

/// A value as written, or the value an argument holds.
fn value_of<'v>(v: Option<&'v Value>, args: Option<&'v Value>) -> Option<&'v Value> {
    match arg_ref(v) {
        Some(name) => has(args, name),
        None => v,
    }
}

/// An object key as JavaScript makes one from `x ?? ''`.
fn key_of(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        v => js_text(v),
    }
}

/// Two step references name the same point: equal texts, or the same argument.
fn same_ref(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(Value::Str(x)), b) => b.and_then(Value::str) == Some(x.as_str()),
        (Some(x @ Value::Obj(_)), Some(y @ Value::Obj(_))) => {
            x.get("arg").is_some() && js_eq(x.get("arg"), y.get("arg"))
        }
        _ => false,
    }
}

/// The entries of an object or the items of an array by index, sorted by key: how `Object.keys(..).sort()` reads.
fn keyed(v: Option<&Value>) -> Vec<(String, &Value)> {
    let mut out: Vec<(String, &Value)> = match v {
        Some(Value::Obj(e)) => e.iter().map(|(k, v)| (k.clone(), v)).collect(),
        Some(Value::Arr(a)) => a
            .iter()
            .enumerate()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
        _ => Vec::new(),
    };
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Whether a list holds a value (`Array.prototype.includes` on JSON values).
fn includes(list: Option<&Value>, x: &Value) -> bool {
    list.and_then(Value::arr).is_some_and(|l| in_slice(l, x))
}

fn in_slice(list: &[Value], x: &Value) -> bool {
    list.iter().any(|v| strict_eq(v, x))
}

/// How a thing moves (entry section 18, `motion.how`), one list with SA-F2: carried in one or two hands, pushed by one
/// Soul or by two, or fixed. A body acts alone, so two Souls' push is refused.
const CARRIED: [(&str, i128); 2] = [("one_hand", 1), ("two_hands", 2)];
const PUSHED: [(&str, i128); 3] = [("pushed_by_one", 1), ("wheeled", 1), ("two_souls", 2)];

/// The most children of one parent a `most_per` need reads.
pub const MAX_SIBLINGS: usize = 1000;

fn table(t: &[(&str, i128)], how: &str) -> Option<i128> {
    t.iter().find(|(k, _)| *k == how).map(|(_, n)| *n)
}

/// The node a node stands loose in, through any slot or hand it is in; `None` if nowhere. Bounded by the nodes.
fn place_of(nodes: Option<&Value>, id: &str) -> Option<String> {
    let ids = keyed(nodes);
    let parent = |x: &str| -> Option<(String, bool)> {
        let x = Value::s(x);
        for (holder, n) in &ids {
            if includes(n.get("loose"), &x) {
                return Some((holder.clone(), true));
            }
            if keyed(n.get("slots"))
                .iter()
                .any(|(_, l)| includes(Some(l), &x))
            {
                return Some((holder.clone(), false));
            }
            if keyed(n.get("hands")).iter().any(|(_, h)| strict_eq(h, &x)) {
                return Some((holder.clone(), false));
            }
        }
        None
    };
    let mut at = parent(id);
    let mut hops = 0;
    while let Some((node, loose)) = at {
        if hops >= ids.len() {
            break;
        }
        if loose {
            return Some(node);
        }
        at = parent(&node);
        hops += 1;
    }
    None
}

/// Decides `input` (`{kinds, act, state, asker}`, the case shape with the kinds by name). Never panics.
pub fn decide(input: &Value) -> Value {
    let part = |k| input.get(k);
    decide_parts(part("kinds"), part("act"), part("state"), part("asker"))
}

/// [`decide`] with the input's four parts given apart, so many cases can share one set of kinds.
pub fn decide_parts(
    kinds: Option<&Value>,
    act: Option<&Value>,
    state: Option<&Value>,
    asker: Option<&Value>,
) -> Value {
    fn truthy(v: Option<&Value>) -> Option<&Value> {
        v.filter(|v| v.truthy())
    }
    let (Some(kinds), Some(act), Some(state), Some(asker)) =
        (truthy(kinds), truthy(act), truthy(state), truthy(asker))
    else {
        return Rules::bad_verdict(-1, "malformed", vec![], vec![]);
    };
    // A thing argument left out is chosen by its selector, as worldd and today's form rules choose it (#3914).
    let owned;
    let mut none = None;
    let act = match select::chosen(kinds, act, state, asker.get("sees")) {
        select::Choice::Same => act,
        select::Choice::Args(a) => {
            owned = a;
            &owned
        }
        select::Choice::None(arg) => {
            none = Some(arg);
            act
        }
        select::Choice::Unknown(node) => {
            return Value::object([
                ("verdict", Value::s("unknown")),
                ("need", Value::Int(-1)),
                ("node", Value::s(&node)),
                ("read", Value::Arr(Vec::new())),
            ]);
        }
    };
    let mut r = Rules {
        kinds,
        act,
        state,
        asker,
        read: Vec::new(),
    };
    let v = r.run();
    // Told only once every need holds, so a far act is never a way to learn what a hiding place holds.
    match none {
        Some(arg) if v.get("verdict").and_then(Value::str) == Some("yes") => Value::object([
            ("verdict", Value::s("no")),
            ("reason", Value::s("none_selected")),
            ("need", Value::Int(-1)),
            (
                "detail",
                Value::object([
                    ("node", act.get("this").cloned().unwrap_or(Value::Null)),
                    ("arg", Value::s(&arg)),
                ]),
            ),
            ("fix", Value::Null),
            (
                "read",
                v.get("read").cloned().unwrap_or(Value::Arr(Vec::new())),
            ),
        ]),
        _ => v,
    }
}

struct Rules<'a> {
    kinds: &'a Value,
    act: &'a Value,
    state: &'a Value,
    asker: &'a Value,
    read: Vec<Value>,
}

impl<'a> Rules<'a> {
    fn bad_verdict(need: i128, what: &str, extra: Obj, read: Vec<Value>) -> Value {
        let mut detail = vec![("what".to_owned(), Value::s(what))];
        detail.extend(extra);
        Value::object([
            ("verdict", Value::s("no")),
            ("reason", Value::s("bad_input")),
            ("need", Value::Int(need)),
            ("detail", Value::Obj(detail)),
            ("fix", Value::Null),
            ("read", Value::Arr(read)),
        ])
    }

    fn bad(&self, need: i128, what: &str, extra: Obj) -> Value {
        Self::bad_verdict(need, what, extra, self.read.clone())
    }

    fn no(&self, reason: &str, need: i128, detail: Obj, fix: Value) -> Value {
        Value::object([
            ("verdict", Value::s("no")),
            ("reason", Value::s(reason)),
            ("need", Value::Int(need)),
            ("detail", Value::Obj(detail)),
            ("fix", fix),
            ("read", Value::Arr(self.read.clone())),
        ])
    }

    /// An unknown naming the node and what of it (`field`, `link` or `slot`) the asker cannot read.
    fn unknown(&self, need: i128, node: &str, what: &str, name: &str, index: bool) -> Value {
        let mut v = vec![
            ("verdict".to_owned(), Value::s("unknown")),
            ("need".to_owned(), Value::Int(need)),
            ("node".to_owned(), Value::s(node)),
            (what.to_owned(), Value::s(name)),
        ];
        if index {
            v.push(("held".to_owned(), Value::s("index")));
        }
        v.push(("read".to_owned(), Value::Arr(self.read.clone())));
        Value::Obj(v)
    }

    fn push(&mut self, address: String, value: Value) {
        self.read.push(Value::Arr(vec![Value::Str(address), value]));
    }

    fn sees(&self, audience: Option<&Value>) -> bool {
        sees_audience(self.asker.get("sees"), audience)
    }

    fn nodes(&self) -> Option<&'a Value> {
        self.state
            .get("nodes")
            .filter(|v| !matches!(v, Value::Null))
    }

    fn args(&self) -> Option<&'a Value> {
        self.act.get("args").filter(|v| !matches!(v, Value::Null))
    }

    fn node(&self, id: Option<&Value>) -> Option<&'a Value> {
        has(self.nodes(), &js_text(id))
    }

    fn entry_of(&self, node: Option<&Value>) -> Option<&'a Value> {
        entry_in(self.kinds, node)
    }

    fn this_id(&self) -> String {
        js_text(self.act.get("this"))
    }

    fn run(&mut self) -> Value {
        let this_id = self.act.get("this");
        let Some(this) = self.node(this_id) else {
            return self.bad(
                -1,
                "no_such_node",
                vec![("node".into(), this_id.cloned().unwrap_or(Value::Null))],
            );
        };
        let Some(entry) = self.entry_of(Some(this)) else {
            let kind = this.get("kind").cloned().unwrap_or(Value::Null);
            return self.bad(-1, "no_such_kind", vec![("kind".into(), kind)]);
        };
        let form_name = self.act.get("form");
        let Some(form) = has(entry.get("forms"), &js_text(form_name)) else {
            return self.bad(
                -1,
                "no_such_form",
                vec![("form".into(), form_name.cloned().unwrap_or(Value::Null))],
            );
        };
        let actor_id = self.state.get("actor");
        if self.node(actor_id).is_none() {
            return self.bad(
                -1,
                "no_such_node",
                vec![("node".into(), actor_id.cloned().unwrap_or(Value::Null))],
            );
        }
        // A field or value argument is one of the form's own choices, so a form never writes a field it does not name.
        let args = self.args();
        for name in sorted(form.get("takes")) {
            let Some(t) = has(form.get("takes"), name) else {
                continue;
            };
            let ty = t.get("type").and_then(Value::str);
            let Some(given) = has(args, name) else {
                continue;
            };
            if !matches!(ty, Some("field" | "value")) {
                continue;
            }
            if !includes(t.get("of"), given) {
                return self.bad(
                    -1,
                    "not_a_choice",
                    vec![
                        ("arg".into(), Value::s(name)),
                        ("value".into(), given.clone()),
                    ],
                );
            }
        }
        let needs: &[Value] = form.get("needs").and_then(Value::arr).unwrap_or(&[]);
        let mut first_unknown = None;
        for (i, n) in needs.iter().enumerate() {
            let i = i128::try_from(i).unwrap_or(i128::MAX);
            let name = n
                .get("need")
                .and_then(Value::str)
                .filter(|s| !s.is_empty() && NEEDS.contains(s));
            let out = match name {
                None => {
                    let need = match n {
                        Value::Obj(_) => n.get("need").cloned().unwrap_or(Value::Null),
                        _ => Value::Null,
                    };
                    return self.bad(i, "unknown_need", vec![("need".into(), need)]);
                }
                Some("state") => self.state_need(n, i, this, entry, form),
                Some("slot_free") => self.slot_free(n, i),
                Some("within_reach") => self.within_reach(n, i, entry, form),
                Some("hand") => self.hand(n, i),
                Some("held_by_actor") => self.held_by_actor(n, i),
                Some("not_in_hand") => self.not_in_hand(i),
                Some("moves") => self.moves(n, i),
                Some("linked") => self.link(n, i, this, entry, true),
                Some("unlinked") => self.link(n, i, this, entry, false),
                Some("most_per") => self.most_per(n, i, this, entry),
                Some("room") => self.transfers(i, form, false),
                Some("enough") => self.transfers(i, form, true),
                Some("sum") => self.sum(n, i, this, entry, form),
                Some(_) => self.any(n, i, this, entry),
            };
            match out {
                Outcome::Ok => {}
                // A need that names its words returns them with its refusal, by key (SA-F6b); bad input is the
                // data's fault, not the need's.
                Outcome::No(mut v) => {
                    if let Some(says) = n.get("says").and_then(Value::str)
                        && v.get("reason").and_then(Value::str) != Some("bad_input")
                        && let Value::Obj(e) = &mut v
                    {
                        e.push(("says".into(), Value::s(says)));
                    }
                    return v;
                }
                Outcome::Unknown(v) => {
                    first_unknown.get_or_insert(v);
                }
            }
        }
        let read = Value::Arr(std::mem::take(&mut self.read));
        match first_unknown {
            // An unknown's read set is everything read: the needs after it were met too, or it would be a no.
            Some(mut v) => {
                if let Value::Obj(e) = &mut v
                    && let Some(r) = e.iter_mut().find(|(k, _)| k == "read")
                {
                    r.1 = read;
                }
                v
            }
            None => Value::object([("verdict", Value::s("yes")), ("read", read)]),
        }
    }

    /// A fix taken only from data: a form of this kind that anyone may start as an act, that `ready` lets through,
    /// with an effect that `meets`.
    fn form_fix(
        &self,
        entry: &Value,
        meets: impl Fn(&Value) -> bool,
        ready: impl Fn(&Value) -> bool,
    ) -> Value {
        let forms = entry.get("forms");
        let current = js_text(self.act.get("form"));
        for name in sorted(forms) {
            let Some(f) = has(forms, name) else { continue };
            if name == current
                || !matches!(f.get("who").and_then(Value::str), Some("anyone" | "holder"))
                || f.get("starts").and_then(Value::str) != Some("act")
                || !ready(f)
            {
                continue;
            }
            if f.get("effects")
                .and_then(Value::arr)
                .unwrap_or(&[])
                .iter()
                .any(&meets)
            {
                return Value::object([("form", Value::s(name))]);
            }
        }
        Value::Null
    }

    fn state_need(
        &mut self,
        n: &Value,
        i: i128,
        this: &Value,
        entry: &'a Value,
        form: &'a Value,
    ) -> Outcome {
        if n.get("link").is_some() {
            return self.place_state(n, i, this, entry);
        }
        if n.get("of").is_some() {
            return self.arg_state(n, i);
        }
        let args = self.args();
        // A field argument names one of the form's fields; a value argument the value compared with (a choice each).
        for k in ["field", "is", "not"] {
            if let Some(arg) = arg_ref(n.get(k))
                && has(args, arg).is_none()
            {
                return Outcome::No(self.bad(
                    i,
                    "argument_missing",
                    vec![("arg".into(), Value::s(arg))],
                ));
            }
        }
        let field = resolve(n.get("field"), args).unwrap_or_default();
        let field = field.as_str();
        let target_is = value_of(n.get("is"), args);
        let target_not = value_of(n.get("not"), args);
        let Some(def) = has(entry.get("state"), field) else {
            return Outcome::No(self.bad(
                i,
                "no_such_field",
                vec![("field".into(), Value::s(field))],
            ));
        };
        let this_id = self.this_id();
        if !self.sees(audience_of(Some(entry), field, Some(def))) {
            return Outcome::Unknown(self.unknown(i, &this_id, "field", field, false));
        }
        if index_only(Some(this)) {
            return Outcome::Unknown(self.unknown(i, &this_id, "field", field, true));
        }
        let mut value = has(this.get("fields"), field)
            .or(def.get("default"))
            .cloned();
        if def.get("type").and_then(Value::str) == Some("timed") {
            match value_at(Some(def), value.as_ref(), self.state.get("now_us")) {
                Ok(v) => value = Some(Value::Int(v)),
                Err(what) => {
                    return Outcome::No(self.bad(i, what, vec![("field".into(), Value::s(field))]));
                }
            }
        }
        let address = format!("{this_id}/field/{}", js_text(def.get("n")));
        self.push(address, value.clone().unwrap_or(Value::Null));
        let ranged = n.get("at_least").is_some() || n.get("at_most").is_some();
        if ranged && int(value.as_ref()).is_none() {
            return Outcome::No(self.bad(
                i,
                "not_whole_number",
                vec![("field".into(), Value::s(field))],
            ));
        }
        let eq = |a: Option<&Value>, b: Option<&Value>| {
            js_eq(flag(Some(def), a).as_ref(), flag(Some(def), b).as_ref())
        };
        let bound = |m: &Value, k, v: Option<&Value>, ge: bool| match (int(v), int(m.get(k))) {
            (Some(x), Some(b)) => {
                if ge {
                    x >= b
                } else {
                    x <= b
                }
            }
            _ => false,
        };
        // Another form's need on this field holds now (its own value, never an argument's choice).
        let holds = |m: &Value, v: Option<&Value>| {
            (m.get("is").is_none() || arg_ref(m.get("is")).is_some() || eq(v, m.get("is")))
                && (m.get("not").is_none()
                    || arg_ref(m.get("not")).is_some()
                    || !eq(v, m.get("not")))
                && (m.get("at_least").is_none() || bound(m, "at_least", v, true))
                && (m.get("at_most").is_none() || bound(m, "at_most", v, false))
        };
        // This need, compared with `is` and `not` as given (its arguments' values, or another choice).
        let meets_with = |v: Option<&Value>, is: Option<&Value>, not: Option<&Value>| {
            (n.get("is").is_none() || eq(v, is))
                && (n.get("not").is_none() || !eq(v, not))
                && (n.get("at_least").is_none() || bound(n, "at_least", v, true))
                && (n.get("at_most").is_none() || bound(n, "at_most", v, false))
        };
        let meets = |v: Option<&Value>| meets_with(v, target_is, target_not);
        if meets(value.as_ref()) {
            return Outcome::Ok;
        }
        let wanted: Obj = ["is", "not", "at_least", "at_most"]
            .into_iter()
            .filter(|k| n.get(k).is_some())
            .map(|k| {
                let v = match k {
                    "is" => target_is,
                    "not" => target_not,
                    _ => n.get(k),
                };
                (k.to_owned(), v.cloned().unwrap_or(Value::Null))
            })
            .collect();
        let detail = || {
            vec![
                ("field".into(), Value::s(field)),
                ("found".into(), value.clone().unwrap_or(Value::Null)),
                ("wanted".into(), Value::Obj(wanted.clone())),
            ]
        };
        // The closest fix is this same act with another choice of the value it compares with (brush the other way);
        // a field argument's other choices are other acts, not fixes (another shoot is not this one).
        let takes = form.get("takes");
        for k in ["is", "not"] {
            let Some(arg) = arg_ref(n.get(k)) else {
                continue;
            };
            let t = has(takes, arg);
            let choices: &[Value] = if has(t, "type").and_then(Value::str) == Some("value") {
                has(t, "of").and_then(Value::arr).unwrap_or(&[])
            } else {
                &[]
            };
            let current = has(args, arg);
            for c in choices {
                let (is, not) = if k == "is" {
                    (Some(c), target_not)
                } else {
                    (target_is, Some(c))
                };
                if current.is_some_and(|v| strict_eq(c, v)) || !meets_with(value.as_ref(), is, not)
                {
                    continue;
                }
                let mut new_args = args
                    .and_then(Value::obj)
                    .map(<[_]>::to_vec)
                    .unwrap_or_default();
                match new_args.iter_mut().find(|(name, _)| name == arg) {
                    Some(e) => e.1 = c.clone(),
                    None => new_args.push((arg.to_owned(), c.clone())),
                }
                let fix = Value::object([
                    ("form", self.act.get("form").cloned().unwrap_or(Value::Null)),
                    ("args", Value::Obj(new_args)),
                ]);
                return Outcome::No(self.no("field_differs", i, detail(), fix));
            }
        }
        // A transfer in fills toward the field's max and one out empties toward its min (SA #3021): it meets the need
        // if that end does. A set with `by` meets it if the value it adds up to does, within the field's bounds.
        let min = match def.get("min") {
            None | Some(Value::Null) => Some(0),
            m => int(m),
        };
        let max = whole(def.get("max"));
        let after = |by: Option<&Value>| match (whole(by), whole(value.as_ref())) {
            (Some(b), Some(v)) => Some(v + b),
            _ => None,
        };
        let fix = self.form_fix(
            entry,
            |e| {
                let change = e.get("change").and_then(Value::str);
                let this_field = e.get("field").and_then(Value::str) == Some(field);
                let is_this = |k| e.get(k).and_then(Value::str) == Some("this");
                let set = change == Some("set") && this_field;
                let by = e.get("by");
                let into_field = match e.get("into_field") {
                    None | Some(Value::Null) => e.get("field"),
                    f => f,
                };
                (set && by.is_none()
                    && !matches!(e.get("to"), Some(Value::Arr(_) | Value::Obj(_)))
                    && meets(e.get("to")))
                    || (set
                        && after(by).is_some_and(|a| {
                            min.is_some_and(|m| a >= m)
                                && max.is_none_or(|m| a <= m)
                                && meets(Some(&Value::Int(a)))
                        }))
                    || (change == Some("transfer")
                        && ((is_this("into")
                            && into_field.and_then(Value::str) == Some(field)
                            && max.is_some_and(|m| meets(Some(&Value::Int(m)))))
                            || (is_this("from")
                                && this_field
                                && meets(Some(&min.map_or(Value::Null, Value::Int))))))
            },
            // The fix's own needs on this field of this thing (not an argument's or the place's) must hold now, or
            // it would be refused in turn.
            |f| {
                f.get("needs")
                    .and_then(Value::arr)
                    .unwrap_or(&[])
                    .iter()
                    .all(|m| {
                        m.get("need").and_then(Value::str) != Some("state")
                            || m.get("of").is_some()
                            || m.get("link").is_some()
                            || m.get("field").and_then(Value::str) != Some(field)
                            || holds(m, value.as_ref())
                    })
            },
        );
        Outcome::No(self.no("field_differs", i, detail(), fix))
    }

    /// A field of the place this thing stands in, read through its link to the place, never from the tree: a parent
    /// means lifetime and frame only (T2). A refusal names no fix: nothing this kind does changes the place.
    fn place_state(&mut self, n: &Value, i: i128, this: &Value, entry: &Value) -> Outcome {
        let ty = key_of(n.get("link"));
        let Some(def) = has(entry.get("links"), &ty) else {
            return Outcome::No(self.bad(i, "no_such_link", vec![("link".into(), Value::Str(ty))]));
        };
        let this_id = self.this_id();
        if !self.sees(def.get("audience")) {
            return Outcome::Unknown(self.unknown(i, &this_id, "link", &ty, false));
        }
        if index_only(Some(this)) {
            return Outcome::Unknown(self.unknown(i, &this_id, "link", &ty, true));
        }
        let ends = has(this.get("links"), &ty).and_then(Value::arr);
        let count = ends.map_or(0, |l| i128::try_from(l.len()).unwrap_or(i128::MAX));
        self.push(
            format!("{this_id}/link/{}", js_text(def.get("n"))),
            Value::Int(count),
        );
        let Some(first) = ends.and_then(|l| l.first()) else {
            let detail = vec![
                ("link".into(), Value::Str(ty)),
                ("count".into(), Value::Int(count)),
            ];
            return Outcome::No(self.no("not_linked", i, detail, Value::Null));
        };
        self.other_field(n, i, &js_text(Some(first)))
    }

    /// A field of the thing a `thing` argument names, read through that thing's own kind.
    fn arg_state(&mut self, n: &Value, i: i128) -> Outcome {
        let Some(arg) = arg_ref(n.get("of")) else {
            return Outcome::No(self.bad(i, "malformed_need", vec![]));
        };
        let Some(id) = has(self.args(), arg) else {
            return Outcome::No(self.bad(
                i,
                "argument_missing",
                vec![("arg".into(), Value::s(arg))],
            ));
        };
        match id.str() {
            Some(id) if has(self.nodes(), id).is_some() => self.other_field(n, i, id),
            _ => {
                let shown = id.str().map_or(Value::Null, Value::s);
                Outcome::No(self.bad(i, "no_such_node", vec![("node".into(), shown)]))
            }
        }
    }

    /// The field `n.field` of another node, read through that node's kind by its number and only by its audience,
    /// and compared as a state need compares; a refusal names no fix (this kind's forms do not change it).
    fn other_field(&mut self, n: &Value, i: i128, id: &str) -> Outcome {
        let other = has(self.nodes(), id);
        let kind = self.entry_of(other);
        let field = n.get("field").and_then(Value::str).unwrap_or("");
        let (Some(other), Some(def)) = (other, has(has(kind, "state"), field)) else {
            let detail = vec![
                ("node".into(), Value::s(id)),
                ("field".into(), Value::s(field)),
            ];
            return Outcome::No(self.bad(i, "no_such_field", detail));
        };
        if !self.sees(def.get("audience")) {
            return Outcome::Unknown(self.unknown(i, id, "field", field, false));
        }
        if index_only(Some(other)) {
            return Outcome::Unknown(self.unknown(i, id, "field", field, true));
        }
        let mut value = has(other.get("fields"), field)
            .or(def.get("default"))
            .cloned();
        let at = || {
            vec![
                ("node".into(), Value::s(id)),
                ("field".into(), Value::s(field)),
            ]
        };
        if def.get("type").and_then(Value::str) == Some("timed") {
            match value_at(Some(def), value.as_ref(), self.state.get("now_us")) {
                Ok(v) => value = Some(Value::Int(v)),
                Err(what) => return Outcome::No(self.bad(i, what, at())),
            }
        }
        self.push(
            format!("{id}/field/{}", js_text(def.get("n"))),
            value.clone().unwrap_or(Value::Null),
        );
        let wanted: Obj = ["is", "not", "at_least", "at_most"]
            .into_iter()
            .filter_map(|k| n.get(k).map(|v| (k.to_owned(), v.clone())))
            .collect();
        let ranged = n.get("at_least").is_some() || n.get("at_most").is_some();
        if ranged && int(value.as_ref()).is_none() {
            return Outcome::No(self.bad(i, "not_whole_number", at()));
        }
        let v = value.as_ref();
        let eq = |k| {
            js_eq(
                flag(Some(def), n.get(k)).as_ref(),
                flag(Some(def), v).as_ref(),
            )
        };
        let bound = |k, ge: bool| match (int(v), int(n.get(k))) {
            (Some(x), Some(b)) => {
                if ge {
                    x >= b
                } else {
                    x <= b
                }
            }
            _ => false,
        };
        if (n.get("is").is_none() || eq("is"))
            && (n.get("not").is_none() || !eq("not"))
            && (n.get("at_least").is_none() || bound("at_least", true))
            && (n.get("at_most").is_none() || bound("at_most", false))
        {
            return Outcome::Ok;
        }
        let mut detail = at();
        detail.push(("found".into(), value.unwrap_or(Value::Null)));
        detail.push(("wanted".into(), Value::Obj(wanted)));
        Outcome::No(self.no("field_differs", i, detail, Value::Null))
    }

    fn slot_free(&mut self, n: &Value, i: i128) -> Outcome {
        let args = self.args();
        let mut slot_ref = n.get("slot").cloned();
        let mut arg_name = None;
        if let Some(r @ Value::Obj(_)) = &slot_ref
            && let Some(a) = r.get("arg")
        {
            let name = js_text(Some(a));
            let Some(v) = has(args, &name) else {
                return Outcome::No(self.bad(
                    i,
                    "argument_missing",
                    vec![("arg".into(), a.clone())],
                ));
            };
            slot_ref = Some(v.clone());
            arg_name = Some(name);
        }
        let this_id = self.this_id();
        let (at_node, at_slot) = match &slot_ref {
            Some(Value::Str(s)) => (this_id.clone(), s.clone()),
            Some(o @ Value::Obj(_)) => match (
                o.get("node").and_then(Value::str),
                o.get("slot").and_then(Value::str),
            ) {
                (Some(nd), Some(sl)) => (nd.to_owned(), sl.to_owned()),
                _ => return Outcome::No(self.bad(i, "malformed_slot", vec![])),
            },
            _ => return Outcome::No(self.bad(i, "malformed_slot", vec![])),
        };
        let holder = has(self.nodes(), &at_node);
        let kind = self.entry_of(holder);
        let def = has(has(kind, "slots"), &at_slot);
        let (Some(holder), Some(kind), Some(def)) = (holder, kind, def) else {
            let detail = vec![
                ("node".into(), Value::Str(at_node)),
                ("slot".into(), Value::Str(at_slot)),
            ];
            return Outcome::No(self.bad(i, "no_such_slot", detail));
        };
        if index_only(Some(holder)) {
            return Outcome::Unknown(self.unknown(i, &at_node, "slot", &at_slot, true));
        }
        let count = |name: &str| {
            has(holder.get("slots"), name)
                .and_then(Value::arr)
                .map_or(0, |l| i128::try_from(l.len()).unwrap_or(i128::MAX))
        };
        let most = |d: &Value| whole(d.get("most"));
        let taken = count(&at_slot);
        self.push(format!("{at_node}/slot/{at_slot}"), Value::Int(taken));
        if most(def).is_some_and(|m| taken < m) {
            return Outcome::Ok;
        }
        let mut fix = Value::Null;
        if let Some(arg_name) = arg_name {
            for other in sorted(kind.get("slots")) {
                let Some(d) = has(kind.get("slots"), other) else {
                    continue;
                };
                let full = most(d).is_some_and(|m| count(other) >= m);
                if other == at_slot || !js_eq(d.get("admits"), def.get("admits")) || full {
                    continue;
                }
                self.push(format!("{at_node}/slot/{other}"), Value::Int(count(other)));
                let to = if matches!(slot_ref, Some(Value::Str(_))) {
                    Value::s(other)
                } else {
                    Value::object([("node", Value::s(&at_node)), ("slot", Value::s(other))])
                };
                let mut new_args = args
                    .and_then(Value::obj)
                    .map(<[_]>::to_vec)
                    .unwrap_or_default();
                match new_args.iter_mut().find(|(k, _)| *k == arg_name) {
                    Some(e) => e.1 = to,
                    None => new_args.push((arg_name.clone(), to)),
                }
                fix = Value::object([
                    ("form", self.act.get("form").cloned().unwrap_or(Value::Null)),
                    ("args", Value::Obj(new_args)),
                ]);
                break;
            }
        }
        let detail = vec![
            ("node".into(), Value::Str(at_node)),
            ("slot".into(), Value::Str(at_slot)),
        ];
        Outcome::No(self.no("slot_taken", i, detail, fix))
    }

    fn within_reach(&mut self, n: &Value, i: i128, entry: &Value, form: &Value) -> Outcome {
        let args = self.args();
        let Some(name) = resolve(n.get("point"), args) else {
            let arg = has(n.get("point"), "arg").cloned().unwrap_or(Value::Null);
            return Outcome::No(self.bad(i, "argument_missing", vec![("arg".into(), arg)]));
        };
        let steps: &[Value] = form.get("steps").and_then(Value::arr).unwrap_or(&[]);
        // Reach to another thing, in this order (decided 17 Nov): (1) walk-first: a form that walks to the thing
        // first reaches it by that walk, so the need is met when the thing is in the actor's place (the engine
        // walks); (2) else the measured pose: `of` names the thing by a form argument, its point is in its own frame,
        // placed by its `at_mm` in the input (SA #3012); (3) else unknown.
        let of = n.get("of");
        let thing_ref = of.or(n.get("point"));
        let thing_id = match of {
            Some(o @ Value::Obj(_)) => resolve(Some(o), args),
            Some(_) => None,
            None => Some(name.clone()),
        };
        let walks = steps.iter().any(|s| {
            s.get("step").and_then(Value::str) == Some("walk_to")
                && same_ref(s.get("point"), thing_ref)
        });
        let is_thing = thing_id.as_ref().is_some_and(|id| {
            has(self.nodes(), id).is_some()
                && (of.is_some()
                    || (has(entry.get("points"), &name).is_none()
                        && has(entry.get("slots"), &name).is_none()))
        });
        if let (true, Some(id)) = (is_thing, &thing_id) {
            if walks {
                let there = place_of(self.nodes(), id);
                let mine = place_of(self.nodes(), &js_text(self.state.get("actor")));
                self.push(
                    format!("{id}/place"),
                    there.clone().map_or(Value::Null, Value::Str),
                );
                if there.is_some() && there == mine {
                    return Outcome::Ok;
                }
                let fix = Value::object([("step", Value::s("walk_to")), ("thing", Value::s(id))]);
                let detail = vec![("thing".into(), Value::s(id))];
                return Outcome::No(self.no("out_of_reach", i, detail, fix));
            }
            if of.is_none() {
                return Outcome::Unknown(self.unknown(i, id, "field", "at_mm", false));
            }
        }
        // `of` names another thing by a form argument: its point is in its own frame, placed by its `at_mm` in the
        // input. Without `of`, the point is this thing's own.
        let mut owner = entry;
        let mut other: Option<(String, String, &Value)> = None;
        if let Some(of) = of {
            let Some(arg) = of.get("arg").and_then(Value::str) else {
                return Outcome::No(self.bad(i, "malformed_need", vec![]));
            };
            let Some(id) = has(args, arg).map(|v| v.str().map(str::to_owned)) else {
                return Outcome::No(self.bad(
                    i,
                    "argument_missing",
                    vec![("arg".into(), Value::s(arg))],
                ));
            };
            let node = id.as_deref().and_then(|id| has(self.nodes(), id));
            let (Some(id), Some(node), Some(kind)) = (id.clone(), node, self.entry_of(node)) else {
                let shown = id.map_or(Value::Null, Value::Str);
                return Outcome::No(self.bad(i, "no_such_node", vec![("node".into(), shown)]));
            };
            owner = kind;
            other = Some((id, arg.to_owned(), node));
        }
        let place = match has(owner.get("points"), &name) {
            Some(point) => point.get("at_mm"),
            None => has(has(owner.get("slots"), &name), "at_mm"),
        };
        let xyz3 = |p: Option<&Value>| -> Option<Vec<i128>> {
            p.and_then(Value::arr)
                .filter(|p| p.len() == 3)
                .and_then(|p| p.iter().map(|v| whole(Some(v))).collect())
        };
        let Some(place) = xyz3(place) else {
            return Outcome::No(self.bad(
                i,
                "no_such_point",
                vec![("point".into(), Value::Str(name))],
            ));
        };
        // The other thing's pose: missing from the input, or held at an index level only, it is unknown, not no.
        let mut origin = None;
        if let Some((id, _, node)) = &other {
            let Some(at) = xyz3(node.get("at_mm")) else {
                return Outcome::Unknown(self.unknown(i, id, "field", "at_mm", false));
            };
            if index_only(Some(node)) {
                return Outcome::Unknown(self.unknown(i, id, "field", "at_mm", true));
            }
            origin = Some(at);
        }
        let step = steps.iter().find(|s| {
            s.get("step").and_then(Value::str) == Some("move")
                && match &other {
                    None => resolve(s.get("at"), args).as_deref() == Some(&name),
                    Some((_, arg, _)) => {
                        has(s.get("toward"), "arg").and_then(Value::str) == Some(arg.as_str())
                    }
                }
        });
        let Some(mv) = step.and_then(|s| s.get("move")).and_then(Value::str) else {
            return Outcome::No(self.bad(
                i,
                "no_move_at_point",
                vec![("point".into(), Value::Str(name))],
            ));
        };
        let reach = whole(has(has(self.state.get("moves"), mv), "reach_mm")).filter(|r| *r >= 0);
        let Some(reach) = reach else {
            return Outcome::No(self.bad(i, "no_move_reach", vec![("move".into(), Value::s(mv))]));
        };
        let actor_id = js_text(self.state.get("actor"));
        let from = self
            .node(self.state.get("actor"))
            .and_then(|a| a.get("effector_mm"));
        let (Some(from), Some(xyz)) = (from, xyz3(from)) else {
            return Outcome::No(self.bad(i, "no_effector", vec![]));
        };
        self.push(format!("{actor_id}/effector_mm"), from.clone());
        self.push(format!("move/{mv}/reach_mm"), Value::Int(reach));
        if let (Some((id, _, _)), Some(at)) = (&other, &origin) {
            let at = Value::Arr(at.iter().map(|v| Value::Int(*v)).collect());
            self.push(format!("{id}/at_mm"), at);
        }
        let at = origin.unwrap_or_else(|| vec![0, 0, 0]);
        // Each coordinate is within 2^53, so each difference within 2^55, its square within 2^110 and the sum within
        // i128.
        let distance_sq: i128 = (0..3)
            .map(|k| {
                let d = xyz[k] - place[k] - at[k];
                d * d
            })
            .sum();
        if distance_sq <= reach * reach {
            return Outcome::Ok;
        }
        let mut detail = vec![("point".to_owned(), Value::s(&name))];
        let fix = match &other {
            None => Value::object([("step", Value::s("walk_to")), ("point", Value::s(&name))]),
            Some((id, _, _)) => {
                detail.push(("of".into(), Value::s(id)));
                // Walk to the thing's point named `stand` if its kind declares one, else to the point itself.
                let stand = has(owner.get("points"), "stand").is_some();
                Value::object([
                    ("step", Value::s("walk_to")),
                    ("point", Value::s(if stand { "stand" } else { &name })),
                    ("thing", Value::s(id)),
                ])
            }
        };
        detail.push(("move".into(), Value::s(mv)));
        Outcome::No(self.no("out_of_reach", i, detail, fix))
    }

    /// The actor's hands, each read; `Err` names what is wrong. The one list an asker states, so it is capped.
    fn hands(&mut self) -> Result<Vec<(String, Value)>, &'static str> {
        let actor = self.node(self.state.get("actor"));
        let hands: Vec<(String, Value)> = match actor.and_then(|a| a.get("hands")) {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Obj(e)) => e.clone(),
            Some(Value::Arr(a)) if a.len() <= MAX_HANDS => a
                .iter()
                .enumerate()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
            Some(Value::Arr(_)) => return Err("too_many_hands"),
            Some(_) => return Err("too_many_hands"),
        };
        if hands.len() > MAX_HANDS {
            return Err("too_many_hands");
        }
        let mut hands = hands;
        hands.sort_by(|a, b| a.0.cmp(&b.0));
        let actor_id = js_text(self.state.get("actor"));
        for (name, v) in &hands {
            self.push(format!("{actor_id}/hand/{name}"), v.clone());
        }
        Ok(hands)
    }

    fn hand(&mut self, n: &Value, i: i128) -> Outcome {
        let hands = match self.hands() {
            Ok(h) => h,
            Err(what) => return Outcome::No(self.bad(i, what, vec![])),
        };
        if n.get("free") == Some(&Value::Bool(true)) {
            if hands.iter().any(|(_, v)| matches!(v, Value::Null)) {
                return Outcome::Ok;
            }
            let fix = if hands.is_empty() {
                Value::Null
            } else {
                Value::object([("step", Value::s("put"))])
            };
            return Outcome::No(self.no("no_free_hand", i, vec![], fix));
        }
        if n.get("empty") == Some(&Value::Bool(true)) {
            let holding = hands
                .iter()
                .filter(|(_, v)| !matches!(v, Value::Null))
                .count();
            if holding == 0 {
                return Outcome::Ok;
            }
            let holding = i128::try_from(holding).unwrap_or(i128::MAX);
            let detail = vec![("holding".into(), Value::Int(holding))];
            let fix = Value::object([("step", Value::s("put"))]);
            return Outcome::No(self.no("hand_not_empty", i, detail, fix));
        }
        if let Some(kind) = n.get("holds").and_then(Value::str) {
            let holding = hands.iter().any(|(_, v)| {
                v.str()
                    .is_some_and(|id| is_kind(has(self.nodes(), id), kind))
            });
            if holding {
                return Outcome::Ok;
            }
            let fix = if hands.is_empty() {
                Value::Null
            } else {
                Value::object([("step", Value::s("take")), ("kind", Value::s(kind))])
            };
            return Outcome::No(self.no(
                "not_holding_kind",
                i,
                vec![("kind".into(), Value::s(kind))],
                fix,
            ));
        }
        Outcome::No(self.bad(i, "malformed_need", vec![]))
    }

    /// The `thing` argument a need is about; `Err` is the refusal for a missing one.
    fn thing_arg(&self, n: &Value, i: i128) -> Result<String, Value> {
        resolve(n.get("thing"), self.args()).ok_or_else(|| {
            let arg = has(n.get("thing"), "arg").cloned().unwrap_or(Value::Null);
            self.bad(i, "argument_missing", vec![("arg".into(), arg)])
        })
    }

    fn held_by_actor(&mut self, n: &Value, i: i128) -> Outcome {
        let named = n.get("thing").is_some();
        let thing = if named {
            match self.thing_arg(n, i) {
                Ok(t) => Value::Str(t),
                Err(v) => return Outcome::No(v),
            }
        } else {
            self.act.get("this").cloned().unwrap_or(Value::Null)
        };
        let hands = match self.hands() {
            Ok(h) => h,
            Err(what) => return Outcome::No(self.bad(i, what, vec![])),
        };
        if hands.iter().any(|(_, v)| strict_eq(v, &thing)) {
            return Outcome::Ok;
        }
        let detail = if named {
            vec![("thing".into(), thing.clone())]
        } else {
            vec![]
        };
        let fix = Value::object([("step", Value::s("take")), ("thing", thing)]);
        Outcome::No(self.no("not_held", i, detail, fix))
    }

    /// This thing is in nobody's hand: read from every node the state gives, so a thing in another Soul's hand is
    /// refused too; only the actor's own hold names a fix.
    fn not_in_hand(&mut self, i: i128) -> Outcome {
        let act: &'a Value = self.act;
        let Some(this) = act.get("this") else {
            return Outcome::Ok;
        };
        for (holder, node) in keyed(self.nodes()) {
            let Some(hand) = keyed(node.get("hands"))
                .into_iter()
                .find(|(_, v)| strict_eq(v, this))
                .map(|(k, _)| k)
            else {
                continue;
            };
            self.push(format!("{holder}/hand/{hand}"), this.clone());
            let mine = self.state.get("actor").and_then(Value::str) == Some(holder.as_str());
            let fix = if mine {
                Value::object([("step", Value::s("put"))])
            } else {
                Value::Null
            };
            let detail = vec![
                ("node".into(), Value::Str(holder)),
                ("hand".into(), Value::Str(hand)),
            ];
            return Outcome::No(self.no("in_hand", i, detail, fix));
        }
        Outcome::Ok
    }

    /// How the thing moves, from its kind's section 18: carried needs that many free hands, pushed needs one Soul.
    fn moves(&mut self, n: &Value, i: i128) -> Outcome {
        let thing = match self.thing_arg(n, i) {
            Ok(t) => t,
            Err(v) => return Outcome::No(v),
        };
        let node = has(self.nodes(), &thing);
        let Some(kind) = self.entry_of(node) else {
            return Outcome::No(self.bad(
                i,
                "no_such_kind",
                vec![("node".into(), Value::s(&thing))],
            ));
        };
        let by = n.get("by").and_then(Value::str);
        let Some(by @ ("carry" | "push")) = by else {
            return Outcome::No(self.bad(i, "malformed_need", vec![]));
        };
        let how = has(kind.get("motion"), "how");
        let kind_name = js_text(has(node, "kind"));
        self.push(
            format!("{kind_name}/motion"),
            how.cloned().unwrap_or(Value::Null),
        );
        let no = |r: &Self, reason: &str, extra: Obj, fix: Value| {
            let mut detail = vec![
                ("thing".into(), Value::s(&thing)),
                ("by".into(), Value::s(by)),
            ];
            detail.extend(extra);
            Outcome::No(r.no(reason, i, detail, fix))
        };
        let how = how.and_then(Value::str).filter(|h| {
            table(&CARRIED, h).is_some() || table(&PUSHED, h).is_some() || *h == "fixed"
        });
        let Some(how) = how else {
            return no(self, "motion_unsaid", vec![], Value::Null);
        };
        let need = table(if by == "carry" { &CARRIED } else { &PUSHED }, how);
        let Some(need) = need else {
            return no(
                self,
                "moves_by",
                vec![("how".into(), Value::s(how))],
                Value::Null,
            );
        };
        if by == "push" {
            if need > 1 {
                let extra = vec![
                    ("how".into(), Value::s(how)),
                    ("souls".into(), Value::Int(need)),
                ];
                return no(self, "needs_souls", extra, Value::Null);
            }
            return Outcome::Ok;
        }
        let hands = match self.hands() {
            Ok(h) => h,
            Err(what) => return Outcome::No(self.bad(i, what, vec![])),
        };
        let free = hands
            .iter()
            .filter(|(_, v)| matches!(v, Value::Null))
            .count();
        if i128::try_from(free).unwrap_or(i128::MAX) >= need {
            return Outcome::Ok;
        }
        let detail = vec![
            ("thing".into(), Value::s(&thing)),
            ("how".into(), Value::s(how)),
            ("hands".into(), Value::Int(need)),
        ];
        Outcome::No(self.no(
            "no_free_hand",
            i,
            detail,
            Value::object([("step", Value::s("put"))]),
        ))
    }

    fn link(&mut self, n: &Value, i: i128, this: &Value, entry: &Value, want: bool) -> Outcome {
        let ty = key_of(n.get("link"));
        let Some(def) = has(entry.get("links"), &ty) else {
            return Outcome::No(self.bad(i, "no_such_link", vec![("link".into(), Value::Str(ty))]));
        };
        let this_id = self.this_id();
        if !self.sees(def.get("audience")) {
            return Outcome::Unknown(self.unknown(i, &this_id, "link", &ty, false));
        }
        if index_only(Some(this)) {
            return Outcome::Unknown(self.unknown(i, &this_id, "link", &ty, true));
        }
        let list = has(this.get("links"), &ty);
        let count = list
            .and_then(Value::arr)
            .map_or(0, |l| i128::try_from(l.len()).unwrap_or(i128::MAX));
        self.push(
            format!("{this_id}/link/{}", js_text(def.get("n"))),
            Value::Int(count),
        );
        let change = if want { "link" } else { "unlink" };
        let meets = |e: &Value| {
            e.get("change").and_then(Value::str) == Some(change)
                && e.get("link").and_then(Value::str) == Some(ty.as_str())
        };
        let fix = if n.get("end").and_then(Value::str) == Some("actor") {
            // Whether the actor is one of the ends (only its author takes a note down; a Soul signs a line once).
            let actor = self.state.get("actor").cloned().unwrap_or(Value::Null);
            if includes(list, &actor) == want {
                return Outcome::Ok;
            }
            // Not on it: linking is a fix only while the link has room; another's place is not this actor's to free.
            if !want || whole(def.get("most")).is_some_and(|m| count < m) {
                self.form_fix(entry, meets, |_| true)
            } else {
                Value::Null
            }
        } else {
            if (count > 0) == want {
                return Outcome::Ok;
            }
            self.form_fix(entry, meets, |_| true)
        };
        let reason = if want { "not_linked" } else { "already_linked" };
        Outcome::No(self.no(
            reason,
            i,
            vec![
                ("link".into(), Value::Str(ty)),
                ("count".into(), Value::Int(count)),
            ],
            fix,
        ))
    }

    /// One end may be linked to at most `most_per` things of this kind under one parent (one signature per guestbook,
    /// one vote per poll), counted on this thing and its siblings: its parent's children of the same kind. A thing
    /// under no parent counts alone. A refusal lists the things that hold the actor (`on`).
    fn most_per(&mut self, n: &Value, i: i128, this: &Value, entry: &Value) -> Outcome {
        let ty = key_of(n.get("link"));
        let Some(def) = has(entry.get("links"), &ty) else {
            return Outcome::No(self.bad(i, "no_such_link", vec![("link".into(), Value::Str(ty))]));
        };
        let most_per = whole(def.get("most_per"));
        let Some(most_per) =
            most_per.filter(|_| def.get("per").and_then(Value::str) == Some("parent"))
        else {
            return Outcome::No(self.bad(i, "malformed_need", vec![]));
        };
        let this_id = self.this_id();
        if !self.sees(def.get("audience")) {
            return Outcome::Unknown(self.unknown(i, &this_id, "link", &ty, false));
        }
        if index_only(Some(this)) {
            return Outcome::Unknown(self.unknown(i, &this_id, "link", &ty, true));
        }
        let me = self.act.get("this").cloned().unwrap_or(Value::Null);
        let nodes = keyed(self.nodes());
        let parent = nodes
            .iter()
            .find(|(_, p)| includes(p.get("children"), &me))
            .map(|(_, p)| *p);
        let kind = this.get("kind");
        let mut siblings: Vec<String> = match parent {
            None => vec![this_id.clone()],
            Some(p) => p
                .get("children")
                .and_then(Value::arr)
                .unwrap_or(&[])
                .iter()
                .filter_map(Value::str)
                .filter(|id| has(self.nodes(), id).is_some_and(|c| js_eq(c.get("kind"), kind)))
                .map(str::to_owned)
                .collect(),
        };
        if siblings.len() > MAX_SIBLINGS {
            return Outcome::No(self.bad(i, "too_many_children", vec![]));
        }
        siblings.sort();
        let actor = self.state.get("actor").cloned().unwrap_or(Value::Null);
        let mut on = Vec::new();
        for id in siblings {
            let ends = has(has(has(self.nodes(), &id), "links"), &ty);
            let count = ends
                .and_then(Value::arr)
                .map_or(0, |l| i128::try_from(l.len()).unwrap_or(i128::MAX));
            self.push(
                format!("{id}/link/{}", js_text(def.get("n"))),
                Value::Int(count),
            );
            if includes(ends, &actor) {
                on.push(Value::Str(id));
            }
        }
        if i128::try_from(on.len()).unwrap_or(i128::MAX) < most_per {
            return Outcome::Ok;
        }
        let fix = if in_slice(&on, &me) {
            self.form_fix(
                entry,
                |e| {
                    e.get("change").and_then(Value::str) == Some("unlink")
                        && e.get("link").and_then(Value::str) == Some(ty.as_str())
                },
                |_| true,
            )
        } else {
            Value::Null
        };
        let detail = vec![
            ("link".into(), Value::s(&ty)),
            ("most_per".into(), Value::Int(most_per)),
            ("on".into(), Value::Arr(on)),
        ];
        Outcome::No(self.no("already_linked", i, detail, fix))
    }

    /// `room`: every amount the form moves has room where it lands (SA-F2b): a pour never overflows. `enough`: every
    /// amount the form asks is there to give, so a pour of three units from a pitcher holding two is refused.
    fn transfers(&mut self, i: i128, form: &Value, enough: bool) -> Outcome {
        let effects: Vec<&Value> = form
            .get("effects")
            .and_then(Value::arr)
            .unwrap_or(&[])
            .iter()
            .filter(|e| e.get("change").and_then(Value::str) == Some("transfer"))
            .collect();
        if effects.is_empty() {
            return Outcome::No(self.bad(i, "no_transfer", vec![]));
        }
        let this_id = self.this_id();
        for e in effects {
            let m = match measure(self.kinds, self.nodes(), &this_id, self.args(), e) {
                Ok(m) => m,
                Err((what, detail)) => return Outcome::No(self.bad(i, what, detail)),
            };
            for (node, def) in [(&m.from, m.from_def), (&m.into, m.into_def)] {
                let n = has(self.nodes(), node);
                if !self.sees(audience_of(self.entry_of(n), &m.field, Some(def))) {
                    return Outcome::Unknown(self.unknown(i, node, "field", &m.field, false));
                }
                if index_only(n) {
                    return Outcome::Unknown(self.unknown(i, node, "field", &m.field, true));
                }
            }
            self.push(
                format!("{}/field/{}", m.from, js_text(m.from_def.get("n"))),
                Value::Int(m.there),
            );
            self.push(
                format!("{}/field/{}", m.into, js_text(m.into_def.get("n"))),
                Value::Int(m.held),
            );
            if !enough
                && let Some(room) = m.room
                && m.moved > room
            {
                let detail = vec![
                    ("node".into(), Value::Str(m.into.clone())),
                    ("field".into(), Value::Str(m.into_field.clone())),
                    ("room".into(), Value::Int(room)),
                    ("amount".into(), Value::Int(m.moved)),
                ];
                return Outcome::No(self.no("no_room", i, detail, Value::Null));
            }
            if enough && m.moved < m.asked {
                let detail = vec![
                    ("node".into(), Value::Str(m.from.clone())),
                    ("field".into(), Value::Str(m.field.clone())),
                    ("has".into(), Value::Int(m.moved)),
                    ("amount".into(), Value::Int(m.asked)),
                ];
                return Outcome::No(self.no("not_enough", i, detail, Value::Null));
            }
        }
        Outcome::Ok
    }

    /// The `fields` list of a `sum` or `any` need, when it names two or more.
    fn field_list(n: &Value) -> Option<&[Value]> {
        n.get("fields")
            .and_then(Value::arr)
            .filter(|f| f.len() >= 2)
    }

    /// The sum of int fields of this kind (a well whose portions are kept in two fields). With `after_moves`, each
    /// field as this form's transfers would leave it, measured as the `room` need measures them.
    fn sum(&mut self, n: &Value, i: i128, this: &Value, entry: &Value, form: &Value) -> Outcome {
        let Some(fields) = Self::field_list(n) else {
            return Outcome::No(self.bad(i, "malformed_need", vec![]));
        };
        let this_id = self.this_id();
        let mut total: i128 = 0;
        for f in fields {
            let field = js_text(Some(f));
            let def = has(entry.get("state"), &field)
                .filter(|d| d.get("type").and_then(Value::str) == Some("int"));
            let Some(def) = def else {
                return Outcome::No(self.bad(
                    i,
                    "no_such_field",
                    vec![("field".into(), f.clone())],
                ));
            };
            if !self.sees(def.get("audience")) {
                return Outcome::Unknown(self.unknown(i, &this_id, "field", &field, false));
            }
            if index_only(Some(this)) {
                return Outcome::Unknown(self.unknown(i, &this_id, "field", &field, true));
            }
            let value = has(this.get("fields"), &field).or(def.get("default"));
            let Some(v) = whole(value) else {
                return Outcome::No(self.bad(
                    i,
                    "not_whole_number",
                    vec![("field".into(), f.clone())],
                ));
            };
            self.push(
                format!("{this_id}/field/{}", js_text(def.get("n"))),
                Value::Int(v),
            );
            total += v;
        }
        let after_moves = n.get("after_moves") == Some(&Value::Bool(true));
        if after_moves {
            let effects = form.get("effects").and_then(Value::arr).unwrap_or(&[]);
            for e in effects
                .iter()
                .filter(|e| e.get("change").and_then(Value::str) == Some("transfer"))
            {
                let m = match measure(self.kinds, self.nodes(), &this_id, self.args(), e) {
                    Ok(m) => m,
                    Err((what, detail)) => return Outcome::No(self.bad(i, what, detail)),
                };
                if m.from == this_id && in_slice(fields, &Value::s(&m.field)) {
                    total -= m.moved;
                }
                if m.into == this_id && in_slice(fields, &Value::s(&m.into_field)) {
                    total += m.moved;
                }
            }
        }
        let wanted: Obj = ["at_least", "at_most"]
            .into_iter()
            .filter_map(|k| n.get(k).map(|v| (k.to_owned(), v.clone())))
            .collect();
        if wanted.is_empty() || wanted.iter().any(|(_, v)| whole(Some(v)).is_none()) {
            return Outcome::No(self.bad(i, "malformed_need", vec![]));
        }
        let ok = |k: &str, ge: bool| {
            whole(n.get(k)).is_none_or(|b| if ge { total >= b } else { total <= b })
        };
        if ok("at_least", true) && ok("at_most", false) {
            return Outcome::Ok;
        }
        let mut detail = vec![
            ("fields".into(), Value::Arr(fields.to_vec())),
            ("found".into(), Value::Int(total)),
            ("wanted".into(), Value::Obj(wanted)),
        ];
        if after_moves {
            detail.push(("after_moves".into(), Value::Bool(true)));
        }
        Outcome::No(self.no("field_differs", i, detail, Value::Null))
    }

    /// At least one of two or more fields of this kind is not a value (sand not yet smooth everywhere). A refusal lists
    /// every field's value; its fix is a form that sets one of them to another value, where the data offers one.
    fn any(&mut self, n: &Value, i: i128, this: &Value, entry: &Value) -> Outcome {
        let (Some(fields), Some(not)) = (Self::field_list(n), n.get("not")) else {
            return Outcome::No(self.bad(i, "malformed_need", vec![]));
        };
        let this_id = self.this_id();
        let mut found = Vec::new();
        let mut differs = false;
        for f in fields {
            let field = js_text(Some(f));
            let def = has(entry.get("state"), &field)
                .filter(|d| d.get("type").and_then(Value::str) != Some("timed"));
            let Some(def) = def else {
                return Outcome::No(self.bad(
                    i,
                    "no_such_field",
                    vec![("field".into(), f.clone())],
                ));
            };
            if !self.sees(def.get("audience")) {
                return Outcome::Unknown(self.unknown(i, &this_id, "field", &field, false));
            }
            if index_only(Some(this)) {
                return Outcome::Unknown(self.unknown(i, &this_id, "field", &field, true));
            }
            let value = has(this.get("fields"), &field).or(def.get("default"));
            self.push(
                format!("{this_id}/field/{}", js_text(def.get("n"))),
                value.cloned().unwrap_or(Value::Null),
            );
            found.push(value.cloned().unwrap_or(Value::Null));
            if !js_eq(
                flag(Some(def), value).as_ref(),
                flag(Some(def), Some(not)).as_ref(),
            ) {
                differs = true;
            }
        }
        if differs {
            return Outcome::Ok;
        }
        let state = entry.get("state");
        let fix = self.form_fix(
            entry,
            |e| {
                let Some(field) = e.get("field").and_then(Value::str) else {
                    return false;
                };
                let def = has(state, field);
                e.get("change").and_then(Value::str) == Some("set")
                    && in_slice(fields, &Value::s(field))
                    && e.get("by").is_none()
                    && !matches!(
                        e.get("to"),
                        Some(Value::Null | Value::Arr(_) | Value::Obj(_))
                    )
                    && !js_eq(
                        flag(def, e.get("to")).as_ref(),
                        flag(def, Some(not)).as_ref(),
                    )
            },
            |_| true,
        );
        let detail = vec![
            ("fields".into(), Value::Arr(fields.to_vec())),
            ("found".into(), Value::Arr(found)),
            ("wanted".into(), Value::object([("not", not.clone())])),
        ];
        Outcome::No(self.no("field_differs", i, detail, fix))
    }
}

/// Runs every case of `doc` (`{"kinds": {...}, "cases": [{name, act, state, asker}, ...]}`) and answers one line a
/// case: its name, a tab and its verdict as JSON. The native test and the WASM build in Node both run it on the same
/// text, so equal output is equal verdicts. A doc that is not JSON answers one line naming why.
#[cfg_attr(
    all(target_arch = "wasm32", not(feature = "checker")),
    wasm_bindgen::prelude::wasm_bindgen
)]
pub fn rules_run(doc: &str) -> String {
    let doc = match json::parse(doc) {
        Ok(d) => d,
        Err(e) => return format!("not json: {e}\n"),
    };
    let kinds = doc.get("kinds");
    let mut out = String::new();
    for c in doc.get("cases").and_then(Value::arr).unwrap_or(&[]) {
        let verdict = decide_parts(kinds, c.get("act"), c.get("state"), c.get("asker"));
        out.push_str(&js_text(c.get("name")));
        out.push('\t');
        out.push_str(&verdict.to_json());
        out.push('\n');
    }
    out
}

/// Decides one input given as JSON text and answers the verdict as JSON text.
#[cfg_attr(
    all(target_arch = "wasm32", not(feature = "checker")),
    wasm_bindgen::prelude::wasm_bindgen
)]
pub fn rules_decide(input: &str) -> String {
    match json::parse(input) {
        Ok(v) => decide(&v).to_json(),
        Err(_) => decide(&Value::Null).to_json(),
    }
}
