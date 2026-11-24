//! `store-probe`: measures this machine's link to the directory's object store. An operator's tool (not the engine):
//! production's worlds meet store stalls of 30 s and more (0.133), and this gives the numbers to tell an occasional
//! stall from a bad link.
//!
//! ```text
//! store-probe [--count <n>] [--big <n>] [--endpoint <url>] [--dry-run]
//! ```
//!
//! Under a fresh prefix `probe/<utc time>/` it writes and reads back `--count` (default 50) objects of 1 KiB, then
//! `--big` (default 5) of 20 MB, each a PUT then a GET of the same key; then deletes every key it wrote and lists the
//! prefix to show nothing is left. It prints, for each kind and operation, the calls' p50, p95 and max, how many took
//! over 5 s and how many failed, then each failure's reason. Every call has 60 s and is never tried again: the point is
//! the raw link. (A create-only PUT whose answer is lost is read back once inside the store client, as in every
//! program that writes to the store, so a failed PUT's time includes that read.)
//!
//! The store is the one `world-aside`, `deploy` and `supervisor` read: the `DIRECTORY_STORE_*` variables' bucket
//! ([`S3::from_vars`]). `--endpoint <scheme://host[:port]>` puts another address in place of the settings' own, with
//! the same bucket, prefix, region and keys. Nothing it prints names the endpoint, the bucket or a key. Exits 0 when the
//! probe ran (its failures are its findings), 1 when objects it wrote are left in the store, 2 on a usage or settings
//! error.
// Operations, not the engine: it measures the wall clock.
#![allow(clippy::disallowed_methods)]

use std::time::{Duration, Instant};

use directoryd::directory::s3::{ENV, S3, URL_ENV};
use directoryd::directory::store::{Store, When};

/// Each call's bound: the whole request, with no retry.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// A call slower than this is counted as slow.
const SLOW: Duration = Duration::from_secs(5);
const SMALL_SIZE: usize = 1024;
const BIG_SIZE: usize = 20_000_000;

/// What one run does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub prefix: String,
    pub count: usize,
    pub big: usize,
    pub small_size: usize,
    pub big_size: usize,
}

/// One operation's calls: each one's time, and each failure as `(call, reason)`.
#[derive(Clone, Debug, Default)]
pub struct Calls {
    pub times: Vec<Duration>,
    pub failures: Vec<(usize, String)>,
}

impl Calls {
    fn add(&mut self, i: usize, t: Duration, failed: Option<String>) {
        self.times.push(t);
        if let Some(why) = failed {
            self.failures.push((i, why));
        }
    }
}

/// A run's findings, by `(kind, operation)` in the order they were made, and the objects left under the prefix.
#[derive(Debug)]
pub struct Report {
    pub ops: Vec<(&'static str, &'static str, Calls)>,
    pub left: Result<usize, String>,
}

impl Report {
    fn calls(&mut self, kind: &'static str, op: &'static str) -> &mut Calls {
        if let Some(i) = self.ops.iter().position(|(k, o, _)| *k == kind && *o == op) {
            return &mut self.ops[i].2;
        }
        self.ops.push((kind, op, Calls::default()));
        let last = self.ops.len() - 1;
        &mut self.ops[last].2
    }
}

/// `n` bytes that do not repeat in any short period (xorshift), different for each `seed`.
fn payload(n: usize, seed: u64) -> Vec<u8> {
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    (0..n)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 32) as u8
        })
        .collect()
}

/// `f` timed; its failure, if any, as a reason.
fn timed(f: impl FnOnce() -> Result<(), String>) -> (Duration, Option<String>) {
    let t = Instant::now();
    let r = f();
    (t.elapsed(), r.err())
}

