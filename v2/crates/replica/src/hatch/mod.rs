//! The code hatch, run (Engine v2 F8, #2823; `v2/docs/bodies.md` rules 10 and 11). A hatch is one pure function, a
//! WASM module named by the hash of its bytes, run in the one interpreter compiled into this library (`wasmi`), so the
//! world, the daemon and a page give the same answer at the same counted cost. It is not a scripting language: a form's
//! author writes data, and the module is compiled code checked here at load.
//!
//! - **Load** ([`Loaded::load`]) refuses by name: `hatch-module-hash-differs` (the bytes are not the named module),
//!   `hatch-module-invalid`, `hatch-module-float` (any `f32` or `f64` instruction or type: WASM's one difference
//!   between machines is a not-a-number's bits), `hatch-module-imports` (any import: it is pure), `hatch-module-memory`
//!   (more than [`MEMORY_MOST`]) and `hatch-module-shape` (not the calling convention below, or a start function).
//! - **The calling convention.** The module exports `memory`, an `i32` global `input` (where the host writes) and
//!   `run: (i32) -> i64`. The host writes the declared reads at `input`, each as a count of little-endian i64 words
//!   and then the words, and calls `run` with the number of bytes written. It answers 1 or 0 (a verdict), or a
//!   field's new value. A hatch that answers several fields also exports an `i32` global `output`: when it answers 1
//!   it has written there, for each answered field in order, a count of little-endian i64 words and then the words
//!   ([`Loaded::run_writing`]); a count past [`OUTPUT_WORDS_MOST`] or past its memory is `hatch-output-malformed`.
//! - **Steps** are the interpreter's own fuel, counted in a fresh instance given the declared budget: the same count
//!   on every host, since the interpreter is the same code. Running out ends the call `hatch-over-budget`; any other
//!   trap is `hatch-trapped`, with its code. A fault in a hatch is contained in its call and named: it never panics
//!   and never stops the caller.
//!
//! Not here: a host function (none exists), a store of creators' modules.

use crate::effects::Refusal;
use crate::ids::{SHA2_256, sha256};
use wasmi::core::{TrapCode, ValueType};
use wasmi::{Config, Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder};

#[cfg(all(target_arch = "wasm32", feature = "vectors"))]
use wasm_bindgen::prelude::wasm_bindgen;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// The most linear memory a hatch may have or grow to, in bytes: 16 pages.
pub const MEMORY_MOST: u64 = 16 * 65_536;

/// The most words a hatch may write for one answered field: a list of 100 records of eight fields, and room.
pub const OUTPUT_WORDS_MOST: u64 = 1024;

/// A hatch's module, checked and compiled, ready to run.
pub struct Loaded {
    engine: Engine,
    module: Module,
}

/// One run: the answer and the steps it took.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ran {
    pub answer: i64,
    pub steps: u64,
}

fn engine(floats: bool) -> Engine {
    let mut c = Config::default();
    c.consume_fuel(true).floats(floats);
    Engine::new(&c)
}

fn store(engine: &Engine) -> Store<StoreLimits> {
    let limits = StoreLimitsBuilder::new()
        .memory_size(MEMORY_MOST as usize)
        .instances(1)
        .build();
    let mut store = Store::new(engine, limits);
    store.limiter(|l| l);
    store
}

