// #2541 (Scaling H5): the numbers a spike needs are exported, alerted on, and reach a person through /__sim/healthz.
// A1: each new series and each new rule (fire and resolve), through the real collector path on a fake clock.
// A2: a firing rule that pages makes /__sim/healthz report hostOk: false with its code; resolving clears it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { metricsText } from './metrics.mjs';
import { metricsUrlFromArgs, openStore, scrapeOnce } from './telemetry.mjs';
import { catchUp, problemsOf, rulesWith } from './telemetry/alerts.mjs';
import { openLauncher } from './launcher.mjs';
import { testPort } from '../lib/test-port.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const tmp = (t) => { mkdirSync(join(ROOT, '.local'), { recursive: true }); const d = mkdtempSync(join(ROOT, '.local', 'spike-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const S = 1000, MIN = 60 * S, EVERY = 15 * S, T0 = Date.UTC(2026, 10, 16, 0, 0, 0), GB = 1e9;
const val = (text, sel) => { const line = text.split('\n').find((l) => l.startsWith(`${sel} `)); return line === undefined ? undefined : Number(line.slice(sel.length + 1)); };
const live = (t) => ({ v: 1, pid: 1, at: t - 2 * S, phase: 'serving', loop: { lastTurnAgeMs: 10, delayP99Ms: 20, elu: 0.3 }, tick: { world: 1, service5s: 1, p99Ms: 30, lateTotal: 0 },
  heap: { usedMb: 500, limitMb: 2048, gcPct10s: 1 }, level: 'green', queue: { depth: 0, oldestMs: 0 }, souls: { awake: 1, waiting: 0, connected: 1 }, shed: {} });
const QUIET = { loopDelayP99Ms: 5, worldsCreated: 0, diskFreeBytes: 200 * GB, diskSizeBytes: 300 * GB };

/** scene(s) → {launcher?: {...}, viewers?: n}; one scrape every 15 s, alerts evaluated after each (as `collect --alerts`). */
async function run(dir, scene, { to, problems = null } = {}) {
  const store = openStore(dir, { everyMs: EVERY }), events = [];
  for (let s = 0; s < to; s += EVERY / S) {
    const t = T0 + s * S, x = scene(s);
    const body = metricsText({ now: t, launcher: { build: 'test', memAvailableMb: 8192, ...QUIET, ...x.launcher }, worlds: [{ slug: 'a', status: 'running', restarts: 0, viewers: x.viewers ?? 3, live: live(t) }] });
    await scrapeOnce(store, 'http://127.0.0.1:1/__sim/metrics', { now: () => t, fetchImpl: async () => ({ ok: true, status: 200, text: async () => body }) });
    events.push(...catchUp(dir, { everyMs: EVERY, now: t, problems }).events.map((e) => ({ ...e, s })));
  }
  store.saveState();
  return events;
}
const of = (ev, rule) => ev.filter((e) => e.rule === rule).map((e) => [e.to, e.s]);

