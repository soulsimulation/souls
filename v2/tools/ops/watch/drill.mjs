#!/usr/bin/env node
// O15's proof run (#2808), in real time on this machine: two test instances (worlds roots under --dir, each with a
// look server), stand-in worlds that write O4's health file every 2 s and O1's supervisor record, and the watcher
// every 60 s with the file sink. About 8 minutes. Prints each message with its delay from the event, and the silences.
//
//   node v2/tools/ops/watch/drill.mjs --dir <empty folder>
// Timeline (s): 15 a world killed and held down; 40 a planned stop; 70 a deploy restarts two worlds and one look
// server; 130 the killed world back and another's clock stalls; 250 the clock runs again and instance b is gone;
// 370 instance b back. A sleeping world sits in the directory's alarm record throughout.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from './look.mjs';
import { run, sink } from './watch.mjs';

const argv = process.argv.slice(2), dir = argv[argv.indexOf('--dir') + 1];
const t0 = Date.now(), at = (s) => new Promise((r) => setTimeout(r, Math.max(0, t0 + s * 1000 - Date.now())));
const rel = (ms) => +((ms - t0) / 1000).toFixed(1);

function world(root, name, alarms) {
  const w = { ticks: 0, written: 0, timer: null, stalled: false };
  mkdirSync(join(root, 'worlds', name), { recursive: true });
  const sup = (state) => writeFileSync(join(root, 'health', `${name}.json`), JSON.stringify({ state, count: 1, failures: 0, last_exit: null }));
  const beat = () => {
    w.written += 1; if (!w.stalled) w.ticks += 40;
    writeFileSync(join(root, 'worlds', name, 'health.json'), JSON.stringify({ at_unix_ms: Date.now(), written: w.written, budget_us: 50_000, ticks: { count: w.ticks }, queues: {} }));
  };
  return Object.assign(w, {
    start() { w.ticks = 0; w.written = 0; sup('running'); beat(); w.timer = setInterval(beat, 2000); },
    stop(state) { clearInterval(w.timer); w.timer = null; sup(state); },
    kill() { clearInterval(w.timer); w.timer = null; },     // SIGKILL'd and held down: the record still says running
    asleep() { sup('stopped'); writeFileSync(alarms, `${name} none\n`, { flag: 'a' }); },
  });
}

async function instance(name) {
  const root = join(dir, name), alarms = join(root, 'directory', 'alarms', 'local');
  for (const d of ['health', 'worlds', 'cache', 'directory/alarms']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(alarms, '');
  const inst = { name, root, alarms, port: 0, server: null };
  inst.up = () => new Promise((r) => { inst.server = serve({ root, alarms, token: 'drill' }); inst.server.listen(inst.port, '127.0.0.1', () => { inst.port = inst.server.address().port; r(); }); });
  inst.down = () => { inst.server.close(); inst.server.closeAllConnections(); };
  await inst.up();
  return inst;
}

const A = await instance('a'), B = await instance('b');
const w = {
  killed: world(A.root, '00a1-01-0', A.alarms), stalls: world(A.root, '00a2-01-0', A.alarms), deployed: world(A.root, '00a3-01-0', A.alarms),
  planned: world(A.root, '00a4-01-0', A.alarms), sleeping: world(A.root, '00a5-01-0', A.alarms), onB: world(B.root, '00b1-01-0', B.alarms),
};
for (const k of ['killed', 'stalls', 'deployed', 'planned', 'onB']) w[k].start();
w.sleeping.asleep();
const sleeperDir = join(A.root, 'worlds', '00a5-01-0'), sleeperBefore = statSync(sleeperDir).mtimeMs;

const events = [];
const ev = (s, what, fn) => at(s).then(async () => { await fn(); events.push({ t: rel(Date.now()), what }); console.log(`${rel(Date.now())} s  ${what}`); });
const outbox = join(dir, 'messages.jsonl');
writeFileSync(outbox, '');
const send = sink(`file:${outbox}`);
const instances = [A, B].map((i) => ({ name: i.name, url: `http://127.0.0.1:${i.port}/ops/watch`, token_env: 'DRILL_TOKEN' }));
process.env.DRILL_TOKEN = 'drill';

const script = Promise.all([
  ev(15, 'kill: world 00a1-01-0 killed and held down', () => w.killed.kill()),
  ev(40, 'silence: world 00a4-01-0 planned stop', () => w.planned.stop('stopped')),
  ev(70, 'silence: deploy restarts 00a3-01-0 and 00b1-01-0 (15 s) and instance a\'s look server (4 s)', async () => {
    w.deployed.stop('restarting'); w.onB.stop('restarting'); A.down();
    setTimeout(() => A.up(), 4000);
    setTimeout(() => { w.deployed.start(); w.onB.start(); }, 15_000);
  }),
  ev(130, 'recover: world 00a1-01-0 back', () => w.killed.start()),
  ev(130, 'stall: world 00a2-01-0 clock stalls', () => { w.stalls.stalled = true; }),
  ev(250, 'recover: world 00a2-01-0 clock runs', () => { w.stalls.stalled = false; }),
  ev(250, 'unreachable: instance b gone', () => B.down()),
  ev(370, 'recover: instance b back', () => B.up()),
]);

let state = {};
for (let s = 5; s <= 425; s += 60) {
  await at(s);
  state = await run(instances, state, send);
  console.log(`${rel(Date.now())} s  run from ${s} s: down ${JSON.stringify(Object.keys(state.checks))}, sent ${state.last.sent.length}`);
}
await script;
for (const i of [A, B]) i.down();
for (const k of Object.keys(w)) clearInterval(w[k].timer);

const messages = readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((m) => ({ t: rel(m.at_unix_ms), text: m.text }));
const delay = (what, re) => { const e = events.find((x) => x.what.startsWith(what)); const m = messages.find((x) => x.t > e.t && re.test(x.text)); return m ? +(m.t - e.t).toFixed(1) : null; };
const rows = [
  ['killed and held down', delay('kill', /alert[\s\S]*00a1-01-0/), delay('recover: world 00a1', /recovered[\s\S]*00a1-01-0/)],
  ['stalled clock', delay('stall', /alert[\s\S]*00a2-01-0 on a: stalled/), delay('recover: world 00a2', /recovered[\s\S]*00a2-01-0/)],
  ['instance unreachable', delay('unreachable', /alert[\s\S]*instance b/), delay('recover: instance b', /recovered[\s\S]*instance b/)],
];
const mentions = (id) => messages.filter((m) => m.text.includes(id)).length;
const report = {
  messages, events,
  table: rows.map(([what, down, up]) => ({ what, alert_after_s: down, recovery_after_s: up })),
  silences: { deploy_restart: mentions('00a3-01-0') + mentions('00b1-01-0') + messages.filter((m) => /instance a/.test(m.text)).length, planned_stop: mentions('00a4-01-0'), sleeping: mentions('00a5-01-0') },
  sleeping_world_untouched: statSync(sleeperDir).mtimeMs === sleeperBefore,
  watcher_last_look: JSON.parse(readFileSync(join(A.root, 'watcher.json'), 'utf8')).at_unix_ms > t0,
};
writeFileSync(join(dir, 'drill.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ table: report.table, silences: report.silences, sleeping_world_untouched: report.sleeping_world_untouched, watcher_last_look: report.watcher_last_look, messages: messages.length }, null, 2));
const ok = report.table.every((r) => r.alert_after_s != null && r.alert_after_s <= 120 && r.recovery_after_s != null && r.recovery_after_s <= 120)
  && Object.values(report.silences).every((n) => n === 0) && messages.length === 6 && report.sleeping_world_untouched;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
