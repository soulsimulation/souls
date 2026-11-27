// The launcher test inventory splits into parallel CI legs (ci-scope.mjs TEST_LEGS, ci.yml), balanced by
// measured seconds per file (test-leg-durations.json, from one hosted run). The durations only balance the split: a
// missing or stale entry can make a leg slower but can never drop or repeat a file, because every leg reads the same
// directory listing and each file goes to exactly one leg.
// CLI: `node .github/scripts/test-legs.mjs <kind> <leg>` prints that leg's files, one per line, relative to the repo root.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Each kind's test directories (the files directly in them, like the shell glob `<dir>/*.test.mjs`) and its leg count. */
export const TEST_LEGS = {
  launcher: { legs: 3, dirs: ['tools/world-launcher', 'tools/world-launcher/soul'], base: 'tools/world-launcher/' },
};

export function legTestFiles(kind, root = '.') {
  const { dirs } = TEST_LEGS[kind] ?? {};
  if (!dirs) throw Error(`no test legs for ${kind}`);
  return dirs.flatMap(d => readdirSync(join(root, d), { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.test.mjs')).map(e => `${d}/${e.name}`)).sort();
}

export function legDurations(kind, file = new URL('./test-leg-durations.json', import.meta.url)) {
  try { return JSON.parse(readFileSync(file, 'utf8')).seconds?.[kind] ?? {}; } catch { return {}; }
}

/** Every leg's files: longest first, each to the currently lightest leg (ties: lower index, then name); deterministic.
 *  Unmeasured files (new ones, and those under a second) weigh one second. */
export function testLegs(files, legs, seconds = {}, base = '') {
  if (!Number.isInteger(legs) || legs < 1) throw Error('Invalid leg count');
  const weight = f => seconds[f.slice(base.length)] ?? 1;
  const out = Array.from({ length: legs }, () => ({ files: [], seconds: 0 }));
  for (const f of [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const i = out.reduce((best, x, j) => (x.seconds < out[best].seconds ? j : best), 0);
    out[i].files.push(f); out[i].seconds += weight(f);
  }
  for (const x of out) { if (!x.files.length) throw Error('Empty test leg'); x.files.sort(); }
  return out;
}

export function legFiles(kind, leg, root = '.') {
  const { legs, base } = TEST_LEGS[kind] ?? {};
  if (!Number.isInteger(leg) || leg < 0 || leg >= legs) throw Error(`Invalid ${kind} leg ${leg}`);
  return testLegs(legTestFiles(kind, root), legs, legDurations(kind), base)[leg].files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [kind, leg] = process.argv.slice(2);
  process.stdout.write(legFiles(kind, Number(leg)).join('\n') + '\n');
}
