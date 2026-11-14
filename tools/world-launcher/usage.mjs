#!/usr/bin/env node
// #1942: one daily usage table for the whole site, in <data>/usage.sqlite, and the operator's report of it.
//
//   node tools/world-launcher/usage.mjs --data <launcher data dir> [--day YYYY-MM-DD] [--tries N] [--wait-ms N]
//        rolls up one UTC day (--day), or every day missed since the last run up to yesterday (no --day). The launcher
//        runs it in a child process shortly after it starts and then every hour (usageRollup below). Each world's
//        sim.db is opened read-only; a world whose database is busy or missing is tried again and, if still unreadable,
//        recorded as skipped for that day (usage_worlds), never as zero. Rolling up a day again replaces its rows.
//   GET <base>/__sim/usage?days=N   loopback only: the report (usageReport); op.mjs usage prints it (formatReport).
//
// Per Soul and day, from each world's own operations tables: acts (edge_receipts_v1 rows created that day), refusals
// (edge_refusals_v1), requests and the client of the latest one (edge_clients_v1, #1936), and the owning account id
// (souls.owner). Nothing else: no token, email, name or text. Operator data; nothing in it is published.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Registry } from './registry.mjs';

const DAY_MS = 86_400_000, MAX_FILL_DAYS = 31;
const SELF = fileURLToPath(import.meta.url);
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const startOf = (day) => Date.parse(`${day}T00:00:00Z`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_daily (day TEXT NOT NULL, world TEXT NOT NULL, account TEXT, soul TEXT NOT NULL, acts INTEGER NOT NULL,
  refusals INTEGER NOT NULL, requests INTEGER NOT NULL, last_client TEXT, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, PRIMARY KEY (day, world, soul));
CREATE TABLE IF NOT EXISTS usage_refusals (day TEXT NOT NULL, world TEXT NOT NULL, code TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, world, code));
CREATE TABLE IF NOT EXISTS usage_worlds (day TEXT NOT NULL, world TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('read', 'skipped')), reason TEXT,
  at INTEGER NOT NULL, PRIMARY KEY (day, world));`;

/** One world's Souls for one UTC day: { souls: [row], codes: Map(code → n) }. Throws when the store cannot be read. */
export function readWorld(file, day) {
  const from = startOf(day), to = from + DAY_MS;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const has = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const souls = new Map(), codes = new Map();
    const row = (soul) => { let r = souls.get(soul); if (!r) souls.set(soul, r = { soul, account: null, acts: 0, refusals: 0, requests: 0, last_client: null, first_at: Infinity, last_at: -Infinity }); return r; };
    const seen = (r, a, b) => { r.first_at = Math.min(r.first_at, a); r.last_at = Math.max(r.last_at, b); };
    if (has.has('edge_receipts_v1')) for (const x of db.prepare('SELECT soul_id, COUNT(*) AS n, MIN(created_at) AS a, MAX(created_at) AS b FROM edge_receipts_v1 WHERE created_at >= ? AND created_at < ? GROUP BY soul_id').all(from, to)) { const r = row(x.soul_id); r.acts = x.n; seen(r, x.a, x.b); }
    if (has.has('edge_refusals_v1')) {
      for (const x of db.prepare('SELECT soul_id, COUNT(*) AS n, MIN(at) AS a, MAX(at) AS b FROM edge_refusals_v1 WHERE at >= ? AND at < ? GROUP BY soul_id').all(from, to)) { const r = row(x.soul_id); r.refusals = x.n; seen(r, x.a, x.b); }
      for (const x of db.prepare('SELECT code, COUNT(*) AS n FROM edge_refusals_v1 WHERE at >= ? AND at < ? GROUP BY code').all(from, to)) codes.set(x.code, x.n);
    }
    // the client of the Soul's latest request that day wins (ties: the later client name, so a rerun picks the same one)
    if (has.has('edge_clients_v1')) for (const x of db.prepare('SELECT soul_id, client, first_at, last_at, n FROM edge_clients_v1 WHERE day = ? ORDER BY last_at, client').all(day)) { const r = row(x.soul_id); r.requests += x.n; seen(r, x.first_at, x.last_at); r.last_client = x.client; }
    if (has.has('souls')) { const q = db.prepare('SELECT owner FROM souls WHERE id = ?'); for (const r of souls.values()) r.account = q.get(r.soul)?.owner ?? null; }
    return { souls: [...souls.values()], codes };
  } finally { db.close(); }
}

const openOut = (file) => { const db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout = 5000'); db.exec(SCHEMA); return db; };

/** Rolls up one day for `worlds` ([{slug, file}]) into `file`: { day, read: [slug], skipped: [{world, reason}] }. */
export async function rollupDay(file, worlds, day, { tries = 3, waitMs = 2000, now = Date.now } = {}) {
  const out = openOut(file), result = { day, read: [], skipped: [] };
  try {
    for (const w of worlds) {
      let got = null, why = 'missing';
      for (let i = 0; i < tries && !got; i++) {
        if (i) await sleep(waitMs);
        if (!existsSync(w.file)) { why = 'missing'; continue; }
        try { got = readWorld(w.file, day); } catch (e) { why = String(e?.message ?? e).split('\n')[0].slice(0, 200); }
      }
      out.exec('BEGIN IMMEDIATE');
      try {
        if (got) {
          out.prepare('DELETE FROM usage_daily WHERE day = ? AND world = ?').run(day, w.slug);
          out.prepare('DELETE FROM usage_refusals WHERE day = ? AND world = ?').run(day, w.slug);
          const ins = out.prepare('INSERT INTO usage_daily (day, world, account, soul, acts, refusals, requests, last_client, first_at, last_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
          for (const r of got.souls) ins.run(day, w.slug, r.account, r.soul, r.acts, r.refusals, r.requests, r.last_client, r.first_at, r.last_at);
          const code = out.prepare('INSERT INTO usage_refusals (day, world, code, n) VALUES (?,?,?,?)');
          for (const [c, n] of got.codes) code.run(day, w.slug, c, n);
          out.prepare("INSERT OR REPLACE INTO usage_worlds (day, world, status, reason, at) VALUES (?, ?, 'read', NULL, ?)").run(day, w.slug, now());
          result.read.push(w.slug);
        } else {
          // an earlier good read of that day stands; otherwise the day is marked skipped for this world (no rows, not zeros)
          if (out.prepare('SELECT status FROM usage_worlds WHERE day = ? AND world = ?').get(day, w.slug)?.status !== 'read')
            out.prepare("INSERT OR REPLACE INTO usage_worlds (day, world, status, reason, at) VALUES (?, ?, 'skipped', ?, ?)").run(day, w.slug, why, now());
          result.skipped.push({ world: w.slug, reason: why });
        }
        out.exec('COMMIT');
      } catch (e) { out.exec('ROLLBACK'); throw e; }
    }
    return result;
  } finally { out.close(); }
}

/** The days to roll up: those after the last one rolled up (at most MAX_FILL_DAYS back), through yesterday. */
export function missedDays(file, now = Date.now()) {
  const yesterday = dayOf(now - DAY_MS);
  let last = null;
  if (existsSync(file)) { const db = openOut(file); try { last = db.prepare('SELECT MAX(day) AS d FROM usage_worlds').get()?.d ?? null; } finally { db.close(); } }
  const days = [];
  for (let t = Math.max(last ? startOf(last) + DAY_MS : startOf(yesterday), startOf(yesterday) - (MAX_FILL_DAYS - 1) * DAY_MS); t <= startOf(yesterday); t += DAY_MS) days.push(dayOf(t));
  return days;
}

/** The launcher's worlds and their stores. */
export const registryWorlds = (dataDir) => { const reg = new Registry(dataDir); return reg.worlds.map((w) => ({ slug: w.slug, file: join(reg.worldDir(w.slug), 'sim.db') })); };

/** The report for the last `days` rolled-up days, test worlds (`exclude`, by slug) left out. */
export function usageReport(file, { days = 7, exclude = [] } = {}) {
  const n = Math.min(366, Math.max(1, Math.floor(Number(days)) || 7));
  if (!existsSync(file)) return { ok: true, days: [], accounts: [] };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const left = new Set(exclude), keep = (r) => !left.has(r.world);
    const last = db.prepare('SELECT MAX(day) AS d FROM usage_worlds').get()?.d;
    if (!last) return { ok: true, days: [], accounts: [] };
    const from = dayOf(startOf(last) - (n - 1) * DAY_MS);
    const all = db.prepare('SELECT day, world, account, soul, acts, refusals, last_client FROM usage_daily WHERE day <= ? ORDER BY day').all(last).filter(keep);
    const codes = db.prepare('SELECT day, world, code, n FROM usage_refusals WHERE day >= ? AND day <= ?').all(from, last).filter(keep);
    const skipped = db.prepare("SELECT day, world, reason FROM usage_worlds WHERE status = 'skipped' AND day >= ? AND day <= ? ORDER BY world").all(from, last).filter(keep);
    const seen = new Map();   // account → Set of days it acted, over the whole table
    for (const r of all) if (r.account) { if (!seen.has(r.account)) seen.set(r.account, new Set()); seen.get(r.account).add(r.day); }
    const firstOf = (a) => [...seen.get(a)].sort()[0];
    const out = [];
    for (let t = startOf(from); t <= startOf(last); t += DAY_MS) {
      const day = dayOf(t), rows = all.filter((r) => r.day === day);
      const accounts = new Set(rows.map((r) => r.account).filter(Boolean)), fresh = [...accounts].filter((a) => firstOf(a) === day).length;
      const byCode = new Map(); for (const c of codes) if (c.day === day) byCode.set(c.code, (byCode.get(c.code) ?? 0) + c.n);
      const clients = {}; for (const r of rows) clients[r.last_client ?? 'none'] = (clients[r.last_client ?? 'none'] ?? 0) + 1;
      out.push({
        day, accounts: accounts.size, newAccounts: fresh, returningAccounts: accounts.size - fresh, souls: new Set(rows.map((r) => `${r.world}\n${r.soul}`)).size,
        acts: rows.reduce((s, r) => s + r.acts, 0), refusals: rows.reduce((s, r) => s + r.refusals, 0),
        topRefusals: [...byCode].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([code, k]) => ({ code, n: k })),
        clients: Object.fromEntries(Object.entries(clients).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
        skipped: skipped.filter((s) => s.day === day).map((s) => ({ world: s.world, reason: s.reason })),
      });
    }
    const accounts = [...seen].filter(([, d]) => [...d].some((x) => x >= from)).map(([account, d]) => { const s = [...d].sort(); return { account, firstSeen: s[0], lastSeen: s.at(-1), daysActive: s.length }; })
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.daysActive - a.daysActive || a.account.localeCompare(b.account));
    return { ok: true, days: out, accounts };
  } finally { db.close(); }
}

/** The report as the operator reads it in a terminal. */
export function formatReport(r) {
  if (!r.days?.length) return 'no usage rolled up yet';
  const lines = [`usage by UTC day, ${r.days[0].day} to ${r.days.at(-1).day} (accounts and Souls that acted; test worlds left out)`];
  for (const d of r.days) {
    lines.push(`${d.day}  accounts ${d.accounts} (new ${d.newAccounts}, returning ${d.returningAccounts})  Souls ${d.souls}  acts ${d.acts}  refusals ${d.refusals}${d.topRefusals.length ? ` (${d.topRefusals.map((c) => `${c.code} ${c.n}`).join(', ')})` : ''}`);
    const clients = Object.entries(d.clients);
    if (clients.length) lines.push(`            Souls by client: ${clients.map(([c, k]) => `${c} ${k}`).join(', ')}`);
    if (d.skipped.length) lines.push(`            skipped (unreadable): ${d.skipped.map((s) => s.world).join(', ')}`);
  }
  lines.push('', 'account               first seen  last seen   days active');
  for (const a of r.accounts) lines.push(`${a.account.padEnd(22)}${a.firstSeen}  ${a.lastSeen}  ${a.daysActive}`);
  return lines.join('\n');
}

/** Mounted by launcher.mjs: the rollup in a child process (after `startMs`, then every `everyMs`) and the report route. */
export function usageRollup({ dataDir, log = () => {}, startMs = 30_000, everyMs = 3_600_000 }) {
  const file = join(dataDir, 'usage.sqlite');
  let running = false;
  const run = () => {
    if (running) return; running = true;
    execFile(process.execPath, [SELF, '--data', dataDir], { timeout: 10 * 60_000 }, (err, stdout) => {
      running = false;
      if (err) { log(`usage rollup failed: ${String(err.message).split('\n')[0]}`); return; }
      try { for (const d of JSON.parse(stdout).days) log(`usage ${d.day}: ${d.read.length} worlds read${d.skipped.length ? `, skipped ${d.skipped.map((s) => s.world).join(', ')}` : ''}`); } catch { /* nothing to say */ }
    });
  };
  if (everyMs > 0) { setTimeout(run, startMs).unref(); setInterval(run, everyMs).unref(); }
  return { run, report: (days, exclude) => [200, usageReport(file, { days: days ?? 7, exclude })] };
}

if (process.argv[1] === SELF) {
  const argv = process.argv.slice(2), flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const dataDir = flag('data'), day = flag('day');
  if (!dataDir || (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day))) { console.error('usage: usage.mjs --data <launcher data dir> [--day YYYY-MM-DD] [--tries N] [--wait-ms N]'); process.exit(2); }
  const file = join(dataDir, 'usage.sqlite'), worlds = registryWorlds(dataDir), opts = { tries: Number(flag('tries') ?? 3), waitMs: Number(flag('wait-ms') ?? 2000) };
  const days = [];
  for (const d of day ? [day] : missedDays(file)) days.push(await rollupDay(file, worlds, d, opts));
  console.log(JSON.stringify({ days }));
}
