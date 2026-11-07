# Cloud replay: 1098-remeasure-1

- Fix branch: `agent/1098-server` @ `d06a6a4ba1b1cf6c50ed5d4547dbe70466a2cb34`
- Playtest: `HEAD` @ `54d9df7eeba325ca659a19acf03964a202148d3e`
- Repeats: 2 · started 2026-11-07T17:01:39Z · finished 2026-11-07T17:29:45Z
- Replay-set exit: 0 · preflight ok: true
- Machine: Linux 5.15.0-139-generic x86_64 · nproc 48 · v22.20.0 · pnpm 10.27.0 · 2.1.319 (Claude Code)
- Memory before: MemTotal: 125.6 GB  MemAvailable: 119.2 GB   · after: MemTotal: 125.6 GB  MemAvailable: 119.2 GB  
- Load before: 0.07 0.10 0.11 · after: 0.88 0.43 0.33
- Browser: Playwright Chromium headless, SwiftShader GL (Linux launch args in lib/platform.mjs); PLAYWRIGHT_BROWSERS_PATH=/home/gene/souls-playtest/browsers
- Asset overlay: 227 files, 98 MB from https://sim.eden.art, missing: none
- Screenshots: PNG → JPEG ≤ 1024 px (q75); `.png` references in text files rewritten to `.jpg`.

## Timings (s)

| step | seconds | exit |
|---|---:|---:|
| fetch-fix | 2 | 0 |
| checkout-fix | 0 | 0 |
| install-playtest | 5 | 0 |
| install-server | 2 | 0 |
| web-build | 3 | 0 |
| overlay | 0 | 0 |
| preflight | 2 | 0 |
| run-specs | 1670 | 0 |
| scrub-paths | 0 | 0 |
| compress | 0 | 0 |
