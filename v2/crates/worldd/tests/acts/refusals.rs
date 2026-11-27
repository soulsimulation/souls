//! E16 (#2787) A3, A4: the twelve impossible or unwelcome requests of `twelve.json`, each asked through the gateway on a
//! served world of its own, after its setup acts. Each is refused with the code the file fixed before it was run, with
//! a detail (the facts), and the detail names no node but the asker's own body, the act's target and its arguments.
use super::*;

/// A node of the fixture by the name the table uses.
fn node(name: &str) -> Id {
    match name {
        "court" => court(),
        "rack" => rack(),
        "vessel" => vessel(),
        "planter" => planter(),
        "ground" => ground(),
        "w1" => w1(),
        "w2" => w2(),
        other => panic!("no node {other} in the fixture"),
    }
}

/// An act's arguments from the table: `{"<n>": {"full": kind} | {"name": text} | {"ids": [node, ...]}}`.
fn arguments(v: Option<&Json>) -> BTreeMap<u64, Value> {
    let mut out = BTreeMap::new();
    for (k, a) in v.and_then(Json::obj).unwrap_or(&[]) {
        let n: u64 = k.parse().expect("an argument's number");
        let value = if let Some(kind) = a.get("full").and_then(Json::str) {
            Value::Text(name(&full(kind, 0xfe)))
        } else if let Some(text) = a.get("name").and_then(Json::str) {
            Value::Text(name(text))
        } else {
            let ids = a.get("ids").and_then(Json::arr).expect("ids");
            Value::Array(
                ids.iter()
                    .map(|i| node(i.str().unwrap()).to_value())
                    .collect(),
            )
        };
        out.insert(n, value);
    }
    out
}

/// The nodes `text` shows by their short form (`replica::world_model::show`: `7c:12`).
fn shown(text: &str) -> BTreeSet<String> {
    let b = text.as_bytes();
    let mut out = BTreeSet::new();
    for i in 0..b.len().saturating_sub(3) {
        let hex = |c: u8| c.is_ascii_digit() || (b'a'..=b'f').contains(&c);
        if (i == 0 || !b[i - 1].is_ascii_alphanumeric())
            && hex(b[i])
            && hex(b[i + 1])
            && b[i + 2] == b':'
            && b[i + 3].is_ascii_digit()
        {
            let end = (i + 3..b.len())
                .find(|j| !b[*j].is_ascii_digit())
                .unwrap_or(b.len());
            out.insert(text[i..end].to_owned());
        }
    }
    out
}

#[test]
fn e16_the_twelve_refusals_each_name_their_code_and_facts_and_nothing_hidden() {
    let table = parse(include_str!("twelve.json")).expect("the table parses");
    let cases = table.get("cases").and_then(Json::arr).expect("cases");
    assert_eq!(cases.len(), 12, "twelve");
    let mut wrong = Vec::new();
    let mut rows = Vec::new();
    for case in cases {
        let n = match case.get("n") {
            Some(Json::Int(n)) => *n,
            _ => panic!("a case's number"),
        };
        let (run, mut a, mut b) = serve(&format!("e16-twelve-{n}"));
        let act = |c: &mut Client, step: &[Json]| {
            let verb = step[1].str().unwrap();
            let target = node(step[2].str().unwrap());
            let r = c.act(verb, Some(target), arguments(step.get(3)));
            (r, c.detail(), target, step.get(3).cloned())
        };
        for step in case.get("setup").and_then(Json::arr).unwrap_or(&[]) {
            let step = step.arr().unwrap();
            let who = if step[0].str() == Some("a") {
                &mut a
            } else {
                &mut b
            };
            let (r, _, _, _) = act(who, step);
            r.unwrap_or_else(|e| panic!("case {n}: setup {:?} refused {e}", step[1]));
        }
        let ask = case.get("ask").and_then(Json::arr).expect("the ask");
        let by_a = ask[0].str() == Some("a");
        let (asked, detail, target, args) = act(if by_a { &mut a } else { &mut b }, ask);
        run.stop();
        let want = case.get("code").and_then(Json::str).unwrap();
        let request = case.get("request").and_then(Json::str).unwrap();
        let detail = detail.unwrap_or_default();
        rows.push(format!("| {n} | {request} | {asked:?} | {detail} |"));
        if asked != Err(want.to_owned()) {
            wrong.push(format!("{n}: {asked:?}, not {want}"));
        }
        if detail.is_empty() {
            wrong.push(format!("{n}: no detail"));
        }
        if let Some(f) = case.get("facts").and_then(Json::str)
            && !detail.contains(f)
        {
            wrong.push(format!("{n}: the detail {detail:?} does not say {f:?}"));
        }
        // A4: the detail names only what the asker named or is.
        let mut may: BTreeSet<String> = [if by_a { w1() } else { w2() }, target]
            .iter()
            .map(|i| replica::world_model::show(*i))
            .collect();
        for (_, a) in args.as_ref().and_then(Json::obj).unwrap_or(&[]) {
            for i in a.get("ids").and_then(Json::arr).unwrap_or(&[]) {
                may.insert(replica::world_model::show(node(i.str().unwrap())));
            }
        }
        let extra: Vec<_> = shown(&detail).difference(&may).cloned().collect();
        if !extra.is_empty() {
            wrong.push(format!("{n}: the detail names {extra:?}"));
        }
    }
    println!("| n | request | answer | detail |\n|---|---|---|---|");
    for r in &rows {
        println!("{r}");
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}
