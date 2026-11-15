// srv-load: the watchdog thread keeps live.json and its own /healthz honest while the main thread is stuck (LOAD-CONTRACT §4).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const here = new URL('.', import.meta.url).pathname;

test('a main thread busy for 4 s: live.json keeps being rewritten and the worker /healthz answers, showing the stuck turn', {timeout: 30_000}, async t => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'souls-watchdog-')); t.after(() => rmSync(dir, {recursive: true, force: true}));
  const script = `
    import {startWatchdog} from ${JSON.stringify(join(here, 'load/watchdog.ts'))};
    import {bootPhase} from ${JSON.stringify(join(here, 'load/boot-progress.ts'))};
    bootPhase('serving', 7);
    startWatchdog({dataDir: ${JSON.stringify(dir)}, port: 0, everyMs: 200, onListening: port => {
      console.log('PORT ' + port);
      setTimeout(() => { console.log('BUSY'); const end = Date.now() + 4000; while (Date.now() < end) {} console.log('FREE'); setTimeout(() => process.exit(0), 300); }, 300);
    }});
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio: ['ignore', 'pipe', 'inherit']});
  t.after(() => child.kill('SIGKILL'));
  let out = ''; const seen = (s: string) => new Promise<void>(r => { const f = () => { if (out.includes(s)) { child.stdout!.off('data', g); r(); } }; const g = (b: Buffer) => { out += b; f(); }; child.stdout!.on('data', g); f(); });
  await seen('PORT '); const port = Number(/PORT (\d+)/.exec(out)![1]);
  await seen('BUSY');
  const t0 = Date.now();
  await new Promise(r => setTimeout(r, 2500));
  const live = JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8'));
  assert.ok(live.at >= t0 + 1500, 'rewritten while the main thread is stuck');
  assert.ok(live.loop.lastTurnAgeMs >= 1500, `the stuck turn shows: ${live.loop.lastTurnAgeMs}`);
  assert.equal(live.phase, 'serving'); assert.equal(live.v, 1); assert.equal(live.pid, child.pid);
  const a = performance.now(), r = await fetch(`http://127.0.0.1:${port}/healthz`, {signal: AbortSignal.timeout(1000)});
  assert.ok(performance.now() - a < 1000, 'answered within 1 s');
  assert.equal(r.status, 200); const h = await r.json() as {ok: boolean; loop: {lastTurnAgeMs: number}};
  assert.equal(h.ok, true); assert.ok(h.loop.lastTurnAgeMs >= 2000);
  assert.ok(!out.includes('FREE'), 'all of this while the main thread was still busy');
});

