#!/usr/bin/env node
// The daily usage table (Engine v2 O21, #3325; today's #1942 carried over): per Soul and UTC day, its acts, its
// refusals and the client of its latest request, in one SQLite file, the operator's store. It keeps the owning
// account id there and nowhere else; nothing in it is published. No text, no token.
//
// Source: the gateway's receipts (I4), one JSON line per answered intent in `<worlds root>/worlds/<world>/receipts/
// <UTC day>.jsonl`: {"t": ms, "soul": "<id>", "account": "<id>", "outcome": "receipt" | "refusal", "client":
// "<name/version>"}. A world whose receipts it cannot read (no receipts folder, an unreadable file) is recorded as
// skipped for that day, never as zero. A world with a receipts folder and no file for the day had no acts: zero.
// Rolling up a day again replaces its rows. Reading files wakes no world.
//
//   node usage.mjs rollup --root <worlds root> --store <usage.sqlite> [--day YYYY-MM-DD]   (default: yesterday)
//   node usage.mjs report --store <usage.sqlite> [--days 7] [--json]
import { isMain } from '../../../../tools/lib/is-main.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DAY_MS = 86_400_000;
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_daily (day TEXT NOT NULL, world TEXT NOT NULL, soul TEXT NOT NULL, account TEXT,
  acts INTEGER NOT NULL, refusals INTEGER NOT NULL, last_client TEXT, last_at INTEGER NOT NULL, PRIMARY KEY (day, world, soul));
CREATE TABLE IF NOT EXISTS usage_worlds (day TEXT NOT NULL, world TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('read', 'skipped')), reason TEXT, PRIMARY KEY (day, world));`;

/** One world's Souls for one day: [{soul, account, acts, refusals, last_client, last_at}]. Throws when it cannot read. */
export function readWorld(root, world, day) {
  const dir = join(root, 'worlds', world, 'receipts');
  readdirSync(dir); // no receipts folder: cannot read
  let text;
  try { text = readFileSync(join(dir, `${day}.jsonl`), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const souls = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let x;
    try { x = JSON.parse(line); } catch { continue; } // a torn last line
    if (typeof x?.soul !== 'string') continue;
    let r = souls.get(x.soul);
    if (!r) souls.set(x.soul, r = { soul: x.soul, account: null, acts: 0, refusals: 0, last_client: null, last_at: -Infinity });
    if (x.outcome === 'refusal') r.refusals++; else if (x.outcome === 'receipt') r.acts++;
    if (typeof x.account === 'string') r.account = x.account;
    if (x.t >= r.last_at) { r.last_at = x.t; if (typeof x.client === 'string') r.last_client = x.client; }
  }
  return [...souls.values()];
}

export function open(store) {
  const db = new DatabaseSync(store);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

/** Rolls up `day` for every world under `root` into `store`: {day, read: [world], skipped: [{world, reason}]}. */
export function rollupDay(store, root, day) {
  let worlds = [];
  try { worlds = readdirSync(join(root, 'worlds')).filter((n) => !n.startsWith('.')).sort(); } catch { /* none */ }
  const db = open(store), result = { day, read: [], skipped: [] };
  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM usage_daily WHERE day = ?').run(day);
    db.prepare('DELETE FROM usage_worlds WHERE day = ?').run(day);
    const put = db.prepare('INSERT INTO usage_daily VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const mark = db.prepare('INSERT INTO usage_worlds VALUES (?, ?, ?, ?)');
    for (const world of worlds) {
      let rows;
      try { rows = readWorld(root, world, day); } catch (e) {
        const reason = e.code === 'ENOENT' ? 'no-receipts' : String(e.code ?? e.message);
        mark.run(day, world, 'skipped', reason);
        result.skipped.push({ world, reason });
        continue;
      }
      for (const r of rows) put.run(day, world, r.soul, r.account, r.acts, r.refusals, r.last_client, Number.isFinite(r.last_at) ? r.last_at : 0);
      mark.run(day, world, 'read', null);
      result.read.push(world);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.close(); }
  return result;
}

/** The last `days` days: per day, each world's status and totals, and per Soul its row (account ids are left out). */
export function report(store, days = 7, now = Date.now()) {
  const from = dayOf(now - days * DAY_MS);
  const db = open(store);
  try {
    const worlds = db.prepare('SELECT day, world, status, reason FROM usage_worlds WHERE day > ? ORDER BY day, world').all(from);
    const souls = db.prepare('SELECT day, world, soul, acts, refusals, last_client FROM usage_daily WHERE day > ? ORDER BY day, world, soul').all(from);
    return { worlds: worlds.map((w) => ({ ...w })), souls: souls.map((s) => ({ ...s })) };
  } finally { db.close(); }
}

export function text(r) {
  const lines = ['day         world  status   souls  acts  refusals'];
  for (const w of r.worlds) {
    const s = r.souls.filter((x) => x.day === w.day && x.world === w.world);
    const sum = (k) => s.reduce((a, x) => a + x[k], 0);
    lines.push(w.status === 'skipped'
      ? `${w.day}  ${w.world.slice(0, 12)}  skipped (${w.reason})`
      : `${w.day}  ${w.world.slice(0, 12)}  read     ${String(s.length).padStart(5)}  ${String(sum('acts')).padStart(4)}  ${String(sum('refusals')).padStart(8)}`);
  }
  return lines.join('\n');
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
  if (argv[0] === 'rollup') {
    const r = rollupDay(opt('store'), opt('root', process.env.WORLDS_ROOT ?? '/var/lib/souls/worlds'), opt('day', dayOf(Date.now() - DAY_MS)));
    console.log(JSON.stringify(r));
  } else if (argv[0] === 'report') {
    const r = report(opt('store'), Number(opt('days', 7)));
    console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : text(r));
  } else {
    console.error('usage: usage.mjs rollup --root <worlds root> --store <file> [--day D] | report --store <file> [--days N] [--json]');
    process.exit(2);
  }
}
