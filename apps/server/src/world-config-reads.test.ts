// Shards (#2389 A2): a world is a function of its own config. The server's code reads a world's settings from that config
// (`cfg`, `cfg.env`, worldConfig(host)), never from a module-level config or from process.env after boot. This guard
// fails when a new `process.env` read or a new import of the module-level `config` appears in the server's code.
//
// What is left is listed below by file, with why it is not a world's own setting. The counts are exact: a file that drops
// a read lowers its count here in the same change, so the list only shrinks. Comments are not counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repo = new URL('../../../', import.meta.url).pathname;
const ROOTS = ['apps/server/src', 'packages/engine-mars/src'];

// Why a read may stay:
const LOAD = 'loadConfig and the program settings: the one place a world is read from an environment';
const FALLBACK = 'a default parameter or `?? process.env` fallback for tests and tools; a started world passes its own env';
const PROGRAM = 'read at import: a measurement, trace or debug switch, the same for every world in one program';
const LATER = 'per world, for a later shard step (docs/design/world-cost.md B2, B3, B5): not in the B1 and B4 rows';
const TOOL = 'not world code: a bench, oracle, fixture, worker child or tool entry point';

/** file → [count, why]. The B1 and B4 rows of docs/design/world-cost.md (A4) hold only LOAD, FALLBACK and PROGRAM reads. */
const ALLOWED: Record<string, [number, string]> = {
  'apps/server/src/config.ts': [3, LOAD],
  'apps/server/src/main.ts': [1, LOAD],
  // B1 and B4 rows
  'apps/server/src/edge/ledger/ledger.ts': [2, PROGRAM],   // SIM_SERVING_BOOT_WAIT_MS
  'apps/server/src/god/assets.ts': [1, FALLBACK],
  'apps/server/src/god/engine-bridge.ts': [3, PROGRAM],   // PERCEIVE_SLICE_MS, SIM_CONTEXT_TIMINGS, SIM_L4_STATS
  'apps/server/src/god/layers.ts': [1, FALLBACK],
  'apps/server/src/god/real-clock.ts': [4, FALLBACK],
  'apps/server/src/god/workbench.ts': [1, FALLBACK],
  'apps/server/src/moderation/store.ts': [1, FALLBACK],
  'packages/engine-mars/src/engine.ts': [5, `${PROGRAM}; marsFactory: ${FALLBACK}`],
  // outside the B1 and B4 rows
  'apps/server/src/world-factory.ts': [4, FALLBACK],
  'apps/server/src/world.ts': [4, LATER],
  'apps/server/src/standby.ts': [1, LATER],
  'apps/server/src/punt-install.ts': [1, PROGRAM],
  'apps/server/src/load/disk-headroom.ts': [1, LATER],
  'apps/server/src/load/watchdog.ts': [2, LATER],
  'apps/server/src/edge/body/testing.ts': [1, TOOL],
  'apps/server/src/edge/comms/fading.ts': [1, LATER],
  'apps/server/src/edge/eyes/worker.ts': [1, TOOL],
  'apps/server/src/edge/ledger/menu-stats.ts': [4, PROGRAM],
  'apps/server/src/edge/ledger/stall-guard.ts': [1, LATER],
  'apps/server/src/god/builds.ts': [4, LATER],
  'apps/server/src/god/context-timing.ts': [2, PROGRAM],
  'apps/server/src/god/context-view-cache.ts': [2, PROGRAM],
  'apps/server/src/god/context-views.ts': [1, LATER],
  'apps/server/src/god/host-render-slot.ts': [2, LATER],
  'apps/server/src/god/look-renderer.ts': [6, LATER],
  'apps/server/src/god/perceive.ts': [2, PROGRAM],
  'apps/server/src/god/trace.ts': [1, PROGRAM],
  'apps/server/src/god/trace-bench.ts': [4, TOOL],
  'apps/server/src/god/walk-audit.ts': [3, TOOL],
  'apps/server/src/god/world-env.ts': [1, FALLBACK],
  'apps/server/src/moderation/classifier.ts': [1, FALLBACK],
  'apps/server/src/portrait/auto-portraits.ts': [2, LATER],
  'apps/server/src/split/delta-oracle.ts': [6, TOOL],
  'apps/server/src/split/delta.ts': [2, PROGRAM],
  'apps/server/src/split/preload.ts': [2, TOOL],
  'apps/server/src/split/read-host.ts': [1, FALLBACK],
  'apps/server/src/split/read-oracle.ts': [5, TOOL],
  'apps/server/src/split/read-pool.ts': [1, FALLBACK],
  'apps/server/src/split/read-worker.ts': [4, TOOL],
  'apps/server/src/split/spatial-tap.ts': [3, TOOL],
};

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const sources = () => ROOTS.flatMap((r) => walk(join(repo, r)).filter((f) => f.endsWith('.ts') && !/\.test\.ts$|\.fixture\.ts$/.test(f)).map((f) => f.slice(repo.length)));

