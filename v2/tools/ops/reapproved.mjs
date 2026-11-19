#!/usr/bin/env node
// Imported Souls approved again (Engine v2 X15, #3322): for each UTC day of the rollback window, how many of the
// Souls X11 imported have had their agent approved once more through W2's pairing. Counts only: no Soul, account,
// device or code is printed.
//
// Sources, both opened read-only:
// - X11's account store (`import-accounts --out <dir>` writes `<dir>/accounts.sqlite`): `imported_souls_v1`, one row
//   per imported Soul, its new id as `<scope hex>:<counter>`.
// - W2's pairing store (directoryd `--pairing <path>`): `pair_requests_v1`, where an approved request is `approved`
//   until its device collects the token, then `delivered`, and names the Soul's grant `soul-<scope hex>-<counter>`.
//   A Soul counts once, on the UTC day of its first approved request (the day the request was made; a request
//   lives minutes).
//
//   node v2/tools/ops/reapproved.mjs --accounts <accounts.sqlite> --pairing <pairing.sqlite>
//        [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]
// --since defaults to the first approval's day, --until to today (UTC).
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const DAY_MS = 86_400_000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The grant text of an imported Soul's id (`<hex>:<counter>` -> `soul-<hex>-<counter>`), or null. */
export const grantOf = (id) => {
  const m = /^([0-9a-f]{32}):(\d+)$/.exec(id);
  return m ? `soul-${m[1]}-${m[2]}` : null;
};

/** {imported, days: [{day, approved, total}]} from the two stores. */
export function count({ accounts, pairing, since, until }) {
  const open = (p) => new DatabaseSync(p, { readOnly: true });
  const a = open(accounts);
  const imported = new Set(a.prepare('SELECT soul FROM imported_souls_v1').all().map((r) => grantOf(r.soul)).filter(Boolean));
  a.close();
  const p = open(pairing);
  const first = new Map();
  for (const r of p.prepare(`SELECT grant_text, MIN(created_at) AS at FROM pair_requests_v1
      WHERE state IN ('approved', 'delivered') AND grant_text IS NOT NULL GROUP BY grant_text`).all()) {
    if (imported.has(r.grant_text)) first.set(r.grant_text, Number(r.at) * 1000);
  }
  p.close();
  const perDay = new Map();
  for (const at of first.values()) perDay.set(dayOf(at), (perDay.get(dayOf(at)) ?? 0) + 1);
  const start = since ?? ([...perDay.keys()].sort()[0] ?? dayOf(Date.now()));
  const end = until ?? dayOf(Date.now());
  let total = [...perDay].filter(([d]) => d < start).reduce((s, [, n]) => s + n, 0);
  const days = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); dayOf(t) <= end; t += DAY_MS) {
    const approved = perDay.get(dayOf(t)) ?? 0;
    total += approved;
    days.push({ day: dayOf(t), approved, total });
  }
  return { imported: imported.size, days };
}

/** The plain table posted on the switch's issue. */
export function format({ imported, days }) {
  const pct = (n) => (imported ? `${Math.round((100 * n) / imported)}%` : '-');
  const rows = days.map((d) => `| ${d.day} | ${imported} | ${d.approved} | ${d.total} | ${pct(d.total)} |`);
  return ['| UTC day | Imported | Approved again that day | Approved again so far | Share |', '|---|---|---|---|---|', ...rows].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const isDay = (d) => d === undefined || /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!flag('accounts') || !flag('pairing') || !isDay(flag('since')) || !isDay(flag('until'))) {
    console.error('usage: reapproved.mjs --accounts <accounts.sqlite> --pairing <pairing.sqlite> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]');
    process.exit(2);
  }
  const r = count({ accounts: flag('accounts'), pairing: flag('pairing'), since: flag('since'), until: flag('until') });
  console.log(argv.includes('--json') ? JSON.stringify(r) : format(r));
}
