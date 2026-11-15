// Shards (#2416 A1): code is shared and worlds are data. Two worlds in one program must never share mutable state, so
// a world's state lives on its own host, engine, ledger or registry, never in a module-level variable. This guard fails
// when new module-level mutable state appears in the server's code: a top-level `let`/`var`, a top-level empty
// `new Map()`/`Set`/`WeakMap`/`WeakSet`/`Array` or `[]`, or an assignment onto `globalThis`.
//
// What is left is listed below by file, with why it is not one world's state. The counts are exact, as in
// world-config-reads.test.ts: a file that drops one lowers its count here in the same change, so the list only shrinks.
// A new entry needs one of these reasons; world state goes on the world instead (docs/design/world-cost.md, B3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repo = new URL('../../../', import.meta.url).pathname;
const ROOTS = ['apps/server/src', 'packages/engine-mars/src'];

const KEYED = 'a WeakMap/WeakSet keyed by one world\'s own object (its host, model, ledger, database, runtime or def): each world has its own entries';
const CACHE = 'a cache keyed by content (a hash, a name, a static file): the same input gives the same answer in every world, so sharing it is the point';
const PROGRAM = 'one per program by design: code registered at import, an id counter that is unique across worlds, or a lazily loaded static asset';
const THREAD = 'a worker thread\'s own module (the watchdog, a read worker, a preview worker): each world starts its own thread';
const TOOL = 'not world code: an oracle, bench or preload entry point';
const DEFAULT = 'the program\'s default for tests and tools; a started world uses its own (startWorld, #2416)';
const LATER = 'one per program for now, listed in docs/design/world-cost.md (A4) for a later shard step';

/** file → [count, why]. */
const ALLOWED: Record<string, [number, string]> = {
  'apps/server/src/auth.ts': [1, KEYED],
  'apps/server/src/edge/body/pip.ts': [1, CACHE],
  'apps/server/src/edge/body/routes.ts': [1, KEYED],
  'apps/server/src/edge/comms/objects/framework.ts': [2, KEYED],
  'apps/server/src/edge/comms/objects/table.ts': [2, KEYED],
  'apps/server/src/edge/comms/store.ts': [3, `${KEYED}; \`savepoints\`: ${PROGRAM}`],
  'apps/server/src/edge/events/schema.ts': [1, PROGRAM],
  'apps/server/src/edge/eyes/view.ts': [2, KEYED],
  'apps/server/src/edge/ledger/ledger.ts': [1, KEYED],
  'apps/server/src/edge/ledger/places.ts': [1, KEYED],
  'apps/server/src/edge/ledger/region-arrival.ts': [1, KEYED],
  'apps/server/src/edge/ledger/vocabulary.ts': [8, `TOKEN_MEMO, NORM_MEMO: ${CACHE}; three: ${KEYED}; knownMemo, synonymWords, stepVerbs: ${LATER}`],
  'apps/server/src/edge/perception/knowledge.ts': [1, 'NO_SECRETS: an empty set never written'],
  'apps/server/src/god/activity-spots.ts': [1, KEYED],
  'apps/server/src/god/context-timing.ts': [1, LATER],
  'apps/server/src/god/edit-preview-worker.ts': [1, THREAD],
  'apps/server/src/god/edit-preview.ts': [2, LATER],
  'apps/server/src/god/engine-bridge.ts': [1, KEYED],
  'apps/server/src/god/god.ts': [2, KEYED],
  'apps/server/src/god/governance.ts': [1, KEYED],
  'apps/server/src/god/ingestion.ts': [1, KEYED],
  'apps/server/src/god/mirror.ts': [7, `${KEYED}; lastGroundHashed: ${LATER}`],
  'apps/server/src/god/nav.ts': [1, 'NO_SERVICE_POINTS: a readonly empty list'],
  'apps/server/src/god/query.ts': [4, KEYED],
  'apps/server/src/god/real-clock.ts': [2, `formatters: ${CACHE}; kept: ${KEYED}`],
  'apps/server/src/god/schema.ts': [1, CACHE],
  'apps/server/src/god/verify-use.ts': [4, KEYED],
  'apps/server/src/god/world-clock.ts': [1, KEYED],
  'apps/server/src/human-capabilities.ts': [1, KEYED],
  'apps/server/src/human-sleep-transition.ts': [1, KEYED],
  'apps/server/src/load/boot-progress.ts': [2, DEFAULT],
  'apps/server/src/load/watchdog-worker.ts': [3, THREAD],
  'apps/server/src/moderation/classifier.ts': [1, LATER],
  'apps/server/src/moderation/routes.ts': [1, CACHE],
  'apps/server/src/moderation/store.ts': [1, KEYED],
  'apps/server/src/moderation/validate.ts': [1, KEYED],
  'apps/server/src/split/delta-oracle.ts': [9, TOOL],
  'apps/server/src/split/delta.ts': [1, `${KEYED}; spotsN, spatialsN: ${PROGRAM}`],
  'apps/server/src/split/menu-world.ts': [1, KEYED],
  'apps/server/src/split/preload.ts': [4, TOOL],
  'apps/server/src/split/read-bridge.ts': [1, KEYED],
  'apps/server/src/split/read-worker.ts': [9, THREAD],
  'apps/server/src/split/spatial-oracle.ts': [5, TOOL],
  'apps/server/src/split/world-init.ts': [1, KEYED],
  'packages/engine-mars/src/disassembly.ts': [1, CACHE],
  'packages/engine-mars/src/engine.ts': [1, KEYED],
  'packages/engine-mars/src/entity-physics.ts': [2, KEYED],
  'packages/engine-mars/src/ground-bridge.ts': [3, `RECIPES, FIELDS: ${CACHE}; coverMemo: ${KEYED}`],
  'packages/engine-mars/src/mars-2026-map.ts': [1, CACHE],
  'packages/engine-mars/src/punt.ts': [1, KEYED],
};

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const sources = () => ROOTS.flatMap((r) => walk(join(repo, r)).filter((f) => f.endsWith('.ts') && !/\.test\.ts$|\.fixture\.ts$/.test(f)).map((f) => f.slice(repo.length)));
export const MODULE_STATE = /^(?:export\s+)?(?:let|var)\s|^(?:export\s+)?const\s+[\w$]+\s*(?::[^=\n]+)?=\s*new\s+(?:Map|Set|WeakMap|WeakSet|Array)\s*(?:<[^\n]*?>)?\s*\(\s*\)|^(?:export\s+)?const\s+[\w$]+\s*(?::[^=\n]+)?=\s*\[\s*\]|\bglobalThis\b[^;\n]*?\.\w+\s*=[^=]/gm;

