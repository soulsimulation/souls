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
# The viewer's origin (V2, #2711): its headers on a part, the pointer and a 404 (v2/docs/viewer-cache.md); the site's pages it serves (O23, #3324).
# The test files by name: Node 24 on CI reads a bare folder as one file, not as the tests inside it.
step origin-headers node --test tools/origin/origin.test.mjs tools/origin/site.test.mjs
# The install (O17, #2810): nothing it would write, and no unit, user or port it names, is today's system's.
step install-apart bash tools/ops/install.sh check
# What a world costs (O11, #2721): the scripted hour, the sum check, a stopped world, the not-metered rule, the page.
step cost node --test tools/ops/cost/cost.test.mjs
# The cut-over's count of what a rollback leaves in the new system (X7, #2836).
step cutover-count node --test tools/ops/cutover/count.test.mjs
# The site owner's health page, usage table and history (O21, #3325); A2 runs the supervisor the tests above built.
step ops-health bash -c 'cargo build -p supervisor --locked --quiet && node --test tools/ops/health/health.test.mjs'
# Imported Souls approved again per day (X15, #3322): counts only, no Soul or account id.
step ops-reapproved node --test tools/ops/reapproved.test.mjs
# The watcher (O15, #2808): one message per trouble and recovery, none for a deploy, a stop or a sleep; no look wakes a world.
step ops-watch node --test tools/ops/watch/watch.test.mjs
# The log's sync table on this runner's disk (K4, #2668): one append and one sync per tick, 1,000 ticks, two repeats.
step log-sync cargo run -p log-crash --locked --quiet -- sync target/log-sync 1000 2
# The driver's loads (I10, #2693): the shared shapes imported, the stretch merged, every kind given a verb.
step driver-loads node --test tools/driver/loads.test.mjs

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

