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
//! | `state` | a field `is` / is `not` a value, or lies in `at_least`..`at_most` (a `timed` field at `state.now_us`) | `field_differs` |
//! | `slot_free` | a slot (of this thing, or `{node, slot}` of another) has fewer occupants than its `most` | `slot_taken` |
//! | `within_reach` | a point is within the reach of the move the form's step makes there, as squares in `i128` | `out_of_reach` |
//! | `hand` | the actor has a free hand (`free: true`) or a hand holding a kind (`holds`) | `no_free_hand`, `not_holding_kind` |
//! | `held_by_actor` | this thing is in one of the actor's hands | `not_held` |
//! | `linked` / `unlinked` | this thing has some / no link of that type | `not_linked`, `already_linked` |
//! | `room` | every amount the form's `transfer` effects move has room where it lands | `no_room` |
//!
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
//! E1): then the unknown carries `"held": "index"` too. Unknown never blocks a send (R8).
//!
//! Whole numbers only (`i128`), no float is ever worked with, and the only list an asker states (a body's hands) is
//! capped at [`MAX_HANDS`]; every other loop runs over lists the kind declares.

pub mod json;

use json::Value;

/// The closed list of needs.
pub const NEEDS: [&str; 8] = [
    "state",
    "slot_free",
    "within_reach",
    "hand",
    "held_by_actor",
    "linked",
    "unlinked",
    "room",
];

