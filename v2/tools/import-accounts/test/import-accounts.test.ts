// Engine v2 X11 (#2820): the acceptance, on a stage made and backed up by today's own code (fixture.ts).
//   node --test v2/tools/import-accounts/test/import-accounts.test.ts      (from the repository root; needs pnpm install and cargo)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ISSUER, makeFixture, type Fixture } from './fixture.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
const V2 = join(ROOT, 'v2');
const DIR = join(ROOT, '.local/import-accounts/test');

const files = (d: string): string[] => readdirSync(d, { recursive: true }).map((f) => join(d, String(f))).filter((f) => statSync(f).isFile());
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let fx: Fixture;
type Row = { stage: number; forks: number; aliases: number; conflicts: number; accountsEqual: boolean; hash: string; clean: boolean;
  worlds: { world: string; live: number; retired: number; brought: number; unowned: number; noKind: Record<string, number>; creator: boolean; equal: boolean }[] };
const runs: { row: Row; stdout: string; out: string }[] = [];

test('setup: the fixture, and two runs into one store', async () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  fx = await makeFixture(join(DIR, 'fixture'));
  execFileSync('cargo', ['build', '-q', '-p', 'import-accounts', '-p', 'scan-ids'], { cwd: V2, stdio: 'inherit' });
  const before = files(fx.set).map((f) => [f, sha(readFileSync(f))]);
  const out = join(DIR, 'out');
  for (let i = 0; i < 2; i++) {
    const r = spawnSync(join(V2, 'target/debug/import-accounts'), [fx.set, '--out', out, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    writeFileSync(join(DIR, `run-${i}.log`), r.stdout + r.stderr);
    runs.push({ row: JSON.parse(r.stdout), stdout: r.stdout + r.stderr, out });
  }
  // The backup is only read: every file's bytes are unchanged, and nothing was added beside them.
  assert.deepEqual(files(fx.set).map((f) => [f, sha(readFileSync(f))]), before);
});

test('A1: every account in the backup maps to the same account id', () => {
  const row = runs[0]!.row;
  assert.equal(row.stage, 3); assert.equal(row.forks, 2); assert.equal(row.aliases, 1); assert.equal(row.conflicts, 0);
  assert.equal(row.accountsEqual, true);
  const db = new DatabaseSync(join(runs[0]!.out, 'accounts.sqlite'), { readOnly: true });
  try {
    const by = (id: string) => db.prepare('SELECT issuer, subject FROM provider_accounts_v1 WHERE account_id = ?').get(id) as { issuer: string; subject: string } | undefined;
    for (const [who, id] of Object.entries(fx.stage)) assert.deepEqual({ ...by(id) }, { issuer: ISSUER, subject: `user_${who}` }, who);
    // The old worlds' registry: carol only it knows keeps her id; alice, whom the stage knows, keeps the stage's id and
    // her old id resolves to it.
    assert.deepEqual({ ...by(fx.forks.carol!) }, { issuer: ISSUER, subject: 'user_carol' });
    assert.equal(by(fx.forks.alice!), undefined);
    assert.equal((db.prepare('SELECT account_id FROM account_aliases_v1 WHERE old_id = ?').get(fx.forks.alice!) as { account_id: string }).account_id, fx.stage.alice);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM provider_accounts_v1').get() as { n: number }).n, 4);
    // Each has W1's principal, in W1's own table.
    assert.equal((db.prepare('SELECT COUNT(*) n FROM account_principals_v1').get() as { n: number }).n, 4);
  } finally { db.close(); }
});

test('A2: per world, Souls and creators equal the backup\'s, less the retired', () => {
  const row = runs[0]!.row;
  const db = new DatabaseSync(join(runs[0]!.out, 'accounts.sqlite'), { readOnly: true });
  const account = (id: string) => (db.prepare('SELECT account_id FROM provider_accounts_v1 WHERE account_id = ? UNION SELECT account_id FROM account_aliases_v1 WHERE old_id = ?').get(id, id) as { account_id: string }).account_id;
  try {
    for (const [world, want] of Object.entries(fx.worlds)) {
      const w = row.worlds.find((r) => r.world === world)!;
      assert.equal(w.live, want.live.length); assert.equal(w.brought, want.live.length); assert.equal(w.retired, want.retired.length);
      assert.equal(w.unowned, 0); assert.equal(w.creator, true); assert.equal(w.equal, true);
      const got = db.prepare('SELECT i.old_soul id, s.account_id owner, s.name, s.description, s.family, s.preset FROM imported_souls_v1 i JOIN souls_v1 s ON s.soul = i.soul WHERE i.world = ? ORDER BY i.old_soul').all(world) as Record<string, string>[];
      assert.deepEqual(got.map((s) => ({ id: s.id, owner: s.owner, name: s.name, description: s.description })),
        want.live.map((s) => ({ ...s, owner: account(s.owner) })).sort((a, b) => a.id.localeCompare(b.id)));
      for (const r of want.retired) assert.equal(got.some((s) => s.id === r), false, 'a retired Soul is not brought');
      for (const s of got) {
        assert.equal(s.family, 'eden:humanoid');
        assert.equal(s.preset, s.id === fx.creature.soul ? fx.creature.preset : 'humanoid');
      }
      assert.equal((db.prepare('SELECT account_id FROM world_creators_v1 WHERE world = ?').get(world) as { account_id: string }).account_id, account(want.creator));
      // W8: each brought Soul has one record, at this world; K10: one birth each, at the world's arrival point.
      const births = JSON.parse(readFileSync(join(runs[0]!.out, 'births', `${world}.json`), 'utf8'));
      assert.equal(births.births.length, want.live.length);
      for (const b of births.births) {
        assert.equal(b.entry, births.zone); assert.equal(b.asked, 0);
        assert.ok(statSync(join(runs[0]!.out, 'directory', 'soul', b.soul.replace(':', '-'))).isFile());
      }
    }
    assert.deepEqual(row.worlds.find((w) => w.world === 'x11-hamlet')!.noKind, { [fx.creature.preset]: 1 });
    assert.equal(row.clean, true);
  } finally { db.close(); }
});

test('A3: no token was copied; no account id is in any log', () => {
  const out = runs[0]!.out;
  const hashes = fx.tokens.map((t) => sha(t));
  // No token and no token hash anywhere: the store included.
  for (const f of files(out)) {
    const b = readFileSync(f);
    for (const t of [...fx.tokens, ...hashes]) assert.equal(b.includes(t), false, `${f} holds a token`);
  }
  // No account id, subject or token, in any form scan-ids knows, in the births (the new history's start), the
  // directory's objects or either run's printed rows. The account store holds ids by design and is left out.
  const ids = join(DIR, 'ids.txt');
  writeFileSync(ids, [...Object.values(fx.stage), ...Object.values(fx.forks), 'user_alice', 'user_bob', 'user_carol', 'user_dana', ...fx.tokens, ...hashes].join('\n') + '\n');
  const r = spawnSync(join(V2, 'target/debug/scan-ids'), ['--ids', ids, join(out, 'births'), join(out, 'directory'), join(DIR, 'run-0.log'), join(DIR, 'run-1.log')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // The control: the same scan finds an account id in the store.
  assert.equal(spawnSync(join(V2, 'target/debug/scan-ids'), ['--ids', ids, join(out, 'accounts.sqlite')]).status, 1);
});

test('A4: a second run gives the same state hash', () => {
  assert.match(runs[0]!.row.hash, /^[0-9a-f]{64}$/);
  assert.equal(runs[1]!.row.hash, runs[0]!.row.hash);
  assert.deepEqual(runs[1]!.row, runs[0]!.row);
});
