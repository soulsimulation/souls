#!/usr/bin/env node
// What a rollback leaves in the new system (Engine v2 X7, #2836): how many accounts and Souls were made after the
// switch. Counts only: no account, Soul, device or code is printed. Both stores are opened read-only.
//
// - Accounts: W1's account store (directoryd `--store`), `provider_accounts_v1.created_at` (seconds) at or after the
//   switch. X11's import keeps an account's first-seen time, so an account brought over is never counted. While
//   directoryd runs it holds this store exclusively; then the count says so instead of guessing.
// - Souls: W2's pairing store (directoryd `--pairing`), approved requests (`approved`, or `delivered` once collected)
//   for a Soul, made at or after the switch, that named no Soul by id, so made a new one. A Soul brought over (X11) is approved
//   again by id (R18), so it is never counted.
//
//   node v2/tools/ops/cutover/count.mjs --since <ISO time> [--args <directory.args>] [--accounts <file>] [--pairing <file>] [--json]
// --args (default /etc/souls/directory.args) supplies --store and --pairing when they are not given.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

/** The store and pairing paths named in directory.args (`DIRECTORYD_ARGS="... --store <p> --pairing <p> ..."`). */
export function storesOf(text) {
  const words = (/DIRECTORYD_ARGS="?([^"\n]*)"?/.exec(text)?.[1] ?? '').trim().split(/\s+/);
  const at = (k) => { const i = words.indexOf(k); return i >= 0 ? words[i + 1] : undefined; };
  return { accounts: at('--store'), pairing: at('--pairing') };
}

/** One store's count, or the reason it could not be read. */
function read(path, sql, since) {
  if (!path) return { count: null, why: 'not configured' };
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    return { count: Number(db.prepare(sql).get(since).n) };
  } catch (e) {
    return { count: null, why: /locked|busy/i.test(e.message) ? 'held by the directory while it runs' : e.message };
  } finally {
    try { db?.close(); } catch { /* closed */ }
  }
}

/** {since, accounts: {count, why?}, souls: {count, why?}} for a switch at `since` (ms). */
export function count({ since, accounts, pairing }) {
  const s = Math.floor(since / 1000);
  return {
    since: new Date(since).toISOString(),
    accounts: read(accounts, 'SELECT COUNT(*) AS n FROM provider_accounts_v1 WHERE created_at >= ?', s),
    souls: read(pairing, `SELECT COUNT(*) AS n FROM pair_requests_v1 WHERE created_at >= ? AND scope = 'soul' AND soul IS NULL
      AND state IN ('approved', 'delivered')`, s),
  };
}

/** The line the rollback prints and the declaration quotes. */
export function line(r) {
  const n = (x, one, many) => (x.count === null ? `${many}: not counted (${x.why})` : `${x.count} ${x.count === 1 ? one : many}`);
  return `made since the switch at ${r.since}: ${n(r.accounts, 'account', 'accounts')}, ${n(r.souls, 'Soul', 'Souls')}; `
    + 'kept untouched in the new system, they return at the next switch; nothing is copied back';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const since = Date.parse(flag('since') ?? '');
  if (Number.isNaN(since)) {
    console.error('usage: count.mjs --since <ISO time> [--args <directory.args>] [--accounts <file>] [--pairing <file>] [--json]');
    process.exit(2);
  }
  let named = {};
  try { named = storesOf(readFileSync(flag('args') ?? '/etc/souls/directory.args', 'utf8')); } catch { /* none: only the flags */ }
  const r = count({ since, accounts: flag('accounts') ?? named.accounts, pairing: flag('pairing') ?? named.pairing });
  console.log(argv.includes('--json') ? JSON.stringify(r) : line(r));
}
