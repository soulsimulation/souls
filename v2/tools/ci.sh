#!/usr/bin/env bash
# CI's `v2` job (.github/workflows/ci.yml, K15 #2637): checks the v2 Rust workspace on the toolchain
# v2/rust-toolchain.toml pins: format, Clippy with warnings as errors, tests, replica's WASM build, and the load tests
# that call it in Node and in a headless browser (K1, #2638). Later tasks add their steps here, not new jobs.
# Needs node and Chrome or Chromium (or $CHROME) on PATH, as ubuntu-latest has. Runs from any directory.
set -euo pipefail
cd "$(dirname "$0")/.."

step() {
  local name=$1 start=$SECONDS
  shift
  echo "::group::v2: $name"
  "$@"
  echo "::endgroup::"
  echo "v2: $name took $((SECONDS - start)) s"
}

# The pinned toolchain's components and WASM target, when the install left them out (no-ops otherwise).
step toolchain bash -c 'rustup component add rustfmt clippy && rustup target add wasm32-unknown-unknown'

step format cargo fmt --all --check
# Engine code names no kind (K3, #2667): the fixture kinds' names are in no Rust code under the crates' src/. Comment
# lines and lines that embed a fixture file (data) are set aside; tests and fixtures name kinds on purpose.
step no-kind-names bash -c '! grep -rniEw --include="*.rs" "lamps?|seats?|cups?" crates/*/src |
  grep -vE "^[^:]+:[0-9]+:[[:space:]]*//" | grep -v "include_str!"'
step lints cargo clippy --workspace --all-targets --locked -- -D warnings
# replica's WASM-only code (the wasm-bindgen export) is linted on its own target too.
step lints-wasm cargo clippy -p replica --target wasm32-unknown-unknown --locked -- -D warnings
# The architecture's own rules (K14, #2648): a self-test on seeded violations, then the tree (v2/tools/arch/README.md).
step arch node tools/arch/check.mjs
step tests cargo test --workspace --locked

# The WASM build: one artifact (wasm-bindgen --target web) that Node loads with initSync and a page with init().
# The command's version is the wasm-bindgen crate's in Cargo.lock; it is installed under target/, which CI caches.
bindgen_version=$(sed -n '/^name = "wasm-bindgen"$/{n;s/^version = "\(.*\)"$/\1/p;}' Cargo.lock)
step wasm-bindgen-cli cargo install wasm-bindgen-cli --version "$bindgen_version" --locked --root target/tools --quiet
# `vectors` adds the test-only export the encoding-vectors step calls (T0, #2639).
step wasm-build cargo build -p replica --release --target wasm32-unknown-unknown --locked --features vectors
step wasm-bindgen target/tools/bin/wasm-bindgen --target web --out-dir target/wasm-load/pkg \
  target/wasm32-unknown-unknown/release/replica.wasm

# The same exported function, natively, in Node and in a headless browser.
input=2638
native=$(cargo run -p wasm-load --locked --quiet -- "$input")
echo "native: load_probe($input) = $native"
step load-node node tools/wasm-load/node.mjs target/wasm-load/pkg "$input" "$native"
step load-browser node tools/wasm-load/browser.mjs target/wasm-load/pkg "$input" "$native"

# The encoding vectors (T0, #2639) through the same WASM build and the cborg library, in Node. The native build runs
# them in `cargo test` (crates/replica/tests/encoding.rs).
step encoding-vectors bash -c 'npm ci --prefix tools/encoding-vectors --no-audit --no-fund &&
  node tools/encoding-vectors/run.mjs target/wasm-load/pkg crates/replica/fixtures/encoding'

# The ids goldens (T3, #2640): the same WASM build in Node gives fixtures/ids/goldens.txt exactly, as the native build
# does in `cargo test` (crates/replica/tests/ids.rs).
step ids-goldens node --input-type=module -e '
  import { readFileSync } from "node:fs"; import { pathToFileURL } from "node:url";
  const r = await import(pathToFileURL("target/wasm-load/pkg/replica.js").href);
  r.initSync({ module: readFileSync("target/wasm-load/pkg/replica_bg.wasm") });
  const got = r.ids_goldens(), want = readFileSync("crates/replica/fixtures/ids/goldens.txt", "utf8");
  console.log(`${got}ids-goldens: WASM in Node ${process.version}, ${got === want ? "equal to" : "DIFFERENT from"} the file`);
  if (got !== want) process.exit(1);'
# The time goldens (T5, #2643), beat 1,000,000 at 130 a minute among them, the same way (crates/replica/tests/time.rs).
step time-goldens node --input-type=module -e '
  import { readFileSync } from "node:fs"; import { pathToFileURL } from "node:url";
  const r = await import(pathToFileURL("target/wasm-load/pkg/replica.js").href);
  r.initSync({ module: readFileSync("target/wasm-load/pkg/replica_bg.wasm") });
  const got = r.time_goldens(), want = readFileSync("crates/replica/fixtures/time/goldens.txt", "utf8");
  console.log(`${got}time-goldens: WASM in Node ${process.version}, ${got === want ? "equal to" : "DIFFERENT from"} the file`);
  if (got !== want) process.exit(1);'