test('A1 series: viewers per world, the launcher\'s loop delay, worlds created, disk free and size; labels are the world slug only', () => {
  const t = metricsText({ now: T0, launcher: { loopDelayP99Ms: 312, worldsCreated: 7, diskFreeBytes: 41 * GB, diskSizeBytes: 300 * GB },
    worlds: [{ slug: 'eden-2026', status: 'running', viewers: 1204 }, { slug: 'quiet', status: 'asleep', viewers: 0 }] });
  assert.equal(val(t, 'sim_world_viewers{world="eden-2026"}'), 1204);
  assert.equal(val(t, 'sim_world_viewers{world="quiet"}'), 0, 'zero viewers is a reading, not missing');
  assert.equal(val(t, 'sim_launcher_event_loop_delay_p99_seconds'), 0.312);
  assert.equal(val(t, 'sim_site_worlds_created_total'), 7);
  assert.match(t, /# TYPE sim_site_worlds_created_total counter/);
  assert.equal(val(t, 'sim_host_disk_free_bytes'), 41 * GB);
  assert.equal(val(t, 'sim_host_disk_size_bytes'), 300 * GB);
  const bare = metricsText({ now: T0, worlds: [{ slug: 'eden-2026', status: 'running' }] });
  for (const n of ['sim_world_viewers{world="eden-2026"}', 'sim_launcher_event_loop_delay_p99_seconds', 'sim_site_worlds_created_total', 'sim_host_disk_free_bytes']) assert.equal(val(bare, n), undefined, `${n}: not reported, left out`);
  for (const l of t.split('\n').filter((x) => /^sim_(world_viewers|launcher_event|site_|host_disk)/.test(x))) assert.match(l, /^[a-z0-9_]+(\{world="[a-z0-9-]+"\})? /, l);
});

test('A1 rules: the launcher\'s loop stall fires within 60 s and resolves below 0.15 s', async (t) => {
  const ev = await run(tmp(t), (s) => ({ launcher: { loopDelayP99Ms: s >= 300 && s < 600 ? 400 : s >= 600 && s < 700 ? 200 : 5 } }), { to: 900 });
  const got = of(ev, 'launcher-loop-stall');
  assert.deepEqual(got.map((x) => x[0]), ['firing', 'resolved']);
  assert.ok(got[0][1] - 300 <= 60, `fired at ${got[0][1]} s`);
  assert.ok(got[1][1] >= 700, 'hysteresis: 0.2 s is still over the 0.15 s clear threshold');
});

test('A1 rules: more than 10 worlds created in an hour fires, across a launcher restart, and resolves when the hour has passed', async (t) => {
  // 6 worlds in the first 5 min, a restart (the counter starts again at 0), 5 more by 10 min: 11 in the hour
  const created = (s) => (s < 300 ? Math.floor(s / 45) : s < 315 ? 0 : Math.min(5, Math.floor((s - 315) / 60) + 1));
  const ev = await run(tmp(t), (s) => ({ launcher: { worldsCreated: created(s) } }), { to: 80 * 60 });
  const got = of(ev, 'worlds-created');
  assert.deepEqual(got.map((x) => x[0]), ['firing', 'resolved']);
  assert.ok(got[0][1] <= 600, `fired at ${got[0][1]} s`);
  assert.ok(got[1][1] > 3600 && got[1][1] <= 3600 + 300 + 120, `resolved at ${got[1][1]} s, once the first creations left the hour`);
  const ten = await run(tmp(t), (s) => ({ launcher: { worldsCreated: Math.min(10, Math.floor(s / 30)) } }), { to: 900 });
  assert.deepEqual(of(ten, 'worlds-created'), [], 'ten in an hour is not more than ten');
});

test('A1 rules: disk free under 20 % fires and resolves; viewers over 1,000 on one world is recorded and never pages', async (t) => {
  const dir = tmp(t), problems = join(dir, 'alert-problems.json'), seen = [];
  const scene = (s) => ({ launcher: { diskFreeBytes: (s >= 120 && s < 400 ? 0.15 : 0.4) * 300 * GB }, viewers: s >= 200 && s < 500 ? 1500 : 40 });
  const store = openStore(dir, { everyMs: EVERY }), ev = [];
  for (let s = 0; s < 800; s += 15) {   // the same path as run(), reading the problems file at each step
    const t1 = T0 + s * S, x = scene(s);
    const body = metricsText({ now: t1, launcher: { ...QUIET, ...x.launcher }, worlds: [{ slug: 'a', status: 'running', viewers: x.viewers, live: live(t1) }] });
    await scrapeOnce(store, 'http://127.0.0.1:1/__sim/metrics', { now: () => t1, fetchImpl: async () => ({ ok: true, status: 200, text: async () => body }) });
    ev.push(...catchUp(dir, { everyMs: EVERY, now: t1, problems }).events.map((e) => ({ ...e, s })));
    seen.push(JSON.parse(readFileSync(problems, 'utf8')).problems.map((p) => p.code).join(','));
  }
  assert.deepEqual(of(ev, 'disk-free').map((x) => x[0]), ['firing', 'resolved']);
  const v = ev.filter((e) => e.rule === 'viewers-high');
  assert.deepEqual(v.map((e) => [e.to, e.world]), [['firing', 'a'], ['resolved', 'a']]);
  const lines = readFileSync(join(dir, 'alerts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.rule === 'viewers-high' && l.to === 'firing' && l.value === 1500), 'in alerts.jsonl');
  assert.ok(seen.some((c) => c === 'alert:disk-free'), 'disk-free pages');
  assert.ok(!seen.some((c) => c.includes('viewers')), 'viewers-high never pages');
  assert.equal(seen.at(-1), '', 'resolved: no codes left');
});

test('A1 rules: refusals stay information; every other rule pages', () => {
  const pages = rulesWith().filter((r) => r.page !== false).map((r) => r.id);
  assert.ok(!pages.includes('viewers-high') && !pages.includes('refusals'));
  for (const id of ['launcher-loop-stall', 'worlds-created', 'disk-free', 'loop-stall', 'host-memory', 'telemetry-gap']) assert.ok(pages.includes(id), id);
  const st = { keys: { 'disk-free|': { state: 'firing' }, 'viewers-high|a': { state: 'firing' }, 'loop-stall|a': { state: 'unknown' } } };
  assert.deepEqual(problemsOf(st, rulesWith()).map((p) => p.code), ['alert:disk-free'], 'only firing rules that page; unknown is not firing');
});

test('the unit\'s collector finds the launcher from its own arguments', () => {
  assert.equal(metricsUrlFromArgs('--base /worlds --port 4620 --range 4621-4659 --data /srv/x'), 'http://127.0.0.1:4620/worlds/__sim/metrics');
  assert.equal(metricsUrlFromArgs('--port 4600'), 'http://127.0.0.1:4600/__sim/metrics');
  assert.throws(() => metricsUrlFromArgs('--base /worlds'), /no --port/);
});

test('A2: a firing rule makes /__sim/healthz report hostOk false with its code; resolving clears it at once; the launcher exports the series', async (t) => {
  const dir = tmp(t), P0 = await testPort(4), P = P0 + 3, base = `http://127.0.0.1:${P}`;
  const templatesDir = join(dir, 'templates'); mkdirSync(templatesDir);
  const webDir = join(dir, 'web'); mkdirSync(webDir); writeFileSync(join(webDir, 'index.html'), '<!doctype html>');
  const fake = new URL('./fake-world.mjs', import.meta.url).pathname, dataDir = join(dir, 'data');
  const command = (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port) } });
  const L = await openLauncher({ port: P, range: [P0, P0 + 2], dataDir, webDir, templatesDir, command, eager: 0, log: () => {}, prewarm: false, publicOrigin: 'http://sim.test', devAuth: true });
  t.after(() => L.close());
  const health = async () => (await fetch(`${base}/__sim/healthz`)).json();
  const { slug } = await (await fetch(`${base}/__sim/worlds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Spike' }) })).json();
  const m = await (await fetch(`${base}/__sim/metrics`)).text();
  assert.equal(val(m, 'sim_site_worlds_created_total'), 1);
  assert.equal(val(m, `sim_world_viewers{world="${slug}"}`), 0);
  assert.ok(val(m, 'sim_launcher_event_loop_delay_p99_seconds') >= 0);
  assert.ok(val(m, 'sim_host_disk_free_bytes') > 0 && val(m, 'sim_host_disk_size_bytes') >= val(m, 'sim_host_disk_free_bytes'));
  assert.equal((await health()).hostOk, undefined, 'no host check and no alerts file: nothing to report');

  // the collector's own evaluation, firing then resolving, writing the file the launcher reads (as the unit runs it);
  // real time, so the file is fresh, and no hold or clear window, so one scrape each way
  const tele = join(dataDir, 'telemetry'), problems = join(dataDir, 'alert-problems.json'), store = openStore(tele, { everyMs: EVERY });
  const rules = rulesWith({ 'disk-free': { holdMs: 0, clearMs: 0 } });
  let last = 0;
  const step = async (freeShare) => {
    const at = Math.max(Date.now(), last + 1); last = at;
    const body = metricsText({ now: at, launcher: { ...QUIET, diskFreeBytes: freeShare * 300 * GB }, worlds: [] });
    await scrapeOnce(store, 'http://127.0.0.1:1/__sim/metrics', { now: () => at, fetchImpl: async () => ({ ok: true, status: 200, text: async () => body }) });
    return catchUp(tele, { rules, everyMs: EVERY, now: at, problems }).events.filter((e) => e.rule === 'disk-free').map((e) => e.to);
  };
  assert.deepEqual(await step(0.1), ['firing']);
  const h1 = await health();
  assert.equal(h1.hostOk, false); assert.deepEqual(h1.hostCodes, ['alert:disk-free']);
  assert.deepEqual(await step(0.5), ['resolved']);
  const done = JSON.parse(readFileSync(problems, 'utf8'));
  assert.deepEqual(done.problems, []);
  const h2 = await health();
  assert.notEqual(h2.hostOk, false); assert.equal(h2.hostCodes, undefined);
  // a timer copy of the old alert in host-health.json does not hold it: the alerts file read now wins
  writeFileSync(join(dataDir, 'host-health.json'), JSON.stringify({ ok: false, at: new Date().toISOString(), codes: ['alert:disk-free'], problems: ['x'] }));
  assert.equal((await health()).hostOk, true);
  // a collector that died (the file stopped changing) is a problem too
  writeFileSync(problems, JSON.stringify({ ...done, at: new Date(Date.now() - 10 * MIN).toISOString() }));
  assert.deepEqual((await health()).hostCodes, ['alert:stale']);
});