test('#2389 A2: no new process.env read in the server code outside loadConfig, and the list only shrinks', () => {
  const found: Record<string, number> = {};
  for (const f of sources()) { const n = (strip(readFileSync(join(repo, f), 'utf8')).match(/process\.env\b/g) ?? []).length; if (n) found[f] = n; }
  const problems: string[] = [];
  for (const [f, n] of Object.entries(found)) {
    const allowed = ALLOWED[f]?.[0] ?? 0;
    if (n > allowed) problems.push(`${f}: ${n} process.env reads, ${allowed} allowed. A world reads its own config (cfg.env, worldConfig(host).env)`);
    else if (n < allowed) problems.push(`${f}: ${n} process.env reads now; lower its count in world-config-reads.test.ts to ${n}`);
  }
  for (const f of Object.keys(ALLOWED)) if (!found[f]) problems.push(`${f}: no process.env read left; remove it from world-config-reads.test.ts`);
  assert.deepEqual(problems, []);
});

test('#2389 A2: the server code never imports the module-level config (only tests and tools do)', () => {
  const named = /import\s*\{[^}]*(?<!type\s)\bconfig\b[^}]*\}\s*from\s*['"][./]*config\.ts['"]/;
  const namespace = /import\s*\*\s*as\s+\w+\s+from\s*['"][./]*config\.ts['"]/, dynamic = /\bimport\(\s*['"`][./]*config\.ts['"`]\s*\)/;
  const imports = sources().filter((f) => { const s = strip(readFileSync(join(repo, f), 'utf8')); return named.test(s) || namespace.test(s) || dynamic.test(s); });
  assert.deepEqual(imports, []);
});

// The env-defaulted helpers read process.env when called with no env. In server code each call passes the world's env;
// what is left is listed by file with its reason, as above.
const HELPERS = /\b(?:realTimeEnabled|productionWorld|clockContext|defaultSiteLog|defaultAssetDir|economyOn)\(\s*\)|\bclockMode\((?:[^(),]|\([^()]*\))*\)/g;
const HELPER_ALLOWED: Record<string, [number, string]> = {
  'apps/server/src/moderation/store.ts': [1, FALLBACK],   // the constructor's default; http.ts passes the world's site log
  'apps/server/src/god/perceive.ts': [1, FALLBACK],       // `layers.economy ?? economyOn()`; a started world sets layers.economy
  'apps/server/src/split/god-replica.ts': [1, LATER],     // a read worker's replica: one per program until B2 and B3
};

test('#2389 A2: no new argument-less call to an env-defaulted helper in the server code, and the list only shrinks', () => {
  const problems: string[] = [];
  const found: Record<string, number> = {};
  for (const f of sources()) { const n = (strip(readFileSync(join(repo, f), 'utf8')).match(HELPERS) ?? []).length; if (n) found[f] = n; }
  for (const [f, n] of Object.entries(found)) {
    const allowed = HELPER_ALLOWED[f]?.[0] ?? 0;
    if (n > allowed) problems.push(`${f}: ${n} env-defaulted helper calls with no env, ${allowed} allowed. Pass the world's env (cfg.env, god.opts.env)`);
    else if (n < allowed) problems.push(`${f}: ${n} such calls now; lower its count in world-config-reads.test.ts to ${n}`);
  }
  for (const f of Object.keys(HELPER_ALLOWED)) if (!found[f]) problems.push(`${f}: no such call left; remove it from world-config-reads.test.ts`);
  assert.deepEqual(problems, []);
});

test('#2389 A2: the guard patterns catch what they are meant to', () => {
  for (const s of ['realTimeEnabled()', 'productionWorld( )', 'clockContext()', 'defaultSiteLog()', 'defaultAssetDir()', 'economyOn()', 'clockMode(t as { clock?: string | null })', 'clockMode(f(x))'])
    assert.equal((s.match(HELPERS) ?? []).length, 1, s);
  for (const s of ['realTimeEnabled(env)', 'clockMode(t, env)', 'clockMode(t as { clock?: string | null }, god.opts.env)', 'export function clockMode(time: X | undefined, env = process.env)'])
    assert.equal((s.match(HELPERS) ?? []).length, 0, s);
});
