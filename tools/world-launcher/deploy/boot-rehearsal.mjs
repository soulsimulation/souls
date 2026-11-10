#!/usr/bin/env node
// Boot rehearsal (#1323): boot a COPY of a world's database with this tree's server code, the way the world's process would
// read it, adopt what its first boot on this release adopts (the repair rules), run it N ticks, and print what happened.
// Run it on the host with the new release's tree, before the release goes live. Nothing leaves the host.
//
//   node tools/world-launcher/deploy/boot-rehearsal.mjs --db <world>/sim.db --scratch <new empty dir> \
//     [--from-pid <the world's running process>] [--env-file <file>]... [--env KEY=VALUE]... [--ticks 1200] [--keep]
//
// The world's environment decides its reader (WORLD_KEY, WORLD_ID, ENGINE, ENABLE_EDEN_* ...): pass the running child's pid
// (its environment is read from /proc/<pid>/environ, in this process only, never printed), its env files, or --env pairs.
// Always forced: DATA_DIR=<scratch>, BRAIN_MODE=fake (no model is called), SIM_WATCHDOG=0. No port is opened and no mind runs.
//
// Read-only on the original: it is opened read-only and copied with SQLite's online backup API into <scratch>/sim.db, which
// must lie outside the world's data directory. The copy is deleted at the end unless --keep.
// Prints one JSON line: {adopted|refused (reason), halted|running, the hashes before and after, ticks run, glitches}.
// Exit 0: booted and running; 2: refused or halted; 1: the rehearsal itself failed.
import {backup, DatabaseSync} from 'node:sqlite';
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, realpathSync} from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';
import {setImmediate} from 'node:timers/promises';

const args = process.argv.slice(2), take = (k) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === k) out.push(args[++i]); return out; };
const one = (k) => take(k).at(-1), has = (k) => args.includes(k);
const src = one('--db'), scratchArg = one('--scratch'), ticks = Number(one('--ticks') ?? 1200);
if (!src || !scratchArg || !Number.isInteger(ticks) || ticks < 0) { console.error('usage: boot-rehearsal.mjs --db <sim.db> --scratch <empty dir> [--from-pid <pid>] [--env-file <f>]... [--env K=V]... [--ticks N] [--keep]'); process.exit(1); }
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const dbFile = real(src), dataDir = dirname(dbFile), scratch = resolve(scratchArg);
if (!existsSync(dbFile)) { console.error(`boot-rehearsal: no database at ${src}`); process.exit(1); }
mkdirSync(scratch, {recursive: true});
const scratchReal = real(scratch);
if (scratchReal === dataDir || scratchReal.startsWith(dataDir + sep)) { console.error('boot-rehearsal: --scratch must lie outside the world\'s data directory'); process.exit(1); }
if (readdirSync(scratchReal).length) { console.error('boot-rehearsal: --scratch must be empty'); process.exit(1); }

