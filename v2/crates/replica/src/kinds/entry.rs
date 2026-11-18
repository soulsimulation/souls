//! A `souls-entry/1` file (`content/kinds`, `docs/soul-actions/entry-format.md`) as the numbered kind K3 loads
//! (Engine v2 B17, #3338). The entry names its sections and parts; K3's text numbers them. This writes the sections
//! K3 reads, and the ones beside them that a part needs to be named by its meaning:
//!
//! - **1** kind, **2** owner;
//! - **3** state, numbered by each field's `n`: `{1: name, 2: type, 3: default, 4: audience rule}` (5: an enum's values);
//! - **4** links, numbered by each type's `n`: `{1: name, 2: from, 3: most, 4: most_per}`;
//! - **5** points, numbered 1, 2, ... in the file's order: `{1: name, 2: at_mm, 3: role, 4: yaw_mdeg}`, and for a
//!   `joint` (a connector) `5: connector kind, 6: the kind it mates with`;
//! - **6** slots, numbered 1, 2, ... in the file's order: `{1: what it admits, 2: at_mm, 3: name}`;
//! - **7** geometry `{1: bounds_mm}`, **18** motion `{1: how}`, **19** loose `{1: 1}` (ever) or `{2: us}`.
//!
//! Any other meaning section (forms, children, areas, ...) is refused by name, `entry-section-not-read`, rather than
//! dropped: a kind named without it would be named by less than its meaning. Sections 20 and up (looks, text, card)
//! sit beside the meaning and are left out.

use crate::rules::json::{Value, parse};

/// The diagnostic-notation text of the numbered kind for this entry's JSON text, for [`super::Kinds::load`].
pub fn entry_to_kind(json: &str) -> Result<String, String> {
    let e = parse(json)?;
    if e.get("format").and_then(Value::str) != Some("souls-entry/1") {
        return Err("entry-format: not a souls-entry/1 entry".into());
    }
    let mut out: Vec<(u64, String)> = Vec::new();
    for (key, v) in e.obj().unwrap_or(&[]) {
        let section = match key.as_str() {
            "format" | "looks" | "text" | "card" | "howtos" => continue,
            "kind" => (1, quoted(v)?),
            "owner" => (2, quoted(v)?),
            "state" => (3, numbered_by_n(v, state_field)?),
            "links" => (4, numbered_by_n(v, link_type)?),
            "points" => (5, in_order(v, point)?),
            "slots" => (6, in_order(v, slot)?),
            "geometry" => (7, map(&[(1, v.get("bounds_mm").map(diag).transpose()?)])),
            "motion" => (18, map(&[(1, v.get("how").map(quoted).transpose()?)])),
            "loose" => (
                19,
                map(&[
                    (1, v.get("ever").filter(|x| x.truthy()).map(|_| "1".into())),
                    (2, v.get("us").map(diag).transpose()?),
                ]),
            ),
            other => return Err(format!("entry-section-not-read: {other}")),
        };
        out.push(section);
    }
    out.sort_by_key(|(n, _)| *n);
    Ok(map(&out
        .into_iter()
        .map(|(n, t)| (n, Some(t)))
        .collect::<Vec<_>>()))
}

fn map(entries: &[(u64, Option<String>)]) -> String {
    let inner: Vec<String> = entries
        .iter()
        .filter_map(|(n, t)| t.as_ref().map(|t| format!("{n}: {t}")))
        .collect();
    format!("{{{}}}", inner.join(", "))
}

/// A JSON value as diagnostic notation: whole numbers, names as text, lists and objects (an object only as a map of
/// named parts is converted by the section readers, never here).
fn diag(v: &Value) -> Result<String, String> {
    match v {
        Value::Int(i) => Ok(i.to_string()),
        Value::Bool(b) => Ok(u8::from(*b).to_string()),
        Value::Str(_) => quoted(v),
        Value::Arr(a) => Ok(format!(
            "[{}]",
            a.iter()
                .map(diag)
                .collect::<Result<Vec<_>, _>>()?
                .join(", ")
        )),
        _ => Err(format!(
            "entry-value: {} is not a whole number, name or list",
            v.to_json()
        )),
    }
}

fn quoted(v: &Value) -> Result<String, String> {
    match v.str() {
        Some(s) if !s.contains(['"', '\\', '#']) => Ok(format!("\"{s}\"")),
        _ => Err(format!("entry-value: {} is not a name", v.to_json())),
    }
}

fn numbered_by_n(
    v: &Value,
    each: fn(&str, &Value) -> Result<String, String>,
) -> Result<String, String> {
    let mut rows = Vec::new();
    for (name, x) in v.obj().unwrap_or(&[]) {
        let Some(Value::Int(n)) = x.get("n") else {
            return Err(format!("entry-number: {name} has no n"));
        };
        rows.push((*n as u64, Some(each(name, x)?)));
    }
    rows.sort_by_key(|(n, _)| *n);
    Ok(map(&rows))
}

fn in_order(v: &Value, each: fn(&str, &Value) -> Result<String, String>) -> Result<String, String> {
    let rows = v
        .obj()
        .unwrap_or(&[])
        .iter()
        .enumerate()
        .map(|(i, (name, x))| Ok((i as u64 + 1, Some(each(name, x)?))))
        .collect::<Result<Vec<_>, String>>()?;
    Ok(map(&rows))
}

fn name(n: &str) -> Result<String, String> {
    quoted(&Value::s(n))
}

fn state_field(n: &str, f: &Value) -> Result<String, String> {
    let rule = f.get("audience").and_then(|a| a.get("rule"));
    Ok(map(&[
        (1, Some(name(n)?)),
        (2, f.get("type").map(quoted).transpose()?),
        (3, f.get("default").map(diag).transpose()?),
        (4, rule.map(quoted).transpose()?),
        (5, f.get("values").map(diag).transpose()?),
    ]))
}

fn link_type(n: &str, l: &Value) -> Result<String, String> {
    Ok(map(&[
        (1, Some(name(n)?)),
        (2, l.get("from").map(quoted).transpose()?),
        (3, l.get("most").map(diag).transpose()?),
        (4, l.get("most_per").map(diag).transpose()?),
    ]))
}

fn point(n: &str, p: &Value) -> Result<String, String> {
    Ok(map(&[
        (1, Some(name(n)?)),
        (2, p.get("at_mm").map(diag).transpose()?),
        (3, p.get("role").map(quoted).transpose()?),
        (4, p.get("yaw_mdeg").map(diag).transpose()?),
        (5, p.get("connector").map(quoted).transpose()?),
        (6, p.get("mates").map(quoted).transpose()?),
    ]))
}

fn slot(n: &str, s: &Value) -> Result<String, String> {
    let admits = match s.get("kinds") {
        Some(k) => diag(k)?,
        None => format!(
            "[{}]",
            s.get("admits").map(quoted).transpose()?.unwrap_or_default()
        ),
    };
    Ok(map(&[
        (1, Some(admits)),
        (2, s.get("at_mm").map(diag).transpose()?),
        (3, Some(name(n)?)),
    ]))
}