/// The run: the PUT+GET pairs of each kind, then the deletes, then a listing of what is left. Each call slower than
/// [`SLOW`] or failed is told on stderr as it happens, with the seconds since the start.
pub fn probe(store: &dyn Store, plan: &Plan) -> Report {
    let start = Instant::now();
    let mut report = Report {
        ops: Vec::new(),
        left: Ok(0),
    };
    let mut written = Vec::new();
    let tell = |kind: &str, op: &str, i: usize, t: Duration, why: &Option<String>| {
        if t > SLOW || why.is_some() {
            eprintln!(
                "store-probe: at {:.1} s: {kind} {op} {i}: {:.3} s{}",
                start.elapsed().as_secs_f64(),
                t.as_secs_f64(),
                why.as_ref()
                    .map(|w| format!(", failed: {w}"))
                    .unwrap_or_default()
            );
        }
    };
    for (kind, n, size) in [
        ("small", plan.count, plan.small_size),
        ("big", plan.big, plan.big_size),
    ] {
        for i in 0..n {
            let key = format!("{}{kind}/{i}", plan.prefix);
            let bytes = payload(size, ((i as u64) << 1) | u64::from(kind == "big"));
            written.push(key.clone());
            let (t, why) = timed(|| {
                store
                    .put(&key, &bytes, When::Absent)
                    .map(|_| ())
                    .map_err(|e| format!("{}: {}", e.name, e.detail))
            });
            tell(kind, "put", i, t, &why);
            report.calls(kind, "put").add(i, t, why);
            let (t, why) = timed(|| match store.get(&key) {
                Ok(Some(o)) if o.bytes == bytes => Ok(()),
                Ok(Some(o)) => Err(format!(
                    "{key}: other bytes ({} read, {} written)",
                    o.bytes.len(),
                    bytes.len()
                )),
                Ok(None) => Err(format!("{key}: not there")),
                Err(e) => Err(format!("{}: {}", e.name, e.detail)),
            });
            tell(kind, "get", i, t, &why);
            report.calls(kind, "get").add(i, t, why);
        }
    }
    for (i, key) in written.iter().enumerate() {
        let (t, why) = timed(|| {
            store
                .delete(key)
                .map_err(|e| format!("{}: {}", e.name, e.detail))
        });
        tell("all", "delete", i, t, &why);
        report.calls("all", "delete").add(i, t, why);
    }
    report.left = store
        .list(&plan.prefix)
        .map(|k| k.len())
        .map_err(|e| format!("{}: {}", e.name, e.detail));
    report
}

/// `(p50, p95, max)` of `times` by nearest rank; zeros for none.
pub fn spread(times: &[Duration]) -> (Duration, Duration, Duration) {
    let mut t = times.to_vec();
    t.sort();
    let rank = |p: usize| {
        t.get((t.len() * p).div_ceil(100).max(1) - 1)
            .copied()
            .unwrap_or_default()
    };
    if t.is_empty() {
        return Default::default();
    }
    (rank(50), rank(95), t[t.len() - 1])
}

/// The report as printed.
pub fn render(plan: &Plan, r: &Report) -> String {
    let s = |d: Duration| format!("{:.3}", d.as_secs_f64());
    let mut out = format!(
        "store-probe: under {} ({} small of {} B, {} big of {} B); seconds per call, each bounded at {} s, none tried again\n",
        plan.prefix,
        plan.count,
        plan.small_size,
        plan.big,
        plan.big_size,
        CALL_TIMEOUT.as_secs()
    );
    out += &format!(
        "{:<6} {:<7} {:>5} {:>8} {:>8} {:>8} {:>5} {:>6}\n",
        "kind", "op", "calls", "p50", "p95", "max", ">5s", "failed"
    );
    for (kind, op, c) in &r.ops {
        let (p50, p95, max) = spread(&c.times);
        out += &format!(
            "{kind:<6} {op:<7} {:>5} {:>8} {:>8} {:>8} {:>5} {:>6}\n",
            c.times.len(),
            s(p50),
            s(p95),
            s(max),
            c.times.iter().filter(|t| **t > SLOW).count(),
            c.failures.len()
        );
    }
    let failures: Vec<String> = r
        .ops
        .iter()
        .flat_map(|(kind, op, c)| {
            c.failures
                .iter()
                .map(move |(i, why)| format!("  {kind} {op} {i} ({} s): {why}\n", s(c.times[*i])))
        })
        .collect();
    if failures.is_empty() {
        out += "failures: none\n";
    } else {
        out += &format!("failures: {}\n", failures.len());
        out += &failures.concat();
    }
    out += &match &r.left {
        Ok(0) => "left in the store: nothing under the prefix\n".to_owned(),
        Ok(n) => format!("left in the store: {n} objects under {}\n", plan.prefix),
        Err(e) => format!("left in the store: unknown, the listing failed: {e}\n"),
    };
    out
}

/// The dry run's plan: what a run would do, and where the store's settings come from.
pub fn render_plan(plan: &Plan, settings: &str, endpoint: Option<&str>) -> String {
    format!(
        "store-probe: dry run; nothing is sent\n\
         store-probe: store: {settings}; endpoint: {}\n\
         store-probe: under {}: {} PUT+GET pairs of {} B, then {} of {} B, then {} DELETEs and one listing\n\
         store-probe: each call bounded at {} s, none tried again; slow means over {} s\n",
        if endpoint.is_some() {
            "the one --endpoint gives"
        } else {
            "the settings' own"
        },
        plan.prefix,
        plan.count,
        plan.small_size,
        plan.big,
        plan.big_size,
        plan.count + plan.big,
        CALL_TIMEOUT.as_secs(),
        SLOW.as_secs()
    )
}

