//! The check in a child process (G6, #2747), so one bad file can only end its own process. The child is the
//! `assets-check` program of this crate: it reads the file on its standard input, takes the limits on its command
//! line, and writes one line of JSON (the result and its peak memory) and then the stripped bytes.
//!
//! - **Memory:** the child counts every allocation and refuses any past its bound, which ends it (portable and exact).
//!   On Linux the parent also sets the child's address-space limit, a second wall.
//! - **Time:** the parent waits at most its bound, then kills the child. On Linux the child's CPU limit is set too.
//!
//! Either way the file is refused, `upload.check-limit`; nothing a file does reaches the parent.

use crate::check::{Checked, Format, Limits, Refused};
use replica::ids::{Hash, Purpose};
use replica::rules::json::{self, Value as Json};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// The child's memory bound by default: the largest allowed file needs a small part of it.
pub const MEMORY: u64 = 128 << 20;
/// The child's time bound by default.
pub const TIME: Duration = Duration::from_secs(5);

/// Every code the check gives, so the child's text maps back to one.
pub const CODES: [&str; 14] = [
    "upload.empty",
    "upload.size",
    "upload.format",
    "upload.invalid",
    "upload.image-invalid",
    "upload.image-format",
    "upload.image-size",
    "upload.external-resource",
    "upload.triangle-budget",
    "upload.texture-side",
    "upload.texture-count",
    "upload.texture-pixels",
    "upload.too-complex",
    "upload.compressed-mesh",
];

/// How to run the check: the `assets-check` program, the file's limits and the process's bounds.
#[derive(Clone, Debug)]
pub struct Checker {
    pub program: PathBuf,
    pub limits: Limits,
    pub memory: u64,
    pub time: Duration,
}

/// One run: the result, and the child's peak memory in bytes when it reported one.
#[derive(Clone, Debug)]
pub struct Ran {
    pub result: Result<Checked, Refused>,
    pub peak: Option<u64>,
}

fn limit_hit(detail: String) -> Ran {
    Ran {
        result: Err(Refused {
            code: "upload.check-limit",
            measured: None,
            limit: None,
            detail,
        }),
        peak: None,
    }
}

impl Checker {
    pub fn new(program: impl Into<PathBuf>) -> Checker {
        Checker {
            program: program.into(),
            limits: Limits::default(),
            memory: MEMORY,
            time: TIME,
        }
    }

    /// Checks `file` in a child process (see the module's notes).
    pub fn check(&self, file: &[u8]) -> Ran {
        if file.is_empty() || file.len() as u64 > self.limits.bytes {
            // Refused on its length alone, before any byte is read; no child is needed.
            return Ran {
                result: crate::check::check(file, &self.limits),
                peak: None,
            };
        }
        let mut cmd = Command::new(&self.program);
        cmd.args(self.limits.to_args())
            .arg(self.memory.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::process::CommandExt;
            let (memory, secs) = (self.memory, self.time.as_secs().max(1));
            // SAFETY: setrlimit is async-signal-safe and touches only the child between fork and exec.
            unsafe {
                cmd.pre_exec(move || {
                    let set = |what, n: u64| {
                        let r = libc::rlimit {
                            rlim_cur: n as libc::rlim_t,
                            rlim_max: n as libc::rlim_t,
                        };
                        libc::setrlimit(what, &r)
                    };
                    // Address space: the counted bound plus room for the program's own mapping.
                    set(libc::RLIMIT_AS, memory * 2 + (64 << 20));
                    set(libc::RLIMIT_CPU, secs);
                    Ok(())
                });
            }
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return limit_hit(format!("the check did not start: {e}")),
        };
        let mut stdin = child.stdin.take().expect("piped");
        let mut stdout = child.stdout.take().expect("piped");
        let input = file.to_vec();
        std::thread::spawn(move || {
            // A child that ends early closes its end; that is its answer, not an error here.
            let _ = stdin.write_all(&input);
        });
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut out = Vec::new();
            let _ = stdout.read_to_end(&mut out);
            let _ = tx.send(out);
        });
        // The child closes its output when it ends, or when it is killed below.
        let out = match rx.recv_timeout(self.time) {
            Ok(out) => out,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return limit_hit(format!("the check ran past {} ms", self.time.as_millis()));
            }
        };
        let status = child.wait();
        if !status.as_ref().is_ok_and(|s| s.success()) {
            return limit_hit(format!(
                "the check ended without an answer ({status:?}): over {} bytes of memory or broken",
                self.memory
            ));
        }
        read_answer(&out).unwrap_or_else(|| limit_hit("the check's answer did not read".into()))
    }
}

/// The child's answer: a line of JSON, then the stripped bytes.
pub fn write_answer(
    out: &mut impl Write,
    result: &Result<Checked, Refused>,
    peak: u64,
) -> std::io::Result<()> {
    let n = |x: u64| Json::Int(x as i128);
    let opt = |x: Option<u64>| x.map_or(Json::Null, n);
    let line = match result {
        Ok(c) => Json::Obj(vec![
            ("ok".into(), Json::Bool(true)),
            ("format".into(), Json::s(c.format.name())),
            ("triangles".into(), n(c.triangles)),
            ("textures".into(), n(c.textures)),
            ("side".into(), n(c.side)),
            ("pixels".into(), n(c.pixels)),
            ("stripped".into(), n(c.stripped)),
            (
                "text".into(),
                Json::Arr(c.text.iter().map(|t| Json::s(t)).collect()),
            ),
            ("peak".into(), n(peak)),
        ]),
        Err(r) => Json::Obj(vec![
            ("ok".into(), Json::Bool(false)),
            ("code".into(), Json::s(r.code)),
            ("measured".into(), opt(r.measured)),
            ("limit".into(), opt(r.limit)),
            ("detail".into(), Json::s(&r.detail)),
            ("peak".into(), n(peak)),
        ]),
    };
    out.write_all(line.to_json().as_bytes())?;
    out.write_all(b"\n")?;
    if let Ok(c) = result {
        out.write_all(&c.bytes)?;
    }
    out.flush()
}

fn read_answer(out: &[u8]) -> Option<Ran> {
    let nl = out.iter().position(|&b| b == b'\n')?;
    let line = json::parse(std::str::from_utf8(&out[..nl]).ok()?).ok()?;
    let num = |k: &str| match line.get(k) {
        Some(Json::Int(x)) => u64::try_from(*x).ok(),
        _ => None,
    };
    let peak = num("peak");
    let result = if line.get("ok")?.truthy() {
        let bytes = out[nl + 1..].to_vec();
        Ok(Checked {
            format: Format::from_name(line.get("format")?.str()?)?,
            hash: Hash::of(Purpose::Upload, &bytes),
            bytes,
            triangles: num("triangles")?,
            textures: num("textures")?,
            side: num("side")?,
            pixels: num("pixels")?,
            stripped: num("stripped")?,
            text: line
                .get("text")?
                .arr()?
                .iter()
                .filter_map(|t| t.str().map(str::to_owned))
                .collect(),
        })
    } else {
        let code = line.get("code")?.str()?;
        Err(Refused {
            code: CODES.iter().find(|c| **c == code)?,
            measured: num("measured"),
            limit: num("limit"),
            detail: line.get("detail")?.str()?.to_owned(),
        })
    };
    Some(Ran { result, peak })
}
