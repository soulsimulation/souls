#!/usr/bin/env node
// Long CI test suites run as several jobs ("pieces"), split by measured file durations. Each suite is the *.test.mjs
// files directly in its directories (what the shell globs `<dir>/*.test.mjs` expand to); SUITES says which, how many
// pieces, and where the durations are:
//   launcher       tools/world-launcher, tools/world-launcher/soul   jobs launcher-0 … launcher-<LAUNCHER_PIECES-1>
//   soul-actions   tools/soul-actions                               jobs soul-actions-0 … soul-actions-<SOUL_ACTIONS_PIECES-1>
// Each job runs (ci.yml)
//
//   files=$(node .github/scripts/test-pieces.mjs <suite> "$TEST_PIECE")
//
// which prints that piece's files, one per line, and exits non-zero unless the suite's pieces together hold every one of
// its test files exactly once. A new test file needs no assignment: it goes to the lightest piece at the median weight,
// so it can never be left out. The durations only balance the pieces; a missing or stale entry can make a piece slower
// but never drop or repeat a file. Each piece first prints {"shard":"<suite>-<i>","files":[…]} to stderr, so the
// durations can be regenerated from the jobs' logs with server-test-durations.mjs (--src .): serially for launcher
// (wall time per file), with --fill for soul-actions, which runs four files at once (summed test time per file).
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAUNCHER_PIECES = 3;
export const SOUL_ACTIONS_PIECES = 3;
export const SUITES = {
  launcher: { dirs: ['tools/world-launcher', 'tools/world-launcher/soul'], pieces: LAUNCHER_PIECES, durations: 'launcher-test-durations.json' },
  'soul-actions': { dirs: ['tools/soul-actions'], pieces: SOUL_ACTIONS_PIECES, durations: 'soul-actions-test-durations.json' },
};
const suiteOf = name => { if (!Object.hasOwn(SUITES, name ?? '')) throw Error(`Unknown test suite ${name}`); return SUITES[name]; };

/** Every test file of a suite, repo-relative, in the order its shell globs expand them (byte order per directory). */
export function suiteTestFiles(suite, root = '.') {
  return suiteOf(suite).dirs.flatMap(dir => readdirSync(join(root, dir), { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.test.mjs') && !e.name.startsWith('.'))
    .map(e => `${dir}/${e.name}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The suite's measured seconds per file ({'tools/x/y.test.mjs': s}); {} when the file is absent or unreadable. */
export function suiteDurations(suite) {
  try { return JSON.parse(readFileSync(new URL(`./${suiteOf(suite).durations}`, import.meta.url), 'utf8')).seconds ?? {}; } catch { return {}; }
}

/** Every piece's files: longest first, each to the currently lightest piece (ties: lower index, then name), deterministic.
 *  Unmeasured files weigh the median. */
export function pieces(all, n, seconds = {}) {
  if (!Number.isInteger(n) || n < 1) throw Error('Invalid piece count');
  const known = all.map(f => seconds[f]).filter(Number.isFinite).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weight = f => (Number.isFinite(seconds[f]) ? seconds[f] : median);
  const out = Array.from({ length: n }, () => ({ files: [], seconds: 0 }));
  for (const f of [...all].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const p = out.reduce((best, x, i) => (x.seconds < out[best].seconds ? i : best), 0);
    out[p].files.push(f); out[p].seconds += weight(f);
  }
  for (const x of out) { if (!x.files.length) throw Error('Empty piece'); x.files.sort(); x.seconds = Math.round(x.seconds); }
  return out;
}

/** Throws unless the pieces hold every file of `all` exactly once and nothing else. */
export function assertExactlyOnce(all, plan) {
  const flat = plan.flatMap(p => p.files), seen = new Set(), twice = flat.filter(f => seen.has(f) || !seen.add(f));
  const missing = all.filter(f => !seen.has(f)), extra = [...seen].filter(f => !all.includes(f));
  if (twice.length || missing.length || extra.length)
    throw Error(`pieces do not hold each test file once: twice [${twice}] missing [${missing}] unknown [${extra}]`);
}

/** One piece's files, after checking that the suite's pieces hold every file exactly once. */
export function pieceFiles(suite, piece, { all = suiteTestFiles(suite), n = suiteOf(suite).pieces, seconds = suiteDurations(suite) } = {}) {
  if (!Number.isInteger(piece) || piece < 0 || piece >= n) throw Error('Invalid piece');
  const plan = pieces(all, n, seconds);
  assertExactlyOnce(all, plan);
  return plan[piece].files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [suite, arg] = process.argv.slice(2), piece = /^\d+$/.test(arg ?? '') ? Number(arg) : NaN;
  const files = pieceFiles(suite, piece);
  console.error(JSON.stringify({ shard: `${suite}-${piece}`, files }));
  process.stdout.write(files.join('\n') + '\n');
}
