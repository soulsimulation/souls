//! A creator's tint on a thing (0.134 R4, `souls-god recolor`): one optional field of the thing's own node, a colour
//! for the whole thing or for one of its named parts, which the page multiplies its picture by. It is an ordinary
//! field written by a creator's edit (`replica::edit`, so only the world's creator writes it), logged and streamed as
//! any set is, and undone by an undo like any other: a batch that added it is undone to the empty list, which reads as
//! no tint (`edit::claims::neutral`). A thing without the field is drawn as before.
//!
//! The field holds rows `[part, rgb]`: `part` is [`WHOLE`] for the whole thing or `part:<name>` for a named part (a
//! name as a part's text must be, `namespace:name`: lowercase letters, digits, `_` and `-`), `rgb` a whole number
//! from 0 to 0xffffff. Each part at most once, at most [`PARTS_MOST`] rows. Anything else is refused
//! `edit.tint-malformed`.

use crate::encode::Value;

/// The tint field, on a thing's node.
pub const F_TINT: u64 = 145;
/// The most rows one tint holds: the whole thing and fifteen parts.
pub const PARTS_MOST: usize = 16;
/// The largest colour, `#ffffff`.
pub const RGB_MOST: u64 = 0xff_ffff;
/// The row's part for the whole thing.
pub const WHOLE: &str = "tint:whole";

/// A named part's name, `<name>` of `part:<name>`; none for [`WHOLE`]; an error for any other text.
fn part_of(t: &str) -> Result<Option<&str>, String> {
    if t == WHOLE {
        return Ok(None);
    }
    let name = t.strip_prefix("part:").unwrap_or("");
    let ok = name.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
    if ok {
        Ok(Some(name))
    } else {
        Err(format!(
            "a tint's part is {WHOLE} or part:<name> (lowercase letters, digits, _ and -), not {t:?}"
        ))
    }
}

/// The rows of a tint as `(part, rgb)`, the part none for the whole thing, or why it does not read as one.
pub fn read(v: &Value) -> Result<Vec<(Option<&str>, u32)>, String> {
    let Value::Array(rows) = v else {
        return Err("a tint is a list of [part, rgb] rows".to_owned());
    };
    if rows.len() > PARTS_MOST {
        return Err(format!("a tint has at most {PARTS_MOST} rows"));
    }
    let mut out: Vec<(Option<&str>, u32)> = Vec::with_capacity(rows.len());
    for r in rows {
        let (part, rgb) = match r {
            Value::Array(r) => match r.as_slice() {
                [Value::Text(p), Value::Uint(c)] if *c <= RGB_MOST => {
                    (part_of(p.as_str())?, *c as u32)
                }
                _ => return Err("a tint row is [part name, rgb 0 to 0xffffff]".to_owned()),
            },
            _ => return Err("a tint row is [part name, rgb 0 to 0xffffff]".to_owned()),
        };
        if out.iter().any(|(p, _)| *p == part) {
            return Err(format!("{} is tinted twice", part.unwrap_or(WHOLE)));
        }
        out.push((part, rgb));
    }
    Ok(out)
}

/// Whether `v` may be written to field `field`: any value to another field, a tint that reads to [`F_TINT`].
pub fn check(field: u64, v: &Value) -> Result<(), String> {
    if field == F_TINT {
        read(v).map(|_| ())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::Name;

    fn row(part: &str, rgb: u64) -> Value {
        Value::Array(vec![
            Value::Text(Name::new(part).unwrap()),
            Value::Uint(rgb),
        ])
    }

    #[test]
    fn a_tint_is_rows_of_a_part_and_a_colour_each_part_once() {
        let ok = Value::Array(vec![row(WHOLE, 0xff0000), row("part:seat", 0x0000ff)]);
        assert_eq!(
            read(&ok).unwrap(),
            vec![(None, 0xff0000), (Some("seat"), 0x0000ff)]
        );
        assert_eq!(read(&Value::Array(Vec::new())).unwrap(), vec![]);
        for bad in [
            Value::Uint(3),
            Value::Array(vec![row(WHOLE, 0x100_0000)]),
            Value::Array(vec![row("part:seat", 1), row("part:seat", 2)]),
            Value::Array(vec![row("seat", 1)]),
            Value::Array(vec![row("part:Seat", 1)]),
            Value::Array(vec![row("part:", 1)]),
            Value::Array(vec![Value::Array(vec![Value::Uint(1), Value::Uint(2)])]),
            Value::Array(
                (0..=PARTS_MOST as u64)
                    .map(|i| row(&format!("part:p{i}"), i))
                    .collect(),
            ),
        ] {
            assert!(check(F_TINT, &bad).is_err(), "{bad:?}");
        }
        assert!(
            check(F_TINT + 1, &Value::Uint(3)).is_ok(),
            "another field is not a tint"
        );
    }
}
