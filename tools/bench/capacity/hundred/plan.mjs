// #2301: the hundred-world bench's pure parts (hundred.mjs runs them; plan.test.mjs checks them).

/** #2240's settled memory: a small world about 250 MB, an Eden-class world about 575 MB (9-17 MB more per idle Soul). */
export const SMALL_MB = 250, EDEN_MB = 575;
/** The world memory figure in which `n` small worlds fit (A6: about 25). */
export const memFigure = (n) => n * SMALL_MB;

/** A seeded generator in [0, 1) (mulberry32): the same seed gives the same agents' gaps every run. */
export function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** An agent's act times: from t0, each after a gap drawn from [lo, hi) ms, while before `end`. */
export function gapsFor(rnd, t0, end, lo, hi) {
  const out = []; for (let t = t0 + lo + rnd() * (hi - lo); t < end; t += lo + rnd() * (hi - lo)) out.push(Math.round(t));
  return out;
}
/** How long a held sit asks for, in seconds: 5 to 15 minutes (short knobs: 30 to 90 s). */
export const holdSecondsFor = (rnd, short) => Math.round(short ? 30 + rnd() * 60 : 300 + rnd() * 600);

/** {n, p50, p95, max} of a list of numbers (nearest rank), rounded; nulls where empty. */
export function pct(xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b), at = (q) => (v.length ? Math.round(v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)]) : null);
  return { n: v.length, p50: at(0.5), p95: at(0.95), max: v.length ? Math.round(v.at(-1)) : null };
}

/** A6: the acts and the samples of the active window. An act failed when it was not accepted; a refusal is a failure
 *  the world answered with a code. The wait an unloaded world adds: an act's time less the median time of acts sent
 *  to a world already in memory. */
export function summarizeActs(acts, samples = []) {
  const warm = pct(acts.filter((a) => a.before === 'running' && a.ok).map((a) => a.ms)).p50 ?? 0;
  const codes = {}; for (const a of acts) if (!a.ok) codes[a.code ?? 'unknown'] = (codes[a.code ?? 'unknown'] ?? 0) + 1;
  return { acts: acts.length, failed: acts.filter((a) => !a.ok).length, refused: acts.filter((a) => !a.ok && a.code && !/^exit-|^timeout$/.test(a.code)).length, firstFailures: acts.filter((a) => !a.ok).slice(0, 10).map(({ slug, kind, code, ms, said }) => ({ slug, kind, code, ms, said })), retried: acts.filter((a) => a.waits > 0).length, codes,
    warmActMs: warm, addedWaitMs: pct(acts.filter((a) => a.before !== 'running').map((a) => Math.max(0, a.ms - warm))),
    byKind: { walk: pct(acts.filter((a) => a.kind === 'walk').map((a) => a.ms)), held: pct(acts.filter((a) => a.kind === 'held').map((a) => a.ms)) },
    inMemMax: Math.max(0, ...samples.map((s) => s.inMem)), startingMax: Math.max(0, ...samples.map((s) => s.starting)), failedWorldsMax: Math.max(0, ...samples.map((s) => s.failed ?? 0)),
    cpu: pct(samples.map((s) => s.cpuCores)), rssMb: pct(samples.map((s) => s.rssMb)) };
}
/** The fraction of the samples in which each world was in memory: {p50, max, perWorld}. */
export function inMemoryFractions(samples) {
  const n = {}, inn = {};
  for (const s of samples) for (const [slug, st] of Object.entries(s.status ?? {})) { n[slug] = (n[slug] ?? 0) + 1; if (st === 'running' || st === 'starting') inn[slug] = (inn[slug] ?? 0) + 1; }
  const perWorld = Object.fromEntries(Object.keys(n).sort().map((k) => [k, +((inn[k] ?? 0) / n[k]).toFixed(3)])), v = Object.values(perWorld).sort((a, b) => a - b);
  return { p50: v.length ? v[Math.ceil(v.length / 2) - 1] : null, max: v.length ? v.at(-1) : null, perWorld };
}

/** The pieces of the still-worlds tranche (#2241) the script relies on, each looked for in the checkout's own sources by
 *  `has(pattern, path)` (a grep over non-test files). What is absent is named with its task and what the run then cannot
 *  show; the run goes on and reports those parts as not shown. */
export const PIECES = [
  { key: 'unload', issue: '#2299', what: 'the launcher unloads still worlds (--unload-still)', pattern: 'unload-still', path: 'tools/world-launcher/launcher.mjs', effect: 'no world leaves memory (A3, A6 to A7)' },
  { key: 'still', issue: '#2297', what: "the world's GET /__sim/still", pattern: '__sim/still', path: 'apps/server/src', effect: 'the launcher never sees a still world, so none unloads (A3 to A7) and A4 has no counters' },
  { key: 'skip', issue: '#2298', what: "a still world's clock is jumped (SIM_SKIP)", pattern: 'SIM_SKIP', path: 'apps/server/src', effect: 'every world ticks straight through: A2 compares two straight runs, A4 recomputes every tick of the gap' },
  { key: 'counters', issue: '#2298 A5', what: 'ticks computed and jumped per world', pattern: '[tT]icks[A-Z]?[a-z]*[Jj]umped|jumpedTicks', path: 'apps/server/src', effect: 'A4 shows no counters' },
  { key: 'winddown', issue: '#2295', what: 'the wind-down (SIM_BODY_KNOBS wanderTicks)', pattern: 'wanderTicks', path: 'apps/server/src', effect: 'silent Souls do not walk out and sleep: worlds with Souls stay awake (A3)' },
  { key: 'queue', issue: '#2304', what: 'loads queued and capped (--load-parallel)', pattern: 'load-parallel', path: 'tools/world-launcher/launcher.mjs', effect: 'A7 loads are not capped by the launcher; the script still counts them' },
  { key: 'mem', issue: '#2233', what: 'one memory figure for worlds (--worlds-mem-mb)', pattern: 'worlds-mem-mb', path: 'tools/world-launcher/launcher.mjs', effect: 'A6 caps worlds in memory by count (--max-running) at the same number of small worlds' },
];
export function probeSource(has) {
  return PIECES.filter((p) => !has(p.pattern, p.path)).map(({ key, issue, what, effect }) => ({ key, issue, what, effect }));
}
