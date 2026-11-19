#!/usr/bin/env node
// The watcher's look at one machine (Engine v2 O15, #2808): GET /ops/watch, answered from files only, so no look
// wakes a world. The watcher off the machine (watch.mjs) asks for it three times over 20 s each minute.
//
// What it reads, under the machine's worlds root ($WORLDS_ROOT):
// - the worlds this machine knows of and their O4 health files (../health/read.mjs: supervisor records, state folders,
//   W8's cached directory records);
// - the supervisor's record, `health/<world>.json` (O1): `running`, `starting`, `restarting` and `restart-loop` are
//   awake; `stopped` (a planned stop, or a world gone to sleep, exit 75) is not;
// - the directory's alarm record (O2): one line per sleeping world, `<world> <due µs>` or `<world> none`. A world it
//   lists is asleep, so healthy, whatever else is on the disk.
// An awake world is in trouble when:
//   `down`         its health file is missing or older than STALE_MS (the process is gone or frozen; O4's writer
//                  thread outlives a stuck clock, so a stale file is not a stall);
//   `stalled`      its health file was rewritten between two reads PAUSE_MS apart and no tick was counted;
//   `lag`          a queue's oldest item is older than the declared bound (`--lag-bound-ms`, default LAG_BOUND_MS);
//   `restart-loop` the supervisor's own verdict: five starts in five minutes and not serving.
// It also carries the page-error service's new kinds (O25, #3336): `page_errors`, from its `health.json` (default
// `<root>/../page-errors/health.json`, `--page-errors`), each new kind's fingerprint, kind and scrubbed text.
// Each look writes `<root>/watcher.json` ({"at_unix_ms"}), which the site owner's health page shows as the watcher's
// last look (A4). It reports; it restarts nothing.
//
//   node look.mjs --root <worlds root> [--alarms <directory>/alarms/<machine>] [--lag-bound-ms 5000] [--page-errors <health.json>] [--port 8091] [--host 127.0.0.1]
// With WATCH_TOKEN set, a look needs `Authorization: Bearer $WATCH_TOKEN`. The answer carries world ids and trouble
// codes only, and page errors' scrubbed text: no Soul, account, token or words.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AWAKE, healthFile, worlds } from '../health/read.mjs';

export const PATH = '/ops/watch';
export const STALE_MS = 10_000;     // five missed writes of O4's 2 s health file
export const PAUSE_MS = 2_500;      // longer than one health write, so a living writer has written again
export const LAG_BOUND_MS = 5_000;  // a queue's oldest item; a tick's budget is 50 ms

const json = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/** The worlds the directory's alarm record calls asleep (O2's `alarms/<machine>`); empty when there is none. */
export function asleep(alarms) {
  if (!alarms) return new Set();
  try {
    return new Set(readFileSync(alarms, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
  } catch { return new Set(); }
}

/** One look at every world on the machine: `{at_unix_ms, worlds: [{world, state, trouble, detail}]}`. */
export async function look(root, { alarms, lagBoundMs = LAG_BOUND_MS, pageErrors = join(root, '..', 'page-errors', 'health.json'), now = Date.now, pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const sleeping = asleep(alarms);
  const all = worlds(root);
  const first = new Map(all.map((w) => [w, healthFile(root, w)]));
  await pause(PAUSE_MS);
  const t = now();
  const rows = all.map((world) => {
    const sup = json(join(root, 'health', `${world}.json`));
    const state = sleeping.has(world) ? 'asleep' : (sup?.state ?? 'unknown');
    const row = { world, state, trouble: null, detail: null };
    if (!AWAKE.has(state)) return row;  // asleep, stopped, or never started here: healthy, and never probed
    if (state === 'restart-loop') return { ...row, trouble: 'restart-loop', detail: `${sup.count} starts in 5 min, last exit ${sup.last_exit}` };
    const h = healthFile(root, world), before = first.get(world);
    const age = Number.isFinite(h?.at_unix_ms) ? t - h.at_unix_ms : null;
    if (age == null || age > STALE_MS) return { ...row, trouble: 'down', detail: age == null ? 'no health file' : `no health written for ${Math.round(age / 1000)} s` };
    if (before && h.written > before.written && h.ticks?.count === before.ticks?.count) {
      return { ...row, trouble: 'stalled', detail: `no tick in ${PAUSE_MS / 1000} s while its health thread wrote` };
    }
    const lag = Math.max(0, ...Object.values(h.queues ?? {}).map((q) => q.oldest_us ?? 0)) / 1000;
    if (lag > lagBoundMs) return { ...row, trouble: 'lag', detail: `oldest queued item ${Math.round(lag)} ms > ${lagBoundMs} ms` };
    return row;
  });
  const tmp = join(root, 'watcher.json.tmp');
  try { writeFileSync(tmp, JSON.stringify({ at_unix_ms: t })); renameSync(tmp, join(root, 'watcher.json')); } catch { /* the page shows the last look that was written */ }
  const pe = json(pageErrors);
  const page_errors = Array.isArray(pe?.new) ? { build: String(pe.build), new: pe.new.slice(0, 20).map((k) => ({ fp: String(k.fp), kind: String(k.kind), message: String(k.message ?? '') })) } : null;
  return { at_unix_ms: t, worlds: rows, page_errors };
}

/** A server for the look alone. */
export function serve({ root, alarms, lagBoundMs, pageErrors, token = process.env.WATCH_TOKEN, pause }) {
  return createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (new URL(req.url, 'http://x').pathname !== PATH || req.method !== 'GET') return send(404, { error: 'not-found' });
    if (token && req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'not-the-watcher' });
    send(200, await look(root, { alarms, lagBoundMs, pageErrors, pause }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
  const root = opt('root', process.env.WORLDS_ROOT ?? '/var/lib/souls/worlds');
  const server = serve({ root, alarms: opt('alarms', join(root, 'directory', 'alarms', process.env.SOULS_MACHINE ?? 'local')), lagBoundMs: Number(opt('lag-bound-ms', LAG_BOUND_MS)), pageErrors: opt('page-errors') });
  server.listen(Number(opt('port', 8091)), opt('host', '127.0.0.1'), () => console.log(`watch look ${server.address().port}`));
}
