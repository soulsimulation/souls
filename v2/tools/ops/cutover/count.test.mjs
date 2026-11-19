// node --test v2/tools/ops/cutover/count.test.mjs (Engine v2 X7, #2836): the rollback's count of accounts and Souls made
// after the switch, from two synthetic stores in a temp folder with directoryd's table shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { count, line, storesOf } from './count.mjs';

const SWITCH = Date.parse('2026-11-20T09:00:00Z'), s = SWITCH / 1000;

function stores(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cutover-count-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const accounts = join(dir, 'accounts.sqlite'), pairing = join(dir, 'pairing.sqlite');
  const a = new DatabaseSync(accounts);
  a.exec('CREATE TABLE provider_accounts_v1(account_id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL)');
  const acct = a.prepare('INSERT INTO provider_accounts_v1 VALUES (?, ?, ?, ?)');
  acct.run('acct_old', 'i', 'a', s - 86_400);   // brought over by X11: its first-seen time is before the switch
  acct.run('acct_new1', 'i', 'b', s);
  acct.run('acct_new2', 'i', 'c', s + 60);
  a.close();
  const p = new DatabaseSync(pairing);
  p.exec(`CREATE TABLE pair_requests_v1(code TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, device TEXT NOT NULL, label TEXT NOT NULL,
    soul TEXT, scope TEXT NOT NULL, force INTEGER NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, account TEXT,
    grant_text TEXT, refusal TEXT, refusal_device TEXT)`);
  const req = p.prepare('INSERT INTO pair_requests_v1(code, secret_hash, device, label, soul, scope, force, created_at, state) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)');
  req.run('c1', 'h1', 'd', 'l', null, 'soul', s + 10, 'delivered');                         // a new Soul: counted
  req.run('c2', 'h2', 'd', 'l', null, 'soul', s + 20, 'approved');                          // a new Soul: counted
  req.run('c3', 'h3', 'd', 'l', `soul-${'a'.repeat(32)}-1`, 'soul', s + 30, 'delivered');   // one brought over, approved again
  req.run('c4', 'h4', 'd', 'l', null, 'soul', s - 30, 'delivered');                         // made before the switch
  req.run('c5', 'h5', 'd', 'l', null, 'soul', s + 40, 'refused');                           // refused: no Soul made
  req.run('c6', 'h6', 'd', 'l', null, 'creator', s + 50, 'delivered');                      // a creator, not a Soul
  p.close();
  return { accounts, pairing };
}

test('counts accounts and Souls made at or after the switch, nothing brought over', (t) => {
  const r = count({ since: SWITCH, ...stores(t) });
  assert.deepEqual(r, { since: '2026-11-20T09:00:00.000Z', accounts: { count: 2 }, souls: { count: 2 } });
  assert.equal(line(r), 'made since the switch at 2026-11-20T09:00:00.000Z: 2 accounts, 2 Souls; kept untouched in the new system, they return at the next switch; nothing is copied back');
});

test('a store it cannot read is named, never guessed', (t) => {
  const r = count({ since: SWITCH, accounts: undefined, pairing: join(tmpdir(), 'no-such-dir-x7', 'pairing.sqlite') });
  assert.equal(r.accounts.count, null);
  assert.equal(r.accounts.why, 'not configured');
  assert.equal(r.souls.count, null);
  assert.match(line(r), /accounts: not counted \(not configured\), Souls: not counted/);
});

test('reads the stores directory.args names', () => {
  assert.deepEqual(storesOf('DIRECTORYD_ARGS="--listen 127.0.0.1:7310 --public-url https://soul.game --store /var/lib/souls/directory/accounts.sqlite --pairing /var/lib/souls/directory/pairing.sqlite"\n'),
    { accounts: '/var/lib/souls/directory/accounts.sqlite', pairing: '/var/lib/souls/directory/pairing.sqlite' });
  assert.deepEqual(storesOf(''), { accounts: undefined, pairing: undefined });
});
