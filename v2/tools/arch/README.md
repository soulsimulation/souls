# arch

Engine v2 K14 (#2648): the architecture's rules, checked by the build, so a change that breaks one fails by name
before review. Each failure prints the rule, its trunk contract and the fix.

`node v2/tools/arch/check.mjs` is the `arch` step of `v2/tools/ci.sh`. It first runs a self-test: every seeded
violation in `seeded/` must fail by its rule's name, or the check itself is broken. Then it checks the tree. It takes
about 0.1 s, and the `cargo metadata` call it makes runs offline.

## The rules

| rule | contract | how it is checked | seeded violation |
|---|---|---|---|
| `write-outside-own`: a system writes only its own node | TRUNK T1, `v2/docs/zones.md` rules 2 and 3 | T1's types and its runner. A system is handed `Own`, which writes only its node. A `Write` is data (it may come from a creator's module or a log), and the runner refuses one to another node by this name. `crates/replica/tests/zones.rs` (`a2_each_planted_bad_system_fails_by_name`) plants `Meddle` and runs in the `tests` step. | `Meddle` in that test |
| `read-same-tick`: a system reads other nodes only as of the previous tick | TRUNK T1, `zones.md` rules 2 and 3 | T1's types: `Prev` holds the previous tick and nothing else, so no method returns this tick's state of another node. A read around the types, through shared state, is caught by the runner's two-order run, by this name, in the same test. | `Peek` in that test, reading `Pour`'s cache |
| `t1-check-wired` | TRUNK T1 | `check.mjs` fails if that test, or either name it asserts, is gone. | `seeded/` (a test file without it) |
| `float-in-replica`: no float in a verdict | TRUNK T0 and T5 | `#![deny(clippy::float_arithmetic)]` across `replica` (the `lints` step), and a scan of every file under `crates/replica/src` that is not on `floats.allow` for `f32`, `f64` and float literals, with comments and strings left out. A module added later, such as E2's selectors or R2's form rules, is covered the day it lands. | `seeded/selector.rs`, `seeded/form_rule.rs` |
| `crate-dependency`: each crate under `v2/crates` depends only on its list | TRUNK T0 for `replica`; K14 for every crate | `cargo metadata --no-deps` against `ALLOWED` in `check.mjs`: normal, dev and build dependencies alike. A new crate without a list fails. | `seeded/metadata.json` (`replica` gains `serde`) |
| `v2-imports-today`: nothing under `v2/crates` uses today's packages | tranche #2635 | A scan of every `.rs` and `.toml` file under `v2/crates` for a relative path into `packages/`, `apps/`, `mars/` or `worlds/`, or an `@souls/` name. | `seeded/imports_today.rs` |
| `import from v2/`: nothing outside `v2/` imports from it | tranche #2635 | One rule of `.github/scripts/guards.mjs scrub`, which runs on every change (the `v2` job does not run when only files outside `v2/` change). An added line in a file outside `v2/` that imports, requires or re-exports a path under `v2/`, or a `v2/` path in `pnpm-workspace.yaml`, fails. | `seeded/outside_v2.ts`, checked as if at `apps/web/src/seeded.ts` |

The self-test calls `guards.mjs`'s own `scrubLine`, so the last row is tested with the other rows.

## What the checks do not prove

- **No static check proves that a system never writes across nodes.** T1's types give a system no method for it, and
  T1's runner refuses a `Write` to another node at run time. That holds only for code a test runs. K2's `apply`
  does not yet assert that the writer owns the target (K14's design asks for it; it is outside this task's Touches).
- **The same-tick read is caught by sampling.** The runner runs each tick in two orders, and a read that both orders
  happen to see alike passes. The wall against shared state is T9's crate boundary (a creator's module cannot share
  memory with another).
- **The float scan reads text.** A float that reaches `replica` through a macro or another crate's type is not seen.
  Clippy's `float_arithmetic` flags arithmetic, not a field or a conversion, which is why the scan exists.
- **The import scans read text.** A path built at run time, or a symbolic link, is not seen. The `guards.mjs` rule
  reads added lines only, so it catches a new import and not an old one; none exists today.
- **The dependency lists are names.** A listed crate that changes what it pulls in passes. `Cargo.lock` and `--locked`
  pin versions.
