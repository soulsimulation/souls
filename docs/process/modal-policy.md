# Remote gate (Modal) policy

The [remote gate](../testing/remote-gate.md) qualifies the complete suite: the steps CI ran identically on the exact
commit come from that CI run, and the rest run on Modal. It is the release check, and it is
the most expensive thing the project runs routinely, so it is used sparingly and on purpose.

1. **No baseline re-runs.** A gate compares a candidate with a baseline. The baseline is the cached suite result of the
   commit that is `main` (keyed by source, the executed harness and Node versions). If the cache lacks it, run it once
   and cache it. A driver-only or `renames.json`-only change keeps the cached baseline.
2. **One full gate per release head.** Iterate with local, focused checks (`node --test`, `tsc`, walk, bundle). The full
   gate runs on the final head about to ship, once its push-to-main CI run is green: it then takes V1, V2-build-root,
   V3-client-cli, V3-launcher-unit, V4-web and V5 from that run and runs only V2-build-worlds, V3-harness, V3-walk,
   V3-bundle, V3-packages, V3-mars-engine and the V6 scenarios on Modal (about 30 minutes instead of 75 to 90). A
   passing full gate seeds the cache for the next release.
3. **Scoped gates for candidates.** When a candidate needs remote proof before release, use `--scope auto`, which runs
   only the steps its diff touches. A scoped receipt never makes a release receipt.
4. **Never gate what the suite doesn't cover.** Docs-only, tools-only and playtest-only changes are not gated. Perf,
   memory, timing and A/B experiments never run through the gate.
5. **Right-sized fan-out.** The harness uses a small, fixed number of containers per run with a prebuilt dependency
   layer. Don't raise it for one run.
6. **Respect the shared cap.** Only a few gates may be in flight at once across all work. The release workflow's
   concurrency group enforces one release at a time.
7. **Fix flaky tests.** A flaky test costs a gate each time it fires. Fix or quarantine it with a reason; never re-run
   until green.
