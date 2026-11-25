// Old Eden's residents come back as real, unpaired Souls (eden-residents.mjs), on a fake host: the facts list three
// Souls' bodies as things (one owner signed in to the new system already, one not yet, one already brought by
// keep-souls) and a fourth whose owner has no sign-in; the old world, the old registry and the new account store.
//   node --test v2/tools/ops/cutover/eden-residents.test.mjs      (from the repository root)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { main, LOOK_MOST, lookOf, residentsOf } from './eden-residents.mjs';

const ROOT = resolve(import.meta.dirname, '../../../..');
const DIR = join(ROOT, '.local/eden-residents/test');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tree = (d) => readdirSync(d, { recursive: true }).map(String).sort().filter((f) => statSync(join(d, f)).isFile()).map((f) => [f, sha(readFileSync(join(d, f)))]);
const LINEAGE = 'ab'.repeat(16), ZONE = 'cd'.repeat(16);
const files = { facts: join(DIR, 'world/facts.json'), old: join(DIR, 'old/sim.db'), registry: join(DIR, 'old/accounts.sqlite'), store: join(DIR, 'new/accounts.sqlite'), world: join(DIR, 'world') };
const args = ['--facts', files.facts, '--old', files.old, '--registry', files.registry, '--store', files.store, '--world-dir', files.world];
const run = (...extra) => { const lines = []; const code = main([...args, ...extra], (l) => lines.push(l)); return { code, text: lines.join('\n') }; };
const look = (hair) => ({ family: 'humanoid', model: `humanoid2-${hair.padEnd(16, '0').slice(0, 16)}`, params: { hair, height: 1.7, skin: '#c99a6e' } });

test('setup: a fake host', () => {
  rmSync(DIR, { recursive: true, force: true });
  for (const d of ['world', 'old', 'new']) mkdirSync(join(DIR, d), { recursive: true });
  const thing = (id, name) => ({ id, def: 'core/humanoid@1', ref: 'core-humanoid@1', parent: null, pose: [0, 0, 0, 0], world: [0, 0, 0, 0], name });
  writeFileSync(files.facts, JSON.stringify({ format: 'souls/import-eden/1', things: [
    { id: 'e_house', def: 'core-house@1', ref: 'core-house@1', parent: null },
    thing('h_0000000001', 'oriel'), thing('h_0000000002', 'thistle'), thing('h_0000000003', 'sprout'), thing('h_0000000004', 'nobody')] }));
  writeFileSync(join(files.world, 'world.json'), JSON.stringify({ format: 'souls/world/1', name: `${LINEAGE}-${ZONE}-0`, souls: [] }));
  writeFileSync(join(files.world, 'bodies.json'), JSON.stringify({ format: 'souls/bodies/1', bodies: [] }));
  const old = new DatabaseSync(files.old);
  old.exec(`CREATE TABLE souls(id TEXT PRIMARY KEY, world_id TEXT NOT NULL, owner TEXT NOT NULL, entity_id TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER, token_hash TEXT);
    CREATE TABLE snapshots(world_id TEXT NOT NULL, tick INTEGER NOT NULL, snapshot TEXT NOT NULL);`);
  const soul = old.prepare('INSERT INTO souls VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?)');
  soul.run('s_0000000001', 'old-eden', 'acct_gene', 'h_0000000001', 'Oriel', 'A resident.', 'token-hash-not-to-copy');
  soul.run('s_0000000002', 'old-eden', 'acct_bea', 'h_0000000002', 'Thistle', 'A gardener.', null);
  soul.run('s_0000000003', 'old-eden', 'acct_bea', 'h_0000000003', 'sprout', '', null);
  soul.run('s_0000000004', 'old-eden', 'acct_gone', 'h_0000000004', 'Nobody', '', null);
  const entities = { h_0000000001: { body: look('mohawk') }, h_0000000002: { body: look('bob') }, h_0000000003: { body: look('braids') }, h_0000000004: { body: null } };
  old.prepare('INSERT INTO snapshots VALUES (?, 5, ?)').run('old-eden', JSON.stringify({ model: { entities: { ...entities, e_house: {} } } }));
  old.prepare('INSERT INTO snapshots VALUES (?, 4, ?)').run('old-eden', JSON.stringify({ model: { entities: {} } }));
  old.close();
  const reg = new DatabaseSync(files.registry);
  reg.exec('CREATE TABLE provider_accounts_v1(account_id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL)');
  reg.prepare('INSERT INTO provider_accounts_v1 VALUES (?, ?, ?, 0)').run('acct_gene', 'test:local', 'Gene');
  reg.prepare('INSERT INTO provider_accounts_v1 VALUES (?, ?, ?, 0)').run('acct_bea', 'test:local', 'Bea');
  reg.close();
  // The new store, as the directory keeps it: Bea has signed in since the switch; keep-souls brought her Thistle.
  const store = new DatabaseSync(files.store);
  store.exec(`CREATE TABLE provider_accounts_v1(account_id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(issuer, subject));
    CREATE TABLE account_principals_v1(account_id TEXT PRIMARY KEY REFERENCES provider_accounts_v1(account_id), principal_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE account_grants_v1(account_id TEXT NOT NULL REFERENCES provider_accounts_v1(account_id), grant_text TEXT NOT NULL, follow TEXT, UNIQUE(account_id, grant_text));
    CREATE TABLE souls_v1(soul TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES provider_accounts_v1(account_id), name TEXT NOT NULL, description TEXT NOT NULL, family TEXT NOT NULL, preset TEXT NOT NULL, look TEXT NOT NULL);
    CREATE TABLE imported_souls_v1(world TEXT NOT NULL, old_soul TEXT NOT NULL, soul TEXT NOT NULL UNIQUE, PRIMARY KEY(world, old_soul));`);
  store.prepare('INSERT INTO provider_accounts_v1 VALUES (?, ?, ?, 0)').run('acct_bea_new', 'test:local', 'Bea');
  store.prepare('INSERT INTO account_principals_v1 VALUES (?, ?, 0)').run('acct_bea_new', `${'ee'.repeat(16)}:0`);
  store.prepare('INSERT INTO souls_v1 VALUES (?, ?, ?, ?, ?, ?, ?)').run(`${'0f'.repeat(16)}:0`, 'acct_bea_new', 'Thistle', 'A gardener.', 'eden:humanoid', 'humanoid2-bob0000000000000', 'aa');
  store.prepare('INSERT INTO imported_souls_v1 VALUES (?, ?, ?)').run('old-eden', 's_0000000002', `${'0f'.repeat(16)}:0`);
  store.close();
});