impl Loaded {
    /// Checks and compiles `bytes`, named by `named`, a SHA-256 multihash (T3 rule 9).
    pub fn load(bytes: &[u8], named: &[u8]) -> R<Loaded> {
        let digest = sha256(bytes);
        if named.len() != 34 || named[0] != SHA2_256 || named[1] != 32 || named[2..] != digest {
            return refuse(
                "hatch-module-hash-differs",
                "the bytes are not the named module",
            );
        }
        if let Err(e) = Module::new(&engine(true), bytes) {
            return refuse("hatch-module-invalid", e.to_string());
        }
        let engine = engine(false);
        let module = match Module::new(&engine, bytes) {
            Ok(m) => m,
            Err(e) => return refuse("hatch-module-float", e.to_string()),
        };
        if let Some(i) = module.imports().next() {
            return refuse(
                "hatch-module-imports",
                format!("{}.{}: a hatch imports nothing", i.module(), i.name()),
            );
        }
        let (mut memory, mut input, mut run) = (false, false, false);
        for e in module.exports() {
            match e.name() {
                "memory" => {
                    let Some(m) = e.ty().memory() else {
                        return refuse("hatch-module-shape", "memory is not a memory");
                    };
                    let pages = u64::from(u32::from(m.initial_pages()));
                    if pages * 65_536 > MEMORY_MOST {
                        return refuse(
                            "hatch-module-memory",
                            format!("{pages} pages; at most {}", MEMORY_MOST / 65_536),
                        );
                    }
                    memory = true;
                }
                "input" => {
                    input = e
                        .ty()
                        .global()
                        .is_some_and(|g| g.content() == ValueType::I32);
                }
                "run" => {
                    run = e.ty().func().is_some_and(|f| {
                        f.params() == [ValueType::I32] && f.results() == [ValueType::I64]
                    });
                }
                _ => {}
            }
        }
        if !(memory && input && run) {
            return refuse(
                "hatch-module-shape",
                "exports memory, an i32 global input and run: (i32) -> i64",
            );
        }
        // A start function would run code in every instance: a hatch has none.
        let mut s = store(&engine);
        let started = Linker::new(&engine)
            .instantiate(&mut s, &module)
            .and_then(|pre| pre.ensure_no_start(&mut s).map_err(wasmi::Error::from));
        if let Err(e) = started {
            return refuse("hatch-module-shape", format!("no start function: {e}"));
        }
        Ok(Loaded { engine, module })
    }

    /// Runs the module once on `reads` (each read's words), in a fresh instance, with `steps_most` steps.
    pub fn run(&self, reads: &[Vec<i64>], steps_most: u64) -> R<Ran> {
        self.run_writing(reads, steps_most, 0).map(|(ran, _)| ran)
    }

    /// [`Loaded::run`] for a hatch that answers `fields` fields: when it answers 1, the words it wrote at its
    /// `output` global for each, in order. A module without `output` is `hatch-module-shape`; a count out of range
    /// or past its memory `hatch-output-malformed`. With no fields, or any other answer, no words.
    pub fn run_writing(
        &self,
        reads: &[Vec<i64>],
        steps_most: u64,
        fields: usize,
    ) -> R<(Ran, Vec<Vec<i64>>)> {
        let mut store = store(&self.engine);
        if store.add_fuel(steps_most).is_err() {
            unreachable!("fuel is on");
        }
        let ran = |store: &Store<StoreLimits>| store.fuel_consumed().unwrap_or(steps_most);
        let trap = |e: wasmi::Error, store: &Store<StoreLimits>| -> R<(Ran, Vec<Vec<i64>>)> {
            match &e {
                wasmi::Error::Trap(t) => match t.trap_code() {
                    Some(TrapCode::OutOfFuel) => {
                        refuse("hatch-over-budget", format!("more than {steps_most} steps"))
                    }
                    Some(code) => refuse(
                        "hatch-trapped",
                        format!("{code} after {} steps", ran(store)),
                    ),
                    None => refuse("hatch-trapped", e.to_string()),
                },
                _ => refuse("hatch-trapped", e.to_string()),
            }
        };
        let instance = match Linker::new(&self.engine)
            .instantiate(&mut store, &self.module)
            .and_then(|pre| pre.ensure_no_start(&mut store).map_err(wasmi::Error::from))
        {
            Ok(i) => i,
            Err(e) => return trap(e, &store),
        };
        let at = instance
            .get_global(&store, "input")
            .and_then(|g| g.get(&store).i32())
            .and_then(|a| usize::try_from(a).ok());
        let memory = instance.get_memory(&store, "memory");
        let run = instance.get_typed_func::<i32, i64>(&store, "run").ok();
        let (Some(at), Some(memory), Some(run)) = (at, memory, run) else {
            return refuse("hatch-module-shape", "exports memory, input and run");
        };
        let mut bytes = Vec::new();
        for r in reads {
            bytes.extend_from_slice(&(r.len() as i64).to_le_bytes());
            for w in r {
                bytes.extend_from_slice(&w.to_le_bytes());
            }
        }
        let Ok(len) = i32::try_from(bytes.len()) else {
            return refuse("hatch-input-too-long", format!("{} bytes", bytes.len()));
        };
        if memory.write(&mut store, at, &bytes).is_err() {
            return refuse(
                "hatch-input-too-long",
                format!("{} bytes at {at} do not fit its memory", bytes.len()),
            );
        }
        let answer = match run.call(&mut store, len) {
            Ok(answer) => answer,
            Err(e) => return trap(wasmi::Error::Trap(e), &store),
        };
        let done = Ran {
            answer,
            steps: ran(&store),
        };
        if fields == 0 || answer != 1 {
            return Ok((done, Vec::new()));
        }
        let Some(mut at) = instance
            .get_global(&store, "output")
            .and_then(|g| g.get(&store).i32())
            .and_then(|a| usize::try_from(a).ok())
        else {
            return refuse(
                "hatch-module-shape",
                "a hatch that answers fields exports an i32 global output",
            );
        };
        let mut out = Vec::with_capacity(fields);
        for i in 0..fields {
            let mut word = [0u8; 8];
            let count = memory
                .read(&store, at, &mut word)
                .ok()
                .map(|()| i64::from_le_bytes(word))
                .and_then(|n| u64::try_from(n).ok())
                .filter(|n| *n <= OUTPUT_WORDS_MOST);
            let Some(count) = count else {
                return refuse(
                    "hatch-output-malformed",
                    format!("field {i}: a count of 0 to {OUTPUT_WORDS_MOST} words in its memory"),
                );
            };
            let mut bytes = vec![0u8; count as usize * 8];
            if memory.read(&store, at + 8, &mut bytes).is_err() {
                return refuse(
                    "hatch-output-malformed",
                    format!("field {i}: {count} words past its memory"),
                );
            }
            out.push(
                bytes
                    .chunks_exact(8)
                    .map(|c| i64::from_le_bytes(c.try_into().unwrap_or([0; 8])))
                    .collect(),
            );
            at += 8 + bytes.len();
        }
        Ok((done, out))
    }
}

