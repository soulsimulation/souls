// X15 (#3322) A4: reapproved.mjs prints, per UTC day, imported and approved-again counts, and no Soul or account id.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./reapproved.mjs', import.meta.url));
const hex = (n) => n.toString(16).padStart(32, 'a');
const at = (iso) => Math.floor(Date.parse(iso) / 1000);

test('per-day imported and approved-again counts, no ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reapproved-'));
  try {
    // X11's store: four imported Souls.
    const accounts = join(dir, 'accounts.sqlite');
    const a = new DatabaseSync(accounts);
    a.exec('CREATE TABLE imported_souls_v1(world TEXT NOT NULL, old_soul TEXT NOT NULL, soul TEXT NOT NULL UNIQUE, PRIMARY KEY(world, old_soul))');
    const souls = [1, 2, 3, 4].map((n) => ({ old: `s_old${n}`, id: `${hex(n)}:0` }));
    for (const s of souls) a.prepare('INSERT INTO imported_souls_v1 VALUES (?, ?, ?)').run('eden', s.old, s.id);
    a.close();
    // W2's store: Soul 1 approved on day one (twice: counted once), Soul 2 delivered on day two, Soul 3 only pending
    // and refused, Soul 4 never asked; a new Soul (not imported) approved on day one is not counted.
    const pairing = join(dir, 'pairing.sqlite');
    const p = new DatabaseSync(pairing);
    p.exec(`CREATE TABLE pair_requests_v1(code TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, device TEXT NOT NULL,
      label TEXT NOT NULL, soul TEXT, scope TEXT NOT NULL, force INTEGER NOT NULL, created_at INTEGER NOT NULL,
      state TEXT NOT NULL, account TEXT, grant_text TEXT, refusal TEXT, refusal_device TEXT)`);
    const ask = p.prepare(`INSERT INTO pair_requests_v1(code, secret_hash, device, label, scope, force, created_at, state,
      account, grant_text) VALUES (?, ?, 'laptop', 'agent', 'soul', 0, ?, ?, ?, ?)`);
    const g = (n) => `soul-${hex(n)}-0`;
    ask.run('C1', 'h1', at('2026-11-20T09:10:00Z'), 'delivered', 'acct_owner1', g(1));
    ask.run('C2', 'h2', at('2026-11-20T23:59:00Z'), 'approved', 'acct_owner1', g(1));
    ask.run('C3', 'h3', at('2026-11-21T00:01:00Z'), 'delivered', 'acct_owner2', g(2));
    ask.run('C4', 'h4', at('2026-11-21T10:00:00Z'), 'pending', null, g(3));
    ask.run('C5', 'h5', at('2026-11-21T11:00:00Z'), 'refused', 'acct_owner3', g(3));
    ask.run('C6', 'h6', at('2026-11-20T10:00:00Z'), 'delivered', 'acct_owner5', g(9));
    p.close();

    const run = (...extra) => execFileSync(process.execPath, [script, '--accounts', accounts, '--pairing', pairing, ...extra], { encoding: 'utf8' });
    const json = JSON.parse(run('--since', '2026-11-20', '--until', '2026-11-22', '--json'));
    assert.deepEqual(json, {
      imported: 4,
      days: [
        { day: '2026-11-20', approved: 1, total: 1 },
        { day: '2026-11-21', approved: 1, total: 2 },
        { day: '2026-11-22', approved: 0, total: 2 },
      ],
    });
    const table = run('--since', '2026-11-20', '--until', '2026-11-22');
    assert.match(table, /\| 2026-11-21 \| 4 \| 1 \| 2 \| 50% \|/);
    // --since defaults to the first approval's day.
    assert.equal(JSON.parse(run('--until', '2026-11-21', '--json')).days[0].day, '2026-11-20');
    // No Soul, account, device or code in either output.
    for (const out of [table, JSON.stringify(json)]) {
      for (const secret of [...souls.flatMap((s) => [s.old, s.id, s.id.split(':')[0]]), 'acct_', 'laptop', 'C1', 'soul-']) {
        assert.ok(!out.includes(secret), `output holds ${secret}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