/// The store's settings read through `get`, with `endpoint` (if given) in place of the address they name:
/// `DIRECTORY_STORE_URL`'s `scheme://host` part, else `DIRECTORY_STORE_ENDPOINT`.
pub fn settings(
    get: impl Fn(&str) -> Option<String>,
    endpoint: Option<&str>,
) -> impl Fn(&str) -> Option<String> {
    let url = get(URL_ENV).filter(|u| !u.trim().is_empty());
    move |k: &str| match endpoint {
        Some(e) if k == URL_ENV => url.as_deref().map(|u| swap_endpoint(u.trim(), e)),
        Some(e) if k == ENV[0] && url.is_none() => Some(e.to_owned()),
        _ => get(k),
    }
}

/// `s3:<scheme>://<host>/<bucket>[/<prefix>]` with `endpoint` in place of `<scheme>://<host>`; a URL not in that form
/// is kept, for [`S3::from_url`] to refuse.
fn swap_endpoint(url: &str, endpoint: &str) -> String {
    let u = url.strip_prefix("s3:").unwrap_or(url);
    match u.split_once("://") {
        Some((_, rest)) => {
            let path = rest.find('/').map_or("", |i| &rest[i..]);
            format!("s3:{}{path}", endpoint.trim_end_matches('/'))
        }
        None => url.to_owned(),
    }
}

/// Days from 1970-01-01 to a civil date (Howard Hinnant's algorithm), for the prefix.
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn stamp_now() -> String {
    let s = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let (y, m, d) = civil(s.div_euclid(86_400));
    let t = s.rem_euclid(86_400);
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        t / 3600,
        t / 60 % 60,
        t % 60
    )
}

