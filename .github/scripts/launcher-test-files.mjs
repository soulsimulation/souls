#!/usr/bin/env node
// The launcher unit tests (every *.test.mjs directly in tools/world-launcher and tools/world-launcher/soul, the files
// `node --test --test-concurrency=1 tools/world-launcher/*.test.mjs tools/world-launcher/soul/*.test.mjs` ran as one
// CI job until November 2026) run as LAUNCHER_PIECES jobs, launcher-0 … launcher-<N-1>, split by measured file
// durations (launcher-test-durations.json). Each job runs
//
//   files=$(node .github/scripts/launcher-test-files.mjs <piece>)     (ci.yml)
//
// which prints that piece's files, one per line, and exits non-zero unless the pieces together hold every launcher test
// file exactly once. A new test file needs no assignment: it goes to the lightest piece at the median weight, so it can
// never be left out. The durations only balance the pieces; a missing or stale entry can make a piece slower but never
// drop or repeat a file. Each piece first prints {"shard":"launcher-<i>","files":[…]} to stderr, so the durations can be
// regenerated from the jobs' serial logs:
//
//   node .github/scripts/server-test-durations.mjs --src . launcher-job.log... > .github/scripts/launcher-test-durations.json
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAUNCHER_PIECES = 3;
export const LAUNCHER_TEST_DIRS = ['tools/world-launcher', 'tools/world-launcher/soul'];

/** Every launcher test file, repo-relative, in the order the shell globs above expand them (byte order per directory). */
export function launcherTestFiles(root = '.') {
  return LAUNCHER_TEST_DIRS.flatMap(dir => readdirSync(join(root, dir), { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.test.mjs') && !e.name.startsWith('.'))
    .map(e => `${dir}/${e.name}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The measured seconds per file ({'tools/world-launcher/x.test.mjs': s}); {} when the file is absent or unreadable. */
export function launcherTestDurations(file = new URL('./launcher-test-durations.json', import.meta.url)) {
  try { return JSON.parse(readFileSync(file, 'utf8')).seconds ?? {}; } catch { return {}; }
}

/** Every piece's files: longest first, each to the currently lightest piece (ties: lower index, then name), deterministic.
 *  Unmeasured files weigh the median. */
export function launcherPieces(all, pieces = LAUNCHER_PIECES, seconds = launcherTestDurations()) {
  if (!Number.isInteger(pieces) || pieces < 1) throw Error('Invalid launcher piece count');
  const known = all.map(f => seconds[f]).filter(Number.isFinite).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weight = f => (Number.isFinite(seconds[f]) ? seconds[f] : median);
  const out = Array.from({ length: pieces }, () => ({ files: [], seconds: 0 }));
  for (const f of [...all].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const p = out.reduce((best, x, i) => (x.seconds < out[best].seconds ? i : best), 0);
    out[p].files.push(f); out[p].seconds += weight(f);
  }
  for (const x of out) { if (!x.files.length) throw Error('Empty launcher piece'); x.files.sort(); x.seconds = Math.round(x.seconds); }
  return out;
}

/** Throws unless the pieces hold every file of `all` exactly once and nothing else. */
export function assertExactlyOnce(all, pieces) {
  const flat = pieces.flatMap(p => p.files), seen = new Set(), twice = flat.filter(f => seen.has(f) || !seen.add(f));
  const missing = all.filter(f => !seen.has(f)), extra = [...seen].filter(f => !all.includes(f));
  if (twice.length || missing.length || extra.length)
    throw Error(`launcher pieces do not hold each test file once: twice [${twice}] missing [${missing}] unknown [${extra}]`);
}

export function launcherPieceFiles(piece, { all = launcherTestFiles(), pieces = LAUNCHER_PIECES, seconds = launcherTestDurations() } = {}) {
  if (!Number.isInteger(piece) || piece < 0 || piece >= pieces) throw Error('Invalid launcher piece');
  const plan = launcherPieces(all, pieces, seconds);
  assertExactlyOnce(all, plan);
  return plan[piece].files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2], piece = /^\d+$/.test(arg ?? '') ? Number(arg) : NaN;
  const files = launcherPieceFiles(piece);
  console.error(JSON.stringify({ shard: `launcher-${piece}`, files }));
  process.stdout.write(files.join('\n') + '\n');
}