/// The closed list of reasons a verdict of `no` names (`link_full` comes from working out effects, not a need).
pub const REASONS: [&str; 11] = [
    "field_differs",
    "slot_taken",
    "out_of_reach",
    "no_free_hand",
    "not_holding_kind",
    "not_held",
    "not_linked",
    "already_linked",
    "no_room",
    "link_full",
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

/// What a `transfer` effect moves (SA-F2b): the field, both ends, what each has, the target's room and the amount.
struct Measure<'a> {
    field: String,
    from: String,
    into: String,
    from_def: &'a Value,
    into_def: &'a Value,
    there: i128,
    held: i128,
    room: Option<i128>,
    moved: i128,
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
    let (Some(from), Some(into)) = (from.clone(), into.clone()) else {
        let show = |x: Option<String>| x.map_or(Value::Null, Value::Str);
        return Err((
            "malformed_transfer",
            vec![("from".into(), show(from)), ("into".into(), show(into))],
        ));
    };
    if from.is_empty() || into.is_empty() || from == into {
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
    for id in [&from, &into] {
        let node = has(nodes, id);
        let entry = has(node, "kind")
            .and_then(Value::str)
            .and_then(|k| kinds.get(k));
        let def = has(has(entry, "state"), &field);
        let detail = vec![
            ("node".into(), Value::Str(id.clone())),
            ("field".into(), Value::Str(field.clone())),
        ];
        let Some(def) = def.filter(|d| d.get("type").and_then(Value::str) == Some("int")) else {
            return Err(("no_such_field", detail));
        };
        if node.is_none() {
            return Err(("no_such_field", detail));
        }
        let value = has(has(node, "fields"), &field).or(def.get("default"));
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
                        ("field".into(), Value::Str(field)),
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
                        ("field".into(), Value::Str(field)),
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
        field,
        from,
        into,
        from_def,
        into_def,
        there,
        held,
        room,
    })
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
    let mut r = Rules {
        kinds,
        act,
        state,
        asker,
        read: Vec::new(),
    };
    r.run()
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
        has(node, "kind")
            .filter(|k| k.truthy())
            .and_then(|k| self.kinds.get(&js_text(Some(k))))
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
                Some("state") => self.state_need(n, i, this, entry),
                Some("slot_free") => self.slot_free(n, i),
                Some("within_reach") => self.within_reach(n, i, entry, form),
                Some("hand") => self.hand(n, i),
                Some("held_by_actor") => self.held_by_actor(i),
                Some("linked") => self.link(n, i, this, entry, true),
                Some("unlinked") => self.link(n, i, this, entry, false),
                Some(_) => self.room(i, form),
            };
            match out {
                Outcome::Ok => {}
                Outcome::No(v) => return v,
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
                || f.get("who").and_then(Value::str) != Some("anyone")
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

    fn state_need(&mut self, n: &Value, i: i128, this: &Value, entry: &'a Value) -> Outcome {
        let field = n.get("field").and_then(Value::str).unwrap_or("");
        let Some(def) = has(entry.get("state"), field) else {
            return Outcome::No(self.bad(
                i,
                "no_such_field",
                vec![("field".into(), Value::s(field))],
            ));
        };
        let this_id = js_text(self.act.get("this"));
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
        let holds = |m: &Value, v: Option<&Value>| {
            let fv = flag(Some(def), v);
            let eq = |k| js_eq(flag(Some(def), m.get(k)).as_ref(), fv.as_ref());
            let bound = |k, ge: bool| match (int(v), int(m.get(k))) {
                (Some(x), Some(b)) => {
                    if ge {
                        x >= b
                    } else {
                        x <= b
                    }
                }
                _ => false,
            };
            (m.get("is").is_none() || eq("is"))
                && (m.get("not").is_none() || !eq("not"))
                && (m.get("at_least").is_none() || bound("at_least", true))
                && (m.get("at_most").is_none() || bound("at_most", false))
        };
        if holds(n, value.as_ref()) {
            return Outcome::Ok;
        }
        let wanted: Obj = ["is", "not", "at_least", "at_most"]
            .into_iter()
            .filter_map(|k| n.get(k).map(|v| (k.to_owned(), v.clone())))
            .collect();
        let current = value.clone();
        let fix = self.form_fix(
            entry,
            |e| {
                e.get("change").and_then(Value::str) == Some("set")
                    && e.get("field").and_then(Value::str) == Some(field)
                    && !matches!(e.get("to"), Some(Value::Arr(_) | Value::Obj(_)))
                    && holds(n, e.get("to"))
            },
            |f| {
                f.get("needs")
                    .and_then(Value::arr)
                    .unwrap_or(&[])
                    .iter()
                    .all(|m| {
                        m.get("need").and_then(Value::str) != Some("state")
                            || m.get("field").and_then(Value::str) != Some(field)
                            || holds(m, current.as_ref())
                    })
            },
        );
        let detail = vec![
            ("field".into(), Value::s(field)),
            ("found".into(), value.unwrap_or(Value::Null)),
            ("wanted".into(), Value::Obj(wanted)),
        ];
        Outcome::No(self.no("field_differs", i, detail, fix))
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
        let this_id = js_text(self.act.get("this"));
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
        let place = match has(entry.get("points"), &name) {
            Some(point) => point.get("at_mm"),
            None => has(has(entry.get("slots"), &name), "at_mm"),
        };
        let place: Option<Vec<i128>> = place
            .and_then(Value::arr)
            .filter(|p| p.len() == 3)
            .and_then(|p| p.iter().map(|v| whole(Some(v))).collect());
        let Some(place) = place else {
            return Outcome::No(self.bad(
                i,
                "no_such_point",
                vec![("point".into(), Value::Str(name))],
            ));
        };
        let steps: &[Value] = form.get("steps").and_then(Value::arr).unwrap_or(&[]);
        let step = steps.iter().find(|s| {
            s.get("step").and_then(Value::str) == Some("move")
                && resolve(s.get("at"), args).as_deref() == Some(&name)
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
        let from_xyz: Option<Vec<i128>> = from
            .and_then(Value::arr)
            .filter(|p| p.len() == 3)
            .and_then(|p| p.iter().map(|v| whole(Some(v))).collect());
        let (Some(from), Some(xyz)) = (from, from_xyz) else {
            return Outcome::No(self.bad(i, "no_effector", vec![]));
        };
        self.push(format!("{actor_id}/effector_mm"), from.clone());
        self.push(format!("move/{mv}/reach_mm"), Value::Int(reach));
        // Each coordinate is within 2^53, so each square is within 2^108 and the sum within i128.
        let distance_sq: i128 = (0..3)
            .map(|k| (xyz[k] - place[k]) * (xyz[k] - place[k]))
            .sum();
        if distance_sq <= reach * reach {
            return Outcome::Ok;
        }
        let detail = vec![
            ("point".into(), Value::s(&name)),
            ("move".into(), Value::s(mv)),
        ];
        let fix = Value::object([("step", Value::s("walk_to")), ("point", Value::Str(name))]);
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
        if let Some(kind) = n.get("holds").and_then(Value::str) {
            let holding = hands.iter().any(|(_, v)| {
                v.str().is_some_and(|id| {
                    has(has(self.nodes(), id), "kind").and_then(Value::str) == Some(kind)
                })
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

    fn held_by_actor(&mut self, i: i128) -> Outcome {
        let hands = match self.hands() {
            Ok(h) => h,
            Err(what) => return Outcome::No(self.bad(i, what, vec![])),
        };
        let this = self.act.get("this");
        if hands
            .iter()
            .any(|(_, v)| this.is_some_and(|t| strict_eq(v, t)))
        {
            return Outcome::Ok;
        }
        let fix = Value::object([
            ("step", Value::s("take")),
            ("thing", this.cloned().unwrap_or(Value::Null)),
        ]);
        Outcome::No(self.no("not_held", i, vec![], fix))
    }

    fn link(&mut self, n: &Value, i: i128, this: &Value, entry: &Value, want: bool) -> Outcome {
        let ty = n.get("link").and_then(Value::str).unwrap_or("");
        let Some(def) = has(entry.get("links"), ty) else {
            return Outcome::No(self.bad(i, "no_such_link", vec![("link".into(), Value::s(ty))]));
        };
        let this_id = js_text(self.act.get("this"));
        if !self.sees(def.get("audience")) {
            return Outcome::Unknown(self.unknown(i, &this_id, "link", ty, false));
        }
        if index_only(Some(this)) {
            return Outcome::Unknown(self.unknown(i, &this_id, "link", ty, true));
        }
        let count = has(this.get("links"), ty)
            .and_then(Value::arr)
            .map_or(0, |l| i128::try_from(l.len()).unwrap_or(i128::MAX));
        self.push(
            format!("{this_id}/link/{}", js_text(def.get("n"))),
            Value::Int(count),
        );
        if (count > 0) == want {
            return Outcome::Ok;
        }
        let change = if want { "link" } else { "unlink" };
        let fix = self.form_fix(
            entry,
            |e| {
                e.get("change").and_then(Value::str) == Some(change)
                    && e.get("link").and_then(Value::str) == Some(ty)
            },
            |_| true,
        );
        let reason = if want { "not_linked" } else { "already_linked" };
        Outcome::No(self.no(
            reason,
            i,
            vec![
                ("link".into(), Value::s(ty)),
                ("count".into(), Value::Int(count)),
            ],
            fix,
        ))
    }

    fn room(&mut self, i: i128, form: &Value) -> Outcome {
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
        let this_id = js_text(self.act.get("this"));
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
            if let Some(room) = m.room
                && m.moved > room
            {
                let detail = vec![
                    ("node".into(), Value::Str(m.into.clone())),
                    ("field".into(), Value::Str(m.field.clone())),
                    ("room".into(), Value::Int(room)),
                    ("amount".into(), Value::Int(m.moved)),
                ];
                return Outcome::No(self.no("no_room", i, detail, Value::Null));
            }
        }
        Outcome::Ok
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