// the world's environment, as its process sees it
const parse = (text, sepChar) => Object.fromEntries(text.split(sepChar).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).replace(/^export\s+/, ''), l.slice(i + 1).replace(/^(['"])(.*)\1$/, '$2')]; }));
const env = {PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? ''};
for (const pid of take('--from-pid')) Object.assign(env, parse(readFileSync(`/proc/${Number(pid)}/environ`, 'utf8'), '\0'));
for (const f of take('--env-file')) Object.assign(env, parse(readFileSync(f, 'utf8'), '\n'));
for (const kv of take('--env')) Object.assign(env, parse(kv, '\n'));
Object.assign(env, {DATA_DIR: scratchReal, BRAIN_MODE: 'fake', SIM_WATCHDOG: '0', SIM_STANDBY: '0'});
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, env);

const out = {world: null, rules: {}, boot: null, adoption: null, run: null, ok: false};
let host, db, code = 1;
try {
  // a consistent copy from a read-only connection, checked
  const ro = new DatabaseSync(dbFile, {readOnly: true});
  try { await backup(ro, join(scratchReal, 'sim.db'), {rate: 0x7fffffff}); } finally { ro.close(); }
  { const c = new DatabaseSync(join(scratchReal, 'sim.db')); const q = c.prepare('PRAGMA quick_check').get(); c.close(); if (Object.values(q)[0] !== 'ok') throw Error('the copy fails quick_check'); }

  const tree = (p) => new URL(`../../../${p}`, import.meta.url).href;
  const {config} = await import(tree('apps/server/src/config.ts'));
  const {Db} = await import(tree('apps/server/src/db.ts'));
  const {WorldHost} = await import(tree('apps/server/src/world.ts'));
  const {worldFactory} = await import(tree('apps/server/src/world-factory.ts'));
  const {edenCoreRequested} = await import(tree('apps/server/src/eden-bootstrap.ts'));
  const {loadGroundRecipes} = await import(tree('apps/server/src/god/ground-host.ts'));
  const {kernelHash} = await import(tree('apps/server/src/fold.ts'));
  const head = (h) => ({tick: h.engine.world.tick, seq: h.seq, rules: h.engine.rulesVersion, engine: h.engine.stateHash(), kernel: kernelHash(h.kernel)});
  const halted = (h) => !h.clockAvailable || h.paused || !!h.stepFailing;

  db = new Db(join(scratchReal, 'sim.db'));
  const edenCore = edenCoreRequested(config, process.env);
  out.world = {id: config.worldId, key: config.worldKey, engine: config.engine, edenCore, header: db.world(config.worldId)?.rules_version ?? null};
  if (!out.world.header) throw Error(`no world ${config.worldId} in this database: set WORLD_ID / WORLD_KEY as the world's process has them`);
  if (config.worldEngine) loadGroundRecipes(db, config.worldId);
  const factory = await worldFactory(db, config, process.env);
  host = new WorldHost(db, factory, config.worldSeed, config.snapshotEveryTicks, config.worldId, edenCore ? {durableClockV1: true} : undefined);
  host.recoveryForEdge = config.mindDriver === 'edge';
  const quiet = {log: console.log, warn: console.warn}, said = [];
  console.log = (...a) => said.push(a.join(' ').slice(0, 300)); console.warn = console.log;
  const t0 = performance.now(), booted = host.boot();
  out.boot = {from: booted.from, replayed: booted.replayed, ms: Math.round(performance.now() - t0), head: head(host)};
  // what main.ts does next, before the first live tick
  const adoption = host.adoptSoulsRepairV1('operator:souls-repair-default'); host.drainInputs();
  const fact = await adoption.then((e) => e, (e) => ({refused: String(e?.message ?? e).slice(0, 300)}));
  out.adoption = fact?.refused ? {result: 'refused', reason: fact.refused} : fact ? {result: 'adopted', tick: fact.tick, seq: fact.seq} : {result: host.engine.rulesVersion.includes('+souls-repair/') ? 'already' : 'none', reason: host.engine.previewSoulsRepairAdoptionV1?.()?.diagnostic?.code ?? null};
  out.adoption.head = head(host); out.adoption.header = db.world(config.worldId)?.rules_version;
  const tick0 = host.engine.world.tick, seq0 = host.seq, t1 = performance.now();
  let ran = 0;
  for (; ran < ticks && !halted(host); ran++) { host.tickOnce(); if (!halted(host)) host.drainInputs(); if (ran % 20 === 0) await setImmediate(); }
  const rows = db.db.prepare("SELECT author, payload FROM events WHERE world_id=? AND seq>? AND kind='rules' AND author IN ('world:refusal','world:recovery')").all(config.worldId, seq0)
    .map((r) => { const p = JSON.parse(r.payload); return r.author === 'world:refusal' ? {refusal: p.refusal?.rule, relocated: !!p.refusal?.relocated, bodies: p.refusal?.bodies} : {recovery: p.recovery?.lastRung ? 'rung 3' : 'rung 2'}; });
  out.run = {ticks: ran, fromTick: tick0, msPerTick: ran ? +((performance.now() - t1) / ran).toFixed(2) : 0, state: halted(host) ? 'halted' : 'running', halt: halted(host) ? String(host.stepFailing ?? host.clockFailure?.message ?? 'paused').slice(0, 300) : null,
    head: head(host), glitches: host.glitches, rewinds: host.rewinds, repairs: rows.slice(0, 50), repairCount: rows.length, violations: host.engine.runtime.violations.filter((v) => v.tick >= tick0).slice(0, 10)};
  console.log = quiet.log; console.warn = quiet.warn;
  out.log = said.filter((l) => /\[boot\]|\[world\]/.test(l)).slice(-20);
  out.ok = out.adoption.result !== 'refused' && out.run.state === 'running' && /\+souls-repair\//.test(out.run.head.rules) === (process.env.SIM_SOULS_REPAIR !== '0' || /\+souls-repair\//.test(out.boot.head.rules));
  code = out.ok ? 0 : 2;
} catch (e) {
  out.error = String(e?.stack ?? e).slice(0, 1200);
} finally {
  try { host?.stop(); } catch {}
  try { db?.close(); } catch {}
  if (!has('--keep')) rmSync(scratchReal, {recursive: true, force: true});
}
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(code);