# The pose goldens (T4, #2644): the three fixtures and 1,000 hand-offs, the same way (crates/replica/tests/pose.rs).
step pose-goldens node --input-type=module -e '
  import { readFileSync } from "node:fs"; import { pathToFileURL } from "node:url";
  const r = await import(pathToFileURL("target/wasm-load/pkg/replica.js").href);
  r.initSync({ module: readFileSync("target/wasm-load/pkg/replica_bg.wasm") });
  const got = r.pose_goldens(), want = readFileSync("crates/replica/fixtures/pose/goldens.txt", "utf8");
  console.log(`${got}pose-goldens: WASM in Node ${process.version}, ${got === want ? "equal to" : "DIFFERENT from"} the file`);
  if (got !== want) process.exit(1);'
# The effects goldens (T6, #2645): the seven generic changes' bytes and state hashes, the same way (tests/effects.rs).
step effects-goldens node --input-type=module -e '
  import { readFileSync } from "node:fs"; import { pathToFileURL } from "node:url";
  const r = await import(pathToFileURL("target/wasm-load/pkg/replica.js").href);
  r.initSync({ module: readFileSync("target/wasm-load/pkg/replica_bg.wasm") });
  const got = r.effects_goldens(), want = readFileSync("crates/replica/fixtures/effects/goldens.txt", "utf8");
  console.log(`${got}effects-goldens: WASM in Node ${process.version}, ${got === want ? "equal to" : "DIFFERENT from"} the file`);
  if (got !== want) process.exit(1);'
# The intents goldens (T10, #2664): every kind of intent's envelope, the same way (crates/replica/tests/intents.rs).
step intents-goldens node --input-type=module -e '
  import { readFileSync } from "node:fs"; import { pathToFileURL } from "node:url";
  const r = await import(pathToFileURL("target/wasm-load/pkg/replica.js").href);
  r.initSync({ module: readFileSync("target/wasm-load/pkg/replica_bg.wasm") });
  const got = r.intents_goldens(), want = readFileSync("crates/replica/fixtures/intents/goldens.txt", "utf8");
  console.log(`${got}intents-goldens: WASM in Node ${process.version}, ${got === want ? "equal to" : "DIFFERENT from"} the file`);
  if (got !== want) process.exit(1);'
# The malformed intents (I2, #2689): the WASM build refuses each by the registry name beside it, as the native build
# does in `cargo test` (crates/replica/tests/intent_decode.rs).
step intent-decode node --input-type=module -e '
  import { readFileSync } from "node:fs"; import { pathToFileURL } from "node:url";
  const r = await import(pathToFileURL("target/wasm-load/pkg/replica.js").href);
  r.initSync({ module: readFileSync("target/wasm-load/pkg/replica_bg.wasm") });
  const rows = r.intent_decode_table().trim().split("\n"), wrong = rows.filter((l) => { const [, a, b] = l.split(" "); return a !== b; });
  console.log(`intent-decode: WASM in Node ${process.version}, ${rows.length} malformed intents, ${wrong.length} refused by another name`, wrong);
  if (wrong.length || rows.length < 60) process.exit(1);'
# The checker a client loads by hash (T10, #2664): replica for wasm32 with no wasm-bindgen exports, so no imports.
step checker-artifact bash -c 'CARGO_TARGET_DIR=target/checker cargo build -p replica --release \
    --target wasm32-unknown-unknown --locked --features checker &&
  CHECKER_WASM="$PWD/target/checker/wasm32-unknown-unknown/release/replica.wasm" \
    cargo test -p replica --test intents --locked the_built_checker_artifact_loads_by_its_hash -- --nocapture'
# The replica (R1, #2684): T6's fixtures, the query cases and 100,000 effects generated from a seed, natively and the
# same WASM build in Node, with the same answer at every step; prints effects a second, the .wasm size and start time.
step replica-equal bash -c 'cargo run -p bench --release --bin replica-equal --locked --quiet -- target/replica-equal &&
  node tools/bench/replica-equal/node.mjs target/wasm-load/pkg target/replica-equal crates/replica/tests/queries.txt'
# The form rules (R2, #2685): every case `cargo test` ran (tests/rules.rs: 10,000 generated, and the case files) through
# the same WASM build in Node, giving the native answers byte for byte.
step rules-equal node --input-type=module -e '
  import { readFileSync } from "node:fs"; import { pathToFileURL } from "node:url";
  const r = await import(pathToFileURL("target/wasm-load/pkg/replica.js").href);
  r.initSync({ module: readFileSync("target/wasm-load/pkg/replica_bg.wasm") });
  const got = r.rules_run(readFileSync("target/tmp/rules/run.json", "utf8")), want = readFileSync("target/tmp/rules/native.txt", "utf8");
  console.log(`rules-equal: ${want.split("\n").length - 1} cases, WASM in Node ${process.version}, ${got === want ? "equal to" : "DIFFERENT from"} native`);
  if (got !== want) process.exit(1);'
# The form rules' drift report (R2, #2685): the live packages/form-rules cases against this library, whose required
# test reads a pinned snapshot. Only the daily full run on main (schedule) or V2_FULL=1, never per change; it prints
# each disagreement and never fails the job.
if [[ "${GITHUB_EVENT_NAME:-}" == schedule || "${V2_FULL:-}" == 1 ]]; then
  step rules-drift bash -c 'cargo test -p replica --locked --test rules -- --ignored --nocapture drift || echo "::warning::rules-drift did not run"'
fi
