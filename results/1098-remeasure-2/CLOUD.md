# Cloud replay: 1098-remeasure-2

- Fix branch: `agent/1098-server-2` @ `b9d52423e94701ffc1276e464ebd95c6af06649e`
- Playtest: `HEAD` @ `b9d52423e94701ffc1276e464ebd95c6af06649e`
- Repeats: 2 · started 2026-11-08T00:19:04Z · finished 2026-11-08T00:45:36Z
- Replay-set exit: 0 · preflight ok: true
- Machine: Linux 5.15.0-139-generic x86_64 · nproc 48 · v22.20.0 · pnpm 10.27.0 · 2.1.319 (Claude Code)
- Memory before: MemTotal: 125.6 GB  MemAvailable: 119.1 GB   · after: MemTotal: 125.6 GB  MemAvailable: 119.1 GB  
- Load before: 0.08 0.08 0.09 · after: 0.63 0.55 0.44
- Browser: Playwright Chromium headless, SwiftShader GL (Linux launch args in lib/platform.mjs); PLAYWRIGHT_BROWSERS_PATH=<home>/souls-playtest/browsers
- Asset overlay: 227 files, 98 MB from https://sim.eden.art, missing: none
- Screenshots: PNG → JPEG ≤ 1024 px (q75); `.png` references in text files rewritten to `.jpg`.

## Timings (s)

| step | seconds | exit |
|---|---:|---:|
| fetch-fix | 0 | 0 |
| checkout-fix | 0 | 0 |
| install-playtest | 3 | 0 |
| install-server | 1 | 0 |
| web-build | 4 | 0 |
| overlay | 0 | 0 |
| preflight | 3 | 0 |
| run-specs | 1581 | 0 |
| compress | 0 | 0 |