test('#2416 A1: no new module-level mutable state in the server code, and the list only shrinks', () => {
  const found: Record<string, number> = {};
  for (const f of sources()) { const n = (strip(readFileSync(join(repo, f), 'utf8')).match(MODULE_STATE) ?? []).length; if (n) found[f] = n; }
  const problems: string[] = [];
  for (const [f, n] of Object.entries(found)) {
    const allowed = ALLOWED[f]?.[0] ?? 0;
    if (n > allowed) problems.push(`${f}: ${n} module-level mutable declarations, ${allowed} allowed. A world's state goes on its host, engine or ledger`);
    else if (n < allowed) problems.push(`${f}: ${n} now; lower its count in world-module-state.test.ts to ${n}`);
  }
  for (const f of Object.keys(ALLOWED)) if (!found[f]) problems.push(`${f}: none left; remove it from world-module-state.test.ts`);
  assert.deepEqual(problems, []);
});

test('#2416 A1: the B3 items are gone from module scope', () => {
  const read = (f: string) => strip(readFileSync(join(repo, f), 'utf8'));
  assert.doesNotMatch(read('mars/viewer/engine/locomotion/walk.ts'), /setWalkReach|walkSchemaWide/, 'walk reach is in the world\'s registry');
  assert.doesNotMatch(read('apps/server/src/god/poster-boards.ts'), /setWorldDaySource|dayNow/, 'the world day comes from the world\'s host');
  assert.doesNotMatch(read('apps/server/src/god/ground-host.ts'), /^const DEEP_MIDDLE/m, 'the deep middles are per world');
  assert.doesNotMatch(read('apps/server/src/god/context-views.ts'), /^const live\b/m, 'context views close per world');
  assert.doesNotMatch(read('apps/server/src/world-main.ts'), /__soulsReadPool/, 'the read pool is the world\'s');
  assert.doesNotMatch(read('apps/server/src/load/clock-source.ts'), /^let /m, 'the clock is the request\'s world\'s');
  assert.doesNotMatch(read('apps/server/src/load/stall-log.ts'), /^let active/m, 'each world\'s admission feeds its own stall log');
  assert.doesNotMatch(read('apps/server/src/world-main.ts'), /\bsharedLoad\b|\bsharedApi\b|\bbootPhase\(|\bbootTick\(/, 'a started world uses its own load gauges');
  assert.doesNotMatch(read('apps/server/src/world.ts'), /\bbootPhase\(|\bbootTick\(/, 'a host writes its own boot progress');
});

test('#2416 A1: the pattern catches what it is meant to', () => {
  for (const s of ['let x = 1;', 'export let y;', 'var z = 0;', 'const M = new Map<string, number>();', 'const S = new Set();', 'export const W = new WeakMap<object, string>();', 'const xs: number[] = [];', '(globalThis as { a?: unknown }).a = pool;', 'globalThis.b = 1;'])
    assert.equal((s.match(MODULE_STATE) ?? []).length, 1, s);
  for (const s of ['  let x = 1;', 'const C = new Set([\'a\']);', 'const N = 3;', 'if (globalThis.b === 1) {}', 'const f = () => [];'])
    assert.equal((s.match(MODULE_STATE) ?? []).length, 0, s);
});