test('#2444: a shard program has one watchdog thread for all its worlds; a stopped world is no longer watched', {timeout: 30_000}, async t => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'souls-watchdog-')); t.after(() => rmSync(dir, {recursive: true, force: true}));
  const script = `
    import {shareWatchdog, startWatchdog} from ${JSON.stringify(join(here, 'load/watchdog.ts'))};
    import {newWorldLoad, S} from ${JSON.stringify(join(here, 'load/shared.ts'))};
    import {mkdirSync} from 'node:fs';
    const root = ${JSON.stringify(dir)}, dog = shareWatchdog(), a = newWorldLoad(), b = newWorldLoad();
    a.boot.phase('serving', 3); b.boot.phase('serving', 9);
    for (const d of ['a', 'b']) mkdirSync(root + '/' + d);
    const wa = startWatchdog({dataDir: root + '/a', everyMs: 100, shared: a.shared, api: a.api});
    const wb = startWatchdog({dataDir: root + '/b', everyMs: 100, shared: b.shared, api: b.api});
    console.log('ONE ' + (wa === dog.worker && wb === dog.worker));
    // (removed once the thread has written both worlds' live.json: under load it starts slowly)
    const {existsSync} = await import('node:fs');
    const ready = setInterval(() => { if (!existsSync(root + '/a/live.json') || !existsSync(root + '/b/live.json')) return; clearInterval(ready); setTimeout(() => { dog.remove(root + '/a'); console.log('REMOVED'); }, 300); }, 50);
    setInterval(() => { a.shared[S.lastTurnAt] = b.shared[S.lastTurnAt] = Date.now(); }, 50);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio: ['ignore', 'pipe', 'inherit']});
  t.after(() => child.kill('SIGKILL'));
  let out = ''; child.stdout!.on('data', (b: Buffer) => { out += b; });
  for (let i = 0; i < 250 && !out.includes('REMOVED'); i++) await new Promise(r => setTimeout(r, 100));
  assert.match(out, /ONE true/, 'both worlds are watched by the program\'s one thread');
  await new Promise(r => setTimeout(r, 300));
  const live = (d: string) => JSON.parse(readFileSync(join(dir, d, 'live.json'), 'utf8'));
  const [a0, b0] = [live('a'), live('b')];
  assert.equal(a0.pid, child.pid); assert.equal(b0.pid, child.pid);
  assert.equal(a0.phase, 'serving'); assert.equal(b0.phase, 'serving');
  await new Promise(r => setTimeout(r, 600));
  assert.equal(live('a').at, a0.at, 'the removed world\'s live.json is no longer written');
  assert.ok(live('b').at > b0.at, 'the other world\'s still is');
});

for (const stepped of [true, false]) test(`#2444 review: a hang in a shard ${stepped ? 'names the world whose tick was running' : 'with no tick running names no world'}`, {timeout: 30_000}, async t => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'souls-watchdog-')); t.after(() => rmSync(dir, {recursive: true, force: true}));
  const script = `
    import {shareWatchdog, startWatchdog} from ${JSON.stringify(join(here, 'load/watchdog.ts'))};
    import {newWorldLoad, S} from ${JSON.stringify(join(here, 'load/shared.ts'))};
    import {existsSync, mkdirSync} from 'node:fs';
    const root = ${JSON.stringify(dir)}, kill = {hangMs: 800, heapPct: 0, heapMs: 0, gcPct: 0}, a = newWorldLoad(), b = newWorldLoad();
    shareWatchdog(); a.boot.phase('serving', 3); b.boot.phase('serving', 9);
    for (const d of ['a', 'b']) mkdirSync(root + '/' + d);
    startWatchdog({dataDir: root + '/a', everyMs: 100, shared: a.shared, api: a.api, kill});
    startWatchdog({dataDir: root + '/b', everyMs: 100, shared: b.shared, api: b.api, kill});
    const turn = setInterval(() => { a.shared[S.lastTurnAt] = b.shared[S.lastTurnAt] = Date.now(); }, 50);
    const ready = setInterval(() => {
      if (!existsSync(root + '/a/live.json') || !existsSync(root + '/b/live.json')) return;
      clearInterval(ready); clearInterval(turn);
      ${stepped ? 'b.shared[S.step] = 3; b.shared[S.stepTick] = 9;' : ''}
      const until = Date.now() + 20_000; while (Date.now() < until) { /* the thread is held */ }
    }, 50);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => child.kill('SIGKILL'));
  let err = ''; child.stderr!.on('data', (b: Buffer) => { err += b; });
  const signal = await new Promise<string | null>(r => child.once('exit', (_c, s) => r(s)));
  assert.equal(signal, 'SIGKILL', `the watchdog ended the program (${err.slice(-500)})`);
  const killed = (d: string) => JSON.parse(readFileSync(join(dir, d, 'live.json'), 'utf8')).killed ?? null;
  assert.equal(killed('a'), null, 'a, serving with no tick running, is never named');
  if (stepped) assert.equal(killed('b')?.reason, 'hang', 'b, whose tick was running, is named');
  else { assert.equal(killed('b'), null, 'nor is b'); assert.match(err, /no world's tick running: ending the program, no world named/); }
});
