// souls-state.mjs on fake stores: a save holds every owner file, a wipe refuses without a matching save and renames
// aside (never deletes), and a later save of the wiped state is empty. `node --test v2/tools/ops/cutover/souls-state.test.mjs`.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { manifestOf, save, wipe } from './souls-state.mjs';

/** A fake directory (the account and pairing stores in directoryd's schema, its args file, the gateway tokens) and world. */
function fake(t) {
  const d = mkdtempSync(join(tmpdir(), 'souls-state-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const accounts = join(d, 'accounts.sqlite'), pairing = join(d, 'pairing.sqlite'), tokens = join(d, 'world', 'tokens');
  const a = new DatabaseSync(accounts);
  a.exec(`CREATE TABLE provider_accounts_v1(account_id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE account_principals_v1(account_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    INSERT INTO provider_accounts_v1 VALUES ('acc_ada', 'https://issuer.test', 'user_ada', 1795000000), ('acc_bo', 'https://issuer.test', 'user_bo', 1795000100);`);
  a.close();
  const p = new DatabaseSync(pairing);
  p.exec(`CREATE TABLE pair_requests_v1(code TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, device TEXT NOT NULL, label TEXT NOT NULL, soul TEXT,
      scope TEXT NOT NULL, force INTEGER NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, account TEXT, grant_text TEXT, refusal TEXT, refusal_device TEXT);
    CREATE TABLE paired_souls_v1(grant_text TEXT PRIMARY KEY, account TEXT NOT NULL, device TEXT, token_hash TEXT);
    INSERT INTO paired_souls_v1 VALUES ('soul:s1', 'acc_ada', 'laptop', 'aa'), ('soul:s2', 'acc_bo', 'desk', 'bb'), ('soul:s3', 'acc_bo', 'desk', 'cc');`);
  p.close();
  mkdirSync(join(d, 'world'));
  writeFileSync(join(d, 'world', 'world.json'), JSON.stringify({ name: 'w', souls: { s1: {}, s2: {}, s3: {} } }));
  writeFileSync(tokens, 'soul:s1 aa\nsoul:s2 bb\nsoul:s3 cc\n');
  writeFileSync(join(d, 'world', 'souls.tokens'), 't1\nt2\nt3\n', { mode: 0o600 });
  const args = join(d, 'directory.args');
  writeFileSync(args, `DIRECTORYD_ARGS="--listen 127.0.0.1:1 --store ${accounts} --pairing ${pairing} --gateway-tokens ${tokens}"\n`);
  return { d, accounts, pairing, tokens, args, world: join(d, 'world') };
}

test('a save holds every owner file, mode 0600, with its counts, and changes nothing', (t) => {
  const f = fake(t), out = join(f.d, 'saved', 'eden.tar');
  const before = readFileSync(f.tokens, 'utf8');
  const m = save({ world: f.world, out, args: f.args });
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.deepEqual(m.counts, { accounts: 2, soulsPaired: 3, worldSouls: 3 });
  const names = execFileSync('tar', ['-tf', out], { encoding: 'utf8' }).split('\n').filter(Boolean).map((n) => n.replace(/^\.\//, '')).sort();
  for (const n of ['manifest.json', 'accounts.sqlite', 'pairing.sqlite', 'gateway.tokens', 'world/world.json', 'world/tokens', 'world/souls.tokens']) assert.ok(names.includes(n), n);
  // The saved store is a whole SQLite file with the rows.
  const x = mkdtempSync(join(tmpdir(), 'souls-state-x-')); t.after(() => rmSync(x, { recursive: true, force: true }));
  execFileSync('tar', ['-xf', out, '-C', x]);
  const db = new DatabaseSync(join(x, 'accounts.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM provider_accounts_v1').get().n, 2);
  db.close();
  assert.deepEqual(manifestOf(out).counts, m.counts);
  assert.equal(readFileSync(f.tokens, 'utf8'), before);
});

test('a wipe needs a save of the files as they are, renames them aside and leaves an empty tokens file', (t) => {
  const f = fake(t), out = join(f.d, 'eden.tar');
  assert.throws(() => wipe({ saved: join(f.d, 'none.tar'), args: f.args }), /souls-state.not-saved/);
  save({ world: f.world, out, args: f.args });
  // A pairing made after the save: the save no longer holds everything, so the wipe refuses.
  const p = new DatabaseSync(f.pairing);
  p.exec("INSERT INTO paired_souls_v1 VALUES ('soul:s4', 'acc_ada', 'phone', 'dd')");
  p.close();
  assert.throws(() => wipe({ saved: out, args: f.args }), /changed-since-save: pairing/);
  save({ world: f.world, out, args: f.args });
  const r = wipe({ saved: out, args: f.args, now: new Date('2026-11-23T14:00:00Z') });
  assert.equal(r.counts.soulsPaired, 4);
  assert.ok(!existsSync(f.accounts) && !existsSync(f.pairing));
  assert.equal(readFileSync(f.tokens, 'utf8'), '');
  const aside = readdirSync(f.d).filter((n) => n.includes('.wiped-2026-11-23T14-00-00-000Z'));
  assert.deepEqual(aside.sort(), ['accounts.sqlite.wiped-2026-11-23T14-00-00-000Z', 'pairing.sqlite.wiped-2026-11-23T14-00-00-000Z']);
  assert.ok(existsSync(`${f.tokens}.wiped-2026-11-23T14-00-00-000Z`), 'the tokens file is kept aside');
  // The world is not touched.
  assert.ok(existsSync(join(f.world, 'world.json')) && existsSync(join(f.world, 'souls.tokens')));
});