test('the residents are the facts\' Souls\' bodies, and a look is the old body\'s params when they fit', () => {
  assert.deepEqual(residentsOf(JSON.parse(readFileSync(files.facts, 'utf8'))).map((r) => r.soul), ['s_0000000001', 's_0000000002', 's_0000000003', 's_0000000004']);
  assert.equal(lookOf(look('bob')), JSON.stringify(look('bob').params));
  assert.equal(lookOf(null), null);
  assert.equal(lookOf({ family: 'floater', params: { a: 1 } }), null, 'only a humanoid look goes on the default body');
  assert.equal(lookOf({ family: 'humanoid', params: { hair: 'x'.repeat(LOOK_MOST) } }), null, 'a look too long for the body');
});

test('the dry run changes nothing and says what it would do, naming no person', () => {
  const before = tree(DIR);
  const { code, text } = run();
  assert.equal(code, 0, text);
  assert.deepEqual(tree(DIR), before, 'not one byte changed');
  assert.match(text, /Oriel \(old s_0000000001, body h_0000000001, old-eden\): to bring, unpaired, under owner \d's account \(made from the old sign-in/);
  assert.match(text, /Thistle \(old s_0000000002.*already in the directory as (0f){16}:0/);
  assert.match(text, /sprout \(old s_0000000003.*to bring, unpaired, under owner \d's account \(it is in the store\)/);
  assert.match(text, /Nobody \(old s_0000000004.*NOT brought: its owner has no sign-in/);
  assert.match(text, /summary: 2 to bring \(1 with an account made\), 1 already brought, 1 without an owner's sign-in/);
  assert.doesNotMatch(text, /Gene|Bea|acct_|test:local/, 'no person, account or sign-in in the output');
});

test('--apply brings each resident unpaired under its owner, born in its look; a second run changes nothing', () => {
  const { code, text } = run('--apply');
  assert.equal(code, 0, text);
  const db = new DatabaseSync(files.store, { readOnly: true });
  const rows = db.prepare(`SELECT i.old_soul, i.world, s.soul, s.name, s.description, s.family, p.issuer, p.subject FROM imported_souls_v1 i
    JOIN souls_v1 s ON s.soul = i.soul JOIN provider_accounts_v1 p ON p.account_id = s.account_id ORDER BY i.old_soul`).all();
  assert.deepEqual(rows.map((r) => [r.old_soul, r.world, r.name, r.description, r.family, r.subject]), [
    ['s_0000000001', 'old-eden', 'Oriel', 'A resident.', 'eden:humanoid', 'Gene'],
    ['s_0000000002', 'old-eden', 'Thistle', 'A gardener.', 'eden:humanoid', 'Bea'],
    ['s_0000000003', 'old-eden', 'sprout', '', 'eden:humanoid', 'Bea']]);
  // Gene had no account in the new store: made with his old id and a principal; sprout joins Bea's new account.
  assert.equal(db.prepare('SELECT account_id FROM provider_accounts_v1 WHERE subject = ?').get('Gene').account_id, 'acct_gene');
  assert.match(db.prepare('SELECT principal_id FROM account_principals_v1 WHERE account_id = ?').get('acct_gene').principal_id, /^[0-9a-f]{32}:0$/);
  assert.equal(db.prepare('SELECT account_id FROM souls_v1 WHERE name = ?').get('sprout').account_id, 'acct_bea_new');
  const oriel = rows[0].soul, [scope] = oriel.split(':');
  assert.match(oriel, /^[0-9a-f]{32}:0$/);
  assert.deepEqual(db.prepare('SELECT grant_text, follow FROM account_grants_v1 WHERE account_id = ?').all('acct_gene').map((r) => ({ ...r })), [{ grant_text: `soul-${scope}-0`, follow: `${scope}.0` }]);
  assert.deepEqual(JSON.parse(db.prepare('SELECT body FROM legacy_looks_v1 WHERE soul = ?').get(oriel).body), look('mohawk'), 'the old body kept whole');
  assert.equal(db.prepare("SELECT count(*) AS n FROM souls_v1 WHERE name = 'Nobody'").get().n, 0);
  db.close();
  // births.json: Oriel and sprout and Thistle (already brought) each born in their look, bound to the world and its catalogue.
  const births = JSON.parse(readFileSync(join(files.world, 'births.json'), 'utf8'));
  assert.deepEqual({ ...births, births: undefined }, { format: 'souls-births/1', world: 'old-eden', lineage: LINEAGE, zone: `${ZONE}:0`,
    catalogueHash: sha(readFileSync(join(files.world, 'bodies.json'))), births: undefined });
  assert.deepEqual(births.births.map((b) => [b.soul === oriel ? 'Oriel' : b.soul, JSON.parse(b.look).hair, b.entry, b.asked]).sort(),
    [[`${'0f'.repeat(16)}:0`, 'bob', `${ZONE}:0`, 0], ['Oriel', 'mohawk', `${ZONE}:0`, 0], [rows[2].soul, 'braids', `${ZONE}:0`, 0]].sort());
  assert.equal(statSync(join(files.world, 'births.json')).mode & 0o777, 0o600);
  assert.match(text, /Oriel \(old s_0000000001.*brought as [0-9a-f]{32}:0, unpaired/);

  const before = tree(DIR);
  const again = run('--apply');
  assert.equal(again.code, 0, again.text);
  assert.match(again.text, /summary: 0 to bring \(0 with an account made\), 3 already brought/);
  const after = tree(DIR).filter(([f]) => !/accounts\.sqlite/.test(f));
  assert.deepEqual(after, before.filter(([f]) => !/accounts\.sqlite/.test(f)), 'births.json and the rest unchanged');
  const db2 = new DatabaseSync(files.store, { readOnly: true });
  assert.equal(db2.prepare('SELECT count(*) AS n FROM imported_souls_v1').get().n, 3);
  db2.close();
});

test('refused, nothing changed: not a directory store, or no catalogue to bind births to', () => {
  rmSync(join(files.world, 'births.json'));
  const bodies = readFileSync(join(files.world, 'bodies.json'));
  rmSync(join(files.world, 'bodies.json'));
  const db = new DatabaseSync(files.store);
  db.exec("DELETE FROM imported_souls_v1 WHERE old_soul = 's_0000000003'");
  db.close();
  const before = tree(DIR);
  const r = run('--apply');
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /refused, the store is unchanged: .*no bodies\.json/);
  assert.deepEqual(tree(DIR).filter(([f]) => !/accounts\.sqlite/.test(f)), before.filter(([f]) => !/accounts\.sqlite/.test(f)));
  writeFileSync(join(files.world, 'bodies.json'), bodies);
  const bad = main(['--facts', files.facts, '--old', files.old, '--registry', files.registry, '--store', files.old, '--world-dir', files.world], () => {});
  assert.equal(bad, 1, 'the old world is no account store');
});