/// Runs a document of cases through a module, one line each, for the three hosts' table (F8 A1, A2): `{"module":
/// "<hex bytes>", "named": "<hex multihash>", "budgets": [steps, ...], "cases": [[[word, ...], ...], ...]}` gives,
/// for each budget and case, `<budget> <case> <answer> <steps>` or `<budget> <case> refused <name>`.
pub fn run_cases(doc: &str) -> String {
    use crate::rules::json::{self, Value};
    let doc = match json::parse(doc) {
        Ok(d) => d,
        Err(e) => return format!("malformed {e}\n"),
    };
    let hex = |k: &str| {
        let t = doc.get(k).and_then(Value::str).unwrap_or("");
        (0..t.len() / 2)
            .map(|i| u8::from_str_radix(t.get(2 * i..2 * i + 2).unwrap_or("zz"), 16).unwrap_or(0))
            .collect::<Vec<u8>>()
    };
    let int = |v: &Value| match v {
        Value::Int(n) => i64::try_from(*n).unwrap_or(0),
        _ => 0,
    };
    let list = |v: Option<&Value>| v.and_then(Value::arr).unwrap_or(&[]).to_vec();
    let loaded = match Loaded::load(&hex("module"), &hex("named")) {
        Ok(l) => l,
        Err(r) => return format!("load refused {}\n", r.name),
    };
    let cases: Vec<Vec<Vec<i64>>> = list(doc.get("cases"))
        .iter()
        .map(|c| {
            list(Some(c))
                .iter()
                .map(|r| list(Some(r)).iter().map(int).collect())
                .collect()
        })
        .collect();
    let mut out = String::new();
    for budget in list(doc.get("budgets")) {
        let budget = u64::try_from(int(&budget)).unwrap_or(0);
        for (i, c) in cases.iter().enumerate() {
            out.push_str(&match loaded.run(c, budget) {
                Ok(r) => format!("{budget} {i} {} {}\n", r.answer, r.steps),
                Err(r) => format!("{budget} {i} refused {}\n", r.name),
            });
        }
    }
    out
}

/// [`run_cases`] from the WASM build, for the daemon's and the page's tests (`vectors` builds only).
#[cfg(all(target_arch = "wasm32", feature = "vectors"))]
#[wasm_bindgen]
pub fn hatch_run_cases(doc: &str) -> String {
    run_cases(doc)
}
