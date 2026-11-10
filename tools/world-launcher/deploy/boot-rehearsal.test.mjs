// #1323: the boot rehearsal reads a copy, never the original, and reports the adoption a release's first boot will make.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture, invite, accept, seed, worldId} from '../../../apps/server/test/native-owner-fixture.ts';
import {marsFactory, GREEN_FIELD_WORLD, EDEN_SAFE_COMMONS_WORLD} from '../../../packages/engine-mars/src/engine.ts';

const script = new URL('./boot-rehearsal.mjs', import.meta.url).pathname;
const env = ['--env', 'WORLD_KEY=eden', '--env', `WORLD_ID=${worldId}`, '--env', 'ENGINE=mars', '--env', `WORLD_SEED=${seed}`];
const rehearse = (...a) => { const r = spawnSync(process.execPath, [script, ...a], {encoding: 'utf8'}); return {code: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').at(-1)) : null, err: r.stderr}; };
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

test('a 0.120 world: the rehearsal adopts on a copy, runs it, and leaves the original and its directory alone', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rehearsal-')); t.after(() => rmSync(dir, {recursive: true, force: true}));
  const data = join(dir, 'world'), db = join(data, 'sim.db'); mkdirSync(data);
  t.mock.method(console, 'log', () => {});
  const f = fixture(db, await marsFactory({...GREEN_FIELD_WORLD}));   // 0.120's reader: no repair rules
  f.brain.quiesce(); await invite(f, 'ada'); await accept(f.host, f.souls.create('dev:ada', {name: 'Ada', description: 'Rehearsal fixture'}));
  for (let i = 0; i < 60; i++) { f.host.tickOnce(); f.host.drainInputs(); } f.host.saveSnapshot(true);
  const oldRules = f.host.engine.rulesVersion; f.host.stop(); f.db.close();
  const before = sha(db);
  const scratch = join(dir, 'scratch'), r = rehearse('--db', db, '--scratch', scratch, '--ticks', '200', ...env);
  assert.equal(r.code, 0, r.err + JSON.stringify(r.out));
  assert.equal(r.out.boot.head.rules, oldRules); assert.equal(r.out.adoption.result, 'adopted');
  assert.equal(r.out.adoption.head.rules, oldRules + '+souls-repair/1'); assert.equal(r.out.adoption.header, r.out.adoption.head.rules);
  assert.equal(r.out.run.state, 'running'); assert.equal(r.out.run.ticks, 200); assert.equal(r.out.run.head.tick, r.out.adoption.head.tick + 200);
  assert.equal(sha(db), before, 'the original is untouched'); assert.equal(existsSync(scratch), false, 'the copy is removed');
  // SIM_SOULS_REPAIR=0: the same world adopts nothing and runs as 0.120 does
  const off = rehearse('--db', db, '--scratch', join(dir, 'scratch-off'), '--ticks', '50', ...env, '--env', 'SIM_SOULS_REPAIR=0');
  assert.equal(off.code, 0, off.err + JSON.stringify(off.out)); assert.equal(off.out.adoption.result, 'none'); assert.equal(off.out.run.head.rules, oldRules);
  // a scratch inside the world's data directory is refused, before anything is copied
  const inside = rehearse('--db', db, '--scratch', join(data, 'copy'), ...env);
  assert.equal(inside.code, 1); assert.match(inside.err, /outside the world's data directory/); assert.equal(sha(db), before);
});

test('an Eden core world (durable clock, its history reader): the rehearsal replays to the frontier, adopts and runs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rehearsal-eden-')); t.after(() => rmSync(dir, {recursive: true, force: true}));
  const data = join(dir, 'world'), db = join(data, 'sim.db'); mkdirSync(data);
  t.mock.method(console, 'log', () => {});
  const f = fixture(db, await marsFactory({...EDEN_SAFE_COMMONS_WORLD, safeCrewRemoval: true}), {durableClockV1: true});
  f.brain.quiesce(); await invite(f, 'ada'); await accept(f.host, f.souls.create('dev:ada', {name: 'Ada', description: 'Rehearsal fixture'}));
  for (let i = 0; i < 60; i++) { f.host.tickOnce(); f.host.drainInputs(); } f.host.saveSnapshot(true); for (let i = 0; i < 20; i++) { f.host.tickOnce(); f.host.drainInputs(); }
  const live = f.host.engine.stateHash(), tick = f.host.engine.world.tick; f.host.stop(); f.db.close();
  const r = rehearse('--db', db, '--scratch', join(dir, 'scratch'), '--ticks', '100', ...env, '--env', 'ENABLE_EDEN_CORE=1');
  assert.equal(r.code, 0, r.err + JSON.stringify(r.out)); assert.equal(r.out.world.edenCore, true);
  assert.deepEqual([r.out.boot.head.tick, r.out.boot.head.engine], [tick, live], 'replayed to the live frontier');
  assert.equal(r.out.adoption.result, 'adopted'); assert.equal(r.out.run.state, 'running'); assert.match(r.out.run.head.rules, /\+souls-repair\/1/);
});