# The page's pose (V7, #2716): a body's bones as a function of its record and time, the same at 30 and 144 frames a
# second, in any order and in a fresh process, with the hand on its contact point (web/src/pose/pose.test.ts).
step web-pose bash -c 'npm ci --prefix web --no-audit --no-fund && node --test web/src/pose/*.test.ts web/src/source/signin.test.ts'
# The words path (V1b, #3361): a local world's said sentence, and a body's name and description, through the page's
# worker within the stream's lag; a whisper in no public file (web/src/source/words.test.ts). A still world is drawn
# at once and kept live (V5b, web/src/source/still.test.ts).
step web-words bash -c 'cargo build -p worldd --locked --quiet && node --test web/src/source/words.test.ts web/src/source/still.test.ts'

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
# The client's library by build hash (R5, #2699): cached or downloaded, refused by name, run in a worker with a limit.
step client-sync node --test client/src/sync/*.test.mjs
# The resident daemon (R6, #2700): ten forced drops against the real gateway and the world's end of it (I4); R5b's resync after a long cut.
step client-daemon bash -c 'cargo build -p gatewayd -p worldd -p directoryd --locked --quiet && node --test client/src/daemon/*.test.mjs'
# The thin command, the brief and find (R7, #2701): 100 scripted command sequences against the same gateway and world.
step client-command bash -c 'cargo build -p directoryd -p gatewayd -p worldd --locked --quiet &&
  node --test client/src/brief/*.test.mjs client/src/find/*.test.mjs client/src/cli/*.test.mjs client/src/shoot/*.test.mjs'
# The creator's command (G7, #2796): a creator's daemon checks batches on its copy with no frame sent, and edits.
step client-creator bash -c 'cargo build -p gatewayd -p worldd --locked --quiet && node --test client/src/creator/*.test.mjs'
# The client's trace and stats (R10, #2702): per achieved intent, local only, with the network refused.
step client-stats node --test client/src/stats/*.test.mjs
# The local check (R8, #2703): R2's rules on the copy, at `can` and again at send time (the daemon's side is above).
step client-check node --test client/src/check/*.test.mjs
# A Soul's memory (R14, #2754): a 30-day home opened unchanged, an hour of named events, digest, consolidate, aliases.
step client-memory node --test client/src/memory/*.test.mjs
# Asking what happened (R16, #2817): a recorded Eden of 100 acting Souls in V4's files, by place, thing and Soul.
step client-history node --test client/src/history/*.test.mjs
# A home on today's client comes across (R18, #2821): the released 2.36.2 client against the new answers, from v2/ alone.
step client-upgrade node --test client/test/compat/*.test.mjs client/src/upgrade/*.test.mjs
# Pairing a Soul to an agent (W2, #2705): from an empty folder to an accepted act, and the token found nowhere else;
# then a paired Soul joins a served world, acts and leaves, through the gateway (C3, #3367).
# Pairing to a served world writes the history it advertises, which `history --at` reads (R16b, #3480).
step client-pair bash -c 'cargo build -p directoryd -p gatewayd -p worldd -p testworld --locked --quiet &&
  node --test client/src/pair/*.test.mjs'
# The served client (R17, #2818): the served files against the release's manifest; the one line, upgrade, rollback.
step client-served bash -c 'cargo build -p directoryd -p gatewayd -p worldd --locked --quiet && node --test client/served/*.test.mjs'
# The reflex table (R9, #2728): the matcher, expiry, cool-down, count, standing consent, and 1,000 events at p99.
step client-reflex node --test client/src/reflex/*.test.mjs
# Wake rules and the owner's messages (R13, #2753): the budget, merging with no reader, the mailbox through the gateway.
step client-wake bash -c 'cargo build -p gatewayd -p worldd -p directoryd --locked --quiet && node --test client/src/wake/*.test.mjs'
# The owner's box (W10, #2802): the page's message reaches the waiting agent, the act's phases and the close come back
# to the owner's view socket alone, and the words are in no log, stream part or world file.
step web-owner-box node --test web/src/owner/box.e2e.ts
# The Soul's own schedule (R15, #2757): sent on time with no model turn, once across a kill, missed while off told.
step client-schedule bash -c 'cargo build -p gatewayd -p worldd --locked --quiet && node --test client/src/schedule/*.test.mjs'
# The MCP endpoint on v2 (R21, #3334): six tools, each answer the thin command's; 401, 405, 413; the card and page.
step client-mcp bash -c 'cargo build -p gatewayd -p worldd --locked --quiet && node --test client/src/mcp/*.test.mjs'
# A creator's terrain (G5, #2762): a landform's patches by today's packages/ground (zod is its one dependency; this job
# runs no pnpm install), and its expansion into one edit.
step creator-terrain bash -c 'npm install --no-save --no-package-lock --no-audit --no-fund --prefix ../packages/ground zod@4.6.7 &&
  node --test tools/terrain/*.test.ts client/src/creator/terrain/*.test.mjs'
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
# The fact sheet (V10, #2720): a 20 s recording's live and history sheets and one factsAt record, the same bytes
# from the same WASM build in Node as natively (tools/facts/wasm.mjs).
step facts-wasm bash -c 'cargo run -p facts --release --locked --quiet -- vectors target/facts-vectors &&
  node tools/facts/wasm.mjs target/wasm-load/pkg target/facts-vectors'
# R16's history against the sheet (R16b, #3480): a 120 s recording's event index, asked by place, thing and Soul.
step facts-history bash -c 'cargo run -p facts --release --locked --quiet -- record target/facts-history 120 &&
  cargo run -p facts --release --locked --quiet -- sheet target/facts-history history 0 120 target/facts-history/sheet &&
  node tools/facts/history.mjs target/facts-history target/facts-history/sheet 120'
# The code hatch (F8, #2823): the world's 1,000 chess-move cases (crates/sim/tests/hatch.rs, in the tests step) through
# the same WASM build in Node, the daemon's runtime, and in a headless browser, each giving the world's table exactly.
step hatch-three-hosts bash -c 'node --test client/src/hatch/*.test.mjs && node web/src/hatch/hatch.browser.mjs'
# The form rules' drift report (R2, #2685): the live packages/form-rules cases against this library, whose required
# test reads a pinned snapshot. Only the daily full run on main (schedule) or V2_FULL=1, never per change; it prints
# each disagreement and never fails the job.
if [[ "${GITHUB_EVENT_NAME:-}" == schedule || "${V2_FULL:-}" == 1 ]]; then
  step rules-drift bash -c 'cargo test -p replica --locked --test rules -- --ignored --nocapture drift || echo "::warning::rules-drift did not run"'
  # The speed bars: the wall-clock bounds the tests above print but do not assert (a loaded runner misses them with
  # no fault in the code), asserted here with V2_SPEED_BARS=1, Rust in release. Printed; a miss warns, never fails.
  step speed-bars bash -c 'export V2_SPEED_BARS=1 R6_REPORT=1 R7_REPORT=1 R9_REPORT=1 &&
    cargo test --release --locked -p sim -p assets -p worldd -p gatewayd -- --include-ignored --nocapture \
      speed_bar a3_a4_a5_twenty_panics n19_a1_a2 a1_to_a5_ground_rebuilt a3_child_bounds a1_the_real_clock \
      c8_an_intent_with_no_answer &&
    node --test client/src/reflex/*.test.mjs client/src/cli/*.test.mjs client/src/daemon/daemon.test.mjs ||
    echo "::warning::a speed bar was missed (see above)"'
fi