fn usage() -> ! {
    eprintln!("usage: store-probe [--count <n>] [--big <n>] [--endpoint <url>] [--dry-run]");
    std::process::exit(2)
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let mut plan = Plan {
        prefix: format!("probe/{}/", stamp_now()),
        count: 50,
        big: 5,
        small_size: SMALL_SIZE,
        big_size: BIG_SIZE,
    };
    let (mut endpoint, mut dry) = (None, false);
    let mut i = 0;
    while i < a.len() {
        let value = || a.get(i + 1).cloned().unwrap_or_else(|| usage());
        let n = || value().parse::<usize>().unwrap_or_else(|_| usage());
        match a[i].as_str() {
            "--count" => plan.count = n(),
            "--big" => plan.big = n(),
            "--endpoint" => endpoint = Some(value()),
            "--dry-run" => {
                dry = true;
                i += 1;
                continue;
            }
            _ => usage(),
        }
        i += 2;
    }
    let get = |k: &str| std::env::var(k).ok();
    let source = if get(URL_ENV).is_some_and(|u| !u.trim().is_empty()) {
        URL_ENV
    } else if get(ENV[0]).is_some() {
        "DIRECTORY_STORE_ENDPOINT and the other DIRECTORY_STORE_* settings"
    } else {
        "none set"
    };
    let store = S3::from_vars(settings(get, endpoint.as_deref()));
    if dry {
        print!("{}", render_plan(&plan, source, endpoint.as_deref()));
        match &store {
            Some(Ok(_)) => println!("store-probe: the settings read; a run would start now"),
            Some(Err(e)) => println!("store-probe: a run would refuse: {}: {}", e.name, e.detail),
            None => println!(
                "store-probe: a run would refuse: no DIRECTORY_STORE_URL or DIRECTORY_STORE_ENDPOINT"
            ),
        }
        return;
    }
    let store = match store {
        Some(Ok(s)) => s.for_probe(plan.big_size as u64 + (1 << 20), CALL_TIMEOUT),
        Some(Err(e)) => {
            eprintln!("store-probe: {}: {}", e.name, e.detail);
            std::process::exit(2)
        }
        None => {
            eprintln!("store-probe: no store set: DIRECTORY_STORE_URL or DIRECTORY_STORE_ENDPOINT");
            std::process::exit(2)
        }
    };
    let report = probe(&store, &plan);
    print!("{}", render(&plan, &report));
    if report.left != Ok(0) {
        std::process::exit(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use directoryd::directory::stand_in::{KEY_ID, StandIn};

    fn stand_in_store(stand_in: &StandIn, timeout: Duration) -> S3 {
        S3::from_url(&stand_in.url("souls"), |k| match k {
            "AWS_ACCESS_KEY_ID" => KEY_ID.to_owned(),
            _ => String::new(),
        })
        .unwrap()
        .for_probe(4 << 20, timeout)
    }

    fn plan(prefix: &str) -> Plan {
        Plan {
            prefix: prefix.to_owned(),
            count: 8,
            big: 2,
            small_size: SMALL_SIZE,
            big_size: 3 << 20,
        }
    }

    /// Against the S3 stand-in: every pair written and read back, every key deleted, the table and nothing left.
    #[test]
    fn a_probe_over_the_stand_in_measures_every_call_and_leaves_nothing() {
        let stand_in = StandIn::start(100).unwrap();
        let s = stand_in_store(&stand_in, CALL_TIMEOUT);
        s.put("keep/other", b"not the probe's", When::Absent)
            .unwrap();
        let p = plan("probe/t1/");
        let r = probe(&s, &p);
        let out = render(&p, &r);
        println!("{out}");
        let ops: Vec<_> = r
            .ops
            .iter()
            .map(|(k, o, c)| (*k, *o, c.times.len()))
            .collect();
        assert_eq!(
            ops,
            [
                ("small", "put", 8),
                ("small", "get", 8),
                ("big", "put", 2),
                ("big", "get", 2),
                ("all", "delete", 10)
            ]
        );
        assert!(r.ops.iter().all(|(_, _, c)| c.failures.is_empty()));
        assert_eq!(r.left, Ok(0));
        assert_eq!(
            stand_in.paths(),
            ["souls/keep/other"],
            "only what was there before"
        );
        assert!(out.contains("failures: none"));
        assert!(out.contains("left in the store: nothing under the prefix"));
    }

    /// A GET the store holds past the call's bound is a failure with its reason, not tried again.
    #[test]
    fn a_stalled_call_is_a_failure_with_its_reason() {
        let stand_in = StandIn::start(100).unwrap();
        let s = stand_in_store(&stand_in, Duration::from_secs(1));
        stand_in.stall_reads(1, Duration::from_secs(2), "/small/3");
        let p = Plan {
            big: 0,
            ..plan("probe/t2/")
        };
        let r = probe(&s, &p);
        let out = render(&p, &r);
        println!("{out}");
        let get = &r
            .ops
            .iter()
            .find(|(k, o, _)| *k == "small" && *o == "get")
            .unwrap()
            .2;
        assert_eq!(get.failures.len(), 1);
        assert_eq!(get.failures[0].0, 3);
        assert!(
            get.failures[0]
                .1
                .starts_with("store-unreachable: probe/t2/small/3: "),
            "{}",
            get.failures[0].1
        );
        assert!(get.times[3] >= Duration::from_secs(1) && get.times[3] < Duration::from_secs(2));
        assert!(out.contains("failures: 1\n  small get 3 ("), "{out}");
        assert_eq!(r.left, Ok(0));
    }

    #[test]
    fn the_spread_is_by_nearest_rank() {
        let t: Vec<Duration> = (1..=20).map(Duration::from_secs).collect();
        assert_eq!(
            spread(&t),
            (
                Duration::from_secs(10),
                Duration::from_secs(19),
                Duration::from_secs(20)
            )
        );
        assert_eq!(spread(&[Duration::from_secs(7)]).1, Duration::from_secs(7));
        assert_eq!(spread(&[]), Default::default());
    }

    #[test]
    fn the_endpoint_takes_the_settings_place_and_nothing_else() {
        let url = |u: &'static str| move |k: &str| (k == URL_ENV).then(|| u.to_owned());
        let f = settings(
            url("s3:https://a.example/bucket/pre"),
            Some("https://b.example/"),
        );
        assert_eq!(
            f(URL_ENV).as_deref(),
            Some("s3:https://b.example/bucket/pre")
        );
        assert_eq!(f(ENV[0]), None);
        let vars = |k: &str| match k {
            "DIRECTORY_STORE_ENDPOINT" => Some("https://a.example".to_owned()),
            "DIRECTORY_STORE_BUCKET" => Some("bucket".to_owned()),
            _ => None,
        };
        let f = settings(vars, Some("http://127.0.0.1:9"));
        assert_eq!(f(ENV[0]).as_deref(), Some("http://127.0.0.1:9"));
        assert_eq!(f(ENV[1]).as_deref(), Some("bucket"));
        assert_eq!(
            settings(vars, None)(ENV[0]).as_deref(),
            Some("https://a.example")
        );
    }

    #[test]
    fn the_dry_run_names_the_calls() {
        let p = Plan {
            count: 50,
            big: 5,
            big_size: BIG_SIZE,
            ..plan("probe/20261124T000000Z/")
        };
        let out = render_plan(&p, URL_ENV, None);
        println!("{out}");
        assert!(out.contains("50 PUT+GET pairs of 1024 B, then 5 of 20000000 B, then 55 DELETEs"));
        assert!(out.contains("bounded at 60 s"));
    }
}
